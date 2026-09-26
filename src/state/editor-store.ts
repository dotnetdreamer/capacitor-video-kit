import { computed, effect, signal } from '@preact/signals-core';
import {
  DEFAULT_OUTPUT,
  aspectOf,
  qualityOf,
  sameOutput,
  type EditOutput,
  MAX_LAYERS,
  MAX_VIDEO_TRACKS,
  MAX_ZOOMS,
  MIN_LAYER_MS,
  DEFAULT_ZOOM_MS,
  DEFAULT_ZOOM_RAMP_MS,
  DEFAULT_ZOOM_SCALE,
  addZoom as addZoomOp,
  compileCamera,
  compileOverlayMotion,
  overlayWireWindow,
  type ComposeOverlayMotion,
  deleteZoom as deleteZoomOp,
  duplicateZoom as duplicateZoomOp,
  findZoom,
  setZoomWindow as setZoomWindowOp,
  updateZoom as updateZoomOp,
  type EditZoom,
  type ZoomPatch,
  addOverlay,
  addVideoTrack,
  addVoiceover,
  applyLayoutPreset,
  canJoinWithNext,
  clipsDurationMs,
  cssFor,
  duplicateClip,
  duplicateOverlay,
  cutPostTo,
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
  setAllTransitions,
  setClipTransition,
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
  transitionPreset,
  transitionWindowAt,
  trimClip,
  uniqueClipKeys,
  compileTransition,
  maxTransitionMs,
  DEFAULT_TRANSITION_MS,
  MIN_TRANSITION_MS,
  type CompiledTransition,
  type EditTransition,
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
  isOverlayVisibleAt,
  overlayAnimationPreset,
  overlayAnimationSpans,
  type OverlayAnimation,
  type OverlayAnimationPart,
  type OverlayLoop,
  type OverlayMove,
} from '../editor';

import type { EditorSource, HapticKind, ResolvedEditorHost } from '../host/host.types';
import { isPictureSource } from '../web-runtime/picture';
import type { Peaks } from '../web-runtime/waveform';
import type { EditorPanel, EditorPlayer, EditorSelection, Filmstrip, OverlayBitmap, ToolbarMode, VolumeTarget } from './editor.types';

/** One layer's compiled motion and the three things it was compiled from; see [EditorStore.overlayMotions]. */
interface CompiledMotion {
  animation: NonNullable<EditOverlay['animation']>;
  kind: EditOverlay['kind'];
  startMs: number;
  endMs: number;
  motion: ComposeOverlayMotion | null;
}

interface HistoryEntry {
  manifest: EditManifest;
  label: string;
}

/**
 * The name of one gesture's run of zoom steps, which [EditorStore.commitCoalesced] folds into one
 * undo step, and only ever made by [EditorStore.coalesceKey]. A string underneath, branded so that a
 * key a component makes up for itself - a template string off a counter of its own, which is how
 * three of them came to fold separate edits into one undo - is a type error rather than a bug found
 * on a phone.
 */
export type CoalesceKey = string & { readonly __brand: 'CoalesceKey' };

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
 * A transition on screen at the playhead, as the preview has to draw it: the incoming clip is the
 * base entry [EditorStore.previewLayers] already holds, and `from` is the outgoing clip's tail,
 * which plays under it for [durationMs] from [startMs].
 */
export interface PreviewTransition {
  /** The incoming clip, whose slot the playhead is in. */
  clipId: string;
  startMs: number;
  durationMs: number;
  /** 0..1 through the window at the playhead. */
  progress: number;
  /** The outgoing clip's tail at the playhead, drawn exactly as a base layer is. */
  from: PreviewVideoLayer;
  transition: CompiledTransition;
}

/**
 * One boundary of the base track, as the transition sheet shows it: the clips either side, what is
 * on it now, and how long a transition the two clips can hold.
 */
export interface TransitionBoundary {
  /** The incoming clip's id - the boundary's name everywhere, since that clip holds the transition. */
  clipId: string;
  /** Index of the incoming clip; the boundary is between clip `index` and clip `index + 1`, counting from 1. */
  index: number;
  from: EditClip;
  to: EditClip;
  /** What is stored, or null for a cut. */
  transition: EditTransition | null;
  /** How long it actually runs, after the clips either side have had their say. 0 for a cut. */
  effectiveMs: number;
  /** The longest transition this boundary can hold, rounded down to the slider's step. */
  maxMs: number;
  /** Where the boundary is on the output timeline: the incoming clip's slot start. */
  atMs: number;
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
 * Every manifest change is a pure function from `capacitor-video-kit`'s edit ops, so snapshots are
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
  /**
   * The clips whose file could not be opened, by key.
   *
   * A duration of 0 is NOT the same question and must not be used as one: a clip that genuinely
   * reports no length reads 0 too, and so does one that has simply not been measured yet. This is
   * the narrower fact - the probe was tried and the file refused - which is the only one worth
   * putting on the screen, because it is the only one the customer can do something about.
   *
   * It matters most on a draft opened days later, where a clip's file can have been deleted or its
   * read permission lapsed. Without this the timeline showed a segment of the right length over a
   * stage that painted nothing, and said nothing about why.
   */
  readonly unreadable = signal<ReadonlySet<string>>(new Set());
  /** Filmstrip frames per clip key, filled in as they are cut. */
  readonly filmstrips = signal<ReadonlyMap<string, Filmstrip>>(new Map());
  /**
   * Peak amplitudes per audio URI - the music track and every voiceover take - as they are measured.
   *
   * Three states, and the timeline draws each of them differently. No entry is "not measured yet"
   * and keeps the plain bar; a [Peaks] is a picture; `null` is "measured, and there is nothing to
   * draw" - a codec this WebView has no decoder for, a file too big to decode, a browser with no
   * Web Audio - which also keeps the plain bar, and stops anything trying again.
   *
   * Keyed by URI rather than by clip key, because audio has no `EditorSource`: a track arrives from
   * the picker, from the sound library or from a saved draft, and the URI is the only name all
   * three share.
   *
   * Never pruned, deliberately. A measurement is 100 bytes per second of audio, so ten tracks
   * auditioned and discarded is well under a megabyte - and keeping them is what lets an undo that
   * brings a removed sound back show its picture at once instead of decoding it a second time.
   */
  readonly waveforms = signal<ReadonlyMap<string, Peaks | null>>(new Map());
  readonly maxClips = signal(10);

  /* -- the edit ---------------------------------------------------------------------------- */

  readonly manifest = signal<EditManifest>(emptyManifest());
  /** The manifest the editor opened with, for "discard your edits?". */
  private readonly opened = signal<EditManifest>(emptyManifest());
  readonly dirty = computed(() => this.manifest.value !== this.opened.value);

  /**
   * Bumped once per COMMITTED change, for a host that wants to follow the edit as it happens.
   *
   * Not [manifest] itself, and that is the whole point of having it. A drag writes the manifest on
   * every frame - see [preview] - so a host watching THAT signal to file a draft would write one
   * draft per frame for a single pull of a trim handle. Every finished step, on the other hand,
   * lands in exactly two places: [pushHistory], which [commit] and [endGesture] both funnel into,
   * and [afterHistoryJump], which is undo and redo. This counts those and nothing else, so one
   * customer action is one bump.
   *
   * Bumped BEFORE [commit] writes the new manifest, because [pushHistory] runs first. A watcher must
   * therefore read the manifest a microtask later rather than inside the notification, which is what
   * `deferredEffect` is for and why nothing here reads it synchronously.
   */
  readonly revision = signal(0);

