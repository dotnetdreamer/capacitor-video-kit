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
  MIN_ZOOM_MS,
  compileCameraWith,
  followPath,
  followPaths,
  followReframes,
  followRest,
  followViewAt,
  zoomTrack,
  type CameraFollow,
  type CameraView,
  type FollowPath,
  type ZoomFraming,
  addOverlay,
  addAudioClip as addAudioClipOp,
  addVideoTrack,
  addVoiceover,
  applyLayoutPreset,
  canJoinWithNext,
  clipsDurationMs,
  cssFor,
  duplicateAudioClip as duplicateAudioClipOp,
  duplicateClip,
  duplicateOverlay,
  cutPostTo,
  emptyManifest,
  findClip,
  findAudioClip,
  findOverlay,
  findVideoTrack,
  findVoiceover,
  joinWithNext,
  moveClip,
  moveAudioClip as moveAudioClipOp,
  moveAudioClipToTrack as moveAudioClipToTrackOp,
  moveClipToTrack,
  moveLayer,
  moveVoiceover,
  neutralAdjust,
  patchClip,
  patchAudioClip,
  musicAsAudioLane,
  musicMovedTo,
  patchMusic,
  patchOverlay,
  patchVoiceover,
  removeClip,
  removeAudioClip,
  reorderAudioClip,
  replaceAudioClip as replaceAudioClipOp,
  setAudioLoop,
  setAudioSpeed as setAudioSpeedOp,
  setMusicSpeed as setMusicSpeedOp,
  soundEffectPreset,
  MAX_AUDIO_EFFECTS,
  addAudioEffect as addAudioEffectOp,
  deleteAudioEffect as deleteAudioEffectOp,
  duplicateAudioEffect as duplicateAudioEffectOp,
  findAudioEffect,
  moveAudioEffect as moveAudioEffectOp,
  moveAudioEffectTo as moveAudioEffectToOp,
  setAudioEffectSetting as setAudioEffectSettingOp,
  setAudioEffectWindow as setAudioEffectWindowOp,
  splitAudioEffect as splitAudioEffectOp,
  updateAudioEffect as updateAudioEffectOp,
  type EditAudioEffect,
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
  slipClip as slipClipOp,
  slotAt,
  sourceMsAt,
  splitAudioClipAt,
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
  type EditAudioClip,
  type EditClip,
  type EditFit,
  type EditManifest,
  type EditMusic,
  type AudioDropTarget,
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
  DEFAULT_LAYOUT_ANIMATION_MS,
  backgroundRgb,
  compileLayoutMotions,
  layoutAnimationPreset,
  layoutOpenings,
  setBackground as setBackgroundOp,
  setTrackLayoutAnimation,
  type LayoutMotions,
  addFocusChange as addFocusChangeOp,
  compileFocus,
  defaultFocus,
  focusChangesPicture,
  focusEntryAt,
  focusEntrySubjects,
  patchClipFocus as patchClipFocusOp,
  removeFocusChange as removeFocusChangeOp,
  resolveFocusSubjects,
  setClipFocus as setClipFocusOp,
  setFocusSubjects as setFocusSubjectsOp,
  type EditFocus,
  type FocusSubjects,
  compileLayerMotion,
  followedTrack,
  followersOf,
  followPatch,
  MAX_TRACKS,
  MAX_SMOOTH_MS,
  mendTrack,
  nextTrackHue,
  nextTrackName,
  outputMsOf,
  pathAt,
  refollowAt,
  repinOverlay,
  sourceMsThrough,
  sureAt,
  trackById,
  trackedFootage,
  trackedPoseAt,
  trackedThingAt,
  trackFromRun,
  trackHealth,
  trackName,
  trackPath,
  trackSmooth,
  trackStretches,
  unfollowOverlay,
  UNSURE_BELOW,
  weakSpots,
  parseSubjectTrack,
  DEFAULT_LOOK_AMOUNT,
  normaliseTrackLook,
  type SubjectTrack,
  type TrackLook,
  type EditTrack,
  type Footage,
  type ShownPose,
  type TrackedPose,
  type TrackHealthSpan,
  type TrackRunResult,
  type TrackScene,
} from '../editor';

import type { EditorSource, HapticKind, ResolvedEditorHost } from '../host/host.types';
import { fitBoxAt, type FitFrame } from '../editor/fit-box';
import { hasTrackLooks, segmentLook, type SegmentLook } from '../editor/track-looks';
import { PeopleMask, anyoneIn, hasBehindLayers, isBehind, peopleSourceKeys, type PeopleMaskFrame, type PeopleSources } from '../editor/people-matte';
import { resolve } from '../web-runtime/files';
import { isPictureSource } from '../web-runtime/picture';
import type { Peaks } from '../web-runtime/waveform';
import { FocusFrames } from '../video-composer/web/focus-frames';
import { probeMedia } from '../video-composer/web/media';
import { openTrackFrames, type TrackFrame, type TrackFrameSource } from '../video-composer/web/track-frames';
import type {
  AudioEffectCopy,
  EditorPanel,
  EditorPlayer,
  EditorSelection,
  Filmstrip,
  OverlayBitmap,
  SoundReplaceTarget,
  SubjectTrackState,
  ToolbarMode,
  TrackAim,
  TrackRunView,
  VolumeTarget,
} from './editor.types';
import { sameUrl } from './same-url';
import { startTrackRun, type TrackRunLive, type TrackRunOutcome } from './track-session';
import { isConvexQuad, quadMiddle } from '../editor/homography';
import {
  compileOverlayQuad,
  isSurfaceTrack,
  nextSurfaceName,
  placeOnSurface,
  surfaceFollowPatch,
  surfaceOf,
  surfaceQuadAt,
  surfaceTrackFromRun,
  type SurfaceQuad,
  type SurfaceRunResult,
} from '../editor/surface';
import { RENDER_FEATURES, type RenderFeature } from '../video-composer/definitions';
import { startPlaneRun, type PlaneRunLive, type PlaneRunOutcome } from './plane-session';

/** One layer's compiled motion and the three things it was compiled from; see [EditorStore.overlayMotions]. */
interface CompiledMotion {
  animation: NonNullable<EditOverlay['animation']>;
  kind: EditOverlay['kind'];
  startMs: number;
  endMs: number;
  motion: ComposeOverlayMotion | null;
}

/**
 * A following layer's compiled motion and everything it was compiled from: the layer itself, since its
 * motion is drawn against its own centre, the track it follows, and every part of the post the footage is
 * drawn through.
 */
interface CompiledTrackMotion {
  overlay: EditOverlay;
  track: EditTrack;
  scene: Pick<EditManifest, 'clips' | 'videoTracks' | 'output' | 'fit'> & Pick<TrackScene, 'camera' | 'layout'>;
  startMs: number;
  endMs: number;
  motion: ComposeOverlayMotion | null;
}

/** The smallest the Track sheet's box may be drawn, as a fraction of the frame's shorter side. */
const MIN_AIM = 0.06;

/** How big the box first is, as a fraction of the frame's width: a thumb's width on a phone. */
const DEFAULT_AIM = 0.3;

/** The longest a finished run plays itself back for, from the layer's start. */
const REVEAL_MS = 8000;

/** A fix plays back from this long before the frame it was made on to [FIX_REVEAL_AFTER_MS] after it. */
const FIX_REVEAL_BEFORE_MS = 1500;
const FIX_REVEAL_AFTER_MS = 2500;

/**
 * How often a run's frame is shown while it reads: thirty times a second at most. A run reads faster
 * than that on a desktop, and every frame shown is a frame's worth of drawing taken from the reading.
 */
const LIVE_EVERY_MS = 33;

/** [EditorStore.trackedPoses] while nothing on the post is tracked: one map, so nothing reading it is told of a change. */
const NO_POSES: ReadonlyMap<string, TrackedPose> = new Map();

/** [EditorStore.tracks] on a post with none: one list, for the same reason. */
const NO_TRACKS: readonly EditTrack[] = [];

/** Each track's health and how many spots of it are worth a second look, read once per track object. */
const TRACK_HEALTH = new WeakMap<EditTrack, { health: TrackHealthSpan[]; spots: number }>();

/** A segment's track looks as the preview reads them: what [segmentLook] made, and the frames read off it. */
interface LookFrames {
  look: SegmentLook;
  frames: FocusFrames;
}

/** Each made look's subject track, parsed once however many segments and redraws read it. */
const PARSED_LOOKS = new WeakMap<Uint8Array, SubjectTrack>();

/** How long Pin text, Pin sticker and Pin photo wait for the layer they pin: a picker is slow, a forgotten one is not pinned later. */
const PIN_NEXT_MS = 120_000;

/** How near a fix's run must come to the old path, as a share of the thing's box, to count as agreeing with it. */
const REJOIN_SLACK = 0.2;

/** The longest Track waits for a tap's fit still reading its frames before it runs on the box as it is. */
const FIT_WAIT_MS = 1200;

/**
 * How far on the second frame a tap's box is fitted with is read ([EditorStore.fitTrackAimAt]): about six
 * frames, long enough for a thing to have moved apart from its background, short enough that it has not
 * changed shape or left.
 */
const FIT_LATER_MS = 200;

/** Each side of a tapped person's box padded by this share of it, so the tracker has their edge to hold. */
const PERSON_PAD = 0.06;

/** The least of the subject grid a person has to cover to be lit up: less is a hand at the frame's edge, or the finder's noise. */
const MIN_PERSON_SHARE = 0.0005;

