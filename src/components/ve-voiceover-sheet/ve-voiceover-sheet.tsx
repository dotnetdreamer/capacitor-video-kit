import { signal } from '@preact/signals-core';
import { Component, Prop } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { MIN_LAYER_MS, clamp, removeVoiceover, voiceRoomAt } from '../../editor';
import type { EditorVoiceHost } from '../../host/host.types';

/**
 * What the host hands back when a take is finished. Named off the host interface rather than
 * written out again, so a recorder that grows a field does not leave a second shape behind here.
 */
type VoiceRecordingResult = Awaited<ReturnType<EditorVoiceHost['stop']>>;

/** One take while the microphone is on. */
interface LiveTake {
  /**
   * The recorder this take is running on, held rather than looked up again when it is stopped: the
   * take belongs to the recorder that opened it, and `media.voice` is optional, so a stop that
   * asked for it a second time would need an answer for a recorder that is no longer there with a
   * customer's words already inside it.
   */
  voice: EditorVoiceHost;
  /** Output-timeline position the take starts at. */
  from: number;
  /** How long it may run before it reaches the next take or the end of the video. */
  room: number;
  /** `performance.now()` when the microphone came on. */
  startedAt: number;
  /** The preview has been seen playing since the take began. */
  sawPlaying: boolean;
  /** `performance.now()` when playback stopped or jumped back, 0 while it is running normally. */
  interruptedAt: number;
}

type Phase = 'idle' | 'starting' | 'recording' | 'stopping';

/** Stop this close to the room's edge, so the last frame of audio never spills into the next take. */
const ROOM_EDGE_MS = 30;
/**
 * How long playback has to stay stopped (or behind the take's start) before the take is ended. A
 * preview crossing a clip boundary can report "not playing" for a frame or two while it swaps the
 * source, and that must not cut a take in half.
 */
const INTERRUPT_GRACE_MS = 250;
/** A playhead this far behind where the take began means the customer scrubbed back. */
const REWIND_TOLERANCE_MS = 250;
/**
 * The wall clock's backstop for a preview that never started or stalled: the take cannot be longer
 * than its room anyway, so a microphone left on well past it is only recording silence.
 */
const OVERRUN_MS = 1500;
/**
 * The host's stop is quick, but while it is outstanding `recordingFromMs` is still set and the shell
 * refuses Next. A stop that never answers would leave the customer stuck behind "Stop recording
 * first", so it is given up on after this long.
 */
const STOP_TIMEOUT_MS = 8000;
/** See [VeVoiceoverSheet.startPointAt]. */
const TAKE_END_SNAP_MS = 50;
/**
 * The most of a take's front that is treated as the recorder warming up. See [leadInMs]: a gap wider
 * than this is not a warm-up but a file whose duration cannot be trusted, and shifting the take by it
 * would move the voice away from the words it belongs to.
 */
const MAX_LEAD_IN_MS = 400;
/** Android's MediaRecorder cannot finish a file shorter than about 300 ms and fails the stop instead. */
const SHORT_TAP_MS = 700;

/**
 * TikTok's voiceover recorder: one big record button, the time it records from, and the takes made
 * so far. The preview, the transport and a compact timeline stay above it, and the timeline draws
 * the take growing in red while `store.recordingFromMs` is set.
 *
 * A take runs against the video: recording starts playback from the playhead and ends by itself
 * when it reaches the next take or the end of the video, or when playback is stopped - so the voice
 * always lands exactly over the frames the customer was watching while they spoke.
 *
 * The microphone belongs to this sheet. Closing it (the tick, or the shell's back button taking the
 * panel away) ends a take in progress and KEEPS it: losing a take to a tap on the tick would be far
 * worse than having one more to delete. The stop that ends it outlives the element, which is why
 * `ve-editor` renders this sheet at a fixed position in its own tree: an element the vdom moved is
 * disconnected and reconnected, and that would end a take the customer is still speaking into.
 */