  private readonly past = signal<HistoryEntry[]>([]);
  private readonly future = signal<HistoryEntry[]>([]);
  private gestureStart: EditManifest | null = null;
  /**
   * While a group is open, each of the transition sheet's own steps after its first folds into the
   * entry the first one made - see [beginHistoryGroup]. `entry` is that entry's index in [past], or
   * -1 before it exists and again once anything else has been recorded on top of it. The animation
   * sheet opens one the same way, for the same reason.
   */
  private historyGroup: { entry: number } | null = null;
  /**
   * The open gesture is the transition sheet's duration slider - or the animation sheet's length
   * slider - so its end is one of the sheet's steps and folds with the rest of the visit.
   *
   * Marked by [setTransitionDuration] and [setAnimationMs] as they preview into the gesture rather
   * than read off the label the gesture ends with. A gesture the sheet did not start never passes
   * through there, and one it did start can be closed under another name: [flushGesture] ends a
   * slider still held when a button is tapped as 'Change', and that is still the sheet's own step.
   */
  private gestureInGroup = false;
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
    return (selected ? rows.find(track => track.id === selected) : null) ?? rows[0] ?? null;
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

  /**
   * The transition at the playhead, or null wherever one clip fills the frame. Beside
   * [previewLayers] rather than inside it, because that list holds ONE base entry and a great deal
   * of the preview - the crop tool, the hit-testing, the source element per track - relies on it.
   */
  readonly previewTransition = computed<PreviewTransition | null>(() => {
    const window = transitionWindowAt(this.slots.value, this.playheadMs.value);
    const kind = window?.to.transitionIn?.kind;
    const transition = kind ? compileTransition(kind) : null;
    if (!window || !transition) return null;
    const from = window.from;
    return {
      clipId: window.to.id,
      startMs: window.startMs,
      durationMs: window.durationMs,
      progress: window.progress,
      from: {
        trackId: null,
        clipId: from.id,
        clipKey: from.clipKey,
        sourceMs: window.fromSourceMs,
        rect: from.rect ?? null,
        crop: from.crop ?? null,
        fit: this.clipFit(from),
        opacity: 1,
        z: 0,
      },
      transition,
    };
  });

  /** One layer of [previewLayers]. `outputMs` is on the layer's OWN timeline, not the post's. */
  private previewLayer(trackId: string | null, slot: TimelineSlot, outputMs: number, opacity: number, z: number): PreviewVideoLayer {
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
  /**
   * The boundary the transition sheet is dressing while it is open, named by its INCOMING clip -
   * the clip that holds the transition. Null whenever the sheet is shut.
   */
  readonly transitionTarget = signal<string | null>(null);
  /** The boundary [transitionTarget] names, worked out, or null when there is none. */
  readonly targetBoundary = computed<TransitionBoundary | null>(() => {
    const id = this.transitionTarget.value;
    return id ? this.boundaryOf(id) : null;
  });
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
  /** The selected segment is a picture, which has no speed and no sound to set. */
  readonly selectedIsPicture = computed(() => this.selectedClip.value?.image === true);
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
    return this.clips.value.find(clip => clip.key === key);
  }

  /**
   * Whether the source behind a clip key is a picture. Read off the source the host handed over and,
   * failing that, off the segments the manifest keeps for it: a draft reopened by a host that stored
   * its sources without their `kind` still knows its pictures from the segments it saved.
   */
  isPictureKey(key: string): boolean {
    if (isPictureSource(this.clipByKey(key))) return true;
    const manifest = this.manifest.value;
    const rows = [manifest.clips, ...manifest.videoTracks.map(track => track.clips)];
    return rows.some(row => row.some(clip => clip.clipKey === key && clip.image === true));
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
    return this.commitStep(label, fn, false);
  }