/** A person the Track sheet lights up on the picture at the playhead: their subject id, and their box on the frame as fractions. */
export interface TrackPersonBox {
  id: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** [EditorStore.trackPeopleBoxes] with nobody to show: one list, so nothing reading it is told of a change. */
const NO_PEOPLE: readonly TrackPersonBox[] = [];

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
   * The preview's own copy of a video source, by clip key: a URL the preview plays in the source's
   * place - the same footage on the same timeline, small and densely keyed, so a cut's seek lands at
   * once rather than decoding seconds of full-size footage. See [EditorMediaHost.previewProxy].
   *
   * Filled in by `EditorMedia` as the host's copies land, and played by the preview alone (see
   * `previewSrc`), so no render, draft or result ever carries one: the source objects are not
   * touched. `EditorMedia` reads it too, to cut a clip's filmstrip on exact frames once it has a copy
   * (see [ThumbnailRequest.precise]). No entry is "play the source itself" - every source until its
   * copy is ready, and every source on a host that makes none. Not reset by [load], which the
   * template studio calls again for every template over the same clips.
   */
  readonly previewUrls = signal<ReadonlyMap<string, string>>(new Map());
  /**
   * The preview's copies of what is heard under the audio effect layers, by the ids of the layers each
   * is of, sorted and joined by commas: a file the preview plays in the place of every sound those
   * layers cover - the post's own sound through them, stacked as they are, by the render's arithmetic -
   * since an element plays a file and not an effect. See `effect-copy.ts` for why it is a file, and for
   * why layers stacked or close together share one.
   *
   * Filled in by `EditorMedia` and played by the preview alone (`PreviewPlayer`), so no render, draft or
   * result ever carries one. A layer with no copy has one still being made: the preview plays the sounds
   * under it as they are meanwhile, and the render has the effect either way.
   */
  readonly audioEffectCopies = signal<ReadonlyMap<string, AudioEffectCopy>>(new Map());
  /**
   * Whether the preview is playing one of [audioEffectCopies] now, in the place of every sound it
   * covers. Written by the preview's player as the playhead goes in and out of a copy, and read by what
   * plays the clips' own sound (`soundHushed`), which then keeps quiet; nothing renders from it.
   */
  readonly soundUnderCopy = signal(false);
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
  /**
   * How many views that DRAW [waveforms] are on screen: the timeline, today, which counts itself in
   * while it is in the document. `EditorMedia` measures sound only while this is above 0.
   *
   * Every measurement is a whole file read and its sound decoded, on the thread the preview plays
   * on. A host that runs the editing core with no timeline - a template studio in front of the
   * editor - paid for one per clip in the very seconds its preview started playing, for waveforms
   * nothing ever drew. The first timeline to appear measures everything the post has, as before.
   */
  readonly waveformViewers = signal(0);
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
   * For each extra track, the layer it shows NEXT, when that starts within `withinMs` of the
   * playhead: the track's first clip while the track has not started, or the clip after the one on
   * screen. Each is read at the instant it starts, so `sourceMs` is the frame its element should be
   * waiting on - which is what lets a layer's element load and find that frame before its window
   * opens rather than on the frame it does; see `FollowerVideo.preload`. A track whose next clip
   * would start past its own end, or past the post's, has nothing next.
   */
  upcomingLayers(withinMs: number): PreviewVideoLayer[] {
    const m = this.manifest.value;
    const at = this.playheadMs.value;
    const total = this.totalMs.value;
    const layers: PreviewVideoLayer[] = [];
    for (const track of m.videoTracks) {
      const cut = Math.min(totalDurationMs({ clips: track.clips }), total - track.startMs);
      if (cut <= 0) continue;
      const into = at - track.startMs;
      const next = timelineSlots({ clips: track.clips }).find(slot => slot.startMs > into && slot.startMs < cut);
      if (!next || next.startMs - into > withinMs) continue;
      layers.push(this.previewLayer(track.id, next, next.startMs, track.opacity, track.z));
    }
    return layers;
  }

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
  /** The Sound tool's little menu (Add sound / Sound effects / Voiceover). */
  readonly soundMenuOpen = signal(false);
  /** The Effects tool's little menu: the picture's effects (Video) or the sound's (Audio). */
  readonly effectsMenuOpen = signal(false);
  /** The timeline plus button's Video / Audio choice, shared with the editor's Back handler. */
  readonly timelineAddMenuOpen = signal(false);
  /** What the volume sheet is adjusting while it is open. */
  readonly volumeTarget = signal<VolumeTarget | null>(null);
  /**
   * The sound the Sound sheet's next pick goes in place of, while a Replace tile has the sheet open.
   * Null is every other way into the sheet, all of which add a sound. Goes with the sheet.
   */
  readonly soundReplaceTarget = signal<SoundReplaceTarget | null>(null);
  /**
   * The open sheet is pulled up, to most of the column. Only the Sound sheet has a grabber, and it
   * opens pulled up; the grabber lowers it and raises it again. Goes with the sheet, so every sheet
   * opens at its own height.
   */
  readonly sheetExpanded = signal(false);
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
  readonly selectedAudio = computed(() => {
    const sel = this.selection.value;
    return sel?.kind === 'audio' ? findAudioClip(this.manifest.value, sel.id) : null;
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
   * Forgets a source's preview copy when the preview could not play it, so the source plays itself
   * from then on. True when there was one to forget - `url` being the copy the preview was given,
   * rather than one that has already been replaced.
   */
  dropPreviewUrl(key: string, url: string): boolean {
    const known = this.previewUrls.value.get(key);
    if (!known || !sameUrl(known, url)) return false;
    const next = new Map(this.previewUrls.value);
    next.delete(key);
    this.droppedPreviewUrls.set(key, known);
    this.previewUrls.value = next;
    return true;
  }

  /**
   * Whether `url` is a preview copy of `key` that [dropPreviewUrl] has already given up on: what an
   * element that was on the same copy as another one finds when its own failure arrives second.
   */
  isDroppedPreviewUrl(key: string, url: string): boolean {
    const dropped = this.droppedPreviewUrls.get(key);
    return !!dropped && sameUrl(dropped, url);
  }

  /** The copies given up on, by key; see [isDroppedPreviewUrl]. */
  private readonly droppedPreviewUrls = new Map<string, string>();

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
      (sel.kind === 'audio' && !!findAudioClip(m, sel.id)) ||
      (sel.kind === 'zoom' && !!findZoom(m, sel.id)) ||
      (sel.kind === 'audioEffect' && !!findAudioEffect(m, sel.id)) ||
      (sel.kind === 'track' && !!trackById(m, sel.id)) ||
      (sel.kind === 'music' && !!m.music);
    if (!stillThere) this.select(null);
    if (this.historyGroup) this.historyGroup.entry = -1;
    // A slider dragged after an undo starts a step of its own rather than folding into one that is
    // now on the redo stack.
    this.coalesced = null;
    // The zoom the sheet is on can be undone out of existence, like the transition sheet's boundary.
    if (this.panel.value === 'zoom' && !this.selectedZoom.value) this.closePanel();
    // And the track the Track sheet shows, by an undo of the run that made it.
    if (this.panel.value === 'track' && this.trackOpen.value && !this.trackShown.value) this.closePanel();
    // And so can the audio effect layer the Audio effects sheet is on.
    if (this.panel.value === 'audioEffects' && !this.selectedAudioEffect.value) this.closePanel();
    // The boundary the transition sheet is on can be undone out of existence - an undo that takes
    // back the clip it was in front of.
    if (this.panel.value === 'transition' && !this.targetBoundary.value) this.closePanel();
    if (this.playheadMs.value > this.totalMs.value) this.seek(this.totalMs.value);
  }

  /* ========================================================================================= */
  /* Selection and chrome                                                                      */
  /* ========================================================================================= */

  select(selection: EditorSelection | null): void {
    // A Pin tile's pin waits only while its track stays what is picked: a sticker sheet or a picker shut
    // with nothing added, and then anything else picked, leaves no pin for a later, unrelated layer.
    if (this.pinNext && !(selection?.kind === 'track' && selection.id === this.pinNext.trackId)) this.pinNext = null;
    this.selection.value = selection;
    this.soundMenuOpen.value = false;
    this.effectsMenuOpen.value = false;
    this.timelineAddMenuOpen.value = false;
    if (selection) this.toolbarMode.value = 'root';
    // A sheet that was about the old selection makes no sense for the new one.
    const panel = this.panel.value;
    if (
      panel === 'speed' ||
      panel === 'volume' ||
      panel === 'opacity' ||
      panel === 'crop' ||
      panel === 'transition' ||
      panel === 'zoom' ||
      panel === 'animation' ||
      panel === 'slip' ||
      panel === 'track'
    )
      this.closePanel();
    // The Audio effects sheet is about a layer, and stays open only while one is what is selected.
    if (panel === 'audioEffects' && selection?.kind !== 'audioEffect') this.closePanel();
  }

  isSelected(selection: EditorSelection): boolean {
    const sel = this.selection.value;
    if (!sel || sel.kind !== selection.kind) return false;
    return sel.kind === 'music' || (sel as { id: string }).id === (selection as { id: string }).id;
  }

  openPanel(panel: EditorPanel | null): void {
    this.soundMenuOpen.value = false;
    this.effectsMenuOpen.value = false;
    this.timelineAddMenuOpen.value = false;
    if (this.panel.value === 'transition' && panel !== 'transition') this.leaveTransition();
    if (this.panel.value === 'animation' && panel !== 'animation') this.leaveAnimation();
    if (this.panel.value === 'slip' && panel !== 'slip') this.leaveSlip();
    if (this.panel.value === 'track' && panel !== 'track') this.leaveTrack();
    // A layout opening still being played is the layout sheet's, and goes with it.
    if (this.panel.value === 'layout' && panel !== 'layout') this.endAudition();
    if (panel !== 'sound') this.soundReplaceTarget.value = null;
    // The Sound sheet opens pulled up to most of the screen, over the editor; see `canExpand`.
    if (panel !== this.panel.value) this.sheetExpanded.value = panel === 'sound';
    this.panel.value = panel;
  }

  closePanel(): void {
    if (this.panel.value === 'transition') this.leaveTransition();
    if (this.panel.value === 'animation') this.leaveAnimation();
    if (this.panel.value === 'slip') this.leaveSlip();
    if (this.panel.value === 'track') this.leaveTrack();
    if (this.panel.value === 'layout') this.endAudition();
    this.panel.value = null;
    this.volumeTarget.value = null;
    this.soundReplaceTarget.value = null;
    this.sheetExpanded.value = false;
  }

  openVolume(target: VolumeTarget): void {
    this.volumeTarget.value = target;
    this.openPanel('volume');
  }

  /** The Sound sheet, adding a sound or, from a Replace tile, putting one in place of `replace`. */
  openSoundSheet(replace: SoundReplaceTarget | null = null): void {
    this.openPanel('sound');
    this.soundReplaceTarget.value = replace;
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
    this.audition(Math.max(0, boundary.atMs - 600), Math.min(this.totalMs.value, boundary.atMs + boundary.effectiveMs + 400), middle);
  }

  /**
   * Plays `fromMs` to `toMs` of the post once, then pauses and parks the preview on `parkMs`. Paused
   * by the customer part way, it is over there and then, and the playhead stays where they stopped
   * it. One at a time: a new one ends the one before.
   */
  private audition(fromMs: number, toMs: number, parkMs: number): void {
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
          this.seek(parkMs);
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

  /**
   * The Trim sheet, on the selected segment: which part of its clip it plays, at the length it has
   * now. Paused, with the preview on the segment's first frame, which is the frame the sheet's strip
   * moves. A picture has no part to choose, and opens nothing.
   */
  openSlip(): void {
    const clip = this.selectedClip.value;
    if (!clip || clip.image) return;
    this.pause();
    this.seekToClip(clip.id);
    this.openPanel('slip');
  }

  /**
   * Plays segment `clipId` from `inMs` of its clip on, at the length it has ([slipClipOp]): live inside
   * the strip's gesture, one step otherwise. The preview goes back to the segment's first frame each
   * time, so the picture follows the strip as it follows the left trim handle.
   */
  slipClip(clipId: string, inMs: number, live = false): void {
    const clip = findClip(this.manifest.value, clipId);
    if (!clip) return;
    const fn = (m: EditManifest): EditManifest => slipClipOp(m, clipId, inMs, this.sourceDurationMs(clip.clipKey));
    if (live) this.preview(fn);
    else if (!this.commit('Trim', fn)) return;
    this.seekToClip(clipId);
  }

  /**
   * Plays segment `clipId` once, first frame to last, and parks the preview back on its first frame:
   * the part as the post will play it, with nothing either side of it.
   */
  auditionClip(clipId: string): void {
    const place = this.clipPlace(clipId);
    if (place) this.audition(place.startMs, place.startMs + place.durationMs, place.startMs);
  }

  /** The playhead to segment `clipId`'s first frame, on the base track or a layer. */
  private seekToClip(clipId: string): void {
    const place = this.clipPlace(clipId);
    if (place) this.seek(place.startMs);
  }

  /**
   * Where segment `clipId` plays on the post: from its first frame, for as long as it is on screen,
   * the stretch under the next clip's transition included. On the base track or a layer; null for a
   * segment the manifest does not have.
   */
  private clipPlace(clipId: string): { startMs: number; durationMs: number } | null {
    const manifest = this.manifest.value;
    const trackId = trackIdOfClip(manifest, clipId);
    if (trackId === undefined) return null;
    const track = trackId === null ? null : findVideoTrack(manifest, trackId);
    const slot = (track ? timelineSlots({ clips: track.clips }) : this.slots.value).find(s => s.clip.id === clipId);
    return slot ? { startMs: (track?.startMs ?? 0) + slot.startMs, durationMs: slot.durationMs + slot.tailMs } : null;
  }

  /** What the Trim sheet was holding, let go of as it shuts: a part still playing stops where it is. */
  private leaveSlip(): void {
    const auditioning = this.stopAudition !== null;
    this.endAudition();
    if (auditioning) this.pause();
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

  /**
   * The canvas colour: what shows wherever no video is drawn - around a video placed smaller than the
   * frame, in letterbox bars, past the end of the base track. Black takes the key off. One undo step.
   */
  setBackground(colour: string): void {
    if (this.commit('Canvas', m => setBackgroundOp(m, colour))) this.haptic('selection');
  }

  /**
   * How the layout opens when the second video comes on and closes when it goes: a style from
   * [LAYOUT_ANIMATIONS], or null for a layout that holds still for the whole post. One undo step.
   *
   * A style keeps the length the layer already has, so trying Slide and then Wipe compares the two
   * moves and not two speeds. Choosing one - or the one already chosen, which is the only way to see
   * it twice - plays the opening on the frame and parks where the layout is open ([auditionLayout]),
   * because a layout that only moves at the edges of the layer is otherwise invisible from wherever
   * the playhead happens to be.
   */
  setLayoutAnimation(trackId: string, id: string | null): void {
    const track = findVideoTrack(this.manifest.value, trackId);
    if (!track) return;
    const preset = id === null ? null : layoutAnimationPreset(id);
    if (id !== null && !preset) return;
    if ((track.layoutAnimation?.id ?? null) !== (preset?.id ?? null)) {
      // An audition left running would go on playing a move that is no longer there.
      if (!preset && this.stopAudition) {
        this.endAudition();
        this.pause();
      }
      const animation = preset ? { id: preset.id, durationMs: track.layoutAnimation?.durationMs ?? DEFAULT_LAYOUT_ANIMATION_MS } : null;
      if (!this.commit('Layout animation', m => setTrackLayoutAnimation(m, trackId, animation))) return;
      this.haptic('selection');
    }
    if (preset) this.auditionLayout(trackId);
  }

  /** How long the opening (and the closing) takes. Live; the slider wraps the drag in a gesture. */
  setLayoutAnimationMs(trackId: string, durationMs: number, live = false): void {
    const current = findVideoTrack(this.manifest.value, trackId)?.layoutAnimation;
    if (!current) return;
    const fn = (m: EditManifest): EditManifest => setTrackLayoutAnimation(m, trackId, { id: current.id, durationMs });
    if (live) this.preview(fn);
    else this.commit('Animation duration', fn);
  }

  /**
   * Plays a layer's layout opening on the frame, once - from a moment before the second video comes
   * on to a moment after the layout has opened - and parks, paused, where it is open, which is how the
   * customer will see it for most of the layer. The times are the render's: [layoutOpenings] is what
   * the keys are compiled from, squeeze and all.
   */
  auditionLayout(trackId: string): void {
    const opening = layoutOpenings(this.manifest.value).find(one => one.trackId === trackId);
    if (!opening) return;
    // Open, but never at the layer's very end, where it is no longer drawn.
    const open = Math.min(opening.startMs + opening.inMs, opening.endMs - 1);
    this.playOnce(Math.max(0, opening.startMs - AUDITION_LEAD_MS), Math.min(opening.endMs, open + AUDITION_TAIL_MS), open);
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
    const pin = layer.kind === 'effect' ? null : this.takePinNext();
    if (
      !this.commit(label, m => {
        const added = addOverlay(m, overlay);
        return added && pin ? (this.pinnedOnThing(added, id, pin) ?? added) : added;
      })
    )
      return null;
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
    const pin = this.takePinNext();
    this.preview(m => {
      const added = addOverlay(m, overlay);
      return added && pin ? (this.pinnedOnThing(added, id, pin) ?? added) : added;
    });
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
    this.preview(m => patchOverlay(m, id, this.pinnedPatch(m, id, patch)));
  }

  commitOverlay(id: string, patch: Parameters<typeof patchOverlay>[2], label: string): void {
    this.commit(label, m => patchOverlay(m, id, this.pinnedPatch(m, id, patch)));
  }

  /**
   * A patch to a TRACKED layer's place, size or angle, as the customer made it on the frame at the
   * playhead - which is where the layer is drawn now, not where it was last put - turned into the patch
   * that draws it there: the track's pin moved to this instant, so it follows the thing from its new
   * place. Every other patch, and every patch to a layer with no track, is handed back as it came.
   */
  private pinnedPatch(m: EditManifest, id: string, patch: Parameters<typeof patchOverlay>[2]): Parameters<typeof patchOverlay>[2] {
    const overlay = findOverlay(m, id);
    if (!overlay?.follow) return patch;
    const shown: ShownPose = {};
    for (const key of ['cx', 'cy', 'scale', 'rotationDeg'] as const) {
      const value = (patch as Record<string, unknown>)[key];
      if (typeof value === 'number') shown[key] = value;
    }
    if (Object.keys(shown).length === 0) return patch;
    const pinned = repinOverlay(overlay, this.sceneOf(m), this.playheadMs.value, shown);
    return pinned ? { ...patch, ...pinned } : patch;
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

  /* -- behind the people -------------------------------------------------------------------- */

  /**
   * Whether a layer can go behind the people in the picture: the export draws the people back over it (the
   * `peopleMatte` [RenderFeature]) and the platform has a people finder ([EditorMediaHost.findSubjects]). The
   * layer row offers Behind people only then, and the preview draws a layer behind only then - anywhere else the
   * export draws it on top, and so does the preview.
   */
  readonly canPutBehind = computed(() => this.renderFeatures.value.includes('peopleMatte') && typeof this.host.media.findSubjects === 'function');

  /** The layer waiting for the people under it to be found before it goes behind them, or null. */
  readonly behindPending = signal<string | null>(null);

  /** Stops waiting for [behindPending]'s people; see [setLayerBehind]. */
  private stopBehindWait: (() => void) | null = null;

  /**
   * Puts layer `id` behind the people in the picture, or back over it. Never an effect, which covers the frame.
   *
   * Behind needs the people of every source on screen while the layer is - the picture over them included, which
   * covers them - so those are looked for first, by Focus's own finder and filed where Focus files its answers
   * ([subjectTracks]), each source looked at once whoever asked. "Finding people..." while that runs; then the
   * layer goes behind as ONE undo step, or, with nobody on screen there, it stays where it is and the customer is
   * told so. Asked again while the people are being found, it says so again; anything else it is asked cancels.
   */
  setLayerBehind(id: string, on: boolean): void {
    const overlay = findOverlay(this.manifest.value, id);
    if (!overlay || overlay.kind === 'effect') return;
    if (!on) {
      this.cancelBehind();
      if (this.commit('Behind people', m => patchOverlay(m, id, { behind: undefined }))) this.haptic('selection');
      return;
    }
    if (overlay.behind || !this.canPutBehind.value) return;
    if (this.behindPending.value === id) {
      this.showToast(FINDING_PEOPLE, FINDING_PEOPLE_MS);
      return;
    }
    this.cancelBehind();
    const window = overlayWireWindow(overlay, this.totalMs.value);
    const keys = peopleSourceKeys(this.manifest.value, [window]);
    for (const key of keys) {
      if (this.subjectTracks.peek().has(key)) continue;
      const source = this.clipByKey(key);
      if (source) this.lookForPeople(source);
    }
    // Null while a source is still being looked at; then whether anybody found is on screen with the layer.
    const answer = (): boolean | null => {
      const tracks = this.subjectTracks.value;
      if (keys.some(key => tracks.get(key)?.status === 'finding')) return null;
      return anyoneIn(this.manifest.peek(), window, key => {
        const state = tracks.get(key);
        return state?.status === 'ready' ? state.result.subjects : null;
      });
    };
    const decide = (found: boolean): void => {
      this.dropFindingToast();
      if (!findOverlay(this.manifest.value, id)) return;
      if (!found) {
        this.showToast('No people found');
        this.haptic('warning');
        return;
      }
      if (this.commit('Behind people', m => patchOverlay(m, id, { behind: true }))) this.haptic('success');
    };
    const now = answer();
    if (now !== null) {
      decide(now);
      return;
    }
    this.behindPending.value = id;
    this.showToast(FINDING_PEOPLE, FINDING_PEOPLE_MS);
    const dispose = effect(() => {
      const found = answer();
      if (found === null) return;
      // Out of the effect, which reads what the commit writes.
      queueMicrotask(() => {
        if (this.stopBehindWait !== stop) return;
        this.cancelBehind();
        decide(found);
      });
    });
    const stop = (): void => dispose();
    this.stopBehindWait = stop;
  }

  /** Stops waiting for the people [behindPending] is waiting for, leaving the layer where it is. */
  private cancelBehind(): void {
    this.stopBehindWait?.();
    this.stopBehindWait = null;
    if (this.behindPending.peek() === null) return;
    this.behindPending.value = null;
    this.dropFindingToast();
  }

  /** "Finding people..." taken down, the moment the people are found or the wait for them is over. */
  private dropFindingToast(): void {
    if (this.toast.peek()?.text === FINDING_PEOPLE) this.toast.value = null;
  }

  /**
   * The people the preview's layers behind them are drawn under: every source's people Focus's finder has found and
   * that has somebody in it, by clip key, and the shapes the preview's elements reported - the same [PeopleSources]
   * the export's matte is made from.
   */
  readonly peopleSources = computed<PeopleSources>(() => {
    const people = new Map<string, SubjectTrack>();
    for (const [key, state] of this.subjectTracks.value) if (state.status === 'ready' && state.result.subjects.length > 0) people.set(key, state.track);
    return { people, aspects: this.sourceShapes.value };
  });

  /** Whether the preview draws any layer behind the people: one is behind, and the export would draw it there. */
  readonly behindShown = computed(() => this.canPutBehind.value && hasBehindLayers(this.manifest.value));

  /** Whether a layer behind the people is on screen at output instant `atMs`. */
  behindOnScreenAt(atMs: number): boolean {
    if (!this.behindShown.value) return false;
    const total = this.totalMs.value;
    return this.manifest.value.overlays.some(overlay => isBehind(overlay) && isOverlayVisibleAt(overlay, atMs, total));
  }

  /**
   * The preview's people on the frame, kept from one frame to the next; see [peopleMaskAt]. The playhead's are
   * kept apart, so a selector read between two painted frames never makes the matte work its grid out again.
   */
  private readonly peopleMask = new PeopleMask();
  private readonly playheadMask = new PeopleMask();

  /**
   * The people on the output frame at output instant `atMs`, as the preview's matte puts them back over the layers
   * behind them: the very grid the export's matte has there, through the camera only while the preview draws one
   * ([cameraLive]). Null while no layer behind the people is on screen then. The grid is the store's own, handed back
   * unchanged while nothing it is made from has moved - [PeopleMaskFrame.version] says when it has.
   */
  peopleMaskAt(atMs: number, mask: PeopleMask = this.peopleMask): PeopleMaskFrame | null {
    if (!this.behindOnScreenAt(atMs)) return null;
    const scene = { manifest: this.manifest.value, camera: this.cameraLive.value ? this.camera.value : null, layout: this.layoutMotions.value };
    return mask.at(scene, this.peopleSources.value, atMs);
  }

  /** [peopleMaskAt] the playhead: the people a paused preview's matte puts back, for whatever shows them. */
  readonly peopleMaskNow = computed(() => this.peopleMaskAt(this.playheadMs.value, this.playheadMask));

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
  /* Tracking                                                                                  */
  /* ========================================================================================= */

  /** The parts of the post a following layer is drawn through, as the render reads them. */
  readonly trackScene = computed<TrackScene>(() => ({ manifest: this.manifest.value, camera: this.camera.value, layout: this.layoutMotions.value }));

  /** The post's tracks, in the order they were made: things in the footage, each a layer of its own. */
  readonly tracks = computed<readonly EditTrack[]>(() => this.manifest.value.tracks ?? NO_TRACKS);

  /** The track picked on the timeline, while a track is what is selected. */
  readonly selectedTrack = computed(() => {
    const sel = this.selection.value;
    return sel?.kind === 'track' ? trackById(this.manifest.value, sel.id) : null;
  });

  /**
   * What the timeline draws each track's row from, in the order the tracks were made: where its footage is
   * on the post (output ms), how sure it was along the way (SOURCE ms, for those stretches to map), how many
   * layers follow it, and how many spots of it are worth a second look.
   */
  readonly trackRows = computed(() => {
    const m = this.manifest.value;
    return this.tracks.value.map(track => {
      // A track's health is its own: read once per track object, not again on every change to the post.
      let read = TRACK_HEALTH.get(track);
      if (!read) TRACK_HEALTH.set(track, (read = { health: trackHealth(track), spots: weakSpots(track).length }));
      return { track, stretches: trackStretches(track, m), health: read.health, followers: followersOf(m.overlays, track.id).length, spots: read.spots };
    });
  });

  /**
   * Where every following layer is drawn at the playhead, by id: what its selection box, a tap and a drag
   * take hold of. A layer that follows nothing, or whose footage has left the post, has no entry and is
   * drawn where it was put.
   */
  readonly trackedPoses = computed<ReadonlyMap<string, TrackedPose>>(() => {
    const following = this.manifest.value.overlays.filter(overlay => overlay.follow && overlay.kind !== 'effect');
    // Nothing following, nothing that moves with the playhead: read it, and every frame of playback would
    // hand whatever reads this a new map.
    if (following.length === 0) return NO_POSES;
    const at = this.playheadMs.value;
    const scene = this.trackScene.value;
    const poses = new Map<string, TrackedPose>();
    for (const overlay of following) {
      const pose = trackedPoseAt(overlay, scene, at);
      if (pose) poses.set(overlay.id, pose);
    }
    return poses;
  });

  /**
   * A layer as it is drawn at the playhead: its own fields, with a following layer's place, size and angle
   * there. A layer that follows nothing is handed straight back WITHOUT reading the playhead, so whatever
   * draws it - the selection box - is not redrawn on every frame of playback for nothing.
   */
  shownOverlay<T extends EditOverlay>(overlay: T): T {
    if (!overlay.follow) return overlay;
    const pose = this.trackedPoses.value.get(overlay.id);
    return pose ? { ...overlay, ...pose } : overlay;
  }

  /** The layer the Track sheet is open on: the selected text, sticker or photo, when the sheet came from one. */
  readonly trackLayer = computed(() => (this.panel.value === 'track' ? this.selectedOverlay.value : null));

  /**
   * Which track the Track sheet shows: the one it was opened on, the one its layer follows, or a new one's
   * once its run lands. Null while a new track is being aimed.
   */
  readonly trackOpen = signal<string | null>(null);

  /** The track the Track sheet shows, while it is open: see [trackOpen]. */
  readonly trackShown = computed(() => (this.panel.value === 'track' ? trackById(this.manifest.value, this.trackOpen.value) : null));

  /** The Track sheet asks which track its layer follows: the post has tracks, and the layer follows none yet. */
  readonly trackChoosing = signal(false);

  /** The Track sheet shows its track's name as a field to type a new one in: Rename on a track's row. */
  readonly trackRenaming = signal(false);

  /**
   * The people in the footage under the Track sheet's box, for a tap on one to aim at them: not looked for
   * yet, being looked for, found, none there, or not something this device can look for.
   */
  readonly trackPeople = signal<'idle' | 'finding' | 'ready' | 'none' | 'unavailable'>('idle');

  /**
   * The Track sheet's box on the frame: what the next run follows. Null while the sheet is shut, and while
   * it shows a track's own box, which [trackThing] draws until the customer moves it.
   */
  readonly trackAim = signal<TrackAim | null>(null);

  /** The box was moved off the shown track's thing: the sheet offers to fix the track from the playhead. */
  readonly trackAimMoved = signal(false);

  /** A run under way, as the sheet shows it. */
  readonly trackRun = signal<TrackRunView | null>(null);

  /** The frame a run is reading and where the thing is in it, a frame at a time: the preview's alone. */
  readonly trackLive = signal<TrackRunLive | null>(null);

  /**
   * Each source's oriented width over its height, by clip key, as the preview's elements report them:
   * which picture is under the Track sheet's box, and where on its source the box lands.
   */
  readonly sourceShapes = signal<ReadonlyMap<string, number>>(new Map());

  /** The run under way: what stops it, what it has found so far, and how that goes on the post. */
  private trackSession: { abort: AbortController; found: () => TrackRunResult | null; land: (found: TrackRunResult) => void } | null = null;

  /** The track the next text, sticker or photo added is pinned to, on its thing: Pin text and its kind. */
  private pinNext: { trackId: string; until: number } | null = null;

  /** How a run opens the footage it reads: the page's own decoder, or frames made up under test. */
  openTrackFootage: (uri: string) => Promise<TrackFrameSource> = openTrackFrames;

  /** How a run measures a source the preview has not reported the shape of yet: off the file, or made up under test. */
  probeTrackFootage: (uri: string) => Promise<{ width: number; height: number }> = probeMedia;

  /** The thing the Track sheet's track follows, at the playhead: its middle and its box on the frame. */
  readonly trackThing = computed(() => {
    const track = this.trackShown.value;
    return track ? trackedThingAt(track, this.trackScene.value, this.playheadMs.value, !!this.trackLayer.value?.follow?.turnWith) : null;
  });

  /** A source's shape, as an element playing it reports it. */
  noteSourceShape(clipKey: string, aspect: number): void {
    if (!(aspect > 0) || this.sourceShapes.value.get(clipKey) === aspect) return;
    this.sourceShapes.value = new Map(this.sourceShapes.value).set(clipKey, aspect);
  }

  /**
   * The Track tool on the main row: a new track, aimed on the frame at the playhead. The box starts in the
   * middle of the picture, and a tap puts it on the thing.
   */
  openNewTrack(): void {
    if (this.tracks.value.length >= MAX_TRACKS) {
      this.showToast(`You can track up to ${MAX_TRACKS} things`);
      this.haptic('warning');
      return;
    }
    this.pause();
    this.select(null);
    this.openPanel('track');
    this.trackOpen.value = null;
    this.trackChoosing.value = false;
    this.trackAimMoved.value = false;
    this.trackAim.value = this.heldAim({ cx: 0.5, cy: 0.45, w: DEFAULT_AIM, h: DEFAULT_AIM * this.frameAspect.value });
    this.haptic('light');
  }

  /**
   * The Track tool on the selected text, sticker or photo: the sheet opens on the track it follows; on a
   * layer that follows none, it asks which of the post's tracks to follow, or - with none yet - aims a new
   * one round the layer. Paused, and on the layer when the playhead is somewhere it is not, because the box
   * is drawn on the frame a run starts from.
   */
  openTrack(): void {
    const overlay = this.selectedOverlay.value;
    if (!overlay || overlay.kind === 'effect') return;
    this.pause();
    this.openPanel('track');
    const total = this.totalMs.value;
    let at = this.playheadMs.value;
    if (!isOverlayVisibleAt(overlay, at, total)) {
      at = overlayWireWindow(overlay, total).startMs;
      this.seek(at);
    }
    const followed = followedTrack(this.manifest.value, overlay);
    this.trackOpen.value = followed?.track.id ?? null;
    this.trackChoosing.value = !followed && this.tracks.value.length > 0;
    this.trackAimMoved.value = false;
    this.trackAim.value = followed ? null : this.aimAround(overlay, at);
    this.haptic('light');
  }

  /** A track's own sheet - how sure it is, its smoothing, and its box to fix it with - from its row. */
  openTrackSheet(trackId: string): void {
    if (!trackById(this.manifest.value, trackId)) return;
    this.pause();
    const sel = this.selection.value;
    if (!(sel?.kind === 'track' && sel.id === trackId)) this.select({ kind: 'track', id: trackId });
    this.openPanel('track');
    this.trackOpen.value = trackId;
    this.trackChoosing.value = false;
    this.trackAimMoved.value = false;
    this.trackAim.value = null;
  }

  /** The Track sheet's layer pinned to track `trackId` where it is drawn now; null aims a new track round it instead. */
  chooseTrack(trackId: string | null): void {
    const overlay = this.trackLayer.value;
    if (!overlay || this.trackRun.value) return;
    this.trackChoosing.value = false;
    if (trackId === null) {
      this.trackOpen.value = null;
      this.trackAim.value = this.aimAround(overlay, this.playheadMs.value);
      return;
    }
    if (this.pinToTrack(overlay.id, trackId)) {
      this.trackOpen.value = trackId;
      this.trackAim.value = null;
    }
  }

  /**
   * A layer dragged on the frame and let go over track `trackId`'s thing: pinned there, where the finger left
   * it, as part of the drag - so the move and the pin are ONE step, and one undo takes both back. Ends the
   * drag's gesture either way: as "Move" alone where the track's footage is not on the post. Whether it pinned.
   */
  dropOnTrack(overlayId: string, trackId: string): boolean {
    const m = this.manifest.value;
    const layer = findOverlay(m, overlayId);
    const track = trackById(m, trackId);
    const patch = layer && track ? this.pinPatch(layer, track, this.sceneOf(m), this.playheadMs.value) : null;
    if (!patch) {
      this.endGesture('Move');
      return false;
    }
    this.preview(next => patchOverlay(next, overlayId, patch));
    this.endGesture('Pin to track');
    this.haptic('success');
    return true;
  }

  /** Pins layer `overlayId` to track `trackId`, exactly where it is drawn at the playhead. Whether it could. */
  pinToTrack(overlayId: string, trackId: string): boolean {
    const done = this.commit('Pin to track', m => {
      const layer = findOverlay(m, overlayId);
      const track = trackById(m, trackId);
      const patch = layer && track ? this.pinPatch(layer, track, this.sceneOf(m), this.playheadMs.value) : null;
      return patch && layer ? patchOverlay(m, layer.id, patch) : null;
    });
    if (done) this.haptic('success');
    else {
      this.showToast('This track is not on the video');
      this.haptic('warning');
    }
    return !!done;
  }

  /**
   * Pin text, Pin sticker and Pin photo: the next text, sticker or photo added - from the tool the toolbar
   * opens next - lands on track `trackId`'s thing at the playhead, pinned to it. Lapses unused after
   * [PIN_NEXT_MS].
   */
  pinNextTo(trackId: string): void {
    if (!trackById(this.manifest.value, trackId)) return;
    this.pinNext = { trackId, until: performance.now() + PIN_NEXT_MS };
  }

  /** The track a layer being added now is pinned to, once: see [pinNextTo]. */
  private takePinNext(): string | null {
    const pin = this.pinNext;
    this.pinNext = null;
    return pin && pin.until > performance.now() && trackById(this.manifest.value, pin.trackId) ? pin.trackId : null;
  }

  /**
   * Layer `id` of `m` put on track `trackId`'s thing at the playhead and pinned to it: a text just over the
   * thing, where a name goes, and a sticker or a photo on it. Null where the thing is not on screen.
   */
  private pinnedOnThing(m: EditManifest, id: string, trackId: string): EditManifest | null {
    const layer = findOverlay(m, id);
    const track = trackById(m, trackId);
    if (!layer || !track || layer.kind === 'effect') return null;
    if (isSurfaceTrack(track)) return this.pinnedOnSurface(m, id, track);
    const at = this.playheadMs.value;
    const thing = trackedThingAt(track, this.sceneOf(m), at);
    if (!thing) return null;
    const top = Math.min(...thing.corners.map(c => c.y));
    const cy = layer.kind === 'text' ? Math.max(0.06, top - 0.05) : thing.cy;
    const placed = patchOverlay(m, id, { cx: within(thing.cx, 0, 1), cy: within(cy, 0, 1) }) ?? m;
    const moved = findOverlay(placed, id);
    const patch = moved ? followPatch(moved, track, this.sceneOf(placed), at) : null;
    return patch ? patchOverlay(placed, id, patch) : null;
  }

  /**
   * The box moved or resized on the frame. Held to the frame and to a fingertip's size. On a track's own
   * box this is the customer fixing the track from here, which the sheet then offers to do.
   */
  setTrackAim(aim: TrackAim): void {
    if (this.panel.value !== 'track' || this.trackRun.value || this.trackChoosing.value) return;
    this.holdTrackFrame();
    this.trackAim.value = this.heldAim(aim);
    if (this.trackShown.value) this.trackAimMoved.value = true;
  }

  /**
   * A finger on the Track sheet's frame: playback - the result playing back, or Play - stopped where it
   * is, so the box is put on the very frame the next run starts from rather than on one the playhead has
   * already left behind.
   */
  holdTrackFrame(): void {
    this.endAudition();
    if (this.playing.value) this.pause();
  }

  /** The box as the frame shows it now: the aim being drawn, or the shown track's thing at the playhead. */
  shownAim(): TrackAim | null {
    const aim = this.trackAim.value;
    if (aim) return aim;
    const thing = this.trackThing.value;
    if (!thing) return null;
    const xs = thing.corners.map(c => c.x);
    const ys = thing.corners.map(c => c.y);
    return this.heldAim({ cx: thing.cx, cy: thing.cy, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
  }

  /**
   * Looks for the people in the footage under the Track sheet's box, so they light up on the picture and a
   * tap on one aims at them ([trackPeopleBoxes], [trackPersonAt]). It is Focus's people finder
   * ([EditorMediaHost.findSubjects]) and Focus's answer: a source Focus has looked at, or is looking at, is
   * not looked at again - the search is the costly part, a whole clip through a segmenter - and the answer
   * filed here in [subjectTracks] is the one Focus finds there, so a clip tracked first focuses at once.
   * Asked again it is the same search, or none. [trackPeople] follows it until the sheet shuts.
   */
  findTrackPeople(): void {
    if (this.panel.value !== 'track') return;
    const source = this.trackPeopleSource();
    if (!source) {
      this.followTrackPeople(null);
      this.trackPeople.value = 'none';
      return;
    }
    if (!this.subjectTracks.peek().has(source.key)) {
      if (!this.host.media.findSubjects) {
        this.followTrackPeople(null);
        this.trackPeople.value = 'unavailable';
        return;
      }
      this.lookForPeople(source);
    }
    this.followTrackPeople(source.key);
  }

  /** Which source [trackPeopleBoxes] are drawn from: the one [findTrackPeople] last looked in. */
  private readonly trackPeopleKey = signal<string | null>(null);

  /** Stops [trackPeople] following a search; see [followTrackPeople]. */
  private stopTrackPeople: (() => void) | null = null;

  /** The source to look for people in: the one under the box, or failing that the picture the frame is made of at the playhead. */
  private trackPeopleSource(): EditorSource | null {
    const aim = this.shownAim();
    const under = aim ? this.footageUnder(aim, this.playheadMs.value) : null;
    const layers = this.previewLayers.value;
    const key = under?.clip.clipKey ?? (layers.find(layer => layer.trackId === null) ?? layers[0])?.clipKey;
    return key ? (this.clipByKey(key) ?? null) : null;
  }

  /**
   * [trackPeople] kept in step with the search for source `key` - this sheet's own or Focus's, whichever
   * is running - until the sheet shuts; null lets go. A search that lands after the sheet has shut still
   * files its answer, for next time and for Focus, and says nothing to a sheet that is gone.
   */
  private followTrackPeople(key: string | null): void {
    if (key !== null && key === this.trackPeopleKey.peek() && this.stopTrackPeople) return;
    this.stopTrackPeople?.();
    this.stopTrackPeople = null;
    this.trackPeopleKey.value = key;
    if (key === null) return;
    this.stopTrackPeople = effect(() => {
      const state = this.subjectTracks.value.get(key);
      let people: 'idle' | 'finding' | 'ready' | 'none' | 'unavailable';
      if (!state) people = 'idle';
      else if (state.status === 'finding') people = 'finding';
      else if (state.status === 'ready') people = state.result.subjects.length > 0 ? 'ready' : 'none';
      else people = state.reason === 'unsupported' ? 'unavailable' : 'none';
      this.trackPeople.value = people;
    });
  }

  /**
   * One source's people looked for, and filed in [subjectTracks] the way `EditorMedia` files Focus's, so
   * Focus - and `EditorMedia` deciding what is still to look for - find it there and do not look again. Not
   * queued behind Focus's searches: the host runs one at a time already, and answers a source it has looked
   * at from what it kept.
   */
  private lookForPeople(source: EditorSource): void {
    const find = this.host.media.findSubjects;
    if (!find) return;
    const key = source.key;
    const file = (state: SubjectTrackState | null): void => {
      const next = new Map(this.subjectTracks.peek());
      if (state) next.set(key, state);
      else next.delete(key);
      this.subjectTracks.value = next;
    };
    file({ status: 'finding', progress: 0 });
    let shown = 0;
    void (async () => {
      try {
        const result = await find.call(this.host.media, source, progress => {
          // A bar that moves a few hundred times on a long clip is a few hundred repaints of the sheet.
          if (progress < 1 && progress - shown < 0.02) return;
          shown = progress;
          file({ status: 'finding', progress });
        });
        if (!result) {
          file({ status: 'none', reason: 'unsupported' });
          return;
        }
        // Read the way the page reads any of its files: through the WebView's own server.
        const bytes = await (await resolve(this.host.platform.fileUrl(result.uri))).arrayBuffer();
        file({ status: 'ready', result, track: parseSubjectTrack(bytes) });
      } catch (error) {
        // Stopped rather than failed: left unfiled, so the next look asks again.
        if ((error as { code?: unknown } | null)?.code === 'cancelled') file(null);
        else file({ status: 'none', reason: 'failed' });
      }
    })();
  }

  /**
   * The people at the playhead, where the picture shows them: each one's cells of the subject grid at the
   * nearest frame the finder read, bounded, and the bounds taken through the clip's own framing - crop, fit,
   * rectangle, turn and camera, as the render places the footage ([trackedFootage]) - to a box on the frame.
   * Kept with the grid and the map, which a tap is tested against ([trackPersonAt]). Null unless the people
   * are ready, the sheet open and the post paused - the Focus sheet's outlines' rule - so playing works
   * none of this out a frame at a time; a finger on the frame pauses it before it asks.
   */
  private readonly trackPeopleFrame = computed(() => {
    if (this.panel.value !== 'track' || this.trackPeople.value !== 'ready' || this.playing.value) return null;
    const key = this.trackPeopleKey.value;
    const state = key ? this.subjectTracks.value.get(key) : undefined;
    if (!key || state?.status !== 'ready') return null;
    // The front-most picture of the source at the playhead, as the preview composites them.
    const layers = this.previewLayers.value;
    let clip: EditClip | null = null;
    for (let i = layers.length - 1; i >= 0 && !clip; i--) if (layers[i]!.clipKey === key) clip = findClip(this.manifest.value, layers[i]!.clipId);
    if (!clip) return null;
    const track = state.track;
    const aspect = this.sourceShapes.value.get(key) ?? track.width / track.height;
    const footage = trackedFootage({ clipId: clip.id, clipKey: key, aspect }, this.trackScene.value, this.playheadMs.value);
    if (!footage) return null;
    let cells: Uint8Array;
    try {
      const span = track.span(clip.image ? 0 : footage.sourceMs);
      cells = track.frame(span.weight < 0.5 ? span.from : span.to);
    } catch {
      return null;
    }
    return { map: footage.map, width: track.width, height: track.height, cells, boxes: this.personBoxes(cells, track.width, track.height, footage.map) };
  });

  /** The people at the playhead as boxes on the frame, for the picture to light up and a tap to aim at: empty unless [trackPeople] is `ready`. */
  readonly trackPeopleBoxes = computed<readonly TrackPersonBox[]>(() => this.trackPeopleFrame.value?.boxes ?? NO_PEOPLE);

  /** Each subject's cells of `cells` (a `gw` by `gh` grid) bounded, and through `map` a box on the frame, held to it. */
  private personBoxes(cells: Uint8Array, gw: number, gh: number, map: Footage['map']): TrackPersonBox[] {
    const left = new Int32Array(256).fill(gw);
    const right = new Int32Array(256).fill(-1);
    const top = new Int32Array(256).fill(gh);
    const bottom = new Int32Array(256).fill(-1);
    const count = new Int32Array(256);
    for (let c = 0; c < cells.length; c++) {
      const id = cells[c]!;
      if (id === 0) continue;
      const x = c % gw;
      const y = (c - x) / gw;
      if (x < left[id]!) left[id] = x;
      if (x > right[id]!) right[id] = x;
      if (y < top[id]!) top[id] = y;
      if (y > bottom[id]!) bottom[id] = y;
      count[id] = count[id]! + 1;
    }
    const output = this.output.value;
    const least = Math.max(12, MIN_PERSON_SHARE * cells.length);
    const boxes: TrackPersonBox[] = [];
    for (let id = 1; id < 256; id++) {
      if (count[id]! < least) continue;
      const corners = [
        map.toOutput(left[id]! / gw, top[id]! / gh),
        map.toOutput((right[id]! + 1) / gw, top[id]! / gh),
        map.toOutput((right[id]! + 1) / gw, (bottom[id]! + 1) / gh),
        map.toOutput(left[id]! / gw, (bottom[id]! + 1) / gh),
      ];
      const x0 = Math.max(0, Math.min(...corners.map(c => c.x)) / output.width);
      const x1 = Math.min(1, Math.max(...corners.map(c => c.x)) / output.width);
      const y0 = Math.max(0, Math.min(...corners.map(c => c.y)) / output.height);
      const y1 = Math.min(1, Math.max(...corners.map(c => c.y)) / output.height);
      // Off the frame, or all but: cropped away, or past a zoom's edge.
      if (!(x1 - x0 > 0.01) || !(y1 - y0 > 0.01)) continue;
      boxes.push({ id, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 });
    }
    return boxes;
  }

  /**
   * The person a tap at frame point `point` (fractions) lands on, or null: the one whose own outline is under
   * the finger, and failing that - between an arm and the body, a gap in a crowd - the smallest box round it.
   * By outline first because boxes overlap where people do, and the one in front is the one tapped.
   */
  trackPersonAt(point: { x: number; y: number }): TrackPersonBox | null {
    const frame = this.trackPeopleFrame.value;
    if (!frame) return null;
    const output = this.output.value;
    const at = frame.map.toSource(point.x * output.width, point.y * output.height);
    if (at) {
      const cx = Math.min(frame.width - 1, Math.max(0, Math.floor(at.u * frame.width)));
      const cy = Math.min(frame.height - 1, Math.max(0, Math.floor(at.v * frame.height)));
      const id = frame.cells[cy * frame.width + cx]!;
      const hit = id > 0 ? frame.boxes.find(box => box.id === id) : undefined;
      if (hit) return hit;
    }
    let best: TrackPersonBox | null = null;
    for (const box of frame.boxes) {
      if (Math.abs(point.x - box.cx) > box.w / 2 || Math.abs(point.y - box.cy) > box.h / 2) continue;
      if (!best || box.w * box.h < best.w * best.h) best = box;
    }
    return best;
  }

  /**
   * The last tap that put the Track sheet's box on something, for the preview to draw it locking on: where
   * the finger landed (frame fractions), the box that tap put there, and whether that box is fitted yet -
   * until it is, the preview draws a small square at the finger. Stale the moment the box is anything else,
   * which the preview tells by `aim` no longer being [trackAim].
   */
  readonly trackLockOn = signal<{ x: number; y: number; aim: TrackAim; fitted: boolean } | null>(null);

  /** Counts taps, so a fit that lands after a newer tap knows it is late. */
  private trackFitSeq = 0;

  /** What stops a fit still reading its frames: a newer tap, and the sheet shutting. */
  private trackFitAbort: AbortController | null = null;

  /**
   * The box round a person the customer tapped ([trackPersonAt]): their outline's box, a little bigger so
   * the tracker has their edge to hold, locking on from the tap. A fit still reading for an earlier tap is
   * called off.
   */
  aimTrackAtPerson(person: TrackPersonBox, tap: { x: number; y: number }): void {
    if (this.panel.value !== 'track' || this.trackRun.value || this.trackChoosing.value) return;
    this.trackFitAbort?.abort();
    this.trackFitAbort = null;
    this.trackFitSeq++;
    const grow = 1 + 2 * PERSON_PAD;
    this.setTrackAim({ cx: person.cx, cy: person.cy, w: person.w * grow, h: person.h * grow });
    const aim = this.trackAim.peek();
    if (!aim) return;
    this.trackLockOn.value = { x: within(tap.x, 0, 1), y: within(tap.y, 0, 1), aim, fitted: true };
    this.haptic('selection');
  }

  /**
   * A tap on the picture while a box is being aimed: the box fitted round whatever is under the finger
   * ([fitBoxAt]) - by how it moves over the next moment of footage where it moves apart from its
   * background, by how it looks otherwise - or a box a thumb wide centred on the tap where neither finds a
   * thing. Ignored while a run is going.
   *
   * The box goes on the tap AT ONCE, a thumb wide, and the preview draws it as a small square at the finger
   * until the fit lands ([trackLockOn]): reading two frames takes a moment, and a finger that sees nothing
   * happen taps again. Whatever happens to the box meanwhile wins over the fit - a newer tap, a drag, a run,
   * the sheet shutting - and a late answer is dropped rather than moving a box the customer has since put
   * somewhere else.
   */
  async fitTrackAimAt(point: { x: number; y: number }): Promise<void> {
    if (this.panel.value !== 'track' || this.trackRun.value || this.trackChoosing.value) return;
    const x = within(point.x, 0, 1);
    const y = within(point.y, 0, 1);
    this.trackFitAbort?.abort();
    const abort = new AbortController();
    this.trackFitAbort = abort;
    const seq = ++this.trackFitSeq;
    this.setTrackAim({ cx: x, cy: y, w: DEFAULT_AIM, h: DEFAULT_AIM * this.frameAspect.value });
    const placed = this.trackAim.peek();
    if (!placed) return;
    this.trackLockOn.value = { x, y, aim: placed, fitted: false };
    const fitted = await this.fitAimAt(x, y, abort.signal).catch(() => null);
    if (this.trackFitAbort === abort) this.trackFitAbort = null;
    if (seq !== this.trackFitSeq || this.trackAim.peek() !== placed || this.panel.value !== 'track' || this.trackRun.value) return;
    if (fitted) this.setTrackAim(fitted);
    const aim = this.trackAim.peek();
    if (!aim) return;
    this.trackLockOn.value = { x, y, aim, fitted: true };
    this.haptic('selection');
  }

  /**
   * The box [fitTrackAimAt] fits round the thing at frame point (`x`, `y`), on the frame at the playhead, or
   * null. The footage under the point is found and opened the way a run finds and opens it, the point taken
   * into the source through the clip's framing and the fitted box's corners brought back out the same way -
   * on a turned clip, the box round all four. Always closes what it opened: a decoder held open is one a run
   * cannot have.
   */
  private async fitAimAt(x: number, y: number, signal: AbortSignal): Promise<TrackAim | null> {
    const at = this.playheadMs.value;
    const under = this.footageUnder({ cx: x, cy: y, w: 0, h: 0 }, at);
    // A picture is not read as footage, and never moves: the box a thumb wide does for it.
    if (!under || under.clip.image) return null;
    const clip = under.clip;
    const uri = this.trackUri(clip.clipKey);
    if (!uri) return null;
    const source = await this.openTrackFootage(uri);
    try {
      if (signal.aborted) return null;
      // Placed by the shape the file reports, which is the shape its frames are read in.
      const footage = trackedFootage({ clipId: clip.id, clipKey: clip.clipKey, aspect: source.aspect }, this.trackScene.value, at);
      if (!footage) return null;
      const output = this.output.value;
      const tap = footage.map.toSourceAnywhere(x * output.width, y * output.height);
      if (!(tap.u >= 0 && tap.u <= 1 && tap.v >= 0 && tap.v <= 1)) return null;
      const frames = await this.fitFrames(source, footage.sourceMs, signal);
      const box = frames ? fitBoxAt(frames.at, tap.u, tap.v, frames.later) : null;
      if (!box) return null;
      const corners = [
        footage.map.toOutput(box.cx - box.w / 2, box.cy - box.h / 2),
        footage.map.toOutput(box.cx + box.w / 2, box.cy - box.h / 2),
        footage.map.toOutput(box.cx + box.w / 2, box.cy + box.h / 2),
        footage.map.toOutput(box.cx - box.w / 2, box.cy + box.h / 2),
      ];
      const x0 = Math.max(0, Math.min(...corners.map(c => c.x)) / output.width);
      const x1 = Math.min(1, Math.max(...corners.map(c => c.x)) / output.width);
      const y0 = Math.max(0, Math.min(...corners.map(c => c.y)) / output.height);
      const y1 = Math.min(1, Math.max(...corners.map(c => c.y)) / output.height);
      if (!(x1 - x0 > 0) || !(y1 - y0 > 0)) return null;
      return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
    } finally {
      source.close();
    }
  }

  /**
   * The frame at SOURCE `atMs` and one [FIT_LATER_MS] on - at the end of the file, one that long before
   * instead, which says as much about what moves - for [fitBoxAt]. Null when not even the first one reads.
   */
  private async fitFrames(source: TrackFrameSource, atMs: number, signal: AbortSignal): Promise<{ at: FitFrame; later: FitFrame | null } | null> {
    let first: TrackFrame | null = null;
    let later: TrackFrame | null = null;
    for await (const frame of source.frames(atMs, atMs + FIT_LATER_MS, signal)) {
      if (!first) first = frame;
      else later = frame;
      if (frame.timeMs - first.timeMs >= FIT_LATER_MS * 0.8) break;
    }
    if (!first) return null;
    if (!later || later.timeMs - first.timeMs < FIT_LATER_MS / 3) {
      later = null;
      const before = Math.max(0, atMs - FIT_LATER_MS);
      if (atMs - before >= FIT_LATER_MS / 3) {
        for await (const frame of source.frames(before, before, signal)) {
          later = frame;
          break;
        }
      }
    }
    const shape = (frame: TrackFrame): FitFrame => ({ width: source.width, height: source.height, luma: frame.luma });
    return { at: shape(first), later: later && later.timeMs !== first.timeMs ? shape(later) : null };
  }

  /** What the taps on the Track sheet's frame were doing, let go of as it shuts: a fit still reading, the lock-on, the people followed. */
  private letGoOfTrackTaps(): void {
    this.trackFitAbort?.abort();
    this.trackFitAbort = null;
    this.trackFitSeq++;
    this.trackLockOn.value = null;
    this.followTrackPeople(null);
    this.trackPeople.value = 'idle';
  }

  /** Back to the track's own box: the fix the customer started, put down. */
  cancelTrackAim(): void {
    if (!this.trackShown.value) return;
    this.trackAim.value = null;
    this.trackAimMoved.value = false;
  }

  /**
   * Follows what is in the box, from the frame the playhead is on. With no track shown it makes a new one:
   * through the layer's time on screen when the sheet came from a layer, which is then pinned to it, or
   * through the whole segment under the box. With a track shown and its box moved, it fixes that track: both
   * ways from here until each way meets the old path again, blended back into it ([mendTrack]).
   *
   * The finished track goes on as ONE step, and plays back once so the customer sees the thing followed
   * without reaching for Play. Stopped - by Stop, or by the sheet closing under it, which is the customer
   * being done - it keeps what was found.
   */
  async startTracking(): Promise<void> {
    // Four corners on a flat surface, or a surface track shown: the surface's own run.
    if (this.trackAimKind.peek() === 'surface' || isSurfaceTrack(this.trackShown.peek())) return this.startSurfaceTracking();
    // A tap's fit still reading its two frames: waited for, so the run follows the fitted box rather than
    // the thumb-wide one put down while the fit reads - and the tap on Track is not lost meanwhile.
    for (const until = performance.now() + FIT_WAIT_MS; this.trackLockOn.peek()?.fitted === false && performance.now() < until; ) {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const aim = this.shownAim();
    const fixing = this.trackShown.value;
    if (!aim || this.trackRun.value || this.trackChoosing.value) return;
    if (fixing && !this.trackAimMoved.value) return;
    const overlay = fixing ? null : this.trackLayer.value;
    if (overlay?.kind === 'effect') return;
    if (!fixing && this.tracks.value.length >= MAX_TRACKS) {
      this.showToast(`You can track up to ${MAX_TRACKS} things`);
      this.haptic('warning');
      return;
    }
    this.pause();
    this.endAudition();
    const at = this.playheadMs.value;
    const m = this.manifest.value;
    const under = this.footageUnder(aim, at);
    if (!under) {
      this.showToast('Put the box on the video');
      this.haptic('warning');
      return;
    }
    const { clip, laneStart, slot } = under;
    if (fixing && clip.clipKey !== fixing.clipKey) {
      this.showToast('Put the box on the tracked video');
      this.haptic('warning');
      return;
    }
    const uri = this.trackUri(clip.clipKey);
    const trackId = fixing?.id ?? null;
    const overlayId = overlay?.id ?? null;
    const land = (found: TrackRunResult, reveal: boolean): void =>
      trackId ? this.landFix(trackId, at, found, reveal) : this.landNewTrack(overlayId, at, found, reveal);

    // The run is under way from the tap, before anything is waited for: Stop, or the sheet shutting, while
    // the clip is still being measured calls it off - rather than a run starting later behind a shut sheet -
    // and a second tap meanwhile starts nothing more.
    const abort = new AbortController();
    const session = { abort, found: (): TrackRunResult | null => null, land: (found: TrackRunResult) => land(found, false) };
    this.trackSession = session;
    const view: TrackRunView = { trackId, overlayId, clipId: clip.id, clipKey: clip.clipKey, outputMs: at, mode: trackId ? 'fix' : 'new', progress: 0 };
    this.trackRun.value = view;
    this.trackLive.value = null;
    const giveUp = (message?: string): void => {
      if (this.trackSession !== session) return;
      this.endTrackRun();
      if (!message) return;
      this.showToast(message);
      this.haptic('warning');
    };

    let aspect = fixing?.aspect ?? this.sourceShapes.value.get(clip.clipKey) ?? 0;
    if (!(aspect > 0) && !clip.image && uri) {
      const probed = await this.probeTrackFootage(uri).catch(() => null);
      if (this.trackSession !== session) return;
      aspect = probed && probed.width > 0 && probed.height > 0 ? probed.width / probed.height : 0;
    }
    if (!(aspect > 0)) aspect = clip.image ? this.frameAspect.value : 0;
    if (!(aspect > 0) || (!clip.image && !uri)) {
      giveUp('This clip cannot be tracked');
      return;
    }

    // The box on the source: its corners taken back through the clip's own framing at this instant.
    const footage = trackedFootage({ clipId: clip.id, clipKey: clip.clipKey, aspect }, this.sceneOf(m), at);
    if (!footage) {
      giveUp();
      return;
    }
    const output = m.output;
    const corners = [
      [aim.cx - aim.w / 2, aim.cy - aim.h / 2],
      [aim.cx + aim.w / 2, aim.cy - aim.h / 2],
      [aim.cx + aim.w / 2, aim.cy + aim.h / 2],
      [aim.cx - aim.w / 2, aim.cy + aim.h / 2],
    ].map(([x, y]) => footage.map.toSourceAnywhere(x! * output.width, y! * output.height));
    const u0 = within(Math.min(...corners.map(c => c.u)), 0, 1);
    const u1 = within(Math.max(...corners.map(c => c.u)), 0, 1);
    const v0 = within(Math.min(...corners.map(c => c.v)), 0, 1);
    const v1 = within(Math.max(...corners.map(c => c.v)), 0, 1);
    if (!(u1 - u0 > 0.005) || !(v1 - v0 > 0.005)) {
      giveUp('Put the box on the video');
      return;
    }
    const box = { cx: (u0 + u1) / 2, cy: (v0 + v1) / 2, w: u1 - u0, h: v1 - v0 };

    // The stretch to follow it through: a new track from a layer, the layer's time on screen inside the
    // segment; any other run, the whole segment - its transition tail included, where the clip plays on
    // under the next one's dissolve. A fix stops short of that wherever it meets the old path again.
    const spanStart = laneStart + slot.startMs;
    const spanEnd = spanStart + Math.max(0, slot.durationMs) + slot.tailMs;
    const window = overlay ? overlayWireWindow(overlay, this.totalMs.value) : { startMs: spanStart, endMs: spanEnd };
    const sourceAt = (outputMs: number) => sourceMsThrough(slot, outputMs - laneStart);
    const anchorMs = footage.sourceMs;
    const fromMs = sourceAt(Math.max(window.startMs, spanStart));
    const toMs = sourceAt(Math.min(window.endMs, spanEnd));

    if (clip.image) {
      // A picture never moves in itself: one sample pins the layer to it, through every zoom and layout.
      const still: TrackRunResult = {
        clipId: clip.id,
        clipKey: clip.clipKey,
        aspect,
        box: { w: box.w, h: box.h },
        atMs: [Math.round(anchorMs)],
        x: [box.cx],
        y: [box.cy],
        scale: [1],
        turn: [0],
        sure: [100],
        lost: [],
        anchorMs: Math.round(anchorMs),
      };
      // Read with nothing waited for, so the run reserved above is still this one.
      this.endTrackRun();
      land(still, false);
      return;
    }

    this.haptic('light');
    let shownAt = -Infinity;
    const run = startTrackRun(
      {
        uri,
        clipId: clip.id,
        clipKey: clip.clipKey,
        anchorMs,
        box,
        fromMs: Math.min(fromMs, anchorMs),
        toMs: Math.max(toMs, anchorMs),
        direction: 'both',
        ...(fixing ? { rejoin: this.rejoinTest(fixing) } : {}),
      },
      live => {
        if (this.trackSession !== session) return;
        const now = performance.now();
        if (now - shownAt >= LIVE_EVERY_MS) {
          shownAt = now;
          this.trackLive.value = live;
        }
        const progress = Math.floor(live.progress * 100) / 100;
        if (progress !== this.trackRun.peek()?.progress) this.trackRun.value = { ...view, progress };
      },
      abort.signal,
      this.openTrackFootage,
    );
    session.found = () => run.found();
    let outcome: TrackRunOutcome;
    try {
      outcome = await run.done;
    } catch {
      if (this.trackSession !== session) return;
      this.endTrackRun();
      this.showToast('This clip cannot be tracked');
      this.haptic('warning');
      return;
    }
    // Stopped, or the sheet shut under it: what it had found went on the post there and then.
    if (this.trackSession !== session) return;
    this.endTrackRun();
    if (!outcome.result) {
      this.showToast('Nothing to follow in this box. Try a bigger one');
      this.haptic('warning');
      return;
    }
    land(outcome.result, !outcome.stopped);
  }

  /**
   * Stop: the run ends where it has got to, and what it found so far goes on the post at once - not once
   * the run has wound down, which a Next tapped straight after would not wait for.
   */
  stopTracking(): void {
    this.settleTrackRun();
  }

  /** Whether a fix's run, at SOURCE `sourceMs` with the thing's middle at `at`, has met `track`'s old path where it was sure. */
  private rejoinTest(track: EditTrack): (sourceMs: number, at: { x: number; y: number }) => boolean {
    const path = trackPath(track);
    const first = track.atMs[0]!;
    const last = track.atMs[track.atMs.length - 1]!;
    return (sourceMs, at) => {
      if (sourceMs < first || sourceMs > last || sureAt(track, sourceMs) * 100 < UNSURE_BELOW) return false;
      const was = pathAt(path, sourceMs);
      return Math.abs(at.x - was.x) <= REJOIN_SLACK * track.box.w * was.scale && Math.abs(at.y - was.y) <= REJOIN_SLACK * track.box.h * was.scale;
    };
  }

  /**
   * A new track from a run, as ONE step: added to the post, named and coloured, and the layer the sheet came
   * from pinned to it where it is drawn on the frame the box was put on (`outputMs`). `reveal` plays it back
   * once: for a run that finished with the sheet still open, so the customer sees the thing followed without
   * reaching for Play.
   */
  private landNewTrack(overlayId: string | null, outputMs: number, found: TrackRunResult, reveal: boolean): void {
    const id = this.newId('track');
    const name = nextTrackName(this.tracks.value);
    const hue = nextTrackHue(this.tracks.value);
    const applied = this.commit('Track', m => {
      if ((m.tracks?.length ?? 0) >= MAX_TRACKS) return null;
      const track = trackFromRun(found, id, name, hue);
      let next: EditManifest = { ...m, tracks: [...(m.tracks ?? []), track] };
      const layer = overlayId ? findOverlay(next, overlayId) : null;
      const patch = layer ? followPatch(layer, track, this.sceneOf(next), outputMs) : null;
      if (layer && patch) next = patchOverlay(next, layer.id, patch) ?? next;
      return next;
    });
    if (!applied) return;
    this.trackOpen.value = id;
    this.trackAim.value = null;
    this.trackAimMoved.value = false;
    // From the main row, the new track is what is selected: its row offers Pin text and the rest.
    if (!overlayId && !this.selection.value) {
      this.selection.value = { kind: 'track', id };
      this.toolbarMode.value = 'root';
    }
    this.haptic('success');
    if (!reveal || this.panel.value !== 'track') return;
    const layer = overlayId ? findOverlay(this.manifest.value, overlayId) : null;
    const track = trackById(this.manifest.value, id);
    const stretch = track ? trackStretches(track, this.manifest.value)[0] : undefined;
    const shown = layer ? overlayWireWindow(layer, this.totalMs.value) : stretch ? { startMs: stretch.startMs, endMs: stretch.endMs } : null;
    if (shown) this.playOnce(shown.startMs, Math.min(shown.endMs, this.totalMs.value, shown.startMs + REVEAL_MS), outputMs);
  }

  /**
   * A fix put on track `trackId` as ONE step ([mendTrack]). Layers pinned inside the mended stretch are moved
   * onto the new path at its edge, so nothing that follows the track moves outside the stretch. `reveal`
   * plays the stretch round the fix once, parked back on the frame the box was put on (`outputMs`).
   */
  private landFix(trackId: string, outputMs: number, found: TrackRunResult, reveal: boolean): void {
    const applied = this.commit('Fix track', m => {
      const old = trackById(m, trackId);
      if (!old || old.clipKey !== found.clipKey || found.atMs.length === 0) return null;
      const mended = mendTrack(old, found);
      const from = found.atMs[0]!;
      const to = found.atMs[found.atMs.length - 1]!;
      // Re-pinned where the two paths agree AS DRAWN: past the reach of the smoothing from the mended stretch,
      // where its raw samples hand over but the smoothed paths still differ by up to a few pixels.
      const reach = 3 * trackSmooth(old) * MAX_SMOOTH_MS;
      const first = old.atMs[0]!;
      const last = old.atMs[old.atMs.length - 1]!;
      const edge = first <= from - reach ? from - reach : last >= to + reach ? to + reach : first < from ? from : last > to ? to : null;
      let next: EditManifest = { ...m, tracks: (m.tracks ?? []).map(t => (t.id === trackId ? mended : t)) };
      if (edge !== null) {
        for (const layer of followersOf(next.overlays, trackId)) {
          const follow = layer.follow!;
          if (follow.pin.atMs < from || follow.pin.atMs > to) continue;
          const moved = refollowAt(old, mended, follow, edge);
          next = patchOverlay(next, layer.id, { follow: moved.follow, rotationDeg: layer.rotationDeg + moved.turn }) ?? next;
        }
      }
      return next;
    });
    if (!applied) return;
    this.trackAim.value = null;
    this.trackAimMoved.value = false;
    this.haptic('success');
    if (reveal && this.panel.value === 'track') this.playOnce(Math.max(0, outputMs - FIX_REVEAL_BEFORE_MS), Math.min(this.totalMs.value, outputMs + FIX_REVEAL_AFTER_MS), outputMs);
  }

  /** The run under way stopped, and what it has found so far put on the post there and then. */
  private settleTrackRun(): void {
    const session = this.trackSession;
    if (!session) return;
    session.abort.abort();
    const found = session.found();
    this.endTrackRun();
    if (found) session.land(found);
  }

  /** Whether the Track sheet's layer grows and shrinks with the thing, and turns with it. Pinned at the playhead first, so it does not jump there. */
  setTrackFollow(patch: { scaleWith?: boolean; turnWith?: boolean }): void {
    const overlay = this.trackLayer.value;
    if (!overlay?.follow) return;
    const changed = this.commit('Track', m => {
      const layer = findOverlay(m, overlay.id);
      if (!layer?.follow) return null;
      const pinned = repinOverlay(layer, this.sceneOf(m), this.playheadMs.value) ?? {};
      const follow = { ...(pinned.follow ?? layer.follow) };
      if (patch.scaleWith === true) follow.scaleWith = true;
      if (patch.scaleWith === false) delete follow.scaleWith;
      if (patch.turnWith === true) follow.turnWith = true;
      if (patch.turnWith === false) delete follow.turnWith;
      return patchOverlay(m, layer.id, { ...pinned, follow });
    });
    if (changed) this.haptic('selection');
  }

  /**
   * How much the shown track's path is smoothed, 0..1. A slider's drag is one step by its coalesce key. Every
   * layer following it stays exactly where it is drawn at the playhead: its pose there taken before the
   * change and pinned to after it.
   */
  setTrackSmooth(value: number, opts?: { coalesce?: CoalesceKey }): void {
    const shown = this.trackShown.value;
    if (!shown) return;
    const smooth = Math.round(within(value, 0, 1) * 100) / 100;
    this.commitCoalesced(
      'Track',
      m => {
        const old = trackById(m, shown.id);
        if (!old || old.smooth === smooth) return null;
        const at = this.playheadMs.value;
        const before = this.sceneOf(m);
        let next: EditManifest = { ...m, tracks: (m.tracks ?? []).map(t => (t.id === old.id ? { ...old, smooth } : t)) };
        const after = this.sceneOf(next);
        for (const layer of followersOf(m.overlays, old.id)) {
          const pose = trackedPoseAt(layer, before, at);
          const pinned = pose ? repinOverlay(layer, after, at, pose) : null;
          if (pinned) next = patchOverlay(next, layer.id, pinned) ?? next;
        }
        return next;
      },
      opts?.coalesce,
    );
  }

  /**
   * Track `trackId`'s look ([EditTrack.look]): `kind` at `amount`, 0..1 - when absent, the strength the track
   * had, or [DEFAULT_LOOK_AMOUNT] - or no look for null. A look is never 0: a Strength dragged to nothing
   * keeps the least the manifest holds, so the look and its slider do not vanish under the finger. A
   * Strength drag is one step by its coalesce key; a new kind is a step of its own, felt as a selection.
   * Whether anything changed.
   */
  setTrackLook(trackId: string, kind: TrackLook['kind'] | null, amount?: number, opts?: { coalesce?: CoalesceKey }): boolean {
    const was = trackById(this.manifest.value, trackId)?.look?.kind ?? null;
    const changed = this.commitCoalesced(
      kind ? 'Look' : 'Remove look',
      m => {
        const track = trackById(m, trackId);
        if (!track) return null;
        const strength = amount ?? track.look?.amount ?? DEFAULT_LOOK_AMOUNT;
        const look = kind ? normaliseTrackLook({ kind, amount: Math.max(0.01, within(strength, 0, 1)) }) : undefined;
        if (look?.kind === track.look?.kind && look?.amount === track.look?.amount) return null;
        const { look: _was, ...rest } = track;
        const next: EditTrack = look ? { ...rest, look } : rest;
        return { ...m, tracks: (m.tracks ?? []).map(t => (t.id === trackId ? next : t)) };
      },
      opts?.coalesce,
    );
    if (changed && kind !== was) this.haptic('selection');
    return changed;
  }

  /** Whether track `trackId` was found in a segment with a Focus of its own, which wins over the track's look there. */
  focusWinsOverLook(trackId: string | null | undefined): boolean {
    const m = this.manifest.value;
    const track = trackById(m, trackId);
    return !!track && focusChangesPicture(findClip(m, track.clipId)?.focus);
  }

  /**
   * [focusWinsOverLook] for the Track sheet's track, which the sheet says in a line of its own. A boolean, so
   * the sheet is not drawn again for every other change to the post.
   */
  readonly trackFocusWins = computed(() => this.focusWinsOverLook(this.trackShown.value?.id));

  /** A track's name, as the customer typed it: trimmed and held to a short length, "Track" when left empty. */
  renameTrack(trackId: string, name: string): void {
    const clean = trackName(name);
    this.commit('Rename track', m => {
      const track = trackById(m, trackId);
      if (!track || track.name === clean) return null;
      return { ...m, tracks: (m.tracks ?? []).map(t => (t.id === trackId ? { ...t, name: clean } : t)) };
    });
  }

  /** None, on a layer's Track sheet: the layer off its track, left standing where it is at the playhead. Closes the sheet. */
  unpinLayer(): void {
    const overlay = this.trackLayer.value;
    if (!overlay) return;
    if (overlay.follow) {
      this.commit('Remove tracking', m => {
        const layer = findOverlay(m, overlay.id);
        return layer?.follow ? patchOverlay(m, layer.id, unfollowOverlay(layer, this.sceneOf(m), this.playheadMs.value)) : null;
      });
      this.haptic('light');
    }
    this.closePanel();
  }

  /** Track `trackId` taken off the post, every layer following it left standing where it is drawn at the playhead. */
  deleteTrack(trackId: string): void {
    const done = this.commit('Remove track', m => {
      if (!trackById(m, trackId)) return null;
      const scene = this.sceneOf(m);
      const at = this.playheadMs.value;
      let next: EditManifest = m;
      for (const layer of followersOf(m.overlays, trackId)) next = patchOverlay(next, layer.id, unfollowOverlay(layer, scene, at)) ?? next;
      // A camera that followed the track holds still, at the view kept on the zoom for that, in the same step.
      if (next.zooms.some(zoom => zoom.follow?.trackId === trackId)) {
        next = {
          ...next,
          zooms: next.zooms.map(zoom => {
            if (zoom.follow?.trackId !== trackId) return zoom;
            const { follow: _follow, ...still } = zoom;
            return still;
          }),
        };
      }
      const tracks = (next.tracks ?? []).filter(t => t.id !== trackId);
      const { tracks: _gone, ...rest } = next;
      return tracks.length > 0 ? { ...rest, tracks } : rest;
    });
    if (!done) return;
    if (this.pinNext?.trackId === trackId) this.pinNext = null;
    if (this.panel.value === 'track' && this.trackOpen.value === trackId) this.closePanel();
    const sel = this.selection.value;
    if (sel?.kind === 'track' && sel.id === trackId) this.select(null);
    this.haptic('light');
  }

  /**
   * The playhead to track `trackId`'s next spot worth a second look after it - round to the first after the
   * last - with the track's sheet open to fix it there. Says so when there is none.
   */
  fixNextSpot(trackId: string): void {
    const m = this.manifest.value;
    const track = trackById(m, trackId);
    if (!track) return;
    const stretches = trackStretches(track, m);
    const times: number[] = [];
    for (const spot of weakSpots(track)) {
      const mid = (spot.fromMs + spot.toMs) / 2;
      const stretch = stretches.find(s => mid >= s.fromMs && mid <= s.toMs);
      if (stretch) times.push(outputMsOf(stretch, mid));
    }
    if (times.length === 0) {
      this.showToast('Nothing to check on this track');
      this.haptic('light');
      return;
    }
    times.sort((a, b) => a - b);
    const now = this.playheadMs.value;
    const next = times.find(t => t > now + 50) ?? times[0]!;
    // On the sheet of a layer that follows this track the sheet stays the layer's - its Follow row and its
    // Remove tracking - and only the playhead and the box move; from anywhere else it opens on the track.
    if (this.panel.value === 'track' && this.trackLayer.value?.follow?.trackId === trackId) {
      this.pause();
      this.endAudition();
      this.trackAim.value = null;
      this.trackAimMoved.value = false;
    } else this.openTrackSheet(trackId);
    this.seek(next);
    this.haptic('selection');
  }

  /**
   * Everything the Track sheet held open, let go of as it shuts: a run stopped and what it found put on the
   * post before the sheet is gone - Next shuts it and reads the post in the same turn - and the box gone.
   */
  private leaveTrack(): void {
    this.settleTrackRun();
    this.letGoOfTrackTaps();
    this.endAudition();
    this.trackAim.value = null;
    this.trackAimMoved.value = false;
    this.trackChoosing.value = false;
    this.trackRenaming.value = false;
    this.trackOpen.value = null;
  }

  private endTrackRun(): void {
    this.trackSession = null;
    this.trackRun.value = null;
    this.trackLive.value = null;
  }

  /** The parts of `m` a following layer is drawn through. */
  private sceneOf(m: EditManifest): TrackScene {
    if (m === this.manifest.value) return this.trackScene.value;
    const layout = compileLayoutMotions(m);
    return { manifest: m, camera: compileCamera(m.zooms ?? [], totalDurationMs(m), { manifest: m, layout }), layout };
  }

  /** A box to start from: a square a thumb wide, round where the layer is drawn at `outputMs`. */
  private aimAround(overlay: EditOverlay, outputMs: number): TrackAim {
    const at = trackedPoseAt(overlay, this.trackScene.value, outputMs) ?? overlay;
    return this.heldAim({ cx: at.cx, cy: at.cy, w: DEFAULT_AIM, h: DEFAULT_AIM * this.frameAspect.value });
  }

  /** A box held to the frame: no smaller than [MIN_AIM] of its shorter side, no bigger than it, its middle on it. */
  private heldAim(aim: TrackAim): TrackAim {
    const aspect = this.frameAspect.value;
    // The shorter side as fractions of the width and of the height.
    const minW = MIN_AIM * Math.min(1, 1 / aspect);
    const minH = MIN_AIM * Math.min(1, aspect);
    return {
      cx: within(aim.cx, 0, 1),
      cy: within(aim.cy, 0, 1),
      w: within(aim.w, minW, 1),
      h: within(aim.h, minH, 1),
    };
  }

  /**
   * The video under the middle of `aim` at `outputMs`: the front-most picture there, as the preview
   * composites them, with the segment's place on its lane. Null over a letterbox bar or the black past a
   * layer's rectangle, where there is nothing to follow.
   */
  private footageUnder(aim: TrackAim, outputMs: number): { clip: EditClip; laneStart: number; slot: TimelineSlot } | null {
    const m = this.manifest.value;
    const scene = this.trackScene.value;
    const output = m.output;
    const layers = [...this.previewLayers.value].reverse();
    for (const layer of layers) {
      const clip = findClip(m, layer.clipId);
      if (!clip) continue;
      const aspect = this.sourceShapes.value.get(clip.clipKey) ?? 0;
      let hit: boolean;
      if (aspect > 0) {
        hit = !!trackedFootage({ clipId: clip.id, clipKey: clip.clipKey, aspect }, scene, outputMs)?.map.toSource(aim.cx * output.width, aim.cy * output.height);
      } else {
        // Its shape not known yet: its rectangle stands in for its picture.
        const rect = clip.rect ?? { x: 0, y: 0, w: 1, h: 1 };
        hit = aim.cx >= rect.x && aim.cx <= rect.x + rect.w && aim.cy >= rect.y && aim.cy <= rect.y + rect.h;
      }
      if (!hit) continue;
      const lane = layer.trackId === null ? { clips: m.clips, startMs: 0 } : m.videoTracks.find(t => t.id === layer.trackId);
      const slot = lane ? timelineSlots({ clips: lane.clips }).find(s => s.clip.id === clip.id) : undefined;
      if (lane && slot) return { clip, laneStart: lane.startMs, slot };
    }
    return null;
  }

  /** A URL the page can decode a source from: the preview's own copy where there is one, as the preview plays it. */
  private trackUri(clipKey: string): string {
    const copy = this.previewUrls.value.get(clipKey);
    if (copy) return copy;
    const source = this.clips.value.find(s => s.key === clipKey);
    if (!source) return '';
    if (source.playbackUrl) return source.playbackUrl;
    return source.sourcePath ? this.host.platform.fileUrl(source.sourcePath) : '';
  }

  /* -- flat surfaces ------------------------------------------------------------------------ */

  /**
   * What the export draws beyond every build ([RenderFeature]), as the host's render says once asked
   * ([loadRenderFeatures]): which tools are offered. None until it answers, and none from a host that cannot.
   */
  readonly renderFeatures = signal<readonly RenderFeature[]>([]);

  /** Whether the export draws a layer on a flat surface in perspective: the Track sheet offers Flat surface. */
  readonly canTrackSurfaces = computed(() => this.renderFeatures.value.includes('overlayQuad'));

  private renderFeaturesAsked = false;

  /** Asks the host's render what it draws, once; [renderFeatures] holds the answer. */
  loadRenderFeatures(): void {
    if (this.renderFeaturesAsked) return;
    this.renderFeaturesAsked = true;
    const render = this.host.render;
    const ask = render?.renderFeatures;
    if (typeof ask !== 'function') return;
    void Promise.resolve()
      .then(() => ask.call(render))
      .then(
        features => {
          const known = Array.isArray(features) ? RENDER_FEATURES.filter(feature => features.includes(feature)) : [];
          if (known.length > 0) this.renderFeatures.value = known;
        },
        () => undefined,
      );
  }

  /** What the Track sheet's aim goes on: a thing, in a box, or a flat surface, by its four corners. */
  readonly trackAimKind = signal<'box' | 'surface'>('box');

  /**
   * The four corners the Track sheet puts on a flat surface, as fractions of the frame - x0, y0, ... top-left,
   * top-right, bottom-right, bottom-left. Null while a box is aimed, and on a surface track's own sheet until
   * the customer tracks it again ([retrackSurface]).
   */
  readonly surfaceAim = signal<readonly number[] | null>(null);

  /** The frame a surface run reads and the surface in it, a frame at a time: the preview's alone. */
  readonly surfaceLive = signal<PlaneRunLive | null>(null);

  /** The run under way is a surface's: what the preview draws it as. */
  readonly surfaceRunning = signal(false);

  /** The shown surface track's quad at the playhead, fractions of the frame: null for no surface, or one off the post. */
  readonly surfaceThing = computed(() => {
    const track = this.trackShown.value;
    return track && isSurfaceTrack(track) ? surfaceQuadAt(track, null, this.trackScene.value, this.playheadMs.value) : null;
  });

  /** Whether the Track sheet's frame belongs to four corners: a surface aimed, or a surface track shown. */
  readonly surfaceAiming = computed(
    () => this.panel.value === 'track' && !this.trackChoosing.value && (this.trackAimKind.value === 'surface' || isSurfaceTrack(this.trackShown.value)),
  );

  /** Box or Flat surface on the Track sheet: a surface's corners start on the box. Flat surface only where the export draws one. */
  setTrackAimKind(kind: 'box' | 'surface'): void {
    if (this.panel.value !== 'track' || this.trackRun.value || this.trackChoosing.value || kind === this.trackAimKind.value) return;
    if (kind === 'surface') {
      if (!this.canTrackSurfaces.value) return;
      const aim = this.shownAim() ?? this.heldAim({ cx: 0.5, cy: 0.45, w: DEFAULT_AIM, h: DEFAULT_AIM * this.frameAspect.value });
      const x0 = aim.cx - aim.w / 2;
      const x1 = aim.cx + aim.w / 2;
      const y0 = aim.cy - aim.h / 2;
      const y1 = aim.cy + aim.h / 2;
      this.surfaceAim.value = this.heldSurface([x0, y0, x1, y0, x1, y1, x0, y1]);
    } else {
      this.surfaceAim.value = null;
    }
    this.trackAimKind.value = kind;
    this.haptic('selection');
  }

  /**
   * The four corners moved on the frame: held to it, and taken only while they still make a surface - convex,
   * no corner across another, no side shorter than the smallest box. On a surface track's own sheet this is the
   * customer tracking it again from here, which the sheet then offers. Whether they were taken.
   */
  setSurfaceAim(corners: readonly number[]): boolean {
    if (this.panel.value !== 'track' || this.trackRun.value || this.trackChoosing.value) return false;
    const held = this.heldSurface(corners);
    if (!held) return false;
    this.holdTrackFrame();
    this.surfaceAim.value = held;
    if (this.trackShown.value) this.trackAimMoved.value = true;
    return true;
  }

  /** The corners as the frame shows them: the ones being put down, or the shown surface track's at the playhead. */
  shownSurfaceAim(): readonly number[] | null {
    return this.surfaceAim.value ?? this.surfaceThing.value?.corners ?? null;
  }

  /** Fix by tracking again: the shown surface's corners at the playhead, to put right and track again whole. */
  retrackSurface(): void {
    const track = this.trackShown.value;
    const at = this.surfaceThing.value;
    if (!track || !isSurfaceTrack(track) || !at || this.trackRun.value || this.panel.value !== 'track') return;
    this.pause();
    this.endAudition();
    this.surfaceAim.value = this.heldSurface(at.corners) ?? at.corners;
    this.trackAimMoved.value = true;
    this.haptic('light');
  }

  /** Cancel on a surface tracked again: back to the surface as it was tracked. */
  cancelSurfaceAim(): void {
    this.surfaceAim.value = null;
    this.cancelTrackAim();
  }

  /** The corners put down and the aim back to a box: what the Track sheet opens with. */
  resetSurfaceAim(): void {
    this.trackAimKind.value = 'box';
    this.surfaceAim.value = null;
  }

  /**
   * `corners` held near the frame, or null for four that make no surface. A finger only ever drags a corner
   * within the frame, but a surface tracked again may reach past its edge, and is kept the shape it is.
   */
  private heldSurface(corners: readonly number[]): number[] | null {
    if (corners.length !== 8 || !corners.every(Number.isFinite)) return null;
    const aspect = this.frameAspect.value;
    const held = corners.map(v => within(v, -0.5, 1.5));
    // In units of the frame's height, where a fold and a length mean what they look like.
    const square = held.map((v, k) => (k % 2 === 0 ? v * aspect : v));
    if (!isConvexQuad(square)) return null;
    const least = MIN_AIM * Math.min(1, aspect);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      if (Math.hypot(square[2 * j]! - square[2 * k]!, square[2 * j + 1]! - square[2 * k + 1]!) < least) return null;
    }
    return held;
  }

  /** [followPatch], or on a surface [surfaceFollowPatch]: a layer pinned to a surface is drawn on it. */
  private pinPatch(layer: EditOverlay, track: EditTrack, scene: TrackScene, outputMs: number): Partial<EditOverlay> | null {
    return isSurfaceTrack(track) ? surfaceFollowPatch(layer, track, scene, outputMs) : followPatch(layer, track, scene, outputMs);
  }

  /** Layer `id` of `m` put ON surface `track` at the playhead ([placeOnSurface]): a photo filling it, a text or a sticker in its middle. */
  private pinnedOnSurface(m: EditManifest, id: string, track: EditTrack): EditManifest | null {
    const layer = findOverlay(m, id);
    if (!layer || layer.kind === 'effect') return null;
    const patch = placeOnSurface(layer, track, this.sceneOf(m), this.playheadMs.value, this.bitmaps.peek().get(id) ?? null);
    return patch ? patchOverlay(m, id, patch) : null;
  }

  /**
   * Track on four corners ([startTracking] while they are put down): the surface under them followed from the
   * frame the playhead is on - through the layer's time on screen when the sheet came from a layer, which is
   * then put on it, or through the whole segment under them. On a surface track's own sheet it tracks that
   * surface again WHOLE, since a surface is never mended, keeping its name, its colour and what is on it.
   * Lands as ONE step; stopped, or the sheet shut under it, it keeps what it found.
   */
  private async startSurfaceTracking(): Promise<void> {
    const shown = this.trackShown.value;
    const again = shown && isSurfaceTrack(shown) ? shown : null;
    const corners = this.surfaceAim.value;
    if (!corners || this.trackRun.value || this.trackChoosing.value || (shown && !again)) return;
    const overlay = again ? null : this.trackLayer.value;
    if (overlay?.kind === 'effect') return;
    if (!again && this.tracks.value.length >= MAX_TRACKS) {
      this.showToast(`You can track up to ${MAX_TRACKS} things`);
      this.haptic('warning');
      return;
    }
    this.pause();
    this.endAudition();
    const at = this.playheadMs.value;
    const m = this.manifest.value;
    const middle = quadMiddle(corners) ?? { x: (corners[0]! + corners[4]!) / 2, y: (corners[1]! + corners[5]!) / 2 };
    const under = this.footageUnder({ cx: middle.x, cy: middle.y, w: 0, h: 0 }, at);
    if (!under) {
      this.showToast('Put the corners on the video');
      this.haptic('warning');
      return;
    }
    const { clip, laneStart, slot } = under;
    if (again && clip.clipKey !== again.clipKey) {
      this.showToast('Put the corners on the tracked video');
      this.haptic('warning');
      return;
    }
    const uri = this.trackUri(clip.clipKey);
    const trackId = again?.id ?? null;
    const overlayId = overlay?.id ?? null;
    const land = (found: SurfaceRunResult, reveal: boolean): void =>
      trackId ? this.landSurfaceAgain(trackId, at, found, reveal) : this.landSurface(overlayId, at, found, reveal);

    // Under way from the tap, as a box's run is: Stop, or the sheet shutting, calls it off at any point.
    const abort = new AbortController();
    const session = { abort, found: (): TrackRunResult | null => null, land: (found: TrackRunResult) => land(found as SurfaceRunResult, false) };
    this.trackSession = session;
    const view: TrackRunView = { trackId, overlayId, clipId: clip.id, clipKey: clip.clipKey, outputMs: at, mode: trackId ? 'fix' : 'new', progress: 0 };
    this.trackRun.value = view;
    this.trackLive.value = null;
    this.surfaceLive.value = null;
    this.surfaceRunning.value = true;
    abort.signal.addEventListener('abort', () => {
      this.surfaceRunning.value = false;
      this.surfaceLive.value = null;
    });
    const giveUp = (message?: string): void => {
      if (this.trackSession !== session) return;
      this.endSurfaceRun();
      if (!message) return;
      this.showToast(message);
      this.haptic('warning');
    };

    let aspect = again?.aspect ?? this.sourceShapes.value.get(clip.clipKey) ?? 0;
    if (!(aspect > 0) && !clip.image && uri) {
      const probed = await this.probeTrackFootage(uri).catch(() => null);
      if (this.trackSession !== session) return;
      aspect = probed && probed.width > 0 && probed.height > 0 ? probed.width / probed.height : 0;
    }
    if (!(aspect > 0)) aspect = clip.image ? this.frameAspect.value : 0;
    if (!(aspect > 0) || (!clip.image && !uri)) {
      giveUp('This clip cannot be tracked');
      return;
    }

    // The corners on the source: taken back through the clip's own framing at this instant.
    const footage = trackedFootage({ clipId: clip.id, clipKey: clip.clipKey, aspect }, this.sceneOf(m), at);
    if (!footage) {
      giveUp();
      return;
    }
    const output = m.output;
    const onSource: number[] = [];
    for (let k = 0; k < 4; k++) {
      const p = footage.map.toSourceAnywhere(corners[2 * k]! * output.width, corners[2 * k + 1]! * output.height);
      onSource.push(p.u, p.v);
    }
    if (!onSource.every(v => v > -0.5 && v < 1.5) || !isConvexQuad(onSource.map((v, k) => (k % 2 === 0 ? v * aspect : v)))) {
      giveUp('Put the corners on the video');
      return;
    }

    const spanStart = laneStart + slot.startMs;
    const spanEnd = spanStart + Math.max(0, slot.durationMs) + slot.tailMs;
    const window = overlay ? overlayWireWindow(overlay, this.totalMs.value) : { startMs: spanStart, endMs: spanEnd };
    const sourceAt = (outputMs: number) => sourceMsThrough(slot, outputMs - laneStart);
    const anchorMs = footage.sourceMs;
    const fromMs = sourceAt(Math.max(window.startMs, spanStart));
    const toMs = sourceAt(Math.min(window.endMs, spanEnd));
    const round5 = (v: number) => Math.round(v * 1e5) / 1e5 + 0;

    if (clip.image) {
      // A picture never moves in itself: one sample of the surface, through every zoom and layout.
      const xs = [onSource[0]!, onSource[2]!, onSource[4]!, onSource[6]!];
      const ys = [onSource[1]!, onSource[3]!, onSource[5]!, onSource[7]!];
      const mid = quadMiddle(onSource) ?? { x: (xs[0]! + xs[2]!) / 2, y: (ys[0]! + ys[2]!) / 2 };
      const still: SurfaceRunResult = {
        clipId: clip.id,
        clipKey: clip.clipKey,
        aspect,
        box: { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
        atMs: [Math.round(anchorMs)],
        x: [round5(mid.x)],
        y: [round5(mid.y)],
        scale: [1],
        turn: [0],
        sure: [100],
        lost: [],
        anchorMs: Math.round(anchorMs),
        corners: onSource.map(round5),
      };
      this.endSurfaceRun();
      land(still, false);
      return;
    }

    this.haptic('light');
    let shownAt = -Infinity;
    const run = startPlaneRun(
      { uri, clipId: clip.id, clipKey: clip.clipKey, anchorMs, corners: onSource, fromMs: Math.min(fromMs, anchorMs), toMs: Math.max(toMs, anchorMs), direction: 'both' },
      live => {
        if (this.trackSession !== session) return;
        const now = performance.now();
        if (now - shownAt >= LIVE_EVERY_MS) {
          shownAt = now;
          this.surfaceLive.value = live;
        }
        const progress = Math.floor(live.progress * 100) / 100;
        if (progress !== this.trackRun.peek()?.progress) this.trackRun.value = { ...view, progress };
      },
      abort.signal,
      this.openTrackFootage,
    );
    session.found = () => run.found();
    let outcome: PlaneRunOutcome;
    try {
      outcome = await run.done;
    } catch {
      if (this.trackSession !== session) return;
      this.endSurfaceRun();
      this.showToast('This clip cannot be tracked');
      this.haptic('warning');
      return;
    }
    if (this.trackSession !== session) return;
    this.endSurfaceRun();
    if (!outcome.result) {
      this.showToast('Nothing to follow on this surface');
      this.haptic('warning');
      return;
    }
    land(outcome.result, !outcome.stopped);
  }

  /** A surface run over: the run let go of, and the frame it drew with it. */
  private endSurfaceRun(): void {
    this.endTrackRun();
    this.surfaceLive.value = null;
    this.surfaceRunning.value = false;
  }

  /**
   * A new surface from a run, as ONE step: "Surface 1", "Surface 2", ... in the next free colour, and the layer
   * the sheet came from put on it ([placeOnSurface]) on the frame the corners were put on. `reveal` plays it
   * back once, as a new track's does.
   */
  private landSurface(overlayId: string | null, outputMs: number, found: SurfaceRunResult, reveal: boolean): void {
    const id = this.newId('track');
    const name = nextSurfaceName(this.tracks.value);
    const hue = nextTrackHue(this.tracks.value);
    const applied = this.commit('Track', m => {
      if ((m.tracks?.length ?? 0) >= MAX_TRACKS) return null;
      const track = surfaceTrackFromRun(found, id, name, hue);
      let next: EditManifest = { ...m, tracks: [...(m.tracks ?? []), track] };
      const layer = overlayId ? findOverlay(next, overlayId) : null;
      const patch = layer ? placeOnSurface(layer, track, this.sceneOf(next), outputMs, this.bitmaps.peek().get(layer.id) ?? null) : null;
      if (layer && patch) next = patchOverlay(next, layer.id, patch) ?? next;
      return next;
    });
    if (!applied) return;
    this.trackOpen.value = id;
    this.trackAim.value = null;
    this.trackAimMoved.value = false;
    this.resetSurfaceAim();
    if (!overlayId && !this.selection.value) {
      this.selection.value = { kind: 'track', id };
      this.toolbarMode.value = 'root';
    }
    this.haptic('success');
    if (!reveal || this.panel.value !== 'track') return;
    const layer = overlayId ? findOverlay(this.manifest.value, overlayId) : null;
    const track = trackById(this.manifest.value, id);
    const stretch = track ? trackStretches(track, this.manifest.value)[0] : undefined;
    const shown = layer ? overlayWireWindow(layer, this.totalMs.value) : stretch ? { startMs: stretch.startMs, endMs: stretch.endMs } : null;
    if (shown) this.playOnce(shown.startMs, Math.min(shown.endMs, this.totalMs.value, shown.startMs + REVEAL_MS), outputMs);
  }

  /** Surface `trackId` tracked again whole, as ONE step: its samples replaced, its name, colour, smoothing and look kept, and so every layer on it. */
  private landSurfaceAgain(trackId: string, outputMs: number, found: SurfaceRunResult, reveal: boolean): void {
    const applied = this.commit('Fix track', m => {
      const old = trackById(m, trackId);
      if (!old || old.clipKey !== found.clipKey || found.atMs.length === 0) return null;
      const fresh = surfaceTrackFromRun(found, old.id, old.name, old.hue, old.smooth);
      if (old.look) fresh.look = old.look;
      return { ...m, tracks: (m.tracks ?? []).map(t => (t.id === trackId ? fresh : t)) };
    });
    if (!applied) return;
    this.trackAim.value = null;
    this.trackAimMoved.value = false;
    this.resetSurfaceAim();
    this.haptic('success');
    if (reveal && this.panel.value === 'track') this.playOnce(Math.max(0, outputMs - FIX_REVEAL_BEFORE_MS), Math.min(this.totalMs.value, outputMs + FIX_REVEAL_AFTER_MS), outputMs);
  }

  /**
   * Every layer on a flat surface, by id: its quad, and the part of its bitmap drawn - compiled as
   * [toComposeSpec] compiles them ([compileOverlayQuad]), over its wire window and against its own bitmap, so
   * the preview draws it in perspective by the very keys the render is handed. No entry for a layer whose
   * bitmap is not drawn yet. Recomputed when the post changes, a layer kept whole while nothing it is compiled
   * from has: a drag across the frame changes one layer.
   */
  readonly overlayQuads = computed<ReadonlyMap<string, SurfaceQuad>>(() => {
    const m = this.manifest.value;
    const bitmaps = this.bitmaps.value;
    if (!m.overlays.some(o => o.follow?.onSurface)) {
      this.compiledQuads.clear();
      return this.noQuads;
    }
    const total = this.totalMs.value;
    const scene = this.trackScene.value;
    const quads = new Map<string, SurfaceQuad>();
    const kept: typeof this.compiledQuads = new Map();
    for (const overlay of m.overlays) {
      const on = surfaceOf(m, overlay);
      const bitmap = on ? bitmaps.get(overlay.id) : undefined;
      if (!on || !bitmap) continue;
      const { startMs, endMs } = overlayWireWindow(overlay, total);
      // A bitmap drawn at an older size - a pinch running ahead of the redraw - stands for the size the layer is now.
      const k = bitmap.scale > 0 ? overlay.scale / bitmap.scale : 1;
      const size = { wPx: bitmap.wPx * k, hPx: bitmap.hPx * k };
      const from = [overlay, on.track, size.wPx, size.hPx, startMs, endMs, m.clips, m.videoTracks, m.output, m.fit, scene.camera, scene.layout];
      const known = this.compiledQuads.get(overlay.id);
      const quad = known && known.from.every((v, i) => v === from[i]) ? known.quad : compileOverlayQuad(overlay, scene, { startMs, endMs }, size);
      kept.set(overlay.id, { from, quad });
      if (quad) quads.set(overlay.id, quad);
    }
    this.compiledQuads = kept;
    return quads;
  });

  /** What [overlayQuads] compiled last time, and from what, so an unchanged layer is not compiled again. */
  private compiledQuads = new Map<string, { from: unknown[]; quad: SurfaceQuad | null }>();

  private readonly noQuads: ReadonlyMap<string, SurfaceQuad> = new Map();

  /* -- end of flat surfaces ----------------------------------------------------------------- */

  /* ========================================================================================= */  /* Colour                                                                                    */
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

  /** Adds an independently placed sound and selects it. A lane is reused when it has room. */
  addAudioClip(music: EditMusic, targetTrackId?: string): string | null {
    const id = this.newId('audio');
    const trackId = this.newId('at');
    const clip: EditAudioClip = { ...music, id };
    if (!this.commit('Add audio', m => addAudioClipOp(m, clip, trackId, targetTrackId))) return null;
    this.select({ kind: 'audio', id });
    this.haptic('light');
    return id;
  }

  removeSelectedAudio(): void {
    const selected = this.selectedAudio.value;
    if (selected && this.commit('Remove audio', m => removeAudioClip(m, selected.id))) this.select(null);
  }

  /**
   * Cuts the selected sound in two at the playhead and selects the right half, as Cut does to a clip
   * and a layer; see [splitAudioClipAt] for what each half keeps.
   */
  splitSelectedAudioAtPlayhead(): void {
    const sound = this.selectedSoundOnLane();
    if (!sound) return;
    const newId = this.newId('audio');
    const at = this.playheadMs.value;
    const cut = this.commit('Cut', m => {
      const onLane = sound.onLane(m);
      return onLane && splitAudioClipAt(onLane, sound.id, at, newId);
    });
    if (cut) {
      this.select({ kind: 'audio', id: newId });
      this.haptic('light');
      return;
    }
    this.showToast(`Move the playhead inside the ${sound.noun} to cut it`);
    this.haptic('warning');
  }

  /** A copy of the selected sound, selected; see [duplicateAudioClip] for where it goes. */
  duplicateSelectedAudio(): void {
    const sound = this.selectedSoundOnLane();
    if (!sound) return;
    const newId = this.newId('audio');
    const trackId = this.newId('at');
    const copied = this.commit('Duplicate', m => {
      const onLane = sound.onLane(m);
      return onLane && duplicateAudioClipOp(onLane, sound.id, newId, trackId);
    });
    if (copied) {
      this.select({ kind: 'audio', id: newId });
      this.haptic('light');
      return;
    }
    this.showToast(`There is no room for a copy of that ${sound.noun}`);
    this.haptic('warning');
  }

  /**
   * The selected sound as one on a lane, which is where Cut and Duplicate leave two of it: its id there,
   * and the step that puts it there inside the same undo step - none for a lane's own sound, and
   * [musicAsAudioLane] for the music, which has no lane until then. `noun` is what each row calls it.
   */
  private selectedSoundOnLane(): { id: string; noun: 'audio' | 'sound'; onLane: (m: EditManifest) => EditManifest | null } | null {
    const audio = this.selectedAudio.value;
    if (audio) return { id: audio.id, noun: 'audio', onLane: m => m };
    if (!this.musicSelected.value) return null;
    const id = this.newId('audio');
    const trackId = this.newId('at');
    return { id, noun: 'sound', onLane: m => musicAsAudioLane(m, id, trackId) };
  }

  /**
   * Live; wrap in begin/endGesture('Move audio'). Each frame moves the sound from where the drag
   * found it, as the music's drag does from `music0`: a sound carried to the end of the video loses
   * its stop there ([musicMovedTo]), and a compounding move would keep it lost when the finger
   * brought the sound back, cut or not.
   */
  previewMoveAudio(id: string, startMs: number): void {
    this.previewFromStart(m => moveAudioClipOp(m, id, startMs));
  }

  /** Commits the position chosen by the lifted audio rail as one undo step. */
  reorderAudio(id: string, toIndex: number): void {
    if (this.commit('Reorder audio', m => reorderAudioClip(m, id, toIndex))) this.haptic('light');
  }

  moveAudioClipToTrack(id: string, target: AudioDropTarget, startMs: number): boolean {
    const newTrackId = this.newId('at');
    if (!this.commit('Move audio to layer', m => moveAudioClipToTrackOp(m, id, target, startMs, newTrackId))) return false;
    this.select({ kind: 'audio', id });
    this.haptic('light');
    return true;
  }

  /** Live; wrap in begin/endGesture. */
  previewAudioClip(id: string, patch: Partial<EditMusic>): void {
    this.preview(m => patchAudioClip(m, id, patch));
  }

  commitAudioClip(id: string, patch: Partial<EditMusic>, label: string): void {
    this.commit(label, m => patchAudioClip(m, id, patch));
  }

  /** Another file under a placed sound, which stays selected; see [replaceAudioClip] for what is kept. */
  replaceAudioClip(id: string, file: Pick<EditMusic, 'uri' | 'fileName' | 'sourceDurationMs'>): boolean {
    if (!this.commit('Replace audio', m => replaceAudioClipOp(m, id, file))) return false;
    this.select({ kind: 'audio', id });
    this.haptic('light');
    return true;
  }

  /** Read at tap time, as the music's Loop is, and named the same way in the undo toast. */
  toggleAudioLoop(id: string): void {
    const clip = findAudioClip(this.manifest.value, id);
    if (!clip) return;
    const loop = !clip.loop;
    this.commit(loop ? 'Loop on' : 'Loop off', m => setAudioLoop(m, id, loop));
    this.haptic('light');
  }

  /**
   * One sound on the lanes at another speed: live (the Speed sheet's slider, inside its gesture) or as
   * a step, named as a clip's speed is. Live steps are made from where the gesture STARTED
   * ([previewFromStart]): slowing a sound into the next one on its lane stops it there
   * ([audioSpeedPatch]), and a drag back up has to take that stop away again rather than keep it.
   */
  setAudioSpeed(id: string, speed: number, live = false): void {
    if (live) this.previewFromStart(m => setAudioSpeedOp(m, id, speed));
    else this.commit('Speed', m => setAudioSpeedOp(m, id, speed));
  }

  /** The music at another speed, live or as a step; see [setAudioSpeed]. Nothing shares its row. */
  setMusicSpeed(speed: number, live = false): void {
    if (live) this.previewFromStart(m => setMusicSpeedOp(m, speed));
    else this.commit('Speed', m => setMusicSpeedOp(m, speed));
  }

  /* ========================================================================================= */
  /* Audio effect layers                                                                       */
  /* ========================================================================================= */

  /** Every audio effect layer, bottom to top: a later one works on what the ones under it made. */
  readonly audioEffects = computed(() => this.manifest.value.audioEffects ?? []);
  readonly selectedAudioEffect = computed(() => {
    const sel = this.selection.value;
    return sel?.kind === 'audioEffect' ? findAudioEffect(this.manifest.value, sel.id) : null;
  });

  /**
   * The Sound menu's Audio effects: the sheet on no layer at all, where a tile adds one on top of
   * whatever is already at the playhead ([chooseAudioEffect]) - an effect layer is added from here
   * and changed from its own tools, as a picture layer is. Paused, so the sound is where the customer
   * left it.
   */
  openAudioEffects(): void {
    this.pause();
    this.select(null);
    this.openPanel('audioEffects');
  }

  /**
   * A tile of the Audio effects sheet: the selected layer becomes `effectId` at its defaults, or - with
   * none selected - a new one is added at the playhead ([addAudioEffectAtPlayhead]). One undo step named
   * for the effect ("Undo: Megaphone"). Returns whether anything changed.
   */
  chooseAudioEffect(effectId: string): boolean {
    const preset = soundEffectPreset(effectId);
    if (!preset) return false;
    const layer = this.selectedAudioEffect.value;
    if (!layer) return this.addAudioEffectAtPlayhead(preset.id) !== null;
    return this.commit(preset.label, m => updateAudioEffectOp(m, layer.id, { effect: preset.id }));
  }

  /**
   * A layer of `effectId` from the playhead to the end of the post, on top of every other layer -
   * stacked over any already there, as a picture layer is added over the others - selected, as one
   * undo step named for the effect. Its id, or null with the customer told why: at the cap.
   */
  addAudioEffectAtPlayhead(effectId: string): string | null {
    const preset = soundEffectPreset(effectId);
    if (!preset) return null;
    if (this.audioEffects.value.length >= MAX_AUDIO_EFFECTS) {
      this.showToast(`You can add up to ${MAX_AUDIO_EFFECTS} audio effects`);
      this.haptic('warning');
      return null;
    }
    const total = this.totalMs.value;
    // Starting at the very end would make a layer nobody hears; it starts at 0 instead, as a layer does.
    const at = this.playheadMs.value >= total - MIN_LAYER_MS ? 0 : Math.round(this.playheadMs.value);
    const id = this.newId('afx');
    const layer: EditAudioEffect = { id, startMs: at, endMs: total, effect: preset.id };
    // Refused only for a post too short to hold a layer at all.
    if (!this.commit(preset.label, m => addAudioEffectOp(m, layer, total))) return null;
    this.select({ kind: 'audioEffect', id });
    this.haptic('light');
    return id;
  }

  /**
   * One of a layer's sliders at `value` on its 0..100 scale: live, inside the slider's gesture, which
   * lands as one undo step named for the slider ("Undo: Megaphone tone").
   */
  setAudioEffectSetting(id: string, key: string, value: number): void {
    this.preview(m => setAudioEffectSettingOp(m, id, key, value));
  }

  /** A layer's Slow ([EditAudioEffect.speed]): live, inside its slider's gesture, as [setAudioEffectSetting]. */
  setAudioEffectSpeed(id: string, speed: number): void {
    this.preview(m => updateAudioEffectOp(m, id, { speed }));
  }

  /**
   * Moves a layer's window, held to the post and never shorter than [MIN_LAYER_MS], over or under any
   * other layer. One undo step labelled 'Audio effect'; the timeline's drags pass a `coalesce` key from
   * [coalesceKey], and every call with it folds into that one step, as a zoom's drag does.
   */
  setAudioEffectWindow(id: string, startMs: number, endMs: number, opts?: { coalesce?: CoalesceKey }): void {
    const total = this.totalMs.value;
    this.commitCoalesced('Audio effect', m => setAudioEffectWindowOp(m, id, startMs, endMs, total), opts?.coalesce);
  }

  /**
   * Start here and End here: the layer's edge to the playhead, as a picture layer's
   * ([setSelectedOverlayEdge]) - or, with the playhead past its other edge, the whole layer moved
   * there at its length - over or under whatever other layers are there.
   */
  setAudioEffectEdge(id: string, edge: 'start' | 'end'): void {
    const layer = findAudioEffect(this.manifest.value, id);
    if (!layer) return;
    const total = this.totalMs.value;
    const at = Math.round(this.playheadMs.value);
    const length = layer.endMs - layer.startMs;
    const [s, e] =
      edge === 'start'
        ? at <= layer.endMs - MIN_LAYER_MS
          ? [at, layer.endMs]
          : [at, Math.min(total, at + length)]
        : at >= layer.startMs + MIN_LAYER_MS
          ? [layer.startMs, at]
          : [Math.max(0, at - length), at];
    this.commit(edge === 'start' ? 'Start here' : 'End here', m => setAudioEffectWindowOp(m, id, s, e, total));
  }

  /**
   * A copy straight after the layer and one place above it, selected. Says why when there is none: at
   * the cap, or with the layer ending at the end of the post, where nothing can come after it.
   */
  duplicateAudioEffect(id: string): void {
    const newId = this.newId('afx');
    if (!this.commit('Duplicate', m => duplicateAudioEffectOp(m, id, newId, this.totalMs.value))) {
      this.showToast(this.audioEffects.value.length >= MAX_AUDIO_EFFECTS ? `You can add up to ${MAX_AUDIO_EFFECTS} audio effects` : 'No room for a copy after this effect');
      this.haptic('warning');
      return;
    }
    this.select({ kind: 'audioEffect', id: newId });
    this.haptic('light');
  }

  /** The layer in two at the playhead, the second half selected, so it can be given another effect. */
  splitAudioEffectAtPlayhead(id: string): void {
    const newId = this.newId('afx');
    if (!this.commit('Cut', m => splitAudioEffectOp(m, id, this.playheadMs.value, newId))) {
      // A cut makes a second layer, so at the cap it is refused however well the playhead is placed.
      this.showToast(
        this.audioEffects.value.length >= MAX_AUDIO_EFFECTS ? `You can add up to ${MAX_AUDIO_EFFECTS} audio effects` : 'Move the playhead inside the effect to cut it',
      );
      this.haptic('warning');
      return;
    }
    this.select({ kind: 'audioEffect', id: newId });
    this.haptic('light');
  }

  /**
   * The selected layer's place in the stack, with a picture layer's four moves ([moveSelectedLayer]):
   * one up works on what the one it passes made, one down is worked on by it.
   */
  moveAudioEffect(id: string, move: LayerMove): void {
    const labels: Record<LayerMove, string> = {
      forward: 'Bring forward',
      backward: 'Send backward',
      front: 'Bring to front',
      back: 'Send to back',
    };
    if (this.commit(labels[move], m => moveAudioEffectOp(m, id, move))) {
      this.haptic('light');
    } else {
      this.showToast(move === 'forward' || move === 'front' ? 'Already on top' : 'Already at the bottom');
    }
  }

  /** A layer held and dropped at another place in the stack on the timeline, 0 being the bottom. */
  moveAudioEffectTo(id: string, toIndex: number): boolean {
    if (!this.commit('Effect order', m => moveAudioEffectToOp(m, id, toIndex))) return false;
    this.haptic('light');
    return true;
  }

  /** Deletes a layer; its sheet closes with it when it was the one open. */
  deleteAudioEffect(id: string): void {
    if (!this.commit('Delete', m => deleteAudioEffectOp(m, id))) return;
    if (this.isSelected({ kind: 'audioEffect', id })) this.select(null);
    if (this.panel.value === 'audioEffects') this.closePanel();
    this.haptic('light');
  }

  /**
   * The sound moved whole to the playhead, as Start here moves the music. A lane plays one sound at
   * a time, so another one in the way stops it, and the toast says why nothing moved.
   */
  startAudioHere(id: string): void {
    const clip = findAudioClip(this.manifest.value, id);
    if (!clip) return;
    const moved = musicMovedTo(clip, this.playheadMs.value, this.totalMs.value);
    if (moved.startMs === clip.startMs && moved.endMs === clip.endMs) return;
    if (this.commit('Move audio', m => patchAudioClip(m, id, moved))) return;
    this.showToast('There is no room for that audio here');
    this.haptic('warning');
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
        case 'audio':
          return patchAudioClip(m, target.id, { volume: v });
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
  /**
   * The selected zoom. One that follows a track is handed out as the zoom area box draws it while the
   * box is on screen - the zoom sheet open, the camera off - its centre and level where its camera
   * looks at the playhead, so the box shows the moving view; everywhere else it is the zoom as stored.
   * The box cannot be dragged off that view: [updateZoom] refuses an area to a zoom that follows.
   */
  readonly selectedZoom = computed(() => {
    const sel = this.selection.value;
    const zoom = sel?.kind === 'zoom' ? findZoom(this.manifest.value, sel.id) : null;
    if (!zoom?.follow || this.panel.value !== 'zoom' || this.cameraLive.value) return zoom;
    const path = this.zoomPaths.value.get(zoom.id);
    if (!path) return zoom;
    const view = followViewAt(path, this.playheadMs.value);
    return { ...zoom, cx: view.cx, cy: view.cy, scale: view.scale };
  });
  /** The track the selected zoom follows, while it follows one the post has: what the zoom sheet names. */
  readonly selectedZoomTrack = computed(() => {
    const sel = this.selection.value;
    const zoom = sel?.kind === 'zoom' ? findZoom(this.manifest.value, sel.id) : null;
    return zoom ? zoomTrack(zoom, this.manifest.value) : null;
  });
  /** Whether a zoom follows the selected track: the Follow cam tile's state, a tap on which then opens that zoom. */
  readonly followCamOn = computed(() => {
    const track = this.selectedTrack.value;
    return !!track && this.zooms.value.some(zoom => zoom.follow?.trackId === track.id);
  });
  /**
   * Every following zoom's path by id, as [followPaths] makes it: what [camera] is compiled from, and
   * where the box of one that follows is drawn. Made again only when something the thing is aimed
   * through changes - a caption dragged rewrites the manifest every frame and touches none of it -
   * and, while no zoom follows, empty without reading anything but the zooms.
   */
  readonly zoomPaths = computed<ReadonlyMap<string, FollowPath>>(() => {
    const zooms = this.zooms.value;
    if (!zooms.some(zoom => zoom.follow)) return this.noFollowPaths;
    const total = this.totalMs.value;
    const m = this.manifest.value;
    const layout = this.layoutMotions.value;
    const made = this.followMade;
    if (
      made &&
      made.zooms === zooms &&
      made.total === total &&
      made.clips === m.clips &&
      made.videoTracks === m.videoTracks &&
      made.tracks === m.tracks &&
      made.output === m.output &&
      made.fit === m.fit &&
      // A new map on every change to the post, empty on nearly every post: two empty ones lay out alike.
      (made.layout === layout || (made.layout.size === 0 && layout.size === 0))
    ) {
      return made.paths;
    }
    const paths = followPaths(zooms, total, { manifest: m, layout });
    this.followMade = { zooms, total, clips: m.clips, videoTracks: m.videoTracks, tracks: m.tracks, output: m.output, fit: m.fit, layout, paths };
    return paths;
  });
  /** The last [zoomPaths] made, and what from. */
  private followMade: {
    zooms: readonly EditZoom[];
    total: number;
    clips: EditManifest['clips'];
    videoTracks: EditManifest['videoTracks'];
    tracks: EditManifest['tracks'];
    output: EditManifest['output'];
    fit: EditManifest['fit'];
    layout: LayoutMotions;
    paths: ReadonlyMap<string, FollowPath>;
  } | null = null;
  /** [zoomPaths] while no zoom follows: one map, so nothing reading it is told of a change. */
  private readonly noFollowPaths: ReadonlyMap<string, FollowPath> = new Map();
  /**
   * The zooms compiled to the camera track the render gets - the one the preview samples, exactly as
   * it samples [compileTransition] for a transition, so what is on screen is what is exported. Only
   * recomputed when the manifest changes, never per frame; the preview reads it through [cameraAt].
   * A zoom that follows a track is compiled from its path, [compileCamera] with the post to follow
   * through; with none following this is the camera there always was.
   */
  readonly camera = computed(() => compileCameraWith(this.zooms.value, this.totalMs.value, this.zoomPaths.value));
  /**
   * Every clip a layer's arrangement opens and closes around, with its keys, compiled exactly as
   * [toComposeSpec] compiles them - so the preview reads the same keys through `rectMotionAt` that
   * the render is handed. Empty for a post with no animated layer, which is nearly every post.
   * Recomputed when the manifest changes, never per frame.
   */
  readonly layoutMotions = computed<LayoutMotions>(() => compileLayoutMotions(this.manifest.value));
  /** The canvas colour as `#rrggbb` - [EditManifest.background] - or null for the black every post starts on. */
  readonly background = computed<string | null>(() => this.manifest.value.background ?? null);
  /**
   * The same as the painter takes it, 0..1 RGB: the colour the preview fills its frame, a clip's bars
   * and a transition's backdrop with - the numbers [toComposeSpec] sends, so the two cannot differ.
   */
  readonly backgroundRgb = computed<[number, number, number]>(() => {
    const colour = this.background.value;
    return colour ? backgroundRgb(colour) : [0, 0, 0];
  });
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
    const m = this.manifest.value;
    const motions = new Map<string, ComposeOverlayMotion>();
    const kept = new Map<string, CompiledMotion>();
    const keptTracks = new Map<string, CompiledTrackMotion>();
    for (const overlay of m.overlays) {
      // A following layer is drawn against the footage, so its keys hang on the layer itself - its own
      // centre is what they are offsets from - on the track it follows, and on everything the footage is
      // drawn through.
      const followed = overlay.kind === 'effect' ? null : followedTrack(m, overlay);
      if (followed) {
        const { startMs, endMs } = overlayWireWindow(overlay, total);
        const scene = { clips: m.clips, videoTracks: m.videoTracks, output: m.output, fit: m.fit, camera: this.camera.value, layout: this.layoutMotions.value };
        const known = this.compiledTracks.get(overlay.id);
        const same =
          known && known.overlay === overlay && known.track === followed.track && known.startMs === startMs && known.endMs === endMs && sameScene(known.scene, scene);
        const entry: CompiledTrackMotion = same
          ? known
          : {
              overlay,
              track: followed.track,
              scene,
              startMs,
              endMs,
              motion: compileLayerMotion(overlay, { manifest: m, camera: scene.camera, layout: scene.layout }, { startMs, endMs }),
            };
        keptTracks.set(overlay.id, entry);
        if (entry.motion) motions.set(overlay.id, entry.motion);
        continue;
      }
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
    this.compiledTracks = keptTracks;
    return motions;
  });
  /** What [overlayMotions] compiled last time, and from what, so an unchanged layer is not compiled again. */
  private compiledMotions = new Map<string, CompiledMotion>();
  /** The same for the tracked layers. */
  private compiledTracks = new Map<string, CompiledTrackMotion>();
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
    // A zoom following its thing has no area of its own to set: the box shows where its camera looks,
    // and a drag or a pinch on it changes nothing. Stop following, or a framing, is the way to move it.
    const zoom = findZoom(this.manifest.value, id);
    const held = zoom && patch.follow === undefined && zoomTrack(zoom, this.manifest.value) ? { ...patch, cx: undefined, cy: undefined, scale: undefined } : patch;
    this.commitCoalesced('Zoom', m => updateZoomOp(m, id, held), opts?.coalesce);
  }

  /**
   * Follow cam on track `trackId`: a zoom over the first stretch of the post its thing is on, trimmed to
   * the room the other zooms leave, that keeps the thing in frame. A picture of another shape from its
   * frame - a wide shot in a tall post - is REFRAMED: the whole shot (`fill`), with a covered one
   * contained in the same step so the whole width is there to pan across. A picture that fills its
   * frame is closed in on (`mid`). Selected, with its sheet open. A zoom already following the track is
   * opened instead, and no room says so.
   */
  followCam(trackId: string): void {
    const m = this.manifest.value;
    if (!trackById(m, trackId)) return;
    const following = m.zooms.find(zoom => zoom.follow?.trackId === trackId);
    if (following) {
      this.openZoom(following.id);
      return;
    }
    if (!this.host.editing.zoom) return;
    if (m.zooms.length >= MAX_ZOOMS) {
      this.showToast(`You can add up to ${MAX_ZOOMS} zooms`);
      this.haptic('warning');
      return;
    }
    const id = this.newId('zoom');
    const total = this.totalMs.value;
    if (!this.commit('Follow cam', next => this.withFollowCam(next, trackId, id, total))) {
      this.showToast('No room for a zoom on this track');
      this.haptic('warning');
      return;
    }
    this.openZoom(id);
    this.haptic('success');
  }

  /** How close following zoom `id` frames its thing: one step, its still view moved to suit ([followRest]). */
  setZoomFollowFraming(id: string, framing: ZoomFraming): void {
    const done = this.commit('Zoom', m => {
      const zoom = findZoom(m, id);
      if (!zoom?.follow || zoom.follow.framing === framing) return null;
      return this.withFollowRest(updateZoomOp(m, id, { follow: { trackId: zoom.follow.trackId, framing } }), id);
    });
    if (done) this.haptic('selection');
  }

  /**
   * Following zoom `id` let go of its thing: held from now on where its camera looks at the playhead -
   * the nearer end of its window when the playhead is outside it - an area like any other zoom's.
   */
  stopZoomFollow(id: string): void {
    const done = this.commit('Stop following', m => {
      const zoom = findZoom(m, id);
      if (!zoom?.follow) return null;
      const path = followPath(zoom, m.zooms, totalDurationMs(m), this.followOf(m));
      const view: CameraView = path ? followViewAt(path, this.playheadMs.value) : zoom;
      return updateZoomOp(m, id, { follow: null, cx: view.cx, cy: view.cy, scale: view.scale });
    });
    if (done) this.haptic('light');
  }

  /** [followCam]'s step on `m`: the clip's fit and the new zoom together, or null where no room is left. */
  private withFollowCam(m: EditManifest, trackId: string, id: string, total: number): EditManifest | null {
    const track = trackById(m, trackId);
    const room = track ? this.followRoom(m, track, total) : null;
    if (!track || !room) return null;
    const footage = trackedFootage(track, { manifest: m, camera: null, layout: compileLayoutMotions(m) }, (room.startMs + room.endMs) / 2);
    if (!footage) return null;
    const clip = footage.clip;
    const reframe = followReframes(clip, track, m.output);
    // Cover took the sides off before any camera could see them: contained, the whole width is there.
    const contained = reframe && (clip.fit ?? m.fit) === 'cover' ? patchClip(m, clip.id, { fit: 'contain' }) : m;
    const zoom: EditZoom = {
      id,
      startMs: room.startMs,
      endMs: room.endMs,
      cx: 0.5,
      cy: 0.5,
      scale: DEFAULT_ZOOM_SCALE,
      // The whole shot is a reframe rather than a move: on from its first frame, so no bar shows at the cut.
      rampMs: reframe ? 0 : DEFAULT_ZOOM_RAMP_MS,
      ease: 'smooth',
      follow: { trackId, framing: reframe ? 'fill' : 'mid' },
    };
    const added = addZoomOp(contained, zoom, total);
    return added ? this.withFollowRest(added, id) : null;
  }

  /**
   * Where a follow of `track` goes: the first of its stretches with [MIN_ZOOM_MS] free of other zooms,
   * and the longest free piece of that one.
   */
  private followRoom(m: EditManifest, track: EditTrack, total: number): { startMs: number; endMs: number } | null {
    const zooms = [...m.zooms].sort((a, b) => a.startMs - b.startMs);
    for (const stretch of trackStretches(track, m)) {
      const from = Math.max(0, Math.ceil(stretch.startMs));
      const to = Math.min(total, Math.floor(stretch.endMs));
      let best: { startMs: number; endMs: number } | null = null;
      let at = from;
      for (const zoom of [...zooms, { startMs: to, endMs: to }]) {
        const end = Math.min(zoom.startMs, to);
        if (end - at >= MIN_ZOOM_MS && (!best || end - at > best.endMs - best.startMs)) best = { startMs: at, endMs: end };
        at = Math.max(at, zoom.endMs);
        if (at >= to) break;
      }
      if (best) return best;
    }
    return null;
  }

  /** Zoom `id`'s still view set to its path's [followRest]: what it holds wherever it cannot follow. */
  private withFollowRest(m: EditManifest, id: string): EditManifest {
    const zoom = findZoom(m, id);
    const path = zoom ? followPath(zoom, m.zooms, totalDurationMs(m), this.followOf(m)) : null;
    if (!path) return m;
    const rest = followRest(path);
    return updateZoomOp(m, id, { cx: rest.cx, cy: rest.cy, scale: rest.scale });
  }

  /** What a zoom on `m` follows its thing through. */
  private followOf(m: EditManifest): CameraFollow {
    return { manifest: m, layout: m === this.manifest.value ? this.layoutMotions.value : compileLayoutMotions(m) };
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
  /* Focus                                                                                     */
  /* ========================================================================================= */

  /**
   * Every source's subjects as far as they have got, by clip key: see [SubjectTrackState]. Written by
   * `EditorMedia`, which looks at a source once a focused segment plays it, and read by the Focus
   * sheet and by the preview, which draws a focus only from a track that is `ready`.
   */
  readonly subjectTracks = signal<ReadonlyMap<string, SubjectTrackState>>(new Map());

  /**
   * The segment the Focus sheet is about: the selected one, or the one under the playhead - the crop
   * tool's rule, for the crop tool's reason.
   */
  readonly focusClip = computed(() => this.selectedClip.value ?? slotAt(this.manifest.value, this.playheadMs.value)?.clip ?? null);

  /** How far that segment's subjects have got, or null for a source nobody has looked at yet. */
  readonly focusTrack = computed<SubjectTrackState | null>(() => {
    const clip = this.focusClip.value;
    return clip ? (this.subjectTracks.value.get(clip.clipKey) ?? null) : null;
  });

  /** The last [focusFrames] made for each segment, kept while what they were made from is the same. */
  private focusMade = new Map<string, { focus: EditFocus; inMs: number; outMs: number; state: SubjectTrackState; frames: FocusFrames }>();

  /** The last [focusFrames] made for each segment's track looks, kept while the looks are the same. */
  private lookMade = new Map<string, LookFrames>();

  /**
   * Each focused segment's focus as the preview draws it, by segment id: compiled against its source's
   * track exactly as the render compiles it ([compileFocus]), and read frame by frame. A segment whose
   * source has no track ready yet is drawn as it is until it has one.
   *
   * A segment with no Focus of its own that changes the picture shows its tracks' looks instead
   * ([EditTrack.look]): the very subject track and focus the render is handed ([segmentLook]), so a
   * blurred face is blurred on the frame exactly as it will be in the file.
   *
   * A segment's frames are kept from one manifest to the next while its focus, its trim and its track
   * are the same objects, so a drag somewhere else on the timeline makes nothing new.
   */
  readonly focusFrames = computed<ReadonlyMap<string, FocusFrames>>(() => {
    const manifest = this.manifest.value;
    const tracks = this.subjectTracks.value;
    const made = new Map<string, { focus: EditFocus; inMs: number; outMs: number; state: SubjectTrackState; frames: FocusFrames }>();
    const lookMade = new Map<string, LookFrames>();
    const frames = new Map<string, FocusFrames>();
    // The post's tracks when one of them has a look, so a post with none does no work for looks at all.
    const looked = hasTrackLooks(manifest) ? manifest.tracks : undefined;
    for (const clip of [...manifest.clips, ...manifest.videoTracks.flatMap(track => track.clips)]) {
      const focus = clip.focus;
      if (looked && !focusChangesPicture(focus)) {
        const look = this.lookFramesFor(clip, looked);
        if (look) {
          lookMade.set(clip.id, look);
          frames.set(clip.id, look.frames);
        }
        continue;
      }
      const state = tracks.get(clip.clipKey);
      if (!focus || !focusChangesPicture(focus) || state?.status !== 'ready') continue;
      const kept = this.focusMade.get(clip.id);
      if (kept && kept.focus === focus && kept.inMs === clip.inMs && kept.outMs === clip.outMs && kept.state === state) {
        made.set(clip.id, kept);
        frames.set(clip.id, kept.frames);
        continue;
      }
      const compiled = compileFocus(clip, state.result);
      if (!compiled) continue;
      const entry = { focus, inMs: clip.inMs, outMs: clip.outMs, state, frames: new FocusFrames(state.track, compiled) };
      made.set(clip.id, entry);
      frames.set(clip.id, entry.frames);
    }
    this.focusMade = made;
    this.lookMade = lookMade;
    return frames;
  });

  /**
   * Segment `clip`'s track looks as the preview reads them, or null for none. The segment's last ones are
   * handed back while [segmentLook] answers the same look, and its bytes are parsed once ([PARSED_LOOKS]), so a
   * Strength drag makes a new focus over the very frames, and a trim dragged makes nothing at all.
   */
  private lookFramesFor(clip: EditClip, tracks: readonly EditTrack[]): LookFrames | null {
    const look = segmentLook(clip, tracks);
    if (!look) return null;
    const kept = this.lookMade.get(clip.id);
    if (kept && kept.look === look) return kept;
    try {
      let track = PARSED_LOOKS.get(look.bytes);
      if (!track) PARSED_LOOKS.set(look.bytes, (track = parseSubjectTrack(look.bytes)));
      // A reader of its own for each segment, as a focused one has: the frames it fills are its own.
      return { look, frames: new FocusFrames(track, { uri: `look:${clip.id}`, ...look.focus }) };
    } catch {
      // Bytes made a moment ago that will not read are this package's bug, not the customer's: the
      // segment is drawn as it is rather than not at all.
      return null;
    }
  }

  /** Where `clip` is in its own footage at the playhead, or its first frame when the playhead is elsewhere. */
  focusSourceMs(clip: EditClip): number {
    const layer = this.previewLayers.value.find(candidate => candidate.clipId === clip.id);
    return layer ? layer.sourceMs : clip.inMs;
  }

  /**
   * Opens the Focus sheet on [focusClip], paused and selected, putting a focus on it first when it has
   * none - the main subject sharp and the rest softened, which is what a customer tapping Focus came
   * for. Nothing on a host that cannot look for subjects; the toolbar offers no Focus there.
   */
  openFocus(): void {
    const clip = this.focusClip.value;
    if (!clip || !this.host.media.findSubjects) return;
    this.pause();
    if (!this.isSelected({ kind: 'clip', id: clip.id })) this.select({ kind: 'clip', id: clip.id });
    if (!clip.focus) this.commit('Focus', m => setClipFocusOp(m, clip.id, defaultFocus()));
    this.openPanel('focus');
  }

  /** The look of the Focus sheet's segment: how soft, how grey, how dark, which way round. Coalesces a drag into one step. */
  setFocusLook(patch: Partial<Pick<EditFocus, 'blur' | 'mono' | 'dim'>> & { invert?: boolean }, opts?: { coalesce?: CoalesceKey }): void {
    const clip = this.focusClip.value;
    if (!clip?.focus) return;
    this.commitCoalesced('Focus', m => patchClipFocusOp(m, clip.id, patch), opts?.coalesce);
  }

  /**
   * The subjects in focus at the playhead - the choice in effect there: the segment's own until its
   * first change, a change's from its time on - with `subject` in or out of it. `all` puts every
   * subject in, or, when every one is in already, takes them all out.
   */
  toggleFocusSubject(subject: number | 'all'): void {
    const clip = this.focusClip.value;
    const focus = clip?.focus;
    const state = this.focusTrack.value;
    if (!clip || !focus || state?.status !== 'ready') return;
    const entry = focusEntryAt(focus, this.focusSourceMs(clip));
    const current = resolveFocusSubjects(focusEntrySubjects(focus, entry), state.result);
    const every = state.result.subjects.map(one => one.id);
    let next: FocusSubjects;
    if (subject === 'all') next = current.length === every.length ? [] : 'all';
    else next = current.includes(subject) ? current.filter(id => id !== subject) : [...current, subject].sort((a, b) => a - b);
    if (this.commit('Focus', m => setFocusSubjectsOp(m, clip.id, entry, next))) this.haptic('selection');
  }

  /** The ids in focus at the playhead, for the sheet's chips: the choice in effect there, as ids. */
  readonly focusSubjectsNow = computed<readonly number[]>(() => {
    const clip = this.focusClip.value;
    const state = this.focusTrack.value;
    if (!clip?.focus || state?.status !== 'ready') return [];
    // Read so a scrub moves the chips onto the choice under the new playhead.
    void this.playheadMs.value;
    return resolveFocusSubjects(focusEntrySubjects(clip.focus, focusEntryAt(clip.focus, this.focusSourceMs(clip))), state.result);
  });

  /**
   * A change of focus at the playhead, to the subjects in focus there now, for the customer to change
   * next: the pull to whoever they tap. Says why when there is no room for one.
   */
  addFocusChangeAtPlayhead(): void {
    const clip = this.focusClip.value;
    const focus = clip?.focus;
    if (!clip || !focus) return;
    const at = Math.round(this.focusSourceMs(clip));
    if (at <= clip.inMs || at >= clip.outMs) {
      this.showToast('Move the playhead into the clip first');
      this.haptic('warning');
      return;
    }
    const subjects = focusEntrySubjects(focus, focusEntryAt(focus, at));
    if (!this.commit('Change focus', m => addFocusChangeOp(m, clip.id, at, subjects))) {
      this.showToast('This clip has as many focus changes as it can take');
      this.haptic('warning');
    }
  }

  /**
   * Where source time `atMs` of segment `clipId` plays on the OUTPUT timeline, for a change of focus
   * the sheet moves the playhead to: its slot's start, on its own layer, plus how far into the trim it
   * is at the segment's speed. Null for a segment nobody has, or a time outside its trim.
   */
  focusChangeOutputMs(clipId: string, atMs: number): number | null {
    const manifest = this.manifest.value;
    const rows: { clips: EditClip[]; startMs: number }[] = [
      { clips: manifest.clips, startMs: 0 },
      ...manifest.videoTracks.map(track => ({ clips: track.clips, startMs: track.startMs })),
    ];
    for (const row of rows) {
      const slot = timelineSlots({ clips: row.clips }).find(candidate => candidate.clip.id === clipId);
      if (!slot) continue;
      const clip = slot.clip;
      if (atMs < clip.inMs || atMs > clip.outMs) return null;
      return row.startMs + slot.startMs + (atMs - clip.inMs) / (clip.speed || 1);
    }
    return null;
  }

  /** Takes off the change of focus at `index`. */
  removeFocusChange(index: number): void {
    const clip = this.focusClip.value;
    if (clip) this.commit('Remove focus change', m => removeFocusChangeOp(m, clip.id, index));
  }

  /** Takes the focus off the segment and closes the sheet: the footage as it is. */
  removeFocus(): void {
    const clip = this.focusClip.value;
    if (clip) this.commit('Remove focus', m => setClipFocusOp(m, clip.id, null));
    this.closePanel();
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
    else if (sel.kind === 'audio') this.removeSelectedAudio();
    // Before the voice catch-all below, or Delete with a zoom selected would silently do nothing.
    else if (sel.kind === 'zoom') this.deleteZoom(sel.id);
    else if (sel.kind === 'track') this.deleteTrack(sel.id);
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
    // A run reading footage for an editor that has gone: there is nothing left to put its path on.
    this.trackSession?.abort.abort();
    this.trackSession = null;
    this.cancelBehind();
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

/** What a layer going behind the people says while they are looked for. */
const FINDING_PEOPLE = 'Finding people...';
/** How long that stays up at most: a minute of footage through a phone's segmenter, and more. */
const FINDING_PEOPLE_MS = 90_000;

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


/** Whether a following layer's footage is drawn through the very same parts of the post: identity, part for part. */
function sameScene(a: CompiledTrackMotion['scene'], b: CompiledTrackMotion['scene']): boolean {
  return a.clips === b.clips && a.videoTracks === b.videoTracks && a.output === b.output && a.fit === b.fit && a.camera === b.camera && a.layout === b.layout;
}

/** `value` held to `min..max`. */
function within(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
