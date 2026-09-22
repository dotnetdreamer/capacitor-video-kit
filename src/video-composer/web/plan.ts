import type {
  ComposeClip,
  ComposeMusic,
  ComposeOutput,
  ComposePlacement,
  ComposeSpec,
  ComposeTrack,
  ComposeTransition,
  ComposeTransitionCurves,
  ComposeTransitionMask,
  ComposeVoiceover,
} from '../definitions';

import { fold, isIdentity, type ColorMatrix } from './color-matrix';
import type { Frame } from './geometry';

/**
 * Everything the browser renderer needs to know that can be worked out without touching a decoder -
 * the port of `RenderPlan.kt`, and pure for the same reason it is pure there: clip durations after
 * a speed change, where each clip lands on the output timeline, how many times a music track has to
 * repeat to cover the video and how long the last repetition runs, and where a voiceover's silence
 * goes are all arithmetic worth pinning with a unit test rather than watching in a video.
 *
 * Times are MICROSECONDS throughout, as they are natively, because the flooring is load-bearing:
 * Media3 floors a sped-up item's duration and this plan has to agree with it to the microsecond, or
 * the same manifest comes out a frame longer in a browser than on a phone.
 */

/** One millisecond: a floor that keeps a degenerate spec from producing a zero-length item. */
export const MIN_CLIP_US = 1_000;

/** Two pixels: the same kind of floor as [MIN_CLIP_US], for a layer's own frame. */
export const MIN_LAYER_PX = 2;

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