  /**
   * [commit], saying whether the step is one of the transition sheet's own - the only kind an open
   * history group folds (see [pushHistory]). Private, because nothing outside the sheet's own actions
   * below has any business joining the step the sheet is building.
   */
  private commitStep(label: string, fn: (m: EditManifest) => EditManifest | null, grouped: boolean): boolean {
    this.flushGesture();
    const before = this.manifest.value;
    const after = fn(before);
    if (!after || after === before) return false;
    this.pushHistory(before, label, grouped);
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
   * A live step applied to where the gesture STARTED rather than to where it has got to.
   *
   * [preview] compounds, which is right for everything that had been using it: moving a clip by a
   * delta, or setting a value that does not read the old one, gives the same answer either way. It
   * is wrong for a step that DESTROYS, and the end grip's cut is the first of those. Fed the
   * running manifest, frame two would cut a post that frame one had already shortened, the picture
   * would race away under a finger that had barely moved, and dragging back out would restore
   * nothing - the clips it would have to put back are gone.
   *
   * Against the snapshot, every frame of the drag is the same cut made once from the same starting
   * point, so it is idempotent and the whole gesture stays reversible until it is let go.
   */
  previewFromStart(fn: (m: EditManifest) => EditManifest | null): void {
    this.beginGesture();
    const next = fn(this.gestureStart ?? this.manifest.value);
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
    const grouped = this.gestureInGroup;
    this.gestureStart = null;
    this.gestureInGroup = false;
    if (!start || start === this.manifest.value) return;
    if (sameValue(start, this.manifest.value)) {
      this.manifest.value = start;
      return;
    }
    this.pushHistory(start, label, grouped);
  }

  /** Throws a gesture away, putting back the manifest it started from. */
  cancelGesture(): void {
    const start = this.gestureStart;
    this.gestureStart = null;
    this.gestureInGroup = false;
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

  /**
   * Records one finished step. `grouped` says it is one of the transition sheet's own, and only
   * those fold into an open group.
   *
   * Anything else that lands while the sheet happens to be open - the mute on the timeline tapped,
   * a clip added - is a step of its own. Folded, one undo of "Transition" took it back as well,
   * without a word about it. Such a step also ends the folding, so the sheet's next step starts an
   * entry of its own above it and undo keeps to the order things were done in.
   */
  private pushHistory(manifest: EditManifest, label: string, grouped = false): void {
    // Any step recorded here ends a coalesced run ([commitCoalesced] restarts one after it).
    this.coalesced = null;
    const group = this.historyGroup;
    // Folded into the group's entry when that entry is still the newest step: the manifest it holds
    // is the one from before the group began, which is exactly what one undo of the whole group has
    // to put back. The revision still moves, so a host filing drafts sees every change.
    if (grouped && group && group.entry >= 0 && group.entry === this.past.value.length - 1 && this.future.value.length === 0) {
      this.revision.value++;
      return;
    }
    this.past.value = [...this.past.value, { manifest, label }].slice(-HISTORY_LIMIT);
    this.future.value = [];
    this.revision.value++;
    if (group) group.entry = grouped ? this.past.value.length - 1 : -1;
  }

  /**
   * Opens a history GROUP: every step the transition sheet itself takes until [endHistoryGroup] -
   * a tile, None, the duration - lands as ONE undo step, the label being the first step's.
   *
   * For a sheet a customer browses rather than uses once. Ten transitions tried one after another
   * before settling on one are one decision, and ten undo steps to get back past them would make
   * undo the least useful button on the screen. A gesture cannot do this job: the sheet's slider
   * opens and closes its own, and a gesture never outlives one.
   *
   * Only the sheet's steps fold (see [pushHistory]); anything else recorded while it is open is a
   * step of its own and ends the folding. So does an undo or redo inside the group - the entry it
   * folded into is no longer the newest - and in both cases the next change the sheet makes starts
   * an entry of its own, as it should.
   */
  beginHistoryGroup(): void {
    this.flushGesture();
    this.historyGroup = { entry: -1 };
  }

  endHistoryGroup(): void {
    this.flushGesture();
    this.historyGroup = null;
  }

  /** A gesture left open (a slider still held when a button is tapped) is closed as its own step. */
  private flushGesture(): void {
    if (this.gestureStart) this.endGesture('Change');
  }

  private afterHistoryJump(): void {
    /* Undo and redo move the manifest without going through [pushHistory], so they count here or a
       host following the edit would miss exactly the changes that put a layer back. */
    this.revision.value++;

    const sel = this.selection.value;
    const m = this.manifest.value;
    const stillThere =
      !sel ||
      (sel.kind === 'clip' && !!findClip(m, sel.id)) ||
      (sel.kind === 'overlay' && !!findOverlay(m, sel.id)) ||
      (sel.kind === 'voice' && !!findVoiceover(m, sel.id)) ||
      (sel.kind === 'zoom' && !!findZoom(m, sel.id)) ||
      (sel.kind === 'music' && !!m.music);
    if (!stillThere) this.select(null);
    if (this.historyGroup) this.historyGroup.entry = -1;
    // A slider dragged after an undo starts a step of its own rather than folding into one that is
    // now on the redo stack.
    this.coalesced = null;
    // The zoom the sheet is on can be undone out of existence, like the transition sheet's boundary.
    if (this.panel.value === 'zoom' && !this.selectedZoom.value) this.closePanel();
    // The boundary the transition sheet is on can be undone out of existence - an undo that takes
    // back the clip it was in front of.
    if (this.panel.value === 'transition' && !this.targetBoundary.value) this.closePanel();
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
    if (panel === 'speed' || panel === 'volume' || panel === 'opacity' || panel === 'crop' || panel === 'transition' || panel === 'zoom' || panel === 'animation')
      this.closePanel();
  }

  isSelected(selection: EditorSelection): boolean {
    const sel = this.selection.value;
    if (!sel || sel.kind !== selection.kind) return false;
    return sel.kind === 'music' || (sel as { id: string }).id === (selection as { id: string }).id;
  }

  openPanel(panel: EditorPanel | null): void {
    this.soundMenuOpen.value = false;
    if (this.panel.value === 'transition' && panel !== 'transition') this.leaveTransition();
    if (this.panel.value === 'animation' && panel !== 'animation') this.leaveAnimation();
    this.panel.value = panel;
  }

  closePanel(): void {
    if (this.panel.value === 'transition') this.leaveTransition();
    if (this.panel.value === 'animation') this.leaveAnimation();
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
  /* Transitions                                                                               */
  /* ========================================================================================= */

  /**
   * The duration the last transition was given, so the next boundary dressed starts where the
   * customer left the slider rather than back at the default.
   */
  private readonly lastTransitionMs = signal(DEFAULT_TRANSITION_MS);
  private stopAudition: (() => void) | null = null;

  /**
   * How long a transition chosen on the target boundary would run - its own duration when it has
   * one, and otherwise the last one chosen, held to what the two clips can take. It is what the
   * sheet's readout shows on a cut, so the number does not jump when the first tile is tapped.
   */
  readonly nextTransitionMs = computed(() => {
    const boundary = this.targetBoundary.value;
    if (!boundary) return this.lastTransitionMs.value;
    if (boundary.transition) return boundary.effectiveMs;
    return Math.max(MIN_TRANSITION_MS, Math.min(this.lastTransitionMs.value, boundary.maxMs));
  });

  /** The boundary INTO base clip `clipId`, or null when that clip has nothing before it. */
  boundaryOf(clipId: string): TransitionBoundary | null {
    const slots = this.slots.value;
    const slot = slots.find(s => s.clip.id === clipId);
    if (!slot || slot.index === 0) return null;
    const from = slots[slot.index - 1].clip;
    return {
      clipId,
      index: slot.index,
      from,
      to: slot.clip,
      transition: slot.clip.transitionIn ?? null,
      effectiveMs: slot.transitionInMs,
      maxMs: maxTransitionMs(from, slot.clip),
      atMs: slot.startMs,
    };
  }

  /**
   * The dot between two clips: opens the transition sheet on the boundary into `clipId`.
   *
   * Everything done in the sheet is one undo step (see [beginHistoryGroup]), and the preview goes to
   * the boundary - the middle of the transition when there is one - so the picture on the screen is
   * the thing the sheet is about.
   */
  openTransition(clipId: string): void {
    const boundary = this.boundaryOf(clipId);
    if (!boundary) return;
    this.pause();
    // Selecting nothing also shuts a transition sheet that was open on another boundary.
    this.select(null);
    this.closePanel();
    this.transitionTarget.value = clipId;
    this.beginHistoryGroup();
    this.openPanel('transition');
    this.seek(boundary.atMs + boundary.effectiveMs / 2);
    this.haptic('light');
  }

  /**
   * A tile: this transition on the boundary, at the duration it already had, or the last one chosen.
   * Plays it once in the preview, which is the only way to see a transition at all.
   */
  chooseTransition(kind: string): void {
    const boundary = this.targetBoundary.value;
    if (!boundary || !transitionPreset(kind)) return;
    if (boundary.maxMs < MIN_TRANSITION_MS) {
      this.showToast('These clips are too short for a transition');
      this.haptic('warning');
      return;
    }
    const wanted = boundary.transition?.durationMs ?? this.lastTransitionMs.value;
    const durationMs = Math.max(MIN_TRANSITION_MS, Math.min(wanted, boundary.maxMs));
    this.commitStep('Transition', m => setClipTransition(m, boundary.clipId, { kind, durationMs }), true);
    this.haptic('selection');
    this.auditionTransition();
  }

  /** None: the boundary goes back to a cut, and the preview to the cut. */
  removeTransition(): void {
    const boundary = this.targetBoundary.value;
    if (!boundary?.transition) return;
    this.endAudition();
    this.commitStep('Transition', m => setClipTransition(m, boundary.clipId, null), true);
    this.haptic('selection');
    this.parkOnBoundary();
  }

  /**
   * The duration slider. Live while it is dragged (the slider wraps the drag in a gesture), one step
   * otherwise. Held to what the two clips can take, which is the slider's own end as well.
   *
   * The preview follows the transition's middle as it moves: a longer transition starts the incoming
   * clip earlier, so the moment the sheet is about slides along under a playhead left where it was.
   */
  setTransitionDuration(durationMs: number, live = false): void {
    const boundary = this.targetBoundary.value;
    const current = boundary?.transition;
    if (!boundary || !current) return;
    const ms = Math.round(Math.max(MIN_TRANSITION_MS, Math.min(boundary.maxMs, durationMs)));
    this.lastTransitionMs.value = ms;
    const fn = (m: EditManifest): EditManifest => setClipTransition(m, boundary.clipId, { kind: current.kind, durationMs: ms });
    if (live) {
      this.preview(fn);
      // After the preview, which is what opens the gesture when the slider has not already.
      this.gestureInGroup = true;
    } else if (!this.commitStep('Transition', fn, true)) {
      return;
    }
    this.parkOnBoundary();
  }

  /**
   * The boundary's transition - or its cut - on every boundary of the base track, as a step of its
   * own rather than folded into the rest of the sheet: it changes clips the customer was not looking
   * at, and undo should be able to take back exactly that. An ordinary [commit] is exactly that, and
   * it also ends the sheet's folding, so what is tried in the sheet afterwards is a step above it.
   *
   * Every boundary before the target that it dresses or undresses moves the target along the
   * timeline, so the preview is put back on it afterwards.
   */
  applyTransitionToAll(): void {
    const boundary = this.targetBoundary.value;
    if (!boundary) return;
    const transition = boundary.transition;
    const changed = this.commit(transition ? 'Transition for all' : 'Remove transitions', m => setAllTransitions(m, transition));
    if (changed) {
      this.showToast(transition ? 'Transition applied to all clips' : 'Transitions removed from all clips');
      this.haptic('success');
      this.parkOnBoundary();
    } else {
      this.showToast(transition ? 'All clips already have this transition' : 'No clip has a transition');
    }
  }

  /**
   * Puts the preview back on the target boundary after a change that moved it: the middle of its
   * transition, or the cut itself when it has none - where [openTransition] put it to begin with.
   *
   * A new duration, None and Apply to all each re-time the base track. The incoming clip starts
   * earlier or later by however much the overlap changed, and every boundary after one that was
   * dressed moves with it, while the playhead stays where it was: on a frame of one clip alone,
   * as often as not, nowhere near the transition the sheet is showing.
   *
   * An audition still running is ended first rather than argued with. Left alone it plays on to the
   * end of the OLD window and then parks on the old middle, undoing this a second later. The
   * customer's own playback is left alone: a playhead they set moving is not the sheet's to take.
   */
  private parkOnBoundary(): void {
    const auditioning = this.stopAudition !== null;
    this.endAudition();
    if (auditioning) this.pause();
    else if (this.playing.value) return;
    const boundary = this.targetBoundary.value;
    if (boundary) this.seek(boundary.atMs + boundary.effectiveMs / 2);
  }

  /**
   * Plays the target boundary's transition once, with a little either side of it, and parks the
   * preview on its middle - the one frame that shows what the transition is.
   */
  auditionTransition(): void {
    const boundary = this.targetBoundary.value;
    if (!boundary || boundary.effectiveMs <= 0) return;
    const middle = boundary.atMs + boundary.effectiveMs / 2;
    const fromMs = Math.max(0, boundary.atMs - 600);
    const toMs = Math.min(this.totalMs.value, boundary.atMs + boundary.effectiveMs + 400);
    this.endAudition();
    this.seek(fromMs);
    this.play();
    let started = false;
    const dispose = effect(() => {
      const at = this.playheadMs.value;
      const playing = this.playing.value;
      if (playing) started = true;
      // Paused by the customer part way: the audition is over, and the playhead stays where they put it.
      const interrupted = started && !playing;
      if (at < toMs && !interrupted) return;
      queueMicrotask(() => {
        if (this.stopAudition !== stop) return;
        this.endAudition();
        if (!interrupted) {
          this.pause();
          this.seek(middle);
        }
      });
    });
    const stop = (): void => dispose();
    this.stopAudition = stop;
  }

  private endAudition(): void {
    const stop = this.stopAudition;
    this.stopAudition = null;
    stop?.();
  }

  /** Everything the transition sheet was holding open, let go of as it shuts. */
  private leaveTransition(): void {
    this.endAudition();
    this.endHistoryGroup();
    this.transitionTarget.value = null;
  }

  /* ========================================================================================= */
  /* Playback                                                                                  */
  /* ========================================================================================= */

  seek(outputMs: number): void {
    const ms = Math.max(0, Math.min(this.totalMs.value, outputMs));
    // Moving the playhead with the zoom sheet open is looking at what the zoom does there; see
    // [zoomView]. Only the customer seeks through the store - the player moves its own playhead.
    if (this.panel.value === 'zoom') this.zoomView.value = 'result';
    if (this.player) this.player.seek(ms);
    else this.playheadMs.value = ms;
  }

  play(): void {
    // Played in the zoom sheet, the move stays on screen where it is paused, rather than the frame
    // dropping back to the area box the moment the customer stops it to look.
    if (this.panel.value === 'zoom') this.zoomView.value = 'result';
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

  /**
   * Cuts the selected segment in two at the playhead, or the one under it when nothing is selected.
   * The tool is called Cut on screen; `split` is the name the ops and the tool's id have always had.
   */
  splitAtPlayhead(): void {
    const newId = this.newId('seg');
    const at = this.playheadMs.value;
    const ok = this.commit('Cut', m => splitClipAt(m, at, newId));
    if (!ok) {
      this.showToast('Move the playhead further into the clip to cut it');
      this.haptic('warning');
      return;
    }
    // Onto the cut just made, the start of the right-hand piece. With no transition near, that is
    // where the playhead already is. A split inside a transition, or just after one, leaves a short
    // left piece that holds the transition into it, and a transition is held to half of either
    // clip, so it shrinks: the track re-times, the new cut moves later, and a playhead left where it
    // was is in the OUTGOING clip, a clip away from the cut the customer is looking for.
    const right = this.slots.value.find(slot => slot.clip.id === newId);
    if (right) this.seek(right.startMs);
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
    if (this.commit('Duplicate', m => duplicateClip(m, clip.id, newId))) {
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
    if (!this.commit('Delete', m => removeClip(m, clip.id))) {
      this.showToast('A video needs at least one clip');
      this.haptic('warning');
      return;
    }
    this.select(null);
    this.haptic('light');
  }

  joinSelectedWithNext(): void {
    const clip = this.selectedClip.value;
    if (clip && this.commit('Join', m => joinWithNext(m, clip.id))) this.haptic('light');
  }

  moveClipTo(clipId: string, toIndex: number): void {
    if (this.commit('Reorder', m => moveClip(m, clipId, toIndex))) this.haptic('light');
  }

  /** Live trim from a handle; wrap in begin/endGesture('Trim'). */
  previewTrim(clipId: string, inMs: number, outMs: number): void {
    const clip = findClip(this.manifest.value, clipId);
    if (!clip) return;
    const source = this.sourceDurationMs(clip.clipKey);
    this.preview(m => trimClip(m, clipId, inMs, outMs, source));
  }

  setClipSpeed(clipId: string, speed: number, live = false): void {
    if (live) this.preview(m => setClipSpeed(m, clipId, speed));
    else this.commit('Speed', m => setClipSpeed(m, clipId, speed));
  }

  patchClip(clipId: string, patch: Parameters<typeof patchClip>[2], label: string, live = false): void {
    if (live) this.preview(m => patchClip(m, clipId, patch));
    else this.commit(label, m => patchClip(m, clipId, patch));
  }

  toggleOriginalMuted(): void {
    const muted = !this.manifest.value.originalMuted;
    this.commit(muted ? 'Mute original sound' : 'Unmute original sound', m => ({ ...m, originalMuted: muted }));
    this.showToast(muted ? 'Original sound off' : 'Original sound on');
    this.haptic('light');
  }

  /**
   * Fill or fit: whether the picture COVERS the rectangle it is drawn in, cropping whatever hangs
   * over, or is CONTAINED inside it with black down the sides it does not reach.
   *
   * The SELECTED segment's, when there is one, and the whole post's otherwise. It was the post's
   * either way, and the tile sits in the clip tools row - so somebody who had placed a video on a
   * layer, seen the black bands its rectangle left around it and tapped Fill changed the fit of
   * every other segment in the post that had not been given one, which on a post of three layers
   * is two pictures they were not looking at. The tile's own label is read back the same way.
   */
  toggleFit(): void {
    const clip = this.selectedClip.value;
    const fit = this.clipFit(clip) === 'cover' ? 'contain' : 'cover';
    const label = fit === 'cover' ? 'Fill frame' : 'Fit frame';
    if (clip) {
      this.commitClipFraming(clip.id, { fit }, label);
      return;
    }
    this.commit(label, m => ({ ...m, fit }));
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
    this.preview(m => patchClip(m, clipId, patch));
  }

  commitClipFraming(clipId: string, patch: ClipFramingPatch, label: string): void {
    this.commit(label, m => patchClip(m, clipId, patch));
  }

  /** Back to the whole source over the whole frame: the crop sheet's Reset. */
  resetClipFraming(clipId: string): void {
    if (this.commit('Reset crop', m => resetClipFraming(m, clipId))) this.haptic('light');
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
    if (!this.commit('Add video', m => addVideoTrack(m, clip, id))) return null;
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
    if (!this.commit('Remove video', m => removeVideoTrack(applyLayoutPreset(m, trackId, 'full'), trackId))) return;
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
    if (!this.commit('Move to layer', mm => moveClipToTrack(mm, clipId, target, atMs, newTrackId))) return false;
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

  /**
   * The end pulled back INTO the post, cutting every row at that instant - see [cutPostTo]. The
   * grip only reaches this once it has given back all the tail there was, so a post nobody has
   * stretched is cutting from the first pixel of the drag.
   *
   * Live steps go through [previewFromStart] and not [preview]: a cut applied to its own result
   * compounds, and the clips the next frame would have to put back are already gone.
   */
  cutPostTo(durationMs: number, live = false): void {
    const fn = (m: EditManifest): EditManifest => cutPostTo(m, durationMs);
    if (live) this.previewFromStart(fn);
    else if (!this.commit('Trim video', fn)) return;
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
    if (!this.commit('Swap videos', m => swapTrackZ(m, trackId))) return;
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
    if (this.commit(`Layout ${label}`, m => applyLayoutPreset(m, trackId, presetId))) {
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
    if (!this.commit(label, m => addOverlay(m, overlay))) return null;
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
    this.preview(m => addOverlay(m, overlay));
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
      this.preview(m => removeOverlay(m, edit.id));
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
    this.preview(m => patchOverlay(m, id, patch));
  }

  commitOverlay(id: string, patch: Parameters<typeof patchOverlay>[2], label: string): void {
    this.commit(label, m => patchOverlay(m, id, patch));
  }

  /** Live move/trim of a layer's time window from the timeline; wrap in begin/endGesture. */
  previewOverlayWindow(id: string, startMs: number, endMs: number): void {
    const total = this.totalMs.value;
    this.preview(m => setOverlayWindow(m, id, startMs, endMs, total));
  }

  duplicateSelectedOverlay(): void {
    const overlay = this.selectedOverlay.value;
    if (!overlay) return;
    const newId = this.newId(overlay.kind);
    if (this.commit('Duplicate', m => duplicateOverlay(m, overlay.id, newId))) {
      this.select({ kind: 'overlay', id: newId });
      this.haptic('light');
    } else if (this.layersFull.value) {
      this.showToast(`You can add up to ${MAX_LAYERS} layers`);
    }
  }

  deleteSelectedOverlay(): void {
    const overlay = this.selectedOverlay.value;
    if (!overlay) return;
    if (this.commit('Delete', m => removeOverlay(m, overlay.id))) {
      this.select(null);
      this.haptic('light');
    }
  }

  deleteOverlay(id: string): void {
    if (this.commit('Delete', m => removeOverlay(m, id))) {
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
    if (this.commit('Cut', m => splitOverlayAt(m, overlay.id, at, newId, total))) {
      this.select({ kind: 'overlay', id: newId });
      this.haptic('light');
    } else if (this.layersFull.value) {
      // A split makes a second layer, so at the cap it is refused however well the playhead is
      // placed - "move the playhead" would send the customer looking for a problem that is not there.
      this.showToast(`You can add up to ${MAX_LAYERS} layers`);
      this.haptic('warning');
    } else {
      this.showToast('Move the playhead inside the layer to cut it');
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
    if (this.commit(labels[move], m => moveLayer(m, overlay.id, move))) {
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
    this.commit(edge === 'start' ? 'Start here' : 'End here', m => setOverlayWindow(m, overlay.id, s, e, total));
  }

  /* ========================================================================================= */
  /* Layer animation                                                                           */
  /* ========================================================================================= */

  /**
   * The Animation tool: opens the animation sheet on the selected layer.
   *
   * Everything done in the sheet is one undo step (see [beginHistoryGroup]): six entrances tried one
   * after another before settling on one are one decision, exactly as six transitions are. The
   * preview is paused, and put on the layer where it has arrived when the playhead is somewhere the
   * layer is not on screen, so the picture is the thing the sheet is about; each tile then plays its
   * move there ([auditionAnimation]).
   */
  openAnimation(): void {
    const overlay = this.selectedOverlay.value;
    if (!overlay) return;
    this.pause();
    // Opened first, which lets go of whatever was open and the group that went with it.
    this.openPanel('animation');
    this.beginHistoryGroup();
    const total = this.totalMs.value;
    if (!isOverlayVisibleAt(overlay, this.playheadMs.value, total)) {
      const { startMs, endMs } = overlayWireWindow(overlay, total);
      const arrived = startMs + overlayAnimationSpans(overlay.animation, endMs - startMs).inMs;
      this.seek(Math.max(startMs, Math.min(arrived, Math.min(endMs, total) - 1)));
    }
    this.haptic('light');
  }

  /**
   * A tile: preset `id` for one part of the selected layer's animation, at the preset's OWN length.
   * Not the length the last preset had: each is tuned at its own (a stamp is 200 ms, a flicker 800),
   * and a flicker squeezed into a stamp's 200 ms is a blink. The preset the part already has keeps
   * the length the customer gave it, and a tap on it plays it again - the only way to see it twice.
   */
  chooseAnimation(part: OverlayAnimationPart, id: string): void {
    const overlay = this.selectedOverlay.value;
    const preset = overlayAnimationPreset(part, id);
    if (!overlay || !preset) return;
    if (overlay.animation?.[part]?.id !== id) {
      const move = part === 'loop' ? { id, periodMs: preset.defaultMs } : { id, durationMs: preset.defaultMs };
      this.commitStep('Animation', m => withAnimationPart(m, overlay.id, part, move), true);
      this.haptic('selection');
    }
    this.auditionAnimation(part);
  }

  /** None: that part of the selected layer's animation taken off, the other two left as they are. */
  removeAnimation(part: OverlayAnimationPart): void {
    const overlay = this.selectedOverlay.value;
    if (!overlay?.animation?.[part]) return;
    // An audition left running would go on playing a move that is no longer there.
    if (this.stopAudition) {
      this.endAudition();
      this.pause();
    }
    this.commitStep('Animation', m => withAnimationPart(m, overlay.id, part, null), true);
    this.haptic('selection');
  }

  /**
   * The length slider: an in's or an out's duration, or a loop's period. Live while it is dragged
   * (the slider wraps the drag in a gesture), one step otherwise. Held to the preset ranges by the
   * ops, which normalise every animation they are handed.
   */
  setAnimationMs(part: OverlayAnimationPart, ms: number, live = false): void {
    const overlay = this.selectedOverlay.value;
    const current = overlay?.animation?.[part];
    if (!overlay || !current) return;
    const move = part === 'loop' ? { id: current.id, periodMs: ms } : { id: current.id, durationMs: ms };
    const fn = (m: EditManifest): EditManifest => withAnimationPart(m, overlay.id, part, move);
    if (live) {
      this.preview(fn);
      // After the preview, which is what opens the gesture when the slider has not already.
      this.gestureInGroup = true;
    } else {
      this.commitStep('Animation', fn, true);
    }
  }

  /**
   * Plays one part of the selected layer's animation on the frame, once, and parks the preview where
   * the layer is at rest, which is how it will mostly be seen:
   *  - an in from a moment before the layer arrives to a moment after it has landed, parked landed;
   *  - an out from a moment before it starts leaving to the end of the layer, parked before it goes;
   *  - a loop from where it starts, for two cycles or a second and a half, parked where it started.
   *
   * The times are the render's: the spans the moves really play in, squeezed when the layer is too
   * short for both, and all of it inside the layer's own window.
   */
  auditionAnimation(part: OverlayAnimationPart): void {
    const overlay = this.selectedOverlay.value;
    const animation = overlay?.animation;
    if (!overlay || !animation?.[part]) return;
    const total = this.totalMs.value;
    const { startMs, endMs } = overlayWireWindow(overlay, total);
    const end = Math.min(endMs, total);
    const spans = overlayAnimationSpans(animation, endMs - startMs);
    // Landed, but never at the window's end, where the layer is no longer drawn.
    const arrived = Math.min(startMs + spans.inMs, end - 1);
    switch (part) {
      case 'in':
        this.playOnce(Math.max(0, startMs - AUDITION_LEAD_MS), Math.min(end, arrived + AUDITION_TAIL_MS), arrived);
        return;
      case 'out': {
        const leaving = Math.max(startMs, endMs - spans.outMs);
        this.playOnce(Math.max(startMs, leaving - AUDITION_LEAD_MS), end, Math.min(leaving, end - 1));
        return;
      }
      case 'loop': {
        const cycles = Math.max(2 * (animation.loop?.periodMs ?? 0), AUDITION_LOOP_MS);
        this.playOnce(arrived, Math.min(startMs + spans.loopEndMs, end, arrived + cycles), arrived);
        return;
      }
    }
  }

  /**
   * Plays `fromMs..toMs` once and parks, paused, on `parkMs` - the transition audition's shape, on
   * any stretch of the post. Paused by the customer part way, it is over and the playhead stays where
   * they put it. It holds [stopAudition], so starting one ends any other.
   */
  private playOnce(fromMs: number, toMs: number, parkMs: number): void {
    this.endAudition();
    if (!(toMs > fromMs)) {
      this.pause();
      this.seek(parkMs);
      return;
    }
    this.seek(fromMs);
    this.play();
    let started = false;
    const dispose = effect(() => {
      const at = this.playheadMs.value;
      const playing = this.playing.value;
      if (playing) started = true;
      const interrupted = started && !playing;
      if (at < toMs && !interrupted) return;
      queueMicrotask(() => {
        if (this.stopAudition !== stop) return;
        this.endAudition();
        if (!interrupted) {
          this.pause();
          this.seek(parkMs);
        }
      });
    });
    const stop = (): void => dispose();
    this.stopAudition = stop;
  }

  /**
   * Everything the animation sheet was holding open, let go of as it shuts. A gesture still open that
   * the sheet did not start is not the sheet's to close - a tap on a caption opens the text sheet over
   * this one having just begun its own - so then only the group goes, and the gesture is left to the
   * sheet it belongs to.
   */
  private leaveAnimation(): void {
    this.endAudition();
    if (this.gestureStart && !this.gestureInGroup) this.historyGroup = null;
    else this.endHistoryGroup();
  }

  /* ========================================================================================= */
  /* Colour                                                                                    */
  /* ========================================================================================= */

  setFilter(filterId: string): void {
    this.commit('Filter', m => (m.filterId === filterId ? m : { ...m, filterId, filterIntensity: 1 }));
  }

  /** Live; wrap in begin/endGesture('Filter strength'). */
  previewFilterIntensity(k: number): void {
    const filterIntensity = Math.max(0, Math.min(1, k));
    // The same object back for the same value, so a slider released where it started is no undo step.
    this.preview(m => (m.filterIntensity === filterIntensity ? m : { ...m, filterIntensity }));
  }

  /** Live; wrap in begin/endGesture('Adjust'). */
  previewAdjust(key: keyof EditAdjust, value: number): void {
    const min = key === 'fade' ? 0 : -1;
    const v = Math.max(min, Math.min(1, value));
    this.preview(m => (m.adjust[key] === v ? m : { ...m, adjust: { ...m.adjust, [key]: v } }));
  }

  resetAdjust(): void {
    this.commit('Reset adjust', m => (Object.values(m.adjust).every(v => v === 0) ? m : { ...m, adjust: neutralAdjust() }));
  }

  /* ========================================================================================= */
  /* Sound                                                                                     */
  /* ========================================================================================= */

  setMusic(music: EditMusic, label = 'Add sound'): void {
    if (this.commit(label, m => ({ ...m, music }))) {
      this.select({ kind: 'music' });
      this.haptic('light');
    }
  }

  removeMusic(): void {
    if (this.commit('Remove sound', m => (m.music ? { ...m, music: null } : m))) this.select(null);
  }

  /** Live; wrap in begin/endGesture. */
  previewMusic(patch: Partial<EditMusic>): void {
    this.preview(m => patchMusic(m, patch));
  }

  commitMusic(patch: Partial<EditMusic>, label: string): void {
    this.commit(label, m => patchMusic(m, patch));
  }

  /** Adds a recorded take where it was recorded. Returns false when there was no room for it. */
  addVoiceover(take: EditVoiceover): boolean {
    const total = this.totalMs.value;
    const ok = this.commit('Voiceover', m => addVoiceover(m, take, total));
    if (ok) {
      this.select({ kind: 'voice', id: take.id });
      this.haptic('success');
    }
    return ok;
  }

  removeSelectedVoice(): void {
    const take = this.selectedVoice.value;
    if (take && this.commit('Delete voiceover', m => removeVoiceover(m, take.id))) this.select(null);
  }

  /** Live; wrap in begin/endGesture('Move voiceover'). */
  previewMoveVoice(id: string, startMs: number): void {
    const total = this.totalMs.value;
    this.preview(m => moveVoiceover(m, id, startMs, total));
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
  /* Zooms                                                                                     */
  /* ========================================================================================= */

  /** Every zoom on the post, in time order. */
  readonly zooms = computed(() => this.manifest.value.zooms ?? []);
  readonly selectedZoom = computed(() => {
    const sel = this.selection.value;
    return sel?.kind === 'zoom' ? findZoom(this.manifest.value, sel.id) : null;
  });
  /**
   * The zooms compiled to the camera track the render gets - the one the preview samples, exactly as
   * it samples [compileTransition] for a transition, so what is on screen is what is exported. Only
   * recomputed when the manifest changes, never per frame; the preview reads it through [cameraAt].
   */
  readonly camera = computed(() => compileCamera(this.zooms.value, this.totalMs.value));
  /**
   * Every moving layer's motion, by layer id, compiled exactly as [toComposeSpec] compiles it: over
   * the layer's window as the wire carries it ([overlayWireWindow]), so the preview reads the same
   * keys through [overlayMotionAt] that the render is handed. A layer that does not move has no entry.
   *
   * Recomputed when the manifest changes, never per frame - and a layer whose animation, window and
   * kind are what they were keeps the keys it had, because a drag across the frame writes the
   * manifest on every movement of the finger and moves none of those three.
   */
  readonly overlayMotions = computed<ReadonlyMap<string, ComposeOverlayMotion>>(() => {
    const total = this.totalMs.value;
    const motions = new Map<string, ComposeOverlayMotion>();
    const kept = new Map<string, CompiledMotion>();
    for (const overlay of this.manifest.value.overlays) {
      if (!overlay.animation) continue;
      const { startMs, endMs } = overlayWireWindow(overlay, total);
      const known = this.compiledMotions.get(overlay.id);
      const same = known && known.animation === overlay.animation && known.kind === overlay.kind && known.startMs === startMs && known.endMs === endMs;
      const entry: CompiledMotion = same
        ? known
        : { animation: overlay.animation, kind: overlay.kind, startMs, endMs, motion: compileOverlayMotion({ startMs, endMs }, overlay.animation, overlay.kind) };
      kept.set(overlay.id, entry);
      if (entry.motion) motions.set(overlay.id, entry.motion);
    }
    this.compiledMotions = kept;
    return motions;
  });
  /** What [overlayMotions] compiled last time, and from what, so an unchanged layer is not compiled again. */
  private compiledMotions = new Map<string, CompiledMotion>();
  /**
   * What the stage shows while the zoom sheet is open and paused: the whole frame with the area box
   * on it (`area`), or the zoomed picture at the playhead (`result`).
   *
   * The last thing the customer did decides it, because each of the two things they do in that sheet
   * needs the other picture. Opening the sheet, or touching the video, is choosing WHERE to zoom, and
   * that wants the whole frame to choose it on. Dragging the timeline, or pressing play, is looking at
   * WHAT the zoom does, and a whole frame there answers a question nobody asked: the move could only be
   * seen by playing it, never by scrubbing through it to the moment in question. Outside the sheet the
   * camera is always on, so this says nothing there.
   */
  readonly zoomView = signal<'area' | 'result'>('area');

  /**
   * Whether the preview applies [camera] at all right now.
   *
   * Off in the crop sheet, which frames the SOURCE and has to show all of it. In the zoom sheet it is
   * on while playing and, paused, when [zoomView] is `result`; off while the area is being drawn, which
   * needs the whole frame the way the crop sheet needs the whole source.
   */
  readonly cameraLive = computed(() => {
    const panel = this.panel.value;
    if (panel === 'crop') return false;
    if (panel === 'zoom') return this.playing.value || this.zoomView.value === 'result';
    return true;
  });

  /** Back to drawing the area: the whole frame and its box. The preview calls it on a touch. */
  showZoomArea(): void {
    this.zoomView.value = 'area';
  }

  /** The coalesce key of the last zoom step, and the history entry it made; see [commitCoalesced]. */
  private coalesced: { key: CoalesceKey; entry: number } | null = null;

  /** How many keys [coalesceKey] has handed out, which numbers the next one. */
  private coalesceKeys = 0;

  /**
   * A coalesce key for ONE gesture - a drag of a zoom sheet's slider, of a zoom's window on the
   * timeline, of the box on the picture - that no gesture before it has had. The component asks for
   * one as the finger goes down and passes it with every step of that gesture, so the gesture lands
   * as one undo step and the next gesture, with a key of its own, as another.
   *
   * Handed out here rather than counted where the gesture happens, because the run a key folds into
   * ([coalesced]) is the store's and lives as long as the store does, and nothing that passes keys
   * lives that long: the zoom sheet is taken out every time its panel closes, the timeline in full
   * screen and under the tall sheets, the preview's gestures whenever the preview leaves the page.
   * Each of them used to count its own, so a new one started again at the same number and its first
   * gesture carried the last one's first key - and folded into that one's step whenever nothing had
   * been recorded in between. Level 2.0x to 3.0x, Done, Edit, 4.0x, and one Undo went back to 2.0x.
   *
   * Not by ending the run whenever a panel opens or closes, either. That is one of the ways a
   * component goes and comes back, not all of them - the timeline goes in full screen with no panel
   * open at all - and each new way would need a rule of its own here. A key that cannot repeat needs
   * none, and leaves the run's rule what it was: the same key, the newest entry, nothing to redo.
   *
   * `name` is only there to make a key readable when stepping through the code; two gestures with the
   * same name still get two keys.
   */
  coalesceKey(name: string): CoalesceKey {
    return `${name}:${++this.coalesceKeys}` as CoalesceKey;
  }

  /**
   * Adds a zoom at the playhead - [DEFAULT_ZOOM_MS] on the middle of the frame at
   * [DEFAULT_ZOOM_SCALE] - shortened to fit before the next zoom and the end of the post, then opens
   * the zoom sheet on it so the area can be drawn straight away. Paused first, because the sheet
   * shows the whole frame only while paused.
   *
   * Does nothing at all on a host that does not offer Zoom (`editing.zoom`). Nothing in the editor
   * offers it there - the toolbar leaves the tile out - so this is the backstop that keeps a way in
   * added later from putting a zoom into that app's posts, and it says nothing because no customer
   * asked.
   */
  addZoomAtPlayhead(): void {
    if (!this.host.editing.zoom) return;
    if (this.manifest.value.zooms.length >= MAX_ZOOMS) {
      this.showToast(`You can add up to ${MAX_ZOOMS} zooms`);
      this.haptic('warning');
      return;
    }
    const total = this.totalMs.value;
    const at = Math.round(this.playheadMs.value);
    const id = this.newId('zoom');
    const zoom: EditZoom = {
      id,
      startMs: at,
      endMs: at + DEFAULT_ZOOM_MS,
      cx: 0.5,
      cy: 0.5,
      scale: DEFAULT_ZOOM_SCALE,
      rampMs: DEFAULT_ZOOM_RAMP_MS,
      ease: 'smooth',
    };
    if (!this.commit('Add zoom', m => addZoomOp(m, zoom, total))) {
      this.showToast('No room for a zoom here');
      this.haptic('warning');
      return;
    }
    this.openZoom(id);
    this.haptic('light');
  }

  /**
   * Selects a zoom and opens its sheet, paused and on the area view (see [zoomView]), so the whole
   * frame is there to draw the area on.
   */
  openZoom(id: string): void {
    if (!findZoom(this.manifest.value, id)) return;
    this.pause();
    this.select({ kind: 'zoom', id });
    this.openPanel('zoom');
    this.zoomView.value = 'area';
  }

  /**
   * Changes a zoom's area, level, ramp or ease. One undo step labelled 'Zoom'; a slider or a drag
   * passes a `coalesce` key from [coalesceKey] and every call with the same key, one after another,
   * folds into that one step, so a drag across the frame is one undo and not sixty.
   */
  updateZoom(id: string, patch: ZoomPatch, opts?: { coalesce?: CoalesceKey }): void {
    this.commitCoalesced('Zoom', m => updateZoomOp(m, id, patch), opts?.coalesce);
  }

  /**
   * Moves a zoom's window, stopping at its neighbours and the end of the post and never shorter
   * than [MIN_ZOOM_MS]. Coalesces as [updateZoom] does, for the timeline's edge drags.
   */
  setZoomWindow(id: string, startMs: number, endMs: number, opts?: { coalesce?: CoalesceKey }): void {
    const total = this.totalMs.value;
    this.commitCoalesced('Zoom', m => setZoomWindowOp(m, id, startMs, endMs, total), opts?.coalesce);
  }

  /**
   * A copy straight after the original, selected. Says so when there is no room there. A copy is a
   * new zoom, so on a host that does not offer Zoom this does nothing, as [addZoomAtPlayhead] does.
   */
  duplicateZoom(id: string): void {
    if (!this.host.editing.zoom) return;
    if (this.manifest.value.zooms.length >= MAX_ZOOMS) {
      this.showToast(`You can add up to ${MAX_ZOOMS} zooms`);
      this.haptic('warning');
      return;
    }
    const newId = this.newId('zoom');
    const total = this.totalMs.value;
    if (!this.commit('Duplicate', m => duplicateZoomOp(m, id, newId, total))) {
      this.showToast('No room for a copy after this zoom');
      this.haptic('warning');
      return;
    }
    if (this.panel.value === 'zoom') this.openZoom(newId);
    else this.select({ kind: 'zoom', id: newId });
    this.haptic('light');
  }

  /** Deletes a zoom; its sheet closes with it when it was the one open. */
  deleteZoom(id: string): void {
    if (!this.commit('Delete', m => deleteZoomOp(m, id))) return;
    if (this.isSelected({ kind: 'zoom', id })) this.select(null);
    if (this.panel.value === 'zoom' && !this.selectedZoom.value) this.closePanel();
    this.haptic('light');
  }

  /**
   * [commit], except that a step carrying the same `key` as the step just before it folds into it:
   * the manifest moves and the revision counts (a host filing drafts sees every change), but no new
   * undo entry is made, so one undo puts back what was there before the first of them.
   *
   * Only while that step is still the newest entry and nothing is waiting to be redone. Anything else
   * recorded in between, an undo, or a redo ends the run, and the next call starts an entry of its
   * own - the history group's rule, for one control rather than one sheet.
   */
  private commitCoalesced(label: string, fn: (m: EditManifest) => EditManifest | null, key?: CoalesceKey): boolean {
    if (!key) return this.commit(label, fn);
    this.flushGesture();
    const before = this.manifest.value;
    const after = fn(before);
    if (!after || after === before) return false;
    const run = this.coalesced;
    if (run && run.key === key && run.entry >= 0 && run.entry === this.past.value.length - 1 && this.future.value.length === 0) {
      this.revision.value++;
      this.manifest.value = after;
      return true;
    }
    this.pushHistory(before, label);
    this.manifest.value = after;
    this.coalesced = { key, entry: this.past.value.length - 1 };
    return true;
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
    // Before the voice catch-all below, or Delete with a zoom selected would silently do nothing.
    else if (sel.kind === 'zoom') this.deleteZoom(sel.id);
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

  /**
   * The frame the post is rendered at: its shape, its size and its rate.
   *
   * A signal and no longer a constant. Everything that measures a SHAPE reads [frameAspect] and
   * everything that measures a SIZE in pixels reads [outputWidth], and both follow the customer's
   * choice the moment it is made - the preview's own box, a layer's bitmap, the picture-in-picture
   * presets, and what a clip's rectangle means.
   */
  readonly output = computed<EditOutput>(() => this.manifest.value.output);

  /** Width / height of the frame. What turns a fraction of it into a shape on screen. */
  readonly frameAspect = computed(() => {
    const output = this.output.value;
    return output.height > 0 ? output.width / output.height : DEFAULT_OUTPUT.width / DEFAULT_OUTPUT.height;
  });

  /** Output width in pixels, for sizing bitmaps in the preview. */
  readonly outputWidth = computed(() => this.output.value.width);

  /** The frame as one of the two shapes a customer picks between. */
  readonly outputAspect = computed(() => aspectOf(this.output.value));

  /** The rung of the resolution ladder the frame is on. */
  readonly outputQuality = computed(() => qualityOf(this.output.value));

  /**
   * Chooses the frame. One undo step, because a shape and a size are one decision to the customer
   * even when they change them one control at a time.
   *
   * Nothing else in the manifest is touched. Every rectangle and every layer centre is a FRACTION
   * of the frame, so they all follow it: a layer halfway across a portrait post is halfway across
   * the landscape one, which is what a customer moving between the two expects to see.
   */
  setOutput(output: EditOutput, label = 'Quality'): void {
    if (sameOutput(this.manifest.value.output, output)) return;
    this.commit(label, m => ({ ...m, output }));
  }

  /**
   * Called by the shell when the editor leaves the document. Only the toast timer outlives the
   * element: it would fire into a store nothing is reading any more, which is harmless, and it
   * would keep that store alive until it did, which is not.
   */
  dispose(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.endAudition();
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
  return ka.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** How much of the frame before a layer arrives, or before it starts to leave, an audition shows. */
const AUDITION_LEAD_MS = 300;
/** How long an audition of an in stays on the layer once it has landed, so the landing is seen. */
const AUDITION_TAIL_MS = 400;
/** The least an audition of a loop plays: a slow sway's two cycles are more, a quick shake's far less. */
const AUDITION_LOOP_MS = 1500;

/**
 * The manifest with one part of a layer's animation set to `move`, or taken off for null. The rest of
 * the animation is kept as it was, and `patchOverlay` takes the `animation` key itself off when the
 * part taken was the last - and hands the same manifest back when nothing changed, so a length
 * dragged back to where it was is no step at all.
 */
function withAnimationPart(m: EditManifest, id: string, part: OverlayAnimationPart, move: OverlayMove | OverlayLoop | null): EditManifest {
  const overlay = findOverlay(m, id);
  if (!overlay) return m;
  const animation: OverlayAnimation = { ...overlay.animation };
  if (!move) delete animation[part];
  else if (part === 'loop') animation.loop = move as OverlayLoop;
  else animation[part] = move as OverlayMove;
  return patchOverlay(m, id, { animation });
}