@Component({
  tag: 've-voiceover-sheet',
  styleUrls: ['../sheet-common.css', 've-voiceover-sheet.css'],
  shadow: true,
})
export class VeVoiceoverSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);

  /*
   * Signals rather than `@State`, so every repaint this sheet asks for comes through the one
   * mechanism the render already runs inside. The clock below is written from a frame callback,
   * which is not a place to be reasoning about a second scheduler.
   */
  private readonly phase = signal<Phase>('idle');
  /** Recorded so far, in whole tenths so the clock only re-renders when its text changes. */
  private readonly elapsedMs = signal(0);
  /** Takes recorded while this sheet has been open, oldest first. "Delete last" means these. */
  private readonly sessionTakeIds = signal<readonly string[]>([]);

  private take: LiveTake | null = null;
  private raf = 0;
  private destroyed = false;

  connectedCallback() {
    /*
     * Cleared rather than assumed false. A disconnect ends the take and sets this, and Stencil
     * reuses an element it merely moved: without the reset, such an element would refuse every
     * start from then on, silently, because `beginTake` reads this after the permission prompt.
     */
    this.destroyed = false;
    // The customer is about to pick where the voice starts; a video running under that is in the
    // way. Before the first render, which reads the room at the playhead this leaves behind.
    this.ctx.store.pause();
  }

  disconnectedCallback() {
    this.destroyed = true;
    // Cannot be awaited here. `stop` reaches the host recorder synchronously and puts the take in
    // the store when it answers, which outlives this sheet. A start still waiting on the permission
    // prompt checks `destroyed` when it resolves and turns the microphone back off.
    if (this.phase.value === 'recording') void this.stop();
    else this.cancelWatch();
    this.watcher.stop();
  }

  /* ========================================================================================= */
  /* Actions                                                                                   */
  /* ========================================================================================= */

  /*
   * One stable function each rather than a fresh arrow per render, because a new value is a changed
   * value to the vdom and the listener would be taken off and put back on every repaint - which
   * during a take is ten times a second.
   */
  private readonly toggleRecording = () => {
    const phase = this.phase.value;
    if (phase === 'recording') void this.stop();
    else if (phase === 'idle') void this.start();
  };

  /** The tick: a take in progress is kept, exactly as the back button would keep it. */
  private readonly done = () => {
    if (this.phase.value === 'recording') void this.stop();
    this.ctx.store.closePanel();
  };

  private readonly deleteLast = () => {
    const store = this.ctx.store;
    const id = this.lastTakeId();
    if (!id || this.phase.value !== 'idle') return;
    const take = store.manifest.value.voiceovers.find(t => t.id === id);
    if (!take) return;
    if (!store.commit('Delete voiceover', m => removeVoiceover(m, id))) return;
    if (store.isSelected({ kind: 'voice', id })) store.select(null);
    // Back to where that take began, so the next tap re-records the same line.
    store.seek(take.startMs);
    store.haptic('light');
  };

  private readonly toggleOriginalMuted = () => this.ctx.store.toggleOriginalMuted();

  /* ========================================================================================= */
  /* What the render asks                                                                      */
  /* ========================================================================================= */

  /** The squared-off button: the microphone is on, or its take is being saved. */
  private live(): boolean {
    const phase = this.phase.value;
    return phase === 'recording' || phase === 'stopping';
  }

  /**
   * A take from an earlier opening of this sheet is still being saved (the sheet was closed
   * mid-take). Starting another before the recorder has let go would be refused.
   */
  private previousTakeSaving(): boolean {
    return this.phase.value === 'idle' && this.ctx.store.recordingFromMs.value !== null;
  }

  private roomMs(): number {
    const store = this.ctx.store;
    return voiceRoomAt(store.manifest.value, this.startPointAt(store.playheadMs.value), store.totalMs.value);
  }

  /**
   * Only an idle button that has nowhere to record is disabled. While a start or a stop is in flight
   * the button keeps its look and simply ignores taps, so a fast start does not flash it grey.
   *
   * The phase is tested first for a second reason here that it did not have in Angular: the render
   * is watched over exactly the signals it read, so short-circuiting past `roomMs` while a take is
   * running is what keeps the playhead out of this sheet's dependencies. Read unconditionally, it
   * would repaint the sheet on all thirty playhead writes a second for a button nothing may press.
   */
  private recordDisabled(): boolean {
    return this.phase.value === 'idle' && (this.previousTakeSaving() || this.roomMs() < MIN_LAYER_MS);
  }

  private status(): string {
    switch (this.phase.value) {
      case 'recording':
        return `Recording ${clockTenths(this.elapsedMs.value)}`;
      case 'stopping':
        return 'Saving your take…';
      default:
        if (this.previousTakeSaving()) return 'Saving your take…';
        return this.roomMs() < MIN_LAYER_MS ? 'Move the playhead to an empty spot' : `Tap to record from ${clock(this.ctx.store.playheadMs.value)}`;
    }
  }

  /**
   * The take "Delete last" removes: the newest one recorded in this sheet that still exists (undo
   * may have taken it away), or - for takes from an earlier visit - the one furthest along.
   */
  private lastTakeId(): string | null {
    const takes = this.ctx.store.manifest.value.voiceovers;
    const ids = this.sessionTakeIds.value;
    for (let i = ids.length - 1; i >= 0; i--) {
      if (takes.some(take => take.id === ids[i])) return ids[i];
    }
    const last = takes.reduce<(typeof takes)[number] | null>((latest, take) => (!latest || take.startMs >= latest.startMs ? take : latest), null);
    return last?.id ?? null;
  }

  /* ========================================================================================= */
  /* Recording                                                                                 */
  /* ========================================================================================= */

  private async start(): Promise<void> {
    if (this.phase.value !== 'idle' || this.recordDisabled()) return;
    const store = this.ctx.store;

    const voice = store.host.media.voice;
    if (!voice) {
      // A host that declared no recorder does not offer this sheet at all, so reaching here means
      // one was taken away mid-edit. That is a microphone which will not start, and it is told the
      // same way as any other: a second sentence for it would only be a second thing to translate.
      this.cannotStart(new Error('This host has no voice recorder'));
      return;
    }

    this.phase.value = 'starting';
    store.pause();

    try {
      await this.openMicrophone(voice);
    } catch (error) {
      this.cannotStart(error);
      return;
    }

    this.beginTake(voice);
  }

  private cannotStart(error: unknown): void {
    this.phase.value = 'idle';
    const permission = isPermissionError(error);
    this.ctx.store.showToast(
      permission ? 'Microphone access is off. Turn it on in Settings to record a voiceover.' : 'The microphone could not be started.',
      permission ? 3200 : 1600,
    );
    this.ctx.store.haptic('warning');
  }

  /**
   * Turns the microphone on. A recorder the host still holds from a page that went away without
   * stopping it (a WebView reload keeps the plugin alive) would refuse every take from then on;
   * nobody can place what it recorded, so it is stopped, thrown away, and the start retried once.
   */
  private async openMicrophone(voice: EditorVoiceHost): Promise<void> {
    try {
      await voice.start();
    } catch (error) {
      if (errorCode(error) !== 'already_recording') throw error;
      await voice.stop().catch(() => undefined);
      await voice.start();
    }
  }

  private beginTake(voice: EditorVoiceHost): void {
    const store = this.ctx.store;
    const from = this.startPointAt(store.playheadMs.value);
    const room = voiceRoomAt(store.manifest.value, from, store.totalMs.value);

    // The permission prompt can sit on screen for as long as the customer likes. If the sheet was
    // closed meanwhile, or the timeline moved the playhead into a take, the microphone is on for a
    // take that has nowhere to go - so it goes straight back off.
    if (this.destroyed || room < MIN_LAYER_MS) {
      void voice.stop().catch(() => undefined);
      this.phase.value = 'idle';
      if (!this.destroyed) store.showToast('Move the playhead to an empty spot');
      return;
    }

    this.take = { voice, from, room, startedAt: performance.now(), sawPlaying: false, interruptedAt: 0 };
    this.elapsedMs.value = 0;
    this.phase.value = 'recording';
    store.recordingFromMs.value = from;
    store.play();
    store.haptic('medium');
    this.raf = requestAnimationFrame(this.watch);
  }

  /**
   * Runs every frame while the microphone is on: the clock signal is only written when its tenth
   * changes, and the take ends itself when the playhead reaches the room's edge, when playback
   * stops, or when the playhead is dragged back before the take's start.
   *
   * Angular ran this outside its zone so that a frame callback did not run change detection over
   * the whole application. There is no zone to leave here, and none is wanted: a signal read
   * outside an effect is untracked, so none of the reads below wakes anything. The tenth guard is
   * kept because the one WRITE is not free - it repaints this sheet - and the clock's own text only
   * changes ten times a second.
   */
  private readonly watch = (): void => {
    this.raf = 0;
    const take = this.take;
    if (!take || this.phase.value !== 'recording') return;

    const now = performance.now();
    const store = this.ctx.store;
    const at = store.playheadMs.value;
    const playing = store.playing.value;
    if (playing) take.sawPlaying = true;

    const interrupted = (take.sawPlaying && !playing) || at < take.from - REWIND_TOLERANCE_MS;
    if (!interrupted) take.interruptedAt = 0;
    else if (!take.interruptedAt) take.interruptedAt = now;

    const recorded = now - take.startedAt;
    const full = at >= take.from + take.room - ROOM_EDGE_MS;
    const overrun = recorded >= take.room + OVERRUN_MS;
    if (full || overrun) {
      void this.stop();
      return;
    }
    if (take.interruptedAt && now - take.interruptedAt >= INTERRUPT_GRACE_MS) {
      // What the microphone heard after the video stopped is silence nobody saw; it is cut off.
      const capMs = take.interruptedAt - take.startedAt;
      void this.stop(capMs);
      return;
    }

    const shown = Math.floor(Math.min(recorded, take.room) / 100) * 100;
    if (shown !== this.elapsedMs.value) this.elapsedMs.value = shown;
    this.raf = requestAnimationFrame(this.watch);
  };

  /**
   * Where a take tapped now would start. After a take the playhead is sent to its end so the next
   * tap carries on from there - but the preview maps that seek through source time and speed and
   * can land a hair short, INSIDE the take, which would disable the button for no visible reason.
   * A playhead that close to a take's end counts as its end.
   */
  private startPointAt(playheadMs: number): number {
    const at = Math.round(playheadMs);
    const take = this.ctx.store.manifest.value.voiceovers.find(t => at < t.startMs + t.durationMs && t.startMs + t.durationMs - at <= TAKE_END_SNAP_MS);
    return take ? take.startMs + take.durationMs : at;
  }

  private cancelWatch(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /**
   * Ends the take and puts it on the timeline where it was recorded. `recordingFromMs` stays set
   * until the take is in the manifest, so the shell's Next cannot render a video that is about to
   * gain a voiceover; it is cleared on every path.
   *
   * @param capMs the longest the take may be, when the end of the useful audio is known.
   */
  private async stop(capMs = Number.POSITIVE_INFINITY): Promise<void> {
    const take = this.take;
    if (!take || this.phase.value !== 'recording') return;
    this.phase.value = 'stopping';
    this.cancelWatch();
    const store = this.ctx.store;
    store.pause();
    const wallMs = performance.now() - take.startedAt;

    try {
      const result = await withTimeout(take.voice.stop(), STOP_TIMEOUT_MS);
      this.placeTake(take, result, wallMs, capMs);
    } catch {
      // A tap too short for the recorder to finish a file fails the stop rather than returning a
      // tiny take; that is a short take, not a broken microphone.
      store.showToast(wallMs < SHORT_TAP_MS ? 'That take was too short' : 'The recording could not be saved. Try again.');
      store.haptic('warning');
      store.seek(take.from);
    } finally {
      store.recordingFromMs.value = null;
      this.take = null;
      this.phase.value = 'idle';
    }
  }

  private placeTake(take: LiveTake, result: VoiceRecordingResult, wallMs: number, capMs: number): void {
    const store = this.ctx.store;
    // The host's duration comes from probing the finished file and reads 0 when the probe failed;
    // the wall clock is then the best measure of what was said.
    const measured = result.durationMs > 0 ? result.durationMs : wallMs;
    // The first audio in the file is not the moment the button was pressed, so the take goes on the
    // timeline where its sound actually belongs rather than where the microphone was asked for.
    const lead = leadInMs(wallMs, result.durationMs);
    const startMs = take.from + lead;
    const durationMs = Math.round(Math.max(0, Math.min(measured, take.room - lead, capMs - lead)));
    store.recordingFromMs.value = null;

    if (durationMs < MIN_LAYER_MS) {
      store.showToast('That take was too short');
      store.haptic('warning');
      store.seek(take.from);
      return;
    }

    const id = store.newId('vo');
    if (store.addVoiceover({ id, uri: result.uri, startMs, durationMs, volume: 1 })) {
      this.sessionTakeIds.value = [...this.sessionTakeIds.value, id];
    } else {
      // Only possible when the manifest changed under the take - an undo put a take back over it.
      store.showToast('There is no room for that take here');
      store.haptic('warning');
    }
    store.seek(startMs + durationMs);
  }

  render() {
    return this.watcher.run(() => {
      const store = this.ctx.store;
      const phase = this.phase.value;
      const live = this.live();
      const disabled = this.recordDisabled();
      const status = this.status();
      const takes = store.manifest.value.voiceovers.length;
      const lastTakeId = this.lastTakeId();
      const originalMuted = store.manifest.value.originalMuted;

      return (
        <ve-sheet heading="Voiceover" onVeConfirm={this.done}>
          <div class="vo">
            <div class="vo__main">
              <button
                type="button"
                class={{ 'vo__record': true, 'vo__record--live': live }}
                disabled={disabled}
                aria-label={live ? 'Stop recording' : 'Record voiceover'}
                // A string on purpose: the vdom removes an attribute set to boolean false, and a
                // button with no `aria-pressed` at all is announced as a plain button.
                aria-pressed={String(live)}
                onClick={this.toggleRecording}
              >
                <span class="vo__record-core"></span>
              </button>

              {/*
                Both spans are siblings of the same tag and the first is conditional, so both carry
                a key: Stencil matches unkeyed same-tag siblings by position, and the dot appearing
                would otherwise turn the status text's element into the dot and leave the sentence
                with nowhere to go.
              */}
              <p class="vo__status">
                {phase === 'recording' ? <span class="vo__dot" aria-hidden="true" key="dot"></span> : null}
                <span key="status">{status}</span>
              </p>
              <p class="vo__hint">The original sound is muted in the preview while you record.</p>

              {takes > 0 ? (
                <div class="vo__takes" key="takes">
                  <span class="vo__takes-count">
                    {takes} {takes === 1 ? 'take' : 'takes'}
                  </span>
                  <span class="vo__takes-sep" aria-hidden="true"></span>
                  <button type="button" class="vo__delete" disabled={phase !== 'idle' || !lastTakeId} onClick={this.deleteLast}>
                    Delete last
                  </button>
                </div>
              ) : null}
            </div>

            <button type="button" role="switch" class="vo__mute" aria-checked={String(originalMuted)} onClick={this.toggleOriginalMuted}>
              <span class="vo__mute-label">Mute original sound in the video</span>
              <span class={{ 'vo__switch': true, 'vo__switch--on': originalMuted }} aria-hidden="true">
                <span class="vo__switch-knob"></span>
              </span>
            </button>
          </div>
        </ve-sheet>
      );
    });
  }
}

