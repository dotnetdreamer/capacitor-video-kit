import { computed, signal } from '@preact/signals-core';
import {
  DEFAULT_OUTPUT,
  MAX_LAYERS,
  MAX_VIDEO_TRACKS,
  MIN_LAYER_MS,
  addOverlay,
  addVideoTrack,
  addVoiceover,
  applyLayoutPreset,
  canJoinWithNext,
  clipsDurationMs,
  cssFor,
  duplicateClip,
  duplicateOverlay,
  emptyManifest,
  findClip,
  findOverlay,
  findVideoTrack,
  findVoiceover,
  joinWithNext,
  moveClip,
  moveClipToTrack,
  moveLayer,
  moveVoiceover,
  neutralAdjust,
  patchClip,
  patchMusic,
  patchOverlay,
  patchVoiceover,
  removeClip,
  removeOverlay,
  removeVideoTrack,
  removeVoiceover,
  resetClipFraming,
  resolveFilterOps,
  setClipSpeed,
  setOverlayWindow,
  setTrackOpacity,
  setTrackStart,
  setPostDuration,
  slotAt,
  sourceMsAt,
  splitClipAt,
  splitOverlayAt,
  swapTrackZ,
  timelineSlots,
  totalDurationMs,
  trackIdOfClip,
  trimClip,
  uniqueClipKeys,
  type ClipDropTarget,
  type ClipFramingPatch,
  type EditAdjust,
  type EditClip,
  type EditFit,
  type EditManifest,
  type EditMusic,
  type EditOverlay,
  type EditPlacement,
  type EditRect,
  type EditVoiceover,
  type EffectOverlay,
  type ImageOverlay,
  type LayerMove,
  type LayoutPresetId,
  type StickerOverlay,
  type TextOverlay,
  type TimelineSlot,
} from '../editor';

import type { EditorSource, HapticKind, ResolvedEditorHost } from '../host/host.types';
import type {
  EditorPanel,
  EditorPlayer,
  EditorSelection,
  Filmstrip,
  OverlayBitmap,
  ToolbarMode,
  VolumeTarget,
} from './editor.types';

interface HistoryEntry {
  manifest: EditManifest;
  label: string;
}

const HISTORY_LIMIT = 50;

/**
 * One layer of video under the playhead, as the preview has to draw it.
 *
 * This is the whole of what a second video track means to anything that shows the edit: which
 * segment of which source is on screen, where in that file the playhead lands, and the rectangle
 * the picture goes in. A post with one video gives one of these, holding exactly what the preview
 * drew before tracks existed, so the drawing code has one path and not two.
 */
export interface PreviewVideoLayer {
  /** Null is the base track. */
  trackId: string | null;
  clipId: string;
  clipKey: string;
  /** Where in the SOURCE file this playhead lands, trim and speed already applied. */
  sourceMs: number;
  /**
   * Where the picture goes and the angle it is turned to. Null is the whole frame standing upright,
   * which is what every post before this was.
   */
  rect: EditPlacement | null;
  crop: EditRect | null;
  fit: EditFit;
  opacity: number;
  z: number;
}

/**
 * The editor's single source of truth, created by the editor shell so every piece of the screen -
 * preview, timeline, toolbar, sheets - reads and changes the same state.
 *
 * Two kinds of change go through here:
 *  - `commit(label, fn)` for a finished action (split, delete, a filter tapped). One undo step.
 *  - `beginGesture()` / `preview(fn)` / `endGesture(label)` for anything continuous (dragging a trim
 *    handle, a slider, a pinch). The manifest follows the finger live, and the whole gesture lands
 *    as ONE undo step when it ends - or none, if nothing actually changed.
 *
 * Every manifest change is a pure function from `choisy-video-kit`'s edit ops, so snapshots are
 * shared by reference and undo is just putting an older object back.
 *
 * The high-level actions (`splitAtPlayhead`, `deleteSelection`, ...) live here rather than in the
 * toolbar because the toolbar, the preview's handles and the timeline all trigger the same ones.
 *
 * One store per editor, created by the editor shell and handed down as a plain object. Nothing
 * reads a module level instance, which is also what keeps two copies of the signals library in one
 * dependency tree from silently breaking every repaint.
 */
export class EditorStore {
  /**
   * The store itself only asks the host for haptics; everything else it does is arithmetic over the
   * manifest. It is public because it is also how the components reach the host at all: the preview
   * and the timeline need `platform.fileUrl` for a local file, the text sheet needs the keyboard
   * stream, the voiceover sheet needs the recorder, and the shell needs `confirm`, the back handler
   * and the inset measurement. Reaching them through the store they already hold is what keeps
   * `@capacitor/core` out of every component in this package.
   */
  constructor(readonly host: ResolvedEditorHost) {}

  /* -- host clips -------------------------------------------------------------------------- */

  /** Every source clip the edit may use, by the host's own `key`. */
  readonly clips = signal<EditorSource[]>([]);
  /** Source duration per clip key. */
  readonly durations = signal<ReadonlyMap<string, number>>(new Map());
  /** Filmstrip frames per clip key, filled in as they are cut. */
  readonly filmstrips = signal<ReadonlyMap<string, Filmstrip>>(new Map());
  readonly maxClips = signal(10);

  /* -- the edit ---------------------------------------------------------------------------- */

  readonly manifest = signal<EditManifest>(emptyManifest());
  /** The manifest the editor opened with, for "discard your edits?". */
  private readonly opened = signal<EditManifest>(emptyManifest());
  readonly dirty = computed(() => this.manifest.value !== this.opened.value);

  private readonly past = signal<HistoryEntry[]>([]);
  private readonly future = signal<HistoryEntry[]>([]);
  private gestureStart: EditManifest | null = null;
  readonly canUndo = computed(() => this.past.value.length > 0);
  readonly canRedo = computed(() => this.future.value.length > 0);
  /**
   * History is frozen while a voiceover take is running, and the transport greys its arrows to say
   * so. An undo mid-take put an older manifest back - taking the take before it off the timeline -
   * and the take that then landed pushed a step of its own, which cleared the redo stack the
   * deleted take was sitting in. It was gone for good, from a button that looks like it undoes.
   */
  readonly historyLocked = computed(() => this.recordingFromMs.value !== null);