/** What a probe of one input told us. Absent for an input nobody managed to open. */
export interface ProbedInput {
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export interface PlannedClip {
  clip: ComposeClip;
  inUs: number;
  /** Already clamped to the probed source duration. */
  outUs: number;
  /** How long this clip occupies on the OUTPUT timeline, i.e. after the speed change. */
  outDurUs: number;
  speed: number;
  /** 0..1, already carrying the spec's `originalVolume` and `originalMuted`. */
  gain: number;
  removeAudio: boolean;
  /**
   * True when the clip asks for a crop, a rect, or both. Worked out once, here, rather than
   * re-derived per frame, because the rule the whole feature hangs on is that a clip with neither
   * takes exactly the path it took before either field existed.
   */
  reframed: boolean;
  /** The frame this clip's picture is drawn into, in real pixels. */
  frame: Frame;
}

/** Where one clip of an extra layer sits on the output frame, over the window it covers. */
export interface LayerPlacement {
  startUs: number;
  endUs: number;
  /**
   * The layer's rectangle on the output frame, 0..1, top-left origin - and the angle it is turned
   * to, which the compositor applies about this rectangle's centre in output pixels.
   *
   * The angle rides on the rectangle rather than beside it because it belongs to it: `fit` is
   * measured in the UPRIGHT rectangle and the fitted picture is turned as one piece, so everything
   * below that sizes a layer's frame from `rect.w` and `rect.h` is right to ignore the turn.
   */
  rect: ComposePlacement;
}

export interface PlannedTrack {
  id: string;
  clips: PlannedClip[];
  placements: LayerPlacement[];
  startUs: number;
  z: number;
  opacity: number;
  hasAudio: boolean;
}

export interface OverlayPlacement {
  id: string;
  png: string;
  /** Centre on the output frame, 0..1, top-left origin with y down - the web's own system. */
  cx: number;
  cy: number;
  /** CLOCKWISE degrees, which is what a canvas `rotate()` already means. */
  rotationDeg: number;
  startUs: number;
  endUs: number;
  opacity: number;
  wPx: number;
  hPx: number;
}

export interface MusicItem {
  inUs: number;
  outUs: number;
  /** Where this repetition starts on the OUTPUT timeline. */
  atUs: number;
  fadeInUs: number;
  /** Relative to this item's own start; -1 for no fade out. */
  fadeOutStartUs: number;
  fadeOutUs: number;
}

export interface MusicPlan {
  uri: string;
  volume: number;
  items: MusicItem[];
}

export interface VoiceItem {
  uri: string;
  atUs: number;
  /** Clip the take here so a slightly long recording cannot extend the composition. */
  lengthUs: number;
  level: number;
}

/**
 * One transition between two base clips, laid out.
 *
 * The spec arrives LOWERED - the outgoing clip already stops where the incoming one starts - so a
 * transition changes nothing about where any base clip sits: `prefixOutUs` and `totalUs` are what
 * they would be with a cut there. What it adds is the outgoing clip's tail, drawn UNDER the incoming
 * clip for the first `durUs` of it, and the numbers that say how the two are mixed.
 */
export interface PlannedTransition {
  /** The base clip it brings in. Its window opens where that clip starts. */
  index: number;
  /** For a log line and a failure message; nothing here or in the painter branches on it. */
  kind: string;
  /** The outgoing clip's last moments, planned exactly as a clip is: the same probe clamp, the same framing. */
  tail: PlannedClip;
  /** Where the window opens on the OUTPUT timeline: the incoming clip's own start. */
  startUs: number;
  /** How long it runs: the tail, and never longer than the incoming clip it runs under. */
  durUs: number;
  curves: ComposeTransitionCurves;
  mask?: ComposeTransitionMask;
  fromTint?: [number, number, number];
  toTint?: [number, number, number];
}

/** A transition that is on screen, and how far through its window the instant asked about is. */
export interface ActiveTransition {
  /** The incoming base clip, which is also the clip `clipIndexAt` names for the same instant. */
  index: number;
  planned: PlannedTransition;
  /** 0..1 through the window. */
  progress: number;
}

export interface RenderPlan {
  spec: ComposeSpec;
  clips: PlannedClip[];
  /** Start of clip i on the OUTPUT timeline. */
  prefixOutUs: number[];
  totalUs: number;
  /**
   * Every transition, in timeline order. EMPTY for a post with none, which is every spec written
   * before transitions existed - and the render asks this once, before its first frame, so such a
   * post takes exactly the loop it always took rather than looking for a window on every frame.
   */
  transitions: PlannedTransition[];
  /** The extra video layers, bottom to top, and only the ones that show something. */
  tracks: PlannedTrack[];
  /** Null when `filter` was empty or folded to identity. */
  colorMatrix: ColorMatrix | null;
  overlays: OverlayPlacement[];
  music: MusicPlan | null;
  voice: VoiceItem[];
  posterAtUs: number;
  output: ComposeOutput;
  /** False when every clip's sound is gone, on every layer, and there is no music or voiceover. */
  hasAudio: boolean;
}

export function buildPlan(spec: ComposeSpec, probes: ReadonlyMap<string, ProbedInput>): RenderPlan {
  const output = evenOutput(spec.output);
  const clips: PlannedClip[] = [];
  const prefixOutUs: number[] = [];
  let cursorUs = 0;

  for (const clip of spec.clips) {
    const item = planClip(clip, spec, probes, output);
    prefixOutUs.push(cursorUs);
    cursorUs += item.outDurUs;
    clips.push(item);
  }

  // What was planned, or the tail the spec asks for past it. Every layer is cut to this length, every
  // audio stream is measured against it, and the frames between the base track's last clip and the
  // end are BLACK - which is the same frame the loop already draws wherever a layer outlasts what is
  // under it, so there is nothing here the renderer did not already know how to paint.
  const askedUs = Math.max(0, Math.round((spec.durationMs ?? 0) * 1000));
  const totalUs = Math.max(clips.length === 0 ? MIN_CLIP_US : cursorUs, askedUs);

  const transitions: PlannedTransition[] = [];
  spec.clips.forEach((clip, index) => {
    // Never the first clip: there is nothing before it to come in from. The parser has already
    // dropped one there, and this is the plan holding the same line on its own.
    const incoming = clips[index];
    if (index === 0 || !clip.transitionIn || !incoming) return;
    const planned = planTransition(clip.transitionIn, index, incoming, prefixOutUs[index] ?? 0, spec, probes, output);
    if (planned) transitions.push(planned);
  });

  const folded = spec.filter.length === 0 ? null : fold(spec.filter);
  const colorMatrix = folded && !isIdentity(folded) ? folded : null;

  const tracks = [...(spec.tracks ?? [])]
    // Bottom to top, and the sort is stable, so two layers claiming one z keep the order the spec
    // listed them in - the tie-break the contract names.
    .sort((a, b) => a.z - b.z)
    .map(track => planTrack(track, spec, probes, output, totalUs))
    // A layer whose start falls past the end of the OUTPUT contributes nothing anywhere.
    .filter(track => track.clips.length > 0);

  const music = planMusic(spec.audio.music, probes, totalUs);
  const voice = planVoice(spec.audio.voiceover, probes, totalUs);

  return {
    spec,
    clips,
    prefixOutUs,
    totalUs,
    transitions,
    tracks,
    colorMatrix,
    overlays: spec.overlays.map(overlay => ({
      id: overlay.id,
      png: overlay.png,
      cx: overlay.cx,
      cy: overlay.cy,
      rotationDeg: overlay.rotationDeg,
      startUs: Math.round(overlay.startMs * 1000),
      endUs: Math.round(overlay.endMs * 1000),
      opacity: clamp(overlay.opacity, 0, 1),
      wPx: overlay.wPx,
      hPx: overlay.hPx,
    })),
    music,
    voice,
    posterAtUs: Math.min(Math.round(spec.posterAtMs * 1000), Math.max(0, totalUs - 1)),
    output,
    hasAudio:
      clips.some(clip => !clip.removeAudio) ||
      transitions.some(transition => !transition.tail.removeAudio) ||
      tracks.some(track => track.hasAudio) ||
      music !== null ||
      voice.length > 0,
  };
}

/**
 * H.264 encoders refuse odd dimensions, so the output is rounded DOWN to an even pair - the same
 * rounding `ComposeOutput.width` documents and both native engines perform.
 */
export function evenOutput(output: ComposeOutput): ComposeOutput {
  return {
    ...output,
    width: Math.max(2, Math.floor(output.width / 2) * 2),
    height: Math.max(2, Math.floor(output.height / 2) * 2),
  };
}

/** Which clip of the base track is on screen at an instant, or -1 past the end. */
export function clipIndexAt(plan: RenderPlan, timeUs: number): number {
  for (let i = 0; i < plan.clips.length; i++) {
    const start = plan.prefixOutUs[i] ?? 0;
    const end = start + (plan.clips[i]?.outDurUs ?? 0);
    if (timeUs < end) return timeUs >= start ? i : -1;
  }
  return -1;
}

/**
 * The transition on screen at an instant of the OUTPUT timeline, or null wherever one clip fills
 * the frame. A window is open from its start up to but NOT including its end, so the frame at the
 * end is the incoming clip alone - the same half-open rule `clipIndexAt` uses for a clip.
 *
 * Progress is clamped rather than trusted, because the one reading every engine shares - curves
 * interpolated at `p` - is only defined on 0..1.
 */
export function transitionAt(plan: RenderPlan, atUs: number): ActiveTransition | null {
  for (const planned of plan.transitions) {
    if (atUs < planned.startUs) return null;
    if (atUs >= planned.startUs + planned.durUs) continue;
    return { index: planned.index, planned, progress: clamp((atUs - planned.startUs) / planned.durUs, 0, 1) };
  }
  return null;
}

/** Which of a layer's placements is on screen at an instant of the OUTPUT timeline, or -1. */
export function visibleIndexAt(track: PlannedTrack, timeUs: number): number {
  if (timeUs < track.startUs) return -1;
  for (let i = 0; i < track.placements.length; i++) {
    if (timeUs < (track.placements[i]?.endUs ?? 0)) return i;
  }
  return -1;
}

/**
 * Where in the SOURCE a clip is, for an instant `offsetIntoClipUs` into its own place on the output
 * timeline. The speed is a straight multiplier on the source time, which is what makes a 2x clip
 * cover twice as much footage in the room it was given.
 */
export function sourceTimeUs(clip: PlannedClip, offsetIntoClipUs: number): number {
  return Math.min(clip.outUs - 1, clip.inUs + offsetIntoClipUs * clip.speed);
}

/* -------------------------------------------------------------------------------------------- */

function planClip(clip: ComposeClip, spec: ComposeSpec, probes: ReadonlyMap<string, ProbedInput>, frame: Frame): PlannedClip {
  const probe = probes.get(clip.uri);
  // The manifest may carry a duration read before the file was trimmed or re-encoded.
  const outMs = probe && probe.durationMs > 0 ? Math.min(clip.outMs, probe.durationMs) : clip.outMs;
  const inUs = Math.round(clip.inMs * 1000);
  const outUs = Math.max(Math.round(outMs * 1000), inUs + MIN_CLIP_US);
  const speed = clamp(clip.speed, MIN_SPEED, MAX_SPEED);

  const gain = spec.audio.originalMuted || clip.muted ? 0 : clamp(clip.volume * spec.audio.originalVolume, 0, 1);
  const sourceHasAudio = probe ? probe.hasAudio : true;

  return {
    clip,
    inUs,
    outUs,
    // FLOORED, not rounded, because Media3 floors and this plan has to be the same number: the
    // renderer's own frame count comes off it, and a microsecond either way is a frame of black at
    // the join between two clips.
    outDurUs: Math.floor((outUs - inUs) / speed),
    speed,
    gain,
    removeAudio: gain <= 0 || !sourceHasAudio,
    reframed: clip.crop !== undefined || clip.rect !== undefined,
    frame,
  };
}

/**
 * A base clip's `transitionIn`, laid out, or null when there is nothing left of it to draw.
 *
 * The tail is planned by [planClip] and nothing else, so it is clamped to its file and framed by
 * exactly the rules its own clip was: it IS that clip, a few hundred milliseconds of it, and a tail
 * framed differently from the clip it continues would jump on the frame the window opens.
 *
 * Its length is floored the way every clip's is, and then held to the incoming clip. The builder
 * already holds a transition to half of either clip, so the second bound only matters for a spec
 * written by hand - where it keeps the tail from running on under the clip AFTER the incoming one,
 * whose own transition would then overlap it.
 */
function planTransition(
  transition: ComposeTransition,
  index: number,
  incoming: PlannedClip,
  startUs: number,
  spec: ComposeSpec,
  probes: ReadonlyMap<string, ProbedInput>,
  output: Frame,
): PlannedTransition | null {
  const tail = planClip(transition.from, spec, probes, output);
  const durUs = Math.min(tail.outDurUs, incoming.outDurUs);
  if (durUs <= 0) return null;
  const planned: PlannedTransition = { index, kind: transition.kind, tail, startUs, durUs, curves: transition.curves };
  if (transition.mask) planned.mask = transition.mask;
  if (transition.fromTint) planned.fromTint = transition.fromTint;
  if (transition.toTint) planned.toTint = transition.toTint;
  return planned;
}

/**
 * An extra layer's clips, laid end to end FROM `startMs` and cut to the base track's length.
 *
 * From `startMs`, because `startMs` DELAYS the layer rather than seeking into it. Cut, because the
 * base decides how long the post is: a layer whose clips outlast it is clipped, and the post does
 * not grow.
 */
function planTrack(track: ComposeTrack, spec: ComposeSpec, probes: ReadonlyMap<string, ProbedInput>, output: ComposeOutput, totalUs: number): PlannedTrack {
  const clips: PlannedClip[] = [];
  const placements: LayerPlacement[] = [];
  const startUs = clamp(Math.round((track.startMs ?? 0) * 1000), 0, totalUs);
  let cursorUs = startUs;

  for (const clip of track.clips) {
    if (cursorUs >= totalUs) break;
    const rect = clip.rect ?? { x: 0, y: 0, w: 1, h: 1 };
    // The layer is drawn at the size of the rectangle it goes in, so the compositor places it one
    // output pixel per layer pixel and needs nothing but the rectangle itself.
    const frame: Frame = {
      width: Math.max(MIN_LAYER_PX, Math.round(rect.w * output.width)),
      height: Math.max(MIN_LAYER_PX, Math.round(rect.h * output.height)),
    };
    // `rect` is dropped from the clip the plan carries: the rectangle has BECOME the frame, and
    // leaving it on would place the picture inside the layer a second time.
    const withoutRect: ComposeClip = { ...clip };
    delete withoutRect.rect;
    let item = planClip(withoutRect, spec, probes, frame);
    // What is left of the base is a CEILING for this clip rather than a target.
    const roomUs = totalUs - cursorUs;
    if (item.outDurUs > roomUs) {
      const cut = cutTo(item, roomUs);
      if (!cut) break;
      item = cut;
    }
    clips.push(item);
    placements.push({ startUs: cursorUs, endUs: cursorUs + item.outDurUs, rect });
    cursorUs += item.outDurUs;
  }

  return {
    id: track.id,
    clips,
    placements,
    startUs,
    z: track.z,
    opacity: clamp(track.opacity ?? 1, 0, 1),
    hasAudio: clips.some(clip => !clip.removeAudio),
  };
}

/**
 * The same clip ending sooner, so it occupies at most `roomUs` of the output timeline, or null when
 * no cut of it fits at all.
 *
 * The trim moves rather than the speed, so the picture plays at the pace the customer chose right
 * up to the cut. `roomUs` is a hard ceiling and not a target, which is why the kept source is
 * rounded DOWN and the answer is checked rather than assumed.
 */
function cutTo(item: PlannedClip, roomUs: number): PlannedClip | null {
  const keptUs = Math.min(item.outUs - item.inUs, Math.floor(roomUs * item.speed));
  if (keptUs < MIN_CLIP_US) return null;
  const cutDurUs = Math.floor(keptUs / item.speed);
  if (cutDurUs > roomUs) return null;
  return { ...item, outUs: item.inUs + keptUs, outDurUs: cutDurUs };
}

/**
 * Music as explicit repetitions rather than a looping source, so a track that starts three seconds
 * in does not go silent for three seconds on every repeat, and so the last repetition can be cut
 * exactly at the end of the video.
 */
function planMusic(music: ComposeMusic | null, probes: ReadonlyMap<string, ProbedInput>, totalUs: number): MusicPlan | null {
  if (!music) return null;
  const probed = probes.get(music.uri);
  const outMs = probed && probed.durationMs > 0 ? Math.min(music.outMs, probed.durationMs) : music.outMs;
  const trackLenUs = Math.round((outMs - music.inMs) * 1000);
  if (trackLenUs <= 0) return null;

  const startUs = Math.max(0, Math.round(music.startMs * 1000));
  const availableUs = totalUs - startUs;
  if (availableUs <= 0) return null;

  const reps = music.loop ? Math.max(1, Math.ceil(availableUs / trackLenUs)) : 1;
  const lastLenUs = music.loop ? availableUs - (reps - 1) * trackLenUs : Math.min(trackLenUs, availableUs);
  if (lastLenUs <= 0) return null;

  const inUs = Math.round(music.inMs * 1000);
  const fadeInUs = Math.max(0, Math.round(music.fadeInMs * 1000));
  const fadeOutUs = Math.max(0, Math.round(music.fadeOutMs * 1000));

  const items: MusicItem[] = [];
  let atUs = startUs;
  for (let k = 0; k < reps; k++) {
    const lenUs = k === reps - 1 ? lastLenUs : trackLenUs;
    items.push({
      inUs,
      outUs: inUs + lenUs,
      atUs,
      // A fade belongs to the start of the track and the end of the video, not to every repetition.
      fadeInUs: k === 0 ? fadeInUs : 0,
      fadeOutStartUs: k === reps - 1 && fadeOutUs > 0 ? Math.max(0, lenUs - fadeOutUs) : -1,
      fadeOutUs: k === reps - 1 ? fadeOutUs : 0,
    });
    atUs += lenUs;
  }
  return { uri: music.uri, volume: clamp(music.volume, 0, 1), items };
}

function planVoice(takes: readonly ComposeVoiceover[], probes: ReadonlyMap<string, ProbedInput>, totalUs: number): VoiceItem[] {
  const items: VoiceItem[] = [];
  let cursorUs = 0;
  for (const take of [...takes].sort((a, b) => a.startMs - b.startMs)) {
    const startUs = Math.max(0, Math.round(take.startMs * 1000));
    if (startUs >= totalUs) continue;
    // The editor prevents overlaps; a manifest that still has one loses the later take rather than
    // silently shifting it.
    if (startUs < cursorUs) continue;
    const probed = probes.get(take.uri);
    const sourceMs = probed && probed.durationMs > 0 ? Math.min(take.durationMs, probed.durationMs) : take.durationMs;
    const lengthUs = Math.min(Math.round(sourceMs * 1000), totalUs - startUs);
    if (lengthUs <= 0) continue;
    items.push({ uri: take.uri, atUs: startUs, lengthUs, level: clamp(take.volume, 0, 1) });
    cursorUs = startUs + lengthUs;
  }
  return items;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}