/* ------------------------------------------------------------------------------------------- */

/**
 * How long the recorder was on before it wrote its first sample, which is how far into the video the
 * take's sound really begins.
 *
 * Android's MediaRecorder opens the microphone, configures the encoder and writes the container
 * header before any audio reaches the file, so a take always comes back shorter than the microphone
 * was on - about 90 ms on the test phone. Placed at the button press, the whole take therefore ran
 * that much ahead of the frames the customer was speaking over. There is no callback for the first
 * sample, so the gap IS the measurement: the wall clock from the moment the host's `start()`
 * resolved to the moment `stop()` was called, less the length of the file that came back from
 * probing it.
 *
 * The wall clock stops before the stop is awaited, while the recorder is still writing, so the file
 * carries the stop's own latency at its end and this reads a little LESS than the true warm-up.
 * Under-shifting leaves the take a few ms early, which is the safe side of a cut.
 *
 * @param fileMs 0 when the file could not be probed, and then there is nothing to compare.
 */
function leadInMs(wallMs: number, fileMs: number): number {
  if (fileMs <= 0) return 0;
  return Math.round(clamp(wallMs - fileMs, 0, MAX_LEAD_IN_MS));
}

/** `00:03` - rounded down, like the transport's clock, so both always agree. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** `00:02.4` */
function clockTenths(ms: number): string {
  return `${clock(ms)}.${Math.floor(Math.max(0, ms) / 100) % 10}`;
}

/**
 * What a rejected recorder call calls itself.
 *
 * The shape is the host's, not the package's: `EditorVoiceHost` says nothing about how a start
 * fails, and it cannot - a Capacitor host rejects with a native `code` on the error, a browser
 * MediaRecorder host rejects with a `DOMException` whose `name` and `message` carry it, and a host
 * of either kind may simply reject with a string. So this sniffs rather than reads, and every
 * caller treats what it returns as a word to look in, never as a value to switch on.
 */
function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/** `permission_denied`, or a message that says as much from a path that sets no code. */
function isPermissionError(error: unknown): boolean {
  return /permission/i.test(errorCode(error)) || /permission/i.test(String(error));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