  /* -- derived ----------------------------------------------------------------------------- */

  readonly slots = computed(() => timelineSlots(this.manifest.value));
  /** How long the post runs: the base track, or the tail the customer has pulled past it. */
  readonly totalMs = computed(() => totalDurationMs(this.manifest.value));
  /**
   * Where the base track's footage ends. The same number as [totalMs] for a post nobody has
   * stretched, and the start of the black tail for one somebody has.
   */
  readonly baseMs = computed(() => clipsDurationMs(this.manifest.value.clips));
  readonly filterOps = computed(() => resolveFilterOps(this.manifest.value));
  /** `filter` for the `<video>` and the tint layers drawn over it, in order. */
  readonly previewCss = computed(() => cssFor(this.filterOps.value));
  readonly layerCount = computed(() => this.manifest.value.overlays.length);
  readonly layersFull = computed(() => this.layerCount.value >= MAX_LAYERS);
  /**
   * Counted over the sources the edit still USES: a replaced clip stays in `clips` so undo can bring
   * it back, but it is not on the post and must not use up a slot.
   */
  readonly canAddClip = computed(() => uniqueClipKeys(this.manifest.value).length < this.maxClips.value);

  /**
   * Every extra video layer, NEAREST THE BASE TRACK FIRST - the order the timeline draws its rows
   * in, top to bottom, and the drawing order back to front.
   *
   * Sorted rather than taken as it comes, because `z` is what the render reads and the array order
   * is only ever a reflection of it. The two agree everywhere the ops touch them; sorting is what
   * keeps a hand-built manifest from drawing its rows in one order and its frame in another.
   */
  readonly videoTrackRows = computed(() => [...this.manifest.value.videoTracks].sort((a, b) => a.z - b.z));
  /** The layer nearest the base track, or null while the post is the one video it opened as. */
  readonly videoTrack = computed(() => this.videoTrackRows.value[0] ?? null);
  /**
   * The layer the Layout sheet arranges: the one the selected segment is on, or the layer nearest
   * the base track when the selection is elsewhere.
   *
   * [videoTrack] was that answer while a post could hold one layer over the base. With several it is
   * a sheet quietly arranging a layer the customer is not looking at, which is the wrong kind of
   * surprise for a tool whose whole job is where the pictures go.
   */
  readonly layoutTrack = computed(() => {
    const selected = this.selectedClipTrackId.value;
    const rows = this.videoTrackRows.value;
    return (selected ? rows.find((track) => track.id === selected) : null) ?? rows[0] ?? null;
  });
  /**
   * Whether another video layer would go past [MAX_VIDEO_TRACKS], which counts the base track. The
   * cap is there so an absurd edit fails with something readable rather than at the encoder, and it
   * is not an opinion about how many pictures belong on the frame.
   */
  readonly videoTracksFull = computed(() => this.manifest.value.videoTracks.length >= MAX_VIDEO_TRACKS - 1);

  /**
   * Every video layer under the playhead, BOTTOM TO TOP by `z` - the list the preview draws and the
   * render composes, in the same order. There is always at least one entry while a clip is under the
   * playhead, and for a post with one video there is exactly one, holding what the preview has drawn
   * all along.
   *
   * A track contributes nothing at all before it starts, nothing after it ends, and nothing past the
   * end of the base track, which is the length of the post: in all three cases the base simply shows
   * through, which is what the render does too. Rebuilt on every playhead write, because `sourceMs`
   * genuinely moves with it - a reader that only cares where the pictures sit should compare on the
   * other fields, the way the preview's own `shownClip` already does.
   */
  readonly previewLayers = computed<PreviewVideoLayer[]>(() => {
    const m = this.manifest.value;
    const at = this.playheadMs.value;
    const total = this.totalMs.value;
    const layers: PreviewVideoLayer[] = [];

    // Past the base track's last frame there is no base picture: the frame is black, and whatever
    // layer is over it is drawn on black. `slotAt` holds the last segment at the very end of the
    // timeline on purpose - a paused customer looking at the final frame has to see one - so the
    // tail is the one place that rule has to be answered here rather than there.
    const baseLen = clipsDurationMs(m.clips);
    const base = at < baseLen || total <= baseLen ? slotAt(m, at) : null;
    if (base) layers.push(this.previewLayer(null, base, at, 1, 0));

    for (const track of m.videoTracks) {
      const into = at - track.startMs;
      if (into < 0) continue;
      const cut = Math.min(totalDurationMs({ clips: track.clips }), total - track.startMs);
      if (cut <= 0) continue;
      // The last instant of the post belongs to whatever is on screen at it - the rule `slotAt`
      // already holds for the base track's final segment. Without it a layer running to the end
      // would blink out on exactly the frame a paused customer is looking at.
      if (into >= cut && !(at >= total && track.startMs + cut >= total)) continue;
      const slot = slotAt({ clips: track.clips }, into);
      if (slot) layers.push(this.previewLayer(track.id, slot, into, track.opacity, track.z));
    }

    // Stable, so the base track stays under a layer that shares its `z` - array order breaks a tie
    // here exactly as it does in the native engines.
    return layers.sort((a, b) => a.z - b.z);
  });

  /** One layer of [previewLayers]. `outputMs` is on the layer's OWN timeline, not the post's. */
  private previewLayer(
    trackId: string | null,
    slot: TimelineSlot,
    outputMs: number,
    opacity: number,
    z: number,
  ): PreviewVideoLayer {
    const clip = slot.clip;
    return {
      trackId,
      clipId: clip.id,
      clipKey: clip.clipKey,
      sourceMs: sourceMsAt(slot, outputMs),
      // Absence is carried through rather than defaulted away, for the same reason the manifest
      // keeps the keys missing: "the whole frame" has to stay tellable from "a rectangle".
      rect: clip.rect ?? null,
      crop: clip.crop ?? null,
      fit: this.clipFit(clip),
      opacity,
      z,
    };
  }

  /* -- selection and chrome ---------------------------------------------------------------- */

  readonly selection = signal<EditorSelection | null>(null);
  readonly panel = signal<EditorPanel | null>(null);
  readonly toolbarMode = signal<ToolbarMode>('root');
  /** The Sound tool's little menu (Add sound / Sound effect / Voiceover). */
  readonly soundMenuOpen = signal(false);
  /** What the volume sheet is adjusting while it is open. */
  readonly volumeTarget = signal<VolumeTarget | null>(null);
  /** The text layer the text sheet is editing, and whether it was created by this edit. */
  readonly textEdit = signal<{ id: string; isNew: boolean } | null>(null);
  readonly fullscreen = signal(false);
  /** Timeline zoom: pixels per second of OUTPUT time. */
  readonly pps = signal(64);

  readonly selectedClip = computed(() => {
    const sel = this.selection.value;
    return sel?.kind === 'clip' ? findClip(this.manifest.value, sel.id) : null;
  });
  readonly selectedOverlay = computed(() => {
    const sel = this.selection.value;
    return sel?.kind === 'overlay' ? findOverlay(this.manifest.value, sel.id) : null;
  });
  readonly selectedVoice = computed(() => {
    const sel = this.selection.value;
    return sel?.kind === 'voice' ? findVoiceover(this.manifest.value, sel.id) : null;
  });
  readonly musicSelected = computed(() => this.selection.value?.kind === 'music' && !!this.manifest.value.music);
  readonly canJoinSelected = computed(() => {
    const clip = this.selectedClip.value;
    return !!clip && canJoinWithNext(this.manifest.value, clip.id);
  });
  /**
   * Which layer the selected segment is on: null for the base track, otherwise the second video's
   * id. The tools a segment gets differ between the two, because split, join, duplicate and reorder
   * all rearrange the base track's `clips` and have nothing to rearrange on a layer holding one clip.
   */
  readonly selectedClipTrackId = computed<string | null>(() => {
    const clip = this.selectedClip.value;
    if (!clip) return null;
    const trackId = trackIdOfClip(this.manifest.value, clip.id);
    return typeof trackId === 'string' ? trackId : null;
  });

  /* -- playback ---------------------------------------------------------------------------- */

  /** Playhead on the OUTPUT timeline. Written by the player; everyone else calls `seek`. */
  readonly playheadMs = signal(0);
  readonly playing = signal(false);
  /** Set while a voiceover take is being recorded: where it started. */
  readonly recordingFromMs = signal<number | null>(null);
  private player: EditorPlayer | null = null;

  /* -- layer bitmaps ----------------------------------------------------------------------- */

  /** Rasterised layers by overlay id, kept current by `OverlayBitmapService`. */
  readonly bitmaps = signal<ReadonlyMap<string, OverlayBitmap>>(new Map());

  /* -- the picture on screen --------------------------------------------------------------- */

  /**
   * The playing clip's oriented width / height, written by the preview from the `<video>` element's
   * metadata and 0 until the first clip has any. It lives here rather than in the preview because
   * crop is the one tool that has to know the shape of the source: the crop sheet turns "1:1" into
   * a fraction of THIS source, and the gestures measure a pan against it. Nothing writes it but the
   * preview, and it is not part of the edit - it is a property of the file, not of the manifest.
   */
  readonly sourceAspect = signal(0);

  /* -- feedback ---------------------------------------------------------------------------- */

  readonly toast = signal<{ id: number; text: string } | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private idCounter = 0;
  /** Whether the "hold a clip to move it" hint has already been said; it is worth saying once. */
  private reorderHinted = false;

  /* ========================================================================================= */
  /* Setup                                                                                     */
  /* ========================================================================================= */

  /** Called once by the shell when clips, durations and the reconciled manifest are ready. */
  load(clips: EditorSource[], durations: ReadonlyMap<string, number>, manifest: EditManifest): void {
    this.clips.value = clips;
    this.durations.value = durations;
    this.manifest.value = manifest;
    this.opened.value = manifest;
    this.past.value = [];
    this.future.value = [];
  }

  attachPlayer(player: EditorPlayer | null): void {
    this.player = player;
  }

  newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${(this.idCounter++).toString(36)}`;
  }

  clipByKey(key: string): EditorSource | undefined {
    return this.clips.value.find((clip) => clip.key === key);
  }

  sourceDurationMs(clipKey: string): number {
    return this.durations.value.get(clipKey) ?? 0;
  }

  /* ========================================================================================= */
  /* History                                                                                   */
  /* ========================================================================================= */

  /**
   * Applies a finished change as one undo step. `fn` may return the same manifest (nothing to do)
   * or null (not possible), and neither touches the history. Returns whether anything changed.
   */
  commit(label: string, fn: (m: EditManifest) => EditManifest | null): boolean {
    this.flushGesture();
    const before = this.manifest.value;
    const after = fn(before);
    if (!after || after === before) return false;
    this.pushHistory(before, label);
    this.manifest.value = after;
    return true;
  }

  /** Starts a continuous change. Safe to call twice; the first snapshot wins. */
  beginGesture(): void {
    if (!this.gestureStart) this.gestureStart = this.manifest.value;
  }

  /** A live step of a gesture. Starts one if none is running. */
  preview(fn: (m: EditManifest) => EditManifest | null): void {
    this.beginGesture();
    const next = fn(this.manifest.value);
    if (next && next !== this.manifest.value) this.manifest.value = next;
  }

  /**
   * Ends a gesture as one undo step, or as nothing when the manifest ended where it began.
   *
   * "Where it began" is a matter of value, not identity. A slider dragged away and back, or a trim
   * handle returned to its edge, rebuilds the manifest on every step and ends on an object that is
   * new but equal to the snapshot - recorded, that is an undo step which undoes nothing. The snapshot
   * itself is put back, so `dirty` (an identity check) does not light up for an editor left untouched.
   */
  endGesture(label: string): void {
    const start = this.gestureStart;
    this.gestureStart = null;
    if (!start || start === this.manifest.value) return;
    if (sameValue(start, this.manifest.value)) {
      this.manifest.value = start;
      return;
    }
    this.pushHistory(start, label);
  }

  /** Throws a gesture away, putting back the manifest it started from. */
  cancelGesture(): void {
    const start = this.gestureStart;
    this.gestureStart = null;
    if (start) this.manifest.value = start;
  }

  undo(): void {
    if (this.refuseWhileRecording()) return;
    this.flushGesture();
    const entry = this.past.value.at(-1);
    if (!entry) return;
    this.past.value = this.past.value.slice(0, -1);
    this.future.value = [...this.future.value, { manifest: this.manifest.value, label: entry.label }];
    this.manifest.value = entry.manifest;
    this.afterHistoryJump();
    this.showToast(`Undo: ${entry.label}`);
    this.haptic('light');
  }

  redo(): void {
    if (this.refuseWhileRecording()) return;
    this.flushGesture();
    const entry = this.future.value.at(-1);
    if (!entry) return;
    this.future.value = this.future.value.slice(0, -1);
    this.past.value = [...this.past.value, { manifest: this.manifest.value, label: entry.label }];
    this.manifest.value = entry.manifest;
    this.afterHistoryJump();
    this.showToast(`Redo: ${entry.label}`);
    this.haptic('light');
  }

  /**
   * Whether a history jump has to be refused, having said so. The buttons are greyed while a take
   * is running, so this only catches the ways in that are not the buttons - a hardware key, a
   * gesture, a tap that landed as the take started.
   */
  private refuseWhileRecording(): boolean {
    if (!this.historyLocked.value) return false;
    this.showToast('Stop recording first');
    this.haptic('warning');
    return true;
  }

  private pushHistory(manifest: EditManifest, label: string): void {
    this.past.value = [...this.past.value, { manifest, label }].slice(-HISTORY_LIMIT);
    this.future.value = [];
  }

  /** A gesture left open (a slider still held when a button is tapped) is closed as its own step. */
  private flushGesture(): void {
    if (this.gestureStart) this.endGesture('Change');
  }

  private afterHistoryJump(): void {
    const sel = this.selection.value;
    const m = this.manifest.value;
    const stillThere =
      !sel ||
      (sel.kind === 'clip' && !!findClip(m, sel.id)) ||
      (sel.kind === 'overlay' && !!findOverlay(m, sel.id)) ||
      (sel.kind === 'voice' && !!findVoiceover(m, sel.id)) ||
      (sel.kind === 'music' && !!m.music);
    if (!stillThere) this.select(null);
    if (this.playheadMs.value > this.totalMs.value) this.seek(this.totalMs.value);
  }

  /* ========================================================================================= */
  /* Selection and chrome                                                                      */
  /* ========================================================================================= */

  select(selection: EditorSelection | null): void {
    this.selection.value = selection;
    this.soundMenuOpen.value = false;
    if (selection) this.toolbarMode.value = 'root';
    // A sheet that was about the old selection makes no sense for the new one.
    const panel = this.panel.value;
    if (panel === 'speed' || panel === 'volume' || panel === 'opacity' || panel === 'crop') this.closePanel();
  }

  isSelected(selection: EditorSelection): boolean {
    const sel = this.selection.value;
    if (!sel || sel.kind !== selection.kind) return false;
    return sel.kind === 'music' || (sel as { id: string }).id === (selection as { id: string }).id;
  }

  openPanel(panel: EditorPanel | null): void {
    this.soundMenuOpen.value = false;
    this.panel.value = panel;
  }

  closePanel(): void {
    this.panel.value = null;
    this.volumeTarget.value = null;
  }

  openVolume(target: VolumeTarget): void {
    this.volumeTarget.value = target;
    this.openPanel('volume');
  }

  /** The "Edit" tool: selects the segment under the playhead. */
  selectClipAtPlayhead(): void {
    const slot = slotAt(this.manifest.value, this.playheadMs.value);
    if (slot) this.select({ kind: 'clip', id: slot.clip.id });
  }

  /* ========================================================================================= */
  /* Playback                                                                                  */
  /* ========================================================================================= */

  seek(outputMs: number): void {
    const ms = Math.max(0, Math.min(this.totalMs.value, outputMs));
    if (this.player) this.player.seek(ms);
    else this.playheadMs.value = ms;
  }

  play(): void {
    this.player?.play();
  }

  pause(): void {
    this.player?.pause();
  }

  togglePlay(): void {
    if (this.playing.value) this.pause();
    else this.play();
  }

  /* ========================================================================================= */
  /* Clips                                                                                     */
  /* ========================================================================================= */

  /** Splits the selected segment at the playhead, or the one under it when nothing is selected. */
  splitAtPlayhead(): void {
    const newId = this.newId('seg');
    const at = this.playheadMs.value;
    const ok = this.commit('Split', (m) => splitClipAt(m, at, newId));
    if (!ok) {
      this.showToast('Move the playhead further into the clip to split it');
      this.haptic('warning');
      return;
    }
    this.select({ kind: 'clip', id: newId });
    this.haptic('light');
    // Two halves can be carried past each other, but only a long press lifts one and nothing on the
    // timeline says so. A split always leaves more than one segment, so this is the moment to say it
    // - once an edit, on the first one.
    if (!this.reorderHinted) {
      this.reorderHinted = true;
      this.showToast('Hold a clip to move it', 2200);
    }
  }

  duplicateSelectedClip(): void {
    const clip = this.selectedClip.value;
    if (!clip) return;
    const newId = this.newId('seg');
    if (this.commit('Duplicate', (m) => duplicateClip(m, clip.id, newId))) {
      this.select({ kind: 'clip', id: newId });
      this.haptic('light');
    }
  }

  deleteSelectedClip(): void {
    const clip = this.selectedClip.value;
    if (!clip) return;
    // The LAST segment of a layer takes the layer with it, and the arrangement that layer was part
    // of has to go in the same undo step: a base left in half the frame with nothing beside it is a
    // black band nobody asked for. `removeVideoTrack` is the one call that knows a split screen is
    // being ended rather than edited, so the delete is handed to it.
    const trackId = this.selectedClipTrackId.value;
    if (trackId && findVideoTrack(this.manifest.value, trackId)?.clips.length === 1) {
      this.removeVideoTrack(trackId);
      return;
    }
    if (!this.commit('Delete', (m) => removeClip(m, clip.id))) {
      this.showToast('A video needs at least one clip');
      this.haptic('warning');
      return;
    }
    this.select(null);
    this.haptic('light');
  }

  joinSelectedWithNext(): void {
    const clip = this.selectedClip.value;
    if (clip && this.commit('Join', (m) => joinWithNext(m, clip.id))) this.haptic('light');
  }

  moveClipTo(clipId: string, toIndex: number): void {
    if (this.commit('Reorder', (m) => moveClip(m, clipId, toIndex))) this.haptic('light');
  }

  /** Live trim from a handle; wrap in begin/endGesture('Trim'). */
  previewTrim(clipId: string, inMs: number, outMs: number): void {
    const clip = findClip(this.manifest.value, clipId);
    if (!clip) return;
    const source = this.sourceDurationMs(clip.clipKey);
    this.preview((m) => trimClip(m, clipId, inMs, outMs, source));
  }

  setClipSpeed(clipId: string, speed: number, live = false): void {
    if (live) this.preview((m) => setClipSpeed(m, clipId, speed));
    else this.commit('Speed', (m) => setClipSpeed(m, clipId, speed));
  }

  patchClip(clipId: string, patch: Parameters<typeof patchClip>[2], label: string, live = false): void {
    if (live) this.preview((m) => patchClip(m, clipId, patch));
    else this.commit(label, (m) => patchClip(m, clipId, patch));
  }

  toggleOriginalMuted(): void {
    const muted = !this.manifest.value.originalMuted;
    this.commit(muted ? 'Mute original sound' : 'Unmute original sound', (m) => ({ ...m, originalMuted: muted }));
    this.showToast(muted ? 'Original sound off' : 'Original sound on');
    this.haptic('light');
  }

  toggleFit(): void {
    const fit = this.manifest.value.fit === 'cover' ? 'contain' : 'cover';
    this.commit(fit === 'cover' ? 'Fill frame' : 'Fit frame', (m) => ({ ...m, fit }));
  }

  /* ========================================================================================= */
  /* Framing: crop and where a clip sits on the frame                                          */
  /* ========================================================================================= */

  /**
   * The segment the crop tool is working on: whatever is selected, or the one under the playhead.
   * Crop is a per-segment thing, so the tool always has a segment even when the customer reached it
   * from the root row without selecting anything first.
   */
  readonly cropClip = computed(() => this.selectedClip.value ?? slotAt(this.manifest.value, this.playheadMs.value)?.clip ?? null);

  /** The fit the given segment is drawn with: its own, or the whole post's. */
  clipFit(clip: { fit?: EditFit } | null | undefined): EditFit {
    return clip?.fit ?? this.manifest.value.fit;
  }

  /** Opens the crop sheet on the segment under the playhead, selecting it so the tools agree. */
  openCrop(): void {
    const clip = this.cropClip.value;
    if (!clip) return;
    this.pause();
    if (!this.isSelected({ kind: 'clip', id: clip.id })) this.select({ kind: 'clip', id: clip.id });
    this.openPanel('crop');
  }

  /**
   * A live change to how a segment is framed - a pan, a pinch, a ratio tapped. Wrap in
   * begin/endGesture: one continuous gesture is one undo step, as every other drag is.
   */
  previewClipFraming(clipId: string, patch: ClipFramingPatch): void {
    this.preview((m) => patchClip(m, clipId, patch));
  }

  commitClipFraming(clipId: string, patch: ClipFramingPatch, label: string): void {
    this.commit(label, (m) => patchClip(m, clipId, patch));
  }

  /** Back to the whole source over the whole frame: the crop sheet's Reset. */
  resetClipFraming(clipId: string): void {
    if (this.commit('Reset crop', (m) => resetClipFraming(m, clipId))) this.haptic('light');
  }

  /* ========================================================================================= */
  /* The second video                                                                          */
  /* ========================================================================================= */

  /**
   * Puts a second video on the frame, `clip` being the whole of its layer, and selects it. Returns
   * the new layer's id, or null when there is no room for one.
   *
   * The layer arrives covering the frame, as the op leaves it, so both pictures are already on
   * screen for whichever arrangement the customer reaches for next.
   */
  addVideoTrack(clip: EditClip): string | null {
    if (this.videoTracksFull.value) {
      this.showToast(`You can have ${MAX_VIDEO_TRACKS} videos on screen at once`);
      this.haptic('warning');
      return null;
    }
    const id = this.newId('vt');
    if (!this.commit('Add video', (m) => addVideoTrack(m, clip, id))) return null;
    this.select({ kind: 'clip', id: clip.id });
    this.haptic('light');
    return id;
  }

  /**
   * Takes the second video off, leaving the post the single layer it was.
   *
   * The arrangement goes with it, in the same undo step. [removeVideoTrack] deliberately leaves the
   * base track wherever a layout put it - it cannot tell a rectangle a preset wrote from one the
   * customer set by hand in the crop tool - so ending the arrangement is the caller's to say, and
   * this caller is the one place that knows a split screen is being ended rather than edited. A
   * base left in half the frame with nothing beside it is a black band nobody asked for.
   */
  removeVideoTrack(trackId: string): void {
    if (!this.commit('Remove video', (m) => removeVideoTrack(applyLayoutPreset(m, trackId, 'full'), trackId))) return;
    this.closePanel();
    this.select(null);
    this.haptic('light');
  }

  /**
   * Carries a segment off the layer it is on and onto another, or onto a layer of its own opened
   * between two rows - the drop that ends a long press dragged down the timeline.
   *
   * `atMs` is where the segment was let go on the output timeline. A new layer keeps it; a layer
   * that is already there is a sequence with no gaps in it, so the drop lands on the nearest
   * boundary instead. Returns whether anything moved.
   */
  moveClipToTrack(clipId: string, target: ClipDropTarget, atMs: number): boolean {
    const m = this.manifest.value;
    if (trackIdOfClip(m, clipId) === null && m.clips.length <= 1) {
      this.showToast('A video needs at least one clip');
      this.haptic('warning');
      return false;
    }
    if (target.kind === 'new' && this.videoTracksFull.value && !this.aloneOnItsLayer(clipId)) {
      this.showToast(`You can have ${MAX_VIDEO_TRACKS} videos on screen at once`);
      this.haptic('warning');
      return false;
    }
    const newTrackId = this.newId('vt');
    if (!this.commit('Move to layer', (mm) => moveClipToTrack(mm, clipId, target, atMs, newTrackId))) return false;
    this.select({ kind: 'clip', id: clipId });
    this.haptic('light');
    return true;
  }

  /**
   * Whether this segment is the whole of the layer it is on, so carrying it off takes the layer
   * with it. Such a move needs no room at the cap: one layer goes as another arrives.
   */
  private aloneOnItsLayer(clipId: string): boolean {
    const trackId = trackIdOfClip(this.manifest.value, clipId);
    if (typeof trackId !== 'string') return false;
    return findVideoTrack(this.manifest.value, trackId)?.clips.length === 1;
  }

  /**
   * Pulls the end of the post past the base track, or lets it back in. Live; wrap in
   * begin/endGesture, which is what the ruler's end handle does.
   *
   * The playhead comes back inside the post when the end is pulled in past it, the way a swap that
   * shortens the post already brings it back: a playhead past the end is a preview showing a frame
   * the video no longer has.
   */
  setPostDuration(durationMs: number, live = false): void {
    const fn = (m: EditManifest): EditManifest => setPostDuration(m, durationMs);
    if (live) this.preview(fn);
    else if (!this.commit('Length', fn)) return;
    if (this.playheadMs.value > this.totalMs.value) this.seek(this.totalMs.value);
  }

  /** Where the second video lands on the output timeline. Live; wrap in begin/endGesture. */
  setTrackStart(trackId: string, startMs: number, live = false): void {
    const fn = (m: EditManifest): EditManifest => setTrackStart(m, trackId, Math.max(0, Math.round(startMs)));
    if (live) this.preview(fn);
    else this.commit('Move video', fn);
  }

  /** Live; wrap in begin/endGesture('Opacity'). */
  setTrackOpacity(trackId: string, opacity: number, live = false): void {
    const value = Math.max(0, Math.min(1, opacity));
    const fn = (m: EditManifest): EditManifest => setTrackOpacity(m, trackId, value);
    if (live) this.preview(fn);
    else this.commit('Opacity', fn);
  }

  /**
   * Swaps which of the two videos is drawn on top of the other.
   *
   * The op does it by exchanging the layers' clips, and the BASE track's length is the length of the
   * post - so a swap that puts a short video underneath shortens the whole thing. That is said out
   * loud rather than left to be discovered on the timeline, and the playhead comes back inside the
   * video it is now past the end of.
   */
  swapTrackZ(trackId: string): void {
    const before = this.totalMs.value;
    if (!this.commit('Swap videos', (m) => swapTrackZ(m, trackId))) return;
    this.haptic('light');
    const after = this.totalMs.value;
    if (this.playheadMs.value > after) this.seek(after);
    if (Math.abs(after - before) > 100) this.showToast(`Your video is now ${(after / 1000).toFixed(1)}s`);
  }

  /**
   * A layout: split screen, a corner inset, or both videos back over the whole frame. It is nothing
   * but a pair of rectangles written onto the clips of the two layers, which is why there is no
   * geometry of its own here - the preset holds it and every engine already draws rectangles.
   */
  applyLayoutPreset(trackId: string, presetId: LayoutPresetId, label: string): void {
    if (this.commit(`Layout ${label}`, (m) => applyLayoutPreset(m, trackId, presetId))) {
      this.haptic('selection');
    }
  }

  /* ========================================================================================= */
  /* Layers                                                                                    */
  /* ========================================================================================= */

  /**
   * Adds a layer from the playhead to the end, selects it, and returns its id - or null at the
   * layer cap, having told the customer why.
   */
  addLayer<T extends EditOverlay>(label: string, layer: Omit<T, 'id' | 'startMs' | 'endMs'> & Partial<Pick<T, 'startMs' | 'endMs'>>): string | null {
    if (this.layersFull.value) {
      this.showToast(`You can add up to ${MAX_LAYERS} layers`);
      this.haptic('warning');
      return null;
    }
    const id = this.newId(layer.kind);
    // Starting at the very end would make a layer nobody can see; start it at 0 instead.
    const at = this.playheadMs.value >= this.totalMs.value - 100 ? 0 : Math.round(this.playheadMs.value);
    const overlay = { startMs: at, endMs: 0, ...layer, id } as unknown as EditOverlay;
    if (!this.commit(label, (m) => addOverlay(m, overlay))) return null;
    this.select({ kind: 'overlay', id });
    this.haptic('light');
    return id;
  }

  addSticker(source: { emoji: string } | { assetId: string }): string | null {
    return this.addLayer<StickerOverlay>('Sticker', {
      kind: 'sticker',
      emoji: 'emoji' in source ? source.emoji : null,
      assetId: 'assetId' in source ? source.assetId : null,
      cx: 0.5,
      cy: 0.42,
      scale: 1,
      rotationDeg: 0,
      opacity: 1,
    });
  }

  addImage(uri: string, fileName: string, aspect: number): string | null {
    return this.addLayer<ImageOverlay>('Overlay', {
      kind: 'image',
      uri,
      fileName,
      aspect: aspect > 0 ? aspect : 1,
      cx: 0.5,
      cy: 0.5,
      scale: 1,
      rotationDeg: 0,
      opacity: 1,
    });
  }

  /** Effects cover the frame from the playhead to the end; their strength is the opacity. */
  addEffect(effectId: string, label: string): string | null {
    return this.addLayer<EffectOverlay>(label, {
      kind: 'effect',
      effectId,
      cx: 0.5,
      cy: 0.5,
      scale: 1,
      rotationDeg: 0,
      opacity: 1,
    });
  }

  /**
   * Opens the text sheet on a NEW text layer. The whole edit - creation, typing, styling - is one
   * gesture, so Cancel removes the layer without a trace and Done is a single undo step.
   */
  startNewText(): void {
    if (this.layersFull.value) {
      this.showToast(`You can add up to ${MAX_LAYERS} layers`);
      this.haptic('warning');
      return;
    }
    this.flushGesture();
    this.pause();
    this.beginGesture();
    const id = this.newId('text');
    const at = this.playheadMs.value >= this.totalMs.value - 100 ? 0 : Math.round(this.playheadMs.value);
    const overlay: TextOverlay = {
      id,
      kind: 'text',
      text: '',
      styleId: 'classic',
      color: '#ffffff',
      effect: 'shadow',
      align: 'center',
      cx: 0.5,
      cy: 0.45,
      scale: 1,
      rotationDeg: 0,
      opacity: 1,
      startMs: at,
      endMs: 0,
    };
    this.preview((m) => addOverlay(m, overlay));
    this.selection.value = { kind: 'overlay', id };
    this.textEdit.value = { id, isNew: true };
    this.openPanel('text');
  }

  /** Opens the text sheet on an existing text layer. */
  startEditText(id: string): void {
    const overlay = findOverlay(this.manifest.value, id);
    if (overlay?.kind !== 'text') return;
    this.flushGesture();
    this.pause();
    this.beginGesture();
    this.selection.value = { kind: 'overlay', id };
    this.textEdit.value = { id, isNew: false };
    this.openPanel('text');
  }

  /** Done: an empty text is not a layer anyone wants, so it goes. */
  finishText(): void {
    const edit = this.textEdit.value;
    if (!edit) return;
    const overlay = findOverlay(this.manifest.value, edit.id);
    if (overlay?.kind === 'text' && !overlay.text.trim()) {
      if (this.gestureStart && !findOverlay(this.gestureStart, edit.id)) {
        // The layer was born in this gesture, so putting the snapshot back removes it exactly.
        // Removing it instead leaves a manifest equal to the snapshot but not the same object - an
        // "Add text" undo step that undoes nothing.
        this.cancelText();
        return;
      }
      this.preview((m) => removeOverlay(m, edit.id));
      this.selection.value = null;
    }
    this.endGesture(edit.isNew ? 'Add text' : 'Edit text');
    this.textEdit.value = null;
    this.closePanel();
  }

  cancelText(): void {
    const edit = this.textEdit.value;
    if (!edit) return;
    this.cancelGesture();
    if (edit.isNew) this.selection.value = null;
    this.textEdit.value = null;
    this.closePanel();
  }

  /** A live change to a layer (drag, pinch, slider, typing); wrap in begin/endGesture. */
  previewOverlay(id: string, patch: Parameters<typeof patchOverlay>[2]): void {
    this.preview((m) => patchOverlay(m, id, patch));
  }

  commitOverlay(id: string, patch: Parameters<typeof patchOverlay>[2], label: string): void {
    this.commit(label, (m) => patchOverlay(m, id, patch));
  }

  /** Live move/trim of a layer's time window from the timeline; wrap in begin/endGesture. */
  previewOverlayWindow(id: string, startMs: number, endMs: number): void {
    const total = this.totalMs.value;
    this.preview((m) => setOverlayWindow(m, id, startMs, endMs, total));
  }

  duplicateSelectedOverlay(): void {
    const overlay = this.selectedOverlay.value;
    if (!overlay) return;
    const newId = this.newId(overlay.kind);
    if (this.commit('Duplicate', (m) => duplicateOverlay(m, overlay.id, newId))) {
      this.select({ kind: 'overlay', id: newId });
      this.haptic('light');
    } else if (this.layersFull.value) {
      this.showToast(`You can add up to ${MAX_LAYERS} layers`);
    }
  }

  deleteSelectedOverlay(): void {
    const overlay = this.selectedOverlay.value;
    if (!overlay) return;
    if (this.commit('Delete', (m) => removeOverlay(m, overlay.id))) {
      this.select(null);
      this.haptic('light');
    }
  }

  deleteOverlay(id: string): void {
    if (this.commit('Delete', (m) => removeOverlay(m, id))) {
      if (this.isSelected({ kind: 'overlay', id })) this.select(null);
      this.haptic('warning');
    }
  }

  splitSelectedOverlayAtPlayhead(): void {
    const overlay = this.selectedOverlay.value;
    if (!overlay) return;
    const newId = this.newId(overlay.kind);
    const total = this.totalMs.value;
    const at = this.playheadMs.value;
    if (this.commit('Split', (m) => splitOverlayAt(m, overlay.id, at, newId, total))) {
      this.select({ kind: 'overlay', id: newId });
      this.haptic('light');
    } else if (this.layersFull.value) {
      // A split makes a second layer, so at the cap it is refused however well the playhead is
      // placed - "move the playhead" would send the customer looking for a problem that is not there.
      this.showToast(`You can add up to ${MAX_LAYERS} layers`);
      this.haptic('warning');
    } else {
      this.showToast('Move the playhead inside the layer to split it');
      this.haptic('warning');
    }
  }

  moveSelectedLayer(move: LayerMove): void {
    const overlay = this.selectedOverlay.value;
    if (!overlay) return;
    const labels: Record<LayerMove, string> = {
      forward: 'Bring forward',
      backward: 'Send backward',
      front: 'Bring to front',
      back: 'Send to back',
    };
    if (this.commit(labels[move], (m) => moveLayer(m, overlay.id, move))) {
      this.haptic('light');
    } else {
      this.showToast(move === 'forward' || move === 'front' ? 'Already on top' : 'Already at the bottom');
    }
  }

  /**
   * Sets start or end of the selected layer to the playhead. A playhead on the far side of the other
   * edge (Start here after the layer has ended) moves the whole layer there with its length: pinning
   * the other edge instead squeezed it into a 100 ms sliver somewhere the playhead was not - off the
   * preview, and nothing like "start here".
   */
  setSelectedOverlayEdge(edge: 'start' | 'end'): void {
    const overlay = this.selectedOverlay.value;
    if (!overlay) return;
    const total = this.totalMs.value;
    const at = this.playheadMs.value;
    const end = overlay.endMs > 0 ? overlay.endMs : total;
    const length = end - overlay.startMs;
    const [s, e] =
      edge === 'start'
        ? at <= end - MIN_LAYER_MS
          ? [at, end]
          : [at, Math.min(total, at + length)]
        : at >= overlay.startMs + MIN_LAYER_MS
          ? [overlay.startMs, at]
          : [Math.max(0, at - length), at];
    this.commit(edge === 'start' ? 'Start here' : 'End here', (m) => setOverlayWindow(m, overlay.id, s, e, total));
  }

  /* ========================================================================================= */
  /* Colour                                                                                    */
  /* ========================================================================================= */

  setFilter(filterId: string): void {
    this.commit('Filter', (m) => (m.filterId === filterId ? m : { ...m, filterId, filterIntensity: 1 }));
  }

  /** Live; wrap in begin/endGesture('Filter strength'). */
  previewFilterIntensity(k: number): void {
    const filterIntensity = Math.max(0, Math.min(1, k));
    // The same object back for the same value, so a slider released where it started is no undo step.
    this.preview((m) => (m.filterIntensity === filterIntensity ? m : { ...m, filterIntensity }));
  }

  /** Live; wrap in begin/endGesture('Adjust'). */
  previewAdjust(key: keyof EditAdjust, value: number): void {
    const min = key === 'fade' ? 0 : -1;
    const v = Math.max(min, Math.min(1, value));
    this.preview((m) => (m.adjust[key] === v ? m : { ...m, adjust: { ...m.adjust, [key]: v } }));
  }

  resetAdjust(): void {
    this.commit('Reset adjust', (m) =>
      Object.values(m.adjust).every((v) => v === 0) ? m : { ...m, adjust: neutralAdjust() },
    );
  }

  /* ========================================================================================= */
  /* Sound                                                                                     */
  /* ========================================================================================= */

  setMusic(music: EditMusic, label = 'Add sound'): void {
    if (this.commit(label, (m) => ({ ...m, music }))) {
      this.select({ kind: 'music' });
      this.haptic('light');
    }
  }

  removeMusic(): void {
    if (this.commit('Remove sound', (m) => (m.music ? { ...m, music: null } : m))) this.select(null);
  }

  /** Live; wrap in begin/endGesture. */
  previewMusic(patch: Partial<EditMusic>): void {
    this.preview((m) => patchMusic(m, patch));
  }

  commitMusic(patch: Partial<EditMusic>, label: string): void {
    this.commit(label, (m) => patchMusic(m, patch));
  }

  /** Adds a recorded take where it was recorded. Returns false when there was no room for it. */
  addVoiceover(take: EditVoiceover): boolean {
    const total = this.totalMs.value;
    const ok = this.commit('Voiceover', (m) => addVoiceover(m, take, total));
    if (ok) {
      this.select({ kind: 'voice', id: take.id });
      this.haptic('success');
    }
    return ok;
  }

  removeSelectedVoice(): void {
    const take = this.selectedVoice.value;
    if (take && this.commit('Delete voiceover', (m) => removeVoiceover(m, take.id))) this.select(null);
  }

  /** Live; wrap in begin/endGesture('Move voiceover'). */
  previewMoveVoice(id: string, startMs: number): void {
    const total = this.totalMs.value;
    this.preview((m) => moveVoiceover(m, id, startMs, total));
  }

  /** Sets a volume live (slider) or as a step, for whatever [VolumeTarget] names. 0..1. */
  setVolume(target: VolumeTarget, volume: number, live: boolean): void {
    const v = Math.max(0, Math.min(1, volume));
    const fn = (m: EditManifest): EditManifest => {
      switch (target.kind) {
        case 'clip':
          return patchClip(m, target.id, { volume: v, muted: v === 0 ? true : false });
        case 'music':
          return patchMusic(m, { volume: v });
        case 'voice':
          return patchVoiceover(m, target.id, { volume: v });
      }
    };
    if (live) this.preview(fn);
    else this.commit('Volume', fn);
  }

  /* ========================================================================================= */
  /* Delete / duplicate, whatever is selected                                                  */
  /* ========================================================================================= */

  deleteSelection(): void {
    const sel = this.selection.value;
    if (!sel) return;
    if (sel.kind === 'clip') this.deleteSelectedClip();
    else if (sel.kind === 'overlay') this.deleteSelectedOverlay();
    else if (sel.kind === 'music') this.removeMusic();
    else this.removeSelectedVoice();
  }

  /* ========================================================================================= */
  /* Feedback                                                                                  */
  /* ========================================================================================= */

  showToast(text: string, ms = 1600): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toast.value = { id: Date.now(), text };
    this.toastTimer = setTimeout(() => (this.toast.value = null), ms);
  }

  /** Haptics are a nicety: a phone without them, or a browser, just does nothing. */
  haptic(kind: HapticKind): void {
    this.host.platform.haptic(kind);
  }

  /** Output width in pixels, for sizing bitmaps in the preview. */
  readonly outputWidth = DEFAULT_OUTPUT.width;

  /**
   * Called by the shell when the editor leaves the document. Only the toast timer outlives the
   * element: it would fire into a store nothing is reading any more, which is harmless, and it
   * would keep that store alive until it did, which is not.
   */
  dispose(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.player = null;
  }
}

/**
 * Structural equality for manifests: plain objects, arrays and primitives, which is all a manifest
 * holds. Shared sub-objects (the edit ops keep everything they did not touch) short-circuit on
 * identity, so this only walks the parts a gesture rebuilt.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}
