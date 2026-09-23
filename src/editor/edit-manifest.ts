import type { FilterOp } from '../video-composer/definitions';
import { normaliseTransition, transitionSpans } from './transitions';

/**
 * What a customer did to their clips, in a form that can be put down and picked up again.
 *
 * Framework-free on purpose: an Angular editor, a React one and a plain script can all build and
 * read the same manifest, and all of them hand it to [toComposeSpec] to get something the native
 * composer can render. Clips are referred to by a caller-chosen `clipKey` - the manifest never
 * needs to know what the host's own clip objects look like.
 *
 * Overlays keep what they ARE (text and its style, an emoji, a sticker id, a photo path, an effect
 * id) rather than a rasterised bitmap: a bitmap cannot be edited, and reopening an edit has to bring
 * back something the customer can still change. The PNG is produced when it is needed - for the
 * preview and for the render, by the same rasteriser, which is what keeps the two identical.
 */

export const MANIFEST_VERSION = 9;

/** How a clip's picture is fitted into the rectangle it is drawn in. */
export type EditFit = 'contain' | 'cover';

/**
 * A rectangle in normalised coordinates: TOP-LEFT origin with y pointing down, the same system
 * every overlay's `cx`/`cy` already uses and the one `ComposeRect` puts on the wire.
 *
 * A crop is inside 0..1 and could hardly be anything else - it names a part of a source frame. A
 * placement is not: it says where a picture is drawn on the output, and a video moved to the edge
 * of the canvas hangs over it. [normalisePlacement] holds the one and [normaliseRect] the other.
 */
export interface EditRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a clip's picture is drawn: a rectangle that may also be TURNED.
 *
 * `rotationDeg` is the overlay convention and nothing new. Same name, same clockwise degrees CSS
 * `rotate()` means, same place in the order: a layer is positioned, sized, and then turned. Two
 * native engines and the preview already draw a sticker that way, so a video layer that turns the
 * same way is maths all three of them already have.
 *
 * It turns about the rectangle's CENTRE, in OUTPUT PIXELS. The centre is the only origin a drag
 * survives: a corner origin swings the picture around a point that moves with `x` and `y`, so a
 * layer turned and then dragged would land where neither the finger nor the rectangle asked for.
 * Output pixels rather than the 0..1 the rectangle is stored in, because normalised space is
 * stretched by the frame it describes - on a 720x1280 post a square window turned 45 degrees comes
 * out a rhombus if the angle is applied in those coordinates, and the preview turns it in CSS
 * pixels where it does not.
 *
 * The fit is measured BEFORE the turn, in the upright rectangle, and the fitted result is turned as
 * one piece. `contain` and `cover` therefore mean exactly what they mean with no angle at all, and
 * the picture keeps its size while a two-finger gesture spins it. Fitting into the turned
 * rectangle's bounding box instead would make the video swell and shrink as it is turned, which is
 * a thing no customer asked a rotate gesture for. `cover` still clips to the rectangle, in the
 * rectangle's own turned frame.
 *
 * Absent and a whole number of turns are the same upright rectangle, and a rectangle only reaches
 * the wire when it says something (see [isFullFrameRect]), so a clip nobody turned costs nothing.
 *
 * The four numbers may leave the frame. `x` and `y` may be negative and the rectangle may be larger
 * than the frame it is drawn on, up to [MAX_PLACEMENT_SIZE]; all that is held is a strip of it on
 * the frame, [MIN_ON_FRAME] wide. Everything that hangs over an edge is cut off there, by the frame
 * in the preview and by the output frame in all four renderers, which is what makes the canvas free.
 */
export interface EditPlacement extends EditRect {
  /** Clockwise, as CSS means it - the units and the sense of [OverlayCommon.rotationDeg]. */
  rotationDeg?: number;
}

export interface EditClip {
  /**
   * The segment's own id, unique within the manifest. Split and duplicate put two segments over the
   * same source, so `clipKey` alone can no longer tell them apart.
   */
  id: string;
  /** The host's own identifier for the source clip. Several segments may share one. */
  clipKey: string;
  /** Trim, in source milliseconds. */
  inMs: number;
  outMs: number;
  /** 0.25 .. 4. */
  speed: number;
  /** 0..1. */
  volume: number;
  muted: boolean;
  /**
   * The part of the ORIENTED source frame to keep, as a fraction of it. Absent is the whole frame,
   * which is what every manifest written before version 3 meant. Applied BEFORE the fit, so the fit
   * measures the cropped picture and not the original.
   */
  crop?: EditRect;
  /**
   * Where the cropped picture is drawn on the output frame, and at what angle. Absent is the whole
   * frame the right way up, and the fit then letterboxes exactly as it always did. Present, the fit
   * applies WITHIN this rectangle.
   *
   * The angle lives on the rectangle rather than beside it so the two can never be half set: there
   * is nothing to turn a clip about until it is placed, and a layout preset carries an
   * arrangement's tilt in the numbers it already carries its position in, with nothing for any
   * engine to learn. `crop` stays the plain [EditRect] on purpose - turning the part of the SOURCE
   * that is sampled is a different operation on different pixels, and a field honoured in one
   * position and ignored in the other is how two engines start disagreeing.
   */
  rect?: EditPlacement;
  /**
   * This segment's own fit, for a clip placed in a `rect` that wants filling while the rest of the
   * timeline is letterboxed. Absent means the manifest's [EditManifest.fit], which is still what a
   * customer toggles for the whole post and still what a clip added today gets.
   */
  fit?: EditFit;
  /**
   * How this segment takes over from the one before it on the BASE track. Absent is a cut.
   *
   * On the clip AFTER the boundary rather than the one before it, because that is the side a split
   * leaves alone: the left piece of a split keeps its id and with it the transition that brought it
   * in, and the new cut in the middle starts as a cut. Never on the first clip of the base track and
   * never on a layer's clip - the ops take it off both, and [normaliseManifest] drops it there.
   *
   * `durationMs` is what the customer ASKED for. The two clips either side can only hold so much,
   * and [transitionSpan] clamps it when it is read, so a trim dragged short and back again gets the
   * transition back as it was.
   */
  transitionIn?: EditTransition;
  /**
   * The source is a PICTURE rather than a video: one still frame, held for as long as the segment
   * runs. Absent is a video, which is every segment of every manifest written before version 9.
   *
   * A picture has no length of its own, so it is given a source [PICTURE_SOURCE_MS] long and its
   * segment starts in the MIDDLE of it (see [defaultPictureEdit]). That is what lets it be trimmed,
   * cut, joined and duplicated by the very ops a video segment is, with no op learning a second kind
   * of clip: both handles have room to pull the picture longer, and a cut leaves two halves that meet
   * exactly, which is what Join asks of them. The numbers are otherwise meaningless - every engine
   * reads a picture's length off `outMs - inMs` and nothing else.
   *
   * A picture plays at 1x and has no sound. [normaliseManifest] and [setClipSpeed] hold the first,
   * and [toComposeSpec] mutes it on the wire.
   */
  image?: true;
}

/** A transition between two base clips: which one, and how long the customer asked for it to run. */
export interface EditTransition {
  /** An id from [TRANSITIONS]. */
  kind: string;
  durationMs: number;
}

/**
 * Another layer of video, so several clips can be on screen at once - split screen, picture in
 * picture, and any collage in between. Its clips are a flat SEQUENCE exactly like
 * [EditManifest.clips]: they play one after another and never overlap EACH OTHER. Overlap happens
 * BETWEEN tracks and nowhere else, because a track is what each engine can actually hold - one
 * `EditedMediaItemSequence` on Android, one `AVMutableCompositionTrack` on iOS, both of them
 * non-overlapping by definition.
 *
 * Where a layer sits on the frame is not a property of the track: it is each clip's own
 * [EditClip.rect], which version 3 already renders and which version 5 can also turn. A layout
 * preset is therefore nothing more than rectangles written onto the clips of the tracks.
 */
export interface EditVideoTrack {
  /** Unique within the manifest, and echoed back by the native engines on a failure. */
  id: string;
  /** Never empty: a track with nothing on it is dropped rather than carried around. */
  clips: EditClip[];
  /**
   * Where this track's first clip lands on the OUTPUT timeline. The base track always starts at 0
   * and its length is the length of the post, so a track running past the base is cut and one
   * ending early leaves the base showing underneath.
   */
  startMs: number;
  /** Higher draws later, so on top. The base track is 0 and a track added today gets 1. */
  z: number;
  /** 0..1 over the whole track. 1 is the picture as it is. */
  opacity: number;
}

export type TextAlign = 'left' | 'center' | 'right';

/**
 * How a text's colour is used. `plate` and `plateSoft` paint the colour BEHIND the text (solid and
 * translucent) and pick black or white for the letters; the others paint the letters.
 */
export type TextEffect = 'none' | 'plate' | 'plateSoft' | 'outline' | 'shadow';

/** What every layer on the video shares. */
export interface OverlayCommon {
  id: string;
  /** Centre, 0..1, top-left origin - the same coordinates the composer takes. */
  cx: number;
  cy: number;
  /** Multiplies the kind's base size (see [OVERLAY_BASE]). Baked into the bitmap, never scaled natively. */
  scale: number;
  /** Clockwise, as CSS means it. */
  rotationDeg: number;
  /** 0..1. For an effect this is its strength. */
  opacity: number;
  /** Output-timeline window. `endMs` of 0 means "until the end". */
  startMs: number;
  endMs: number;
}

export interface TextOverlay extends OverlayCommon {
  kind: 'text';
  /** Raw, with `\n` for the line breaks the customer typed. Wrapping is the rasteriser's job. */
  text: string;
  /** A text style id from the host's style registry (font, weight, glow...). */
  styleId: string;
  color: string;
  effect: TextEffect;
  align: TextAlign;
}

export interface StickerOverlay extends OverlayCommon {
  kind: 'sticker';
  /** Exactly one of the two. An emoji is drawn with the device's own emoji font. */
  emoji: string | null;
  /** A sticker from the host's bundled pack, resolved to a URL by the rasteriser's context. */
  assetId: string | null;
}

export interface ImageOverlay extends OverlayCommon {
  kind: 'image';
  /** `file://` or `content://` of the picked photo. */
  uri: string;
  fileName: string;
  /** Natural width / height, so a layout never has to wait for the photo to decode. */
  aspect: number;
}

/**
 * A full-frame look (vignette, film frame, grain...) for a window of the video. It is a bitmap like
 * every other layer, which is what lets it render natively with no shader of its own. Position,
 * scale and rotation are fixed at the frame; `opacity` is its strength.
 */
export interface EffectOverlay extends OverlayCommon {
  kind: 'effect';
  effectId: string;
}

export type EditOverlay = TextOverlay | StickerOverlay | ImageOverlay | EffectOverlay;
export type OverlayKind = EditOverlay['kind'];

export interface EditMusic {
  uri: string;
  fileName: string;
  /** Length of the whole track, 0 when it could not be read. */
  sourceDurationMs: number;
  /** The section of the track that is used. `outMs` of 0 means "to the end of the track". */
  inMs: number;
  outMs: number;
  /** Where the track starts on the OUTPUT timeline. */
  startMs: number;
  volume: number;
  /** Repeat the section until the video ends. */
  loop: boolean;
  fadeOutMs: number;
}

export interface EditVoiceover {
  id: string;
  uri: string;
  /** Where the take starts on the OUTPUT timeline. Takes never overlap. */
  startMs: number;
  durationMs: number;
  volume: number;
}

/** Each -1..1 with 0 as "untouched", except `fade` which is 0..1. */
export interface EditAdjust {
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  /** Negative is green, positive is magenta. */
  tint: number;
  fade: number;
}

export interface EditManifest {
  version: typeof MANIFEST_VERSION;
  /**
   * The BASE track. It always starts at 0 and its length is the length of the post: everything in
   * [EditManifest.videoTracks] is cut to it.
   */
  clips: EditClip[];
  /**
   * Extra video layers over `clips`, at most [MAX_VIDEO_TRACKS] - 1 of them, bottom to top by `z`.
   * Empty is the whole of what every manifest written before version 4 could say, and empty is
   * what [toComposeSpec] turns back into a spec with no `tracks` key at all - which is what lets
   * every engine keep the single-sequence path it takes today.
   *
   * An array rather than an optional key, unlike a clip's crop: there is no wire fast path to
   * protect here (the emptiness is tested when the spec is built, once) and every reader would
   * otherwise have to write `?? []` around a list that is conceptually always there.
   */
  videoTracks: EditVideoTrack[];
  /**
   * How long the post runs when that is MORE than the base track, in output ms. 0 is "as long as the
   * base track", which is what every manifest written before version 6 meant and what a post nobody
   * has pulled the end of still means.
   *
   * The base track used to be the whole answer, and that made the timeline as long as the footage on
   * its bottom row: a layer could be placed anywhere the base already reached and nowhere else. A
   * customer wanting a second video to play AFTER the first had nothing to drag it onto. So the post
   * gets a length of its own, and past the base track's last frame the picture is BLACK - which is
   * exactly what every engine already draws in the gaps a layer leaves, so there is no new kind of
   * frame here, only a new place to find one.
   *
   * Never shorter than the base track: the base is the spine of the post and a length that cut it
   * off would be a trim nobody asked for, made by dragging something else. [setPostDuration] holds
   * that floor, and the readers below take the larger of the two rather than trusting the number.
   */
  durationMs: number;
  /** Id from [FILTER_PRESETS]. */
  filterId: string;
  /** 0..1, how far the preset is applied. */
  filterIntensity: number;
  adjust: EditAdjust;
  /** The whole post's fit, and the default for a segment that carries no [EditClip.fit] of its own. */
  fit: EditFit;
  /** Mutes every clip's own sound without touching music or voiceover. */
  originalMuted: boolean;
  /** Bottom to top: a later layer is drawn over an earlier one, in the preview and in the render. */
  overlays: EditOverlay[];
  music: EditMusic | null;
  /** Sorted by `startMs`, never overlapping. */
  voiceovers: EditVoiceover[];
  /**
   * The frame the post is rendered at, and the frame every fraction here is a fraction OF.
   *
   * Always present, like [videoTracks] and for the same reason: every reader needs it, an absent
   * one would have to be defaulted at each of them, and a post that carries [DEFAULT_OUTPUT]
   * explicitly is the post that was always being made. A manifest written before version 7 has no
   * `output` key and [normaliseManifest] gives it that same default, so it reopens unchanged.
   */
  output: EditOutput;
}

/* -------------------------------------------------------------------------------------------- */

/**
 * The shape and size of the finished post.
 *
 * It is the frame every fraction in this manifest is a fraction OF: a clip's rectangle, a layer's
 * centre, a crop. Changing it therefore changes what the whole post means, which is why it lives
 * here beside them rather than being handed to the render at the end.
 */
export interface EditOutput {
  width: number;
  height: number;
  fps: number;
}

/** 720x1280 at 30 fps - portrait, and what a vertical feed plays. */
export const DEFAULT_OUTPUT: EditOutput = { width: 720, height: 1280, fps: 30 };

/** Which way up the post is. Nothing else: a frame is one of these two shapes. */
export type OutputAspect = '9:16' | '16:9';

/**
 * A resolution, named by its SHORT side.
 *
 * The short side and not the long one, because the same choice has to name a portrait frame and a
 * landscape one: `1080p` is 1080x1920 standing up and 1920x1080 lying down, and a ladder written in
 * long sides would have to be read backwards for one of the two.
 */
export interface OutputQuality {
  id: string;
  label: string;
  /** The frame's shorter side in pixels. Even, as every H.264 encoder requires. */
  shortSide: number;
}

/**
 * What a customer may choose, smallest first.
 *
 * Whether a given platform can actually ENCODE each of them is a different question, asked of the
 * composer rather than assumed here: a phone from four years ago refuses 4K, a browser without an
 * H.264 encoder refuses everything above what its fallback can manage, and the sheet greys out what
 * comes back unsupported instead of offering a choice that would fail at the last step.
 */
export const OUTPUT_QUALITIES: readonly OutputQuality[] = [
  { id: '720p', label: '720P', shortSide: 720 },
  { id: '1080p', label: '1080P', shortSide: 1080 },
  { id: '2.7k', label: '2.7K', shortSide: 1520 },
  { id: '4k', label: '4K', shortSide: 2160 },
];

/** The frame rates on offer. 60 is smoother and twice the bitrate for the same picture. */
export const OUTPUT_FPS = [30, 60] as const;

/** The frame those three choices come to. */
export function outputFor(aspect: OutputAspect, qualityId: string, fps: number): EditOutput {
  const quality = OUTPUT_QUALITIES.find((one) => one.id === qualityId) ?? OUTPUT_QUALITIES[0];
  const short = quality.shortSide;
  // 16:9 of a 1080 short side is 1920, and both sides stay even because 16/9 of any multiple of 9
  // is a whole number and these are all multiples of 8.
  const long = Math.round((short * 16) / 9 / 2) * 2;
  const upright = aspect === '9:16';
  return { width: upright ? short : long, height: upright ? long : short, fps: nearestFps(fps) };
}

/** Which way up a frame is. A square one counts as upright, as the default is. */
export function aspectOf(output: EditOutput): OutputAspect {
  return output.width > output.height ? '16:9' : '9:16';
}

/** The quality a frame is on, by its short side, or the nearest one below it. */
export function qualityOf(output: EditOutput): OutputQuality {
  const short = Math.min(output.width, output.height);
  let best = OUTPUT_QUALITIES[0];
  for (const quality of OUTPUT_QUALITIES) {
    if (quality.shortSide <= short + 1) best = quality;
  }
  return best;
}

function nearestFps(fps: number): number {
  return OUTPUT_FPS.reduce((best, one) => (Math.abs(one - fps) < Math.abs(best - fps) ? one : best), OUTPUT_FPS[0]);
}

/** A frame read off a stored post or a host's props, held to something an engine can encode. */
export function normaliseOutput(value: unknown): EditOutput {
  if (!value || typeof value !== 'object') return { ...DEFAULT_OUTPUT };
  const raw = value as Record<string, unknown>;
  // Even sides, because H.264 refuses an odd one and the failure comes at the end of the render.
  const width = evenWithin(num(raw['width'], DEFAULT_OUTPUT.width));
  const height = evenWithin(num(raw['height'], DEFAULT_OUTPUT.height));
  return { width, height, fps: nearestFps(num(raw['fps'], DEFAULT_OUTPUT.fps)) };
}

/** The sides a frame may have: not zero, not larger than the tallest rung of the ladder, and even. */
function evenWithin(value: number): number {
  const longest = Math.round((OUTPUT_QUALITIES[OUTPUT_QUALITIES.length - 1].shortSide * 16) / 9);
  return Math.round(clamp(value, 16, longest) / 2) * 2;
}

/**
 * The size of each layer kind at `scale` 1, as fractions of the OUTPUT width. The rasteriser draws
 * at `base * scale`, and the preview sizes the resulting bitmap by `wPx / DEFAULT_OUTPUT.width` of
 * its own width - so both agree without either knowing the other's pixel density.
 */
export const OVERLAY_BASE = {
  /** Font size of a text layer. */
  textFont: 0.065,
  /** Widest a line of text may run before it wraps, at scale 1. */
  textWrap: 0.86,
  /** Glyph size of an emoji. */
  emoji: 0.2,
  /** Width of a bundled sticker. */
  sticker: 0.34,
  /** Width of a photo. */
  image: 0.5,
} as const;

/** Every layer kind together. More than this and a mid-range phone runs out of bitmap memory. */
export const MAX_LAYERS = 30;

/**
 * How many video layers a post may hold, the BASE TRACK INCLUDED - so sixteen is the base and
 * fifteen more. How many pictures belong on the frame is the customer's to decide, and this number
 * is not an opinion about it.
 *
 * It used to be a playback budget, and that was the wrong place for one. The EXPORT composites
 * offline: nothing there is racing a frame deadline, a layer that costs more only makes the render
 * take longer, and neither engine has a structural reason to stop at two. What the LIVE PREVIEW can
 * decode at once is a real limit, but it is a different number in a different place. It belongs to
 * the preview, which is where a dropped frame is actually felt and which is free to show a still
 * for a layer it cannot play while the render still draws every one of them.
 *
 * A ceiling stays because the parsers need one to refuse with. A spec asking for hundreds of layers
 * is a caller bug, and it has to come back as a sentence naming the limit rather than as an
 * out-of-memory kill with nothing in the log to read. Sixteen is where absurdity starts rather than
 * where a phone starts to struggle: a collage a person builds by hand on a phone screen does not
 * reach it, and a spec past it was not built by a person.
 */
export const MAX_VIDEO_TRACKS = 16;

/**
 * The longest a post may run, tail and all: half an hour.
 *
 * A ceiling on absurdity rather than an opinion about length, like [MAX_VIDEO_TRACKS]. The end of
 * the timeline is dragged, and a drag with nothing to stop it can be carried for as long as a finger
 * holds at the edge of the screen - so there has to be a number, and it has to be one no post a
 * person builds by hand on a phone will ever reach.
 */
export const MAX_POST_MS = 30 * 60 * 1000;

/** The shortest a clip segment may become. */
export const MIN_CLIP_MS = 200;

/** The shortest a layer, a music section or a voiceover may become. */
export const MIN_LAYER_MS = 100;

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 6;

/**
 * The smallest a crop or a placement rectangle may become, as a fraction of the frame. This is a
 * degeneracy floor and not a matter of taste - a zero-width rectangle is a black frame, and the
 * native parsers reject `w <= 0` outright - so a crop tool wanting to stop the customer zooming
 * past the source's real resolution has to impose its own, tighter, limit on top.
 */
export const MIN_RECT_SIZE = 0.01;

/**
 * The largest a clip's placement rectangle may be, as a multiple of the frame.
 *
 * A placement is free of the frame's edges (see [normalisePlacement]), so its size has to stop
 * somewhere or a pinch could ask for a rectangle a thousand frames wide. Two is what the renderers
 * can take rather than a matter of taste: a clip on an extra video layer is drawn into a texture of
 * its rectangle's own size, and twice a 1080x1920 output is 2160x3840, still inside the 4096 every
 * GL implementation this package runs on guarantees. A crop has no such cap and needs none - there
 * is nothing outside a source frame to sample.
 */
export const MAX_PLACEMENT_SIZE = 2;

/**
 * How much of a clip's placement rectangle has to stay ON the frame, as a fraction of it.
 *
 * The only limit left on where a video may be put. A customer pushing one off an edge is framing
 * the shot - a strip of it along the bottom, a corner of it behind a caption - so the rule has to
 * let them go on until almost nothing of it is left, and stop only where the video would be gone
 * altogether: a rectangle with no part of it on the frame is invisible in the preview, invisible in
 * the render, and impossible to get a finger back onto.
 *
 * A twelfth of the frame is roughly 60px across a 720 wide output and 105 down a 1280 tall one,
 * which is a strip a thumb can still find. A rectangle SMALLER than this keeps all of itself on the
 * frame instead, because a video a twentieth of the frame wide cannot leave a twelfth of itself
 * behind.
 */
export const MIN_ON_FRAME = 1 / 12;

/**
 * How far a placement of this size may run in one axis: from `min` (pushed off the near edge) to
 * `max` (pushed off the far one), as the rectangle's own leading edge.
 *
 * One function for both axes and for all four of the places that enforce this - the manifest, the
 * gesture that writes it, and the three parsers that read it off the wire - because the same post
 * has to be the same picture on every engine.
 */
export function placementRange(size: number): { min: number; max: number } {
  const kept = Math.min(size, MIN_ON_FRAME);
  return { min: kept - size, max: 1 - kept };
}

/**
 * How close to the edges of the frame still counts as the whole frame. One unit of the four-decimal
 * rounding a rectangle is stored at, so a crop box dragged back into the corners collapses to
 * "absent" rather than sitting one ten-thousandth off it and costing every engine its fast path.
 */
const FULL_FRAME_EPSILON = 1e-4;

export const SPEED_CHIPS = [0.5, 1, 1.5, 2, 3] as const;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

export const TEXT_COLORS = [
  '#ffffff',
  '#000000',
  '#ff3b5c',
  '#ff8a3d',
  '#ffd23f',
  '#a6ff2e',
  '#2ee6a6',
  '#3dc2ff',
  '#3d6bff',
  '#9b5cff',
  '#ff5cc8',
  '#f5e6c8',
  '#8e8e93',
  '#0b8e87',
  '#4b1b5a',
];

/**
 * A ceiling one particular host happens to have, kept only because an app may want the number.
 *
 * It is NOT applied to anything here. A render size is the host's policy and not this package's:
 * one app posts to a server with a 100MB limit and offers 720p and 1080p, another builds 4K for a
 * different purpose entirely, and a bitrate quietly held down to somebody else's ceiling would make
 * the second app's 4K a bigger, softer 1080p. What a host allows is [EditorOutputOptions], and the
 * editor offers exactly that.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Enough bitrate to make a frame of THIS size look like the source, and nothing to do with how big
 * the resulting file is. A host that has a size limit expresses it by choosing which rungs of the
 * ladder to offer, which is a decision it can explain to its customer; a bitrate secretly reduced
 * to fit somebody's upload endpoint is one nobody can see and everybody blames the encoder for.
 */
export function videoBitrateFor(output: EditOutput = DEFAULT_OUTPUT): number {
  return Math.max(1_200_000, idealBitrate(output));
}

/**
 * Bits per pixel per frame: what H.264 needs to keep a frame of THIS size looking like the source.
 *
 * A rate is a property of the frame and not a number that can be fixed once. 4 Mbps is generous at
 * 720x1280 and is a smear at 4K, which is the whole reason this exists: the old ceiling was a
 * constant, and offering a customer 4K while handing the encoder a 720p budget would have given
 * them a bigger, softer video and called it higher quality.
 *
 * A twelfth of a bit per pixel is around the knee of the curve for H.264 at these sizes: 2.3 Mbps
 * at 720x1280/30, 5.2 at 1080x1920/30, 41 at 4K/60.
 */
const BITS_PER_PIXEL = 1 / 12;

function idealBitrate(output: EditOutput): number {
  const pixels = Math.max(1, output.width * output.height);
  return Math.round(pixels * Math.max(1, output.fps) * BITS_PER_PIXEL);
}

/**
 * Roughly how big the finished file will be, for the sheet to show before anyone commits to it.
 *
 * Video plus the 128 kbps of audio every spec carries, which is small enough at these rates to be
 * noise and large enough on a long post to be worth not pretending about. It is an estimate in the
 * honest sense: a still shot comes out well under it and a handheld one in a busy room comes close,
 * because that is what a bitrate MEANS to an encoder that is allowed to spend less.
 */
export function estimatedBytes(totalMs: number, output: EditOutput): number {
  const seconds = Math.max(0, totalMs / 1000);
  const bits = (videoBitrateFor(output) + 128_000) * seconds;
  return Math.round(bits / 8);
}

/* -------------------------------------------------------------------------------------------- */
/* Colour                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export type FilterCategory = 'trending' | 'food' | 'portrait' | 'landscape' | 'vintage' | 'mono';

export interface FilterPreset {
  id: string;
  label: string;
  category: FilterCategory;
  ops: FilterOp[];
}

export const FILTER_CATEGORIES: { id: FilterCategory; label: string }[] = [
  { id: 'trending', label: 'Trending' },
  { id: 'food', label: 'Food' },
  { id: 'portrait', label: 'Portrait' },
  { id: 'landscape', label: 'Landscape' },
  { id: 'vintage', label: 'Vintage' },
  { id: 'mono', label: 'B&W' },
];

/**
 * Every preset is CSS Filter Effects maths. That is what lets a preview drawn by the WebView with
 * `filter:` and the frames the native encoder writes agree without anyone tuning one against the
 * other - both read the same numbers. Tints always come last in a preset, for the reason given on
 * [resolveFilterOps].
 */
export const FILTER_PRESETS: FilterPreset[] = [
  { id: 'none', label: 'Original', category: 'trending', ops: [] },
  {
    id: 'crisp',
    label: 'Crisp',
    category: 'trending',
    ops: [
      { op: 'contrast', amount: 1.1 },
      { op: 'saturate', amount: 1.1 },
    ],
  },
  {
    id: 'vivid',
    label: 'Vivid',
    category: 'trending',
    ops: [
      { op: 'saturate', amount: 1.4 },
      { op: 'contrast', amount: 1.12 },
    ],
  },
  {
    id: 'warm',
    label: 'Warm',
    category: 'trending',
    ops: [
      { op: 'saturate', amount: 1.15 },
      { op: 'brightness', amount: 1.03 },
      { op: 'tint', rgb: [255, 168, 72], alpha: 0.1 },
    ],
  },
  {
    id: 'golden',
    label: 'Golden',
    category: 'trending',
    ops: [
      { op: 'saturate', amount: 1.25 },
      { op: 'contrast', amount: 1.05 },
      { op: 'tint', rgb: [255, 186, 66], alpha: 0.18 },
    ],
  },
  {
    id: 'cool',
    label: 'Cool',
    category: 'trending',
    ops: [
      { op: 'saturate', amount: 1.05 },
      { op: 'tint', rgb: [72, 148, 255], alpha: 0.12 },
    ],
  },
  {
    id: 'fade',
    label: 'Fade',
    category: 'trending',
    ops: [
      { op: 'contrast', amount: 0.85 },
      { op: 'brightness', amount: 1.08 },
      { op: 'saturate', amount: 0.85 },
    ],
  },
  {
    id: 'tasty',
    label: 'Tasty',
    category: 'food',
    ops: [
      { op: 'saturate', amount: 1.3 },
      { op: 'contrast', amount: 1.08 },
      { op: 'tint', rgb: [255, 150, 60], alpha: 0.06 },
    ],
  },
  {
    id: 'fresh',
    label: 'Fresh',
    category: 'food',
    ops: [
      { op: 'saturate', amount: 1.2 },
      { op: 'brightness', amount: 1.05 },
      { op: 'tint', rgb: [140, 255, 170], alpha: 0.05 },
    ],
  },
  {
    id: 'bakery',
    label: 'Bakery',
    category: 'food',
    ops: [
      { op: 'sepia', amount: 0.2 },
      { op: 'saturate', amount: 1.15 },
      { op: 'brightness', amount: 1.05 },
    ],
  },
  {
    id: 'espresso',
    label: 'Espresso',
    category: 'food',
    ops: [
      { op: 'contrast', amount: 1.15 },
      { op: 'saturate', amount: 0.9 },
      { op: 'sepia', amount: 0.25 },
      { op: 'brightness', amount: 0.95 },
    ],
  },
  {
    id: 'pure',
    label: 'Pure',
    category: 'portrait',
    ops: [
      { op: 'brightness', amount: 1.06 },
      { op: 'contrast', amount: 0.95 },
      { op: 'saturate', amount: 0.95 },
    ],
  },
  {
    id: 'glow',
    label: 'Glow',
    category: 'portrait',
    ops: [
      { op: 'brightness', amount: 1.08 },
      { op: 'saturate', amount: 1.05 },
      { op: 'tint', rgb: [255, 200, 200], alpha: 0.06 },
    ],
  },
  {
    id: 'peach',
    label: 'Peach',
    category: 'portrait',
    ops: [
      { op: 'saturate', amount: 1.05 },
      { op: 'tint', rgb: [255, 170, 140], alpha: 0.1 },
    ],
  },
  {
    id: 'sunrise',
    label: 'Sunrise',
    category: 'landscape',
    ops: [
      { op: 'saturate', amount: 1.2 },
      { op: 'tint', rgb: [255, 140, 90], alpha: 0.12 },
    ],
  },
  {
    id: 'ocean',
    label: 'Ocean',
    category: 'landscape',
    ops: [
      { op: 'saturate', amount: 1.1 },
      { op: 'hueRotate', degrees: -8 },
      { op: 'tint', rgb: [60, 160, 255], alpha: 0.1 },
    ],
  },
  {
    id: 'forest',
    label: 'Forest',
    category: 'landscape',
    ops: [
      { op: 'saturate', amount: 1.15 },
      { op: 'hueRotate', degrees: 8 },
      { op: 'contrast', amount: 1.05 },
    ],
  },
  {
    id: 'retro',
    label: 'Retro',
    category: 'vintage',
    ops: [
      { op: 'sepia', amount: 0.35 },
      { op: 'contrast', amount: 0.95 },
      { op: 'brightness', amount: 1.05 },
      { op: 'tint', rgb: [255, 210, 150], alpha: 0.08 },
    ],
  },
  {
    id: 'polaroid',
    label: 'Polaroid',
    category: 'vintage',
    ops: [
      { op: 'contrast', amount: 0.9 },
      { op: 'brightness', amount: 1.1 },
      { op: 'saturate', amount: 0.8 },
      { op: 'tint', rgb: [255, 240, 200], alpha: 0.08 },
    ],
  },
  {
    id: 'seventies',
    label: '1970',
    category: 'vintage',
    ops: [
      { op: 'sepia', amount: 0.5 },
      { op: 'saturate', amount: 1.2 },
      { op: 'hueRotate', degrees: -10 },
    ],
  },
  {
    id: 'mono',
    label: 'Mono',
    category: 'mono',
    ops: [
      { op: 'grayscale', amount: 1 },
      { op: 'contrast', amount: 1.08 },
    ],
  },
  {
    id: 'noir',
    label: 'Noir',
    category: 'mono',
    ops: [
      { op: 'grayscale', amount: 1 },
      { op: 'contrast', amount: 1.35 },
      { op: 'brightness', amount: 0.92 },
    ],
  },
  {
    id: 'silver',
    label: 'Silver',
    category: 'mono',
    ops: [
      { op: 'grayscale', amount: 1 },
      { op: 'brightness', amount: 1.1 },
      { op: 'contrast', amount: 0.9 },
    ],
  },
];

export interface AdjustSlider {
  id: keyof EditAdjust;
  label: string;
  /** -1 for the two-sided sliders, 0 for `fade`. */
  min: -1 | 0;
}

export const ADJUST_SLIDERS: AdjustSlider[] = [
  { id: 'brightness', label: 'Brightness', min: -1 },
  { id: 'contrast', label: 'Contrast', min: -1 },
  { id: 'saturation', label: 'Saturation', min: -1 },
  { id: 'warmth', label: 'Warmth', min: -1 },
  { id: 'tint', label: 'Tint', min: -1 },
  { id: 'fade', label: 'Fade', min: 0 },
];

export function neutralAdjust(): EditAdjust {
  return { brightness: 0, contrast: 0, saturation: 0, warmth: 0, tint: 0, fade: 0 };
}

export function filterPreset(id: string): FilterPreset {
  return FILTER_PRESETS.find((preset) => preset.id === id) ?? FILTER_PRESETS[0];
}

/**
 * A preset's ops pulled toward identity. `k` of 1 is the preset as designed and 0 is no change:
 * multiplicative amounts move toward 1, the "how much" ops toward 0, angles toward 0 degrees and a
 * tint toward transparent.
 */
export function scaleOps(ops: FilterOp[], k: number): FilterOp[] {
  const t = clamp(k, 0, 1);
  if (t === 1) return ops;
  return ops.map((op): FilterOp => {
    switch (op.op) {
      case 'brightness':
      case 'contrast':
      case 'saturate':
        return { op: op.op, amount: round4(1 + (op.amount - 1) * t) };
      case 'sepia':
      case 'grayscale':
        return { op: op.op, amount: round4(op.amount * t) };
      case 'hueRotate':
        return { op: 'hueRotate', degrees: round4(op.degrees * t) };
      case 'tint':
        return { op: 'tint', rgb: op.rgb, alpha: round4(op.alpha * t) };
    }
  });
}

/** The Adjust sliders as CSS maths. Neutral sliders contribute nothing at all. */
export function adjustOps(adjust: EditAdjust): FilterOp[] {
  const ops: FilterOp[] = [];
  const a = { ...neutralAdjust(), ...adjust };
  if (a.brightness) ops.push({ op: 'brightness', amount: round4(1 + 0.4 * a.brightness) });
  if (a.contrast) ops.push({ op: 'contrast', amount: round4(1 + 0.4 * a.contrast) });
  if (a.saturation) ops.push({ op: 'saturate', amount: round4(1 + 0.6 * a.saturation) });
  if (a.fade > 0) {
    ops.push({ op: 'contrast', amount: round4(1 - 0.3 * a.fade) });
    ops.push({ op: 'saturate', amount: round4(1 - 0.15 * a.fade) });
  }
  if (a.warmth > 0) ops.push({ op: 'tint', rgb: [255, 160, 60], alpha: round4(0.14 * a.warmth) });
  if (a.warmth < 0) ops.push({ op: 'tint', rgb: [60, 140, 255], alpha: round4(0.14 * -a.warmth) });
  if (a.tint > 0) ops.push({ op: 'tint', rgb: [255, 60, 220], alpha: round4(0.1 * a.tint) });
  if (a.tint < 0) ops.push({ op: 'tint', rgb: [60, 230, 90], alpha: round4(0.1 * -a.tint) });
  return ops;
}

/**
 * The whole colour pipeline the render runs: the preset at its intensity, then the Adjust sliders.
 *
 * Tints are moved to the end. The preview can only draw a tint as a translucent layer ON TOP of a
 * CSS-filtered video, so every tint lands after every other op there whatever order the list says;
 * putting them last here is what makes the native render do the same thing.
 */
export function resolveFilterOps(manifest: Pick<EditManifest, 'filterId' | 'filterIntensity' | 'adjust'>): FilterOp[] {
  const all = [
    ...scaleOps(filterPreset(manifest.filterId).ops, manifest.filterIntensity ?? 1),
    ...adjustOps(manifest.adjust ?? neutralAdjust()),
  ].filter((op) => !isIdentityOp(op));
  return [...all.filter((op) => op.op !== 'tint'), ...all.filter((op) => op.op === 'tint')];
}

/**
 * The browser's reading of a filter stack, for a live preview: a CSS `filter` string plus the tints,
 * which CSS has no filter function for and a host draws as translucent layers on top, in order.
 * `tint` is the last of them, for callers that only ever had one.
 */
export function cssFor(ops: FilterOp[]): { filter: string; tints: string[]; tint: string | null } {
  const parts: string[] = [];
  const tints: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case 'brightness':
        parts.push(`brightness(${op.amount})`);
        break;
      case 'contrast':
        parts.push(`contrast(${op.amount})`);
        break;
      case 'saturate':
        parts.push(`saturate(${op.amount})`);
        break;
      case 'sepia':
        parts.push(`sepia(${op.amount})`);
        break;
      case 'grayscale':
        parts.push(`grayscale(${op.amount})`);
        break;
      case 'hueRotate':
        parts.push(`hue-rotate(${op.degrees}deg)`);
        break;
      case 'tint':
        tints.push(`rgba(${op.rgb[0]}, ${op.rgb[1]}, ${op.rgb[2]}, ${op.alpha})`);
        break;
    }
  }
  return { filter: parts.join(' ') || 'none', tints, tint: tints[tints.length - 1] ?? null };
}

function isIdentityOp(op: FilterOp): boolean {
  switch (op.op) {
    case 'brightness':
    case 'contrast':
    case 'saturate':
      return op.amount === 1;
    case 'sepia':
    case 'grayscale':
      return op.amount === 0;
    case 'hueRotate':
      return op.degrees === 0;
    case 'tint':
      return op.alpha === 0;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Framing                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * A crop or placement rectangle brought inside the frame, or `undefined` for anything that is not
 * one. Absence is carried through deliberately: "no crop" has to stay a missing field all the way
 * to the wire, because every engine tests for exactly that to keep doing what it did before crops
 * existed, and a full-frame rectangle substituted in as a default would quietly cost that.
 *
 * The size the customer asked for is what is kept: a rectangle pushed off an edge slides back in
 * rather than being squashed against it. Squashing is the other reading of "clamp so `x + w <= 1`",
 * and it turns a crop dragged all the way to the right edge into a zero-width one - a black frame,
 * and a shape the native parsers refuse.
 *
 * Four numbers and nothing else, so this stays the reader for a crop. A placement's angle comes
 * back from [normalisePlacement] instead, because nothing turns the part of a source that is kept.
 */
export function normaliseRect(value: unknown): EditRect | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  // Rounded before the corner is clamped against it, not after: rounding a corner up once the room
  // for it had already been worked out could push `x + w` a ten-thousandth past 1 and hand the
  // native parsers a rectangle they would have to clamp all over again.
  const w = round4(clamp(num(raw['w'], 1), MIN_RECT_SIZE, 1));
  const h = round4(clamp(num(raw['h'], 1), MIN_RECT_SIZE, 1));
  return {
    x: Math.min(round4(clamp(num(raw['x'], 0), 0, 1)), round4(1 - w)),
    y: Math.min(round4(clamp(num(raw['y'], 0), 0, 1)), round4(1 - h)),
    w,
    h,
  };
}

/**
 * A placement rectangle with its angle kept, or `undefined` for anything that is not one.
 *
 * A placement is FREE of the frame, and that is the whole difference between it and a crop. A crop
 * names a part of a source and there is nothing outside a source to name, so [normaliseRect] holds
 * one inside the unit square; a placement says where a picture is DRAWN, and a customer who pushes
 * a video off the side of the canvas means the part that hangs over to be cut off by the frame -
 * the arrangement every phone editor is built on. So `x` and `y` may be negative, `x + w` may pass
 * 1, and the size may run to [MAX_PLACEMENT_SIZE] of the frame.
 *
 * What is held instead is a STRIP of it on the frame, [MIN_ON_FRAME] wide, and nothing else. That
 * is the whole of the limit: a customer can push a video until only that strip of it is showing,
 * which is what framing a shot along an edge actually asks for. It stops there because a rectangle
 * with no part of it on the frame is invisible in the preview, invisible in the render, and
 * impossible to get a finger back onto.
 *
 * The angle is NOT wrapped into a single turn. An overlay's is not either, a gesture spun twice
 * round keeps its total that way, and every engine reduces the angle itself the moment it takes a
 * sine of it. An upright angle is dropped rather than stored as 0, so a rectangle turned and put
 * back is the rectangle it was before anybody touched it, down to its keys.
 */
export function normalisePlacement(value: unknown): EditPlacement | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const w = round4(clamp(num(raw['w'], 1), MIN_RECT_SIZE, MAX_PLACEMENT_SIZE));
  const h = round4(clamp(num(raw['h'], 1), MIN_RECT_SIZE, MAX_PLACEMENT_SIZE));
  // The corner is rounded BEFORE it is held, never after: rounded once the room for it had already
  // been worked out, it could land a ten-thousandth past the bound and hand the native parsers a
  // placement they would have to hold all over again - the trap [normaliseRect] steps around too.
  const across = placementRange(w);
  const down = placementRange(h);
  const rect: EditPlacement = {
    x: clamp(round4(num(raw['x'], 0)), across.min, across.max),
    y: clamp(round4(num(raw['y'], 0)), down.min, down.max),
    w,
    h,
  };
  const deg = round4(num(raw['rotationDeg'], 0));
  return deg % 360 === 0 ? rect : { ...rect, rotationDeg: deg };
}

/** Whether two frames are the same frame. */
export function sameOutput(a: EditOutput, b: EditOutput): boolean {
  return a.width === b.width && a.height === b.height && a.fps === b.fps;
}

/** A rectangle's angle in clockwise degrees, with an absent one counting as upright. */
export function rectRotationDeg(rect: EditPlacement | null | undefined): number {
  return rect?.rotationDeg ?? 0;
}

/**
 * Whether a rectangle stands exactly as it was drawn. Any whole number of turns does, which is why
 * this is a question rather than a comparison against 0.
 */
export function isUprightRect(rect: EditPlacement | null | undefined): boolean {
  return rectRotationDeg(rect) % 360 === 0;
}

/**
 * Whether a rectangle covers the whole frame, which is the same thing as not having one. Absent
 * answers true, so a caller can ask this one question instead of two.
 *
 * A TURNED rectangle never does, whatever its four numbers say: the whole frame at an angle shows
 * black in the corners, which is a picture the customer asked for and not an absence.
 */
export function isFullFrameRect(rect: EditPlacement | null | undefined): boolean {
  if (!rect) return true;
  if (!isUprightRect(rect)) return false;
  // Each of the four against the frame's own number in BOTH directions. A crop can only ever be
  // smaller than the frame and inside it, so one-sided tests read the same for one - but a
  // placement may hang off an edge and may be larger than the frame, and `x <= 0` alone would
  // call a video pushed half off the left side "the whole frame" and throw its rectangle away.
  return (
    Math.abs(rect.x) <= FULL_FRAME_EPSILON &&
    Math.abs(rect.y) <= FULL_FRAME_EPSILON &&
    Math.abs(rect.w - 1) <= FULL_FRAME_EPSILON &&
    Math.abs(rect.h - 1) <= FULL_FRAME_EPSILON
  );
}

/** Whether two rectangles say the same thing, with absent and full-frame counting as the same. */
export function sameRect(a: EditPlacement | null | undefined, b: EditPlacement | null | undefined): boolean {
  if (isFullFrameRect(a) && isFullFrameRect(b)) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && rectRotationDeg(a) === rectRotationDeg(b);
}

/**
 * Whether a segment is framed at all - cropped, placed in a rectangle, turned in one, or fitted
 * differently from the rest of the post. A whole-frame crop or upright whole-frame rectangle is
 * not: it renders exactly as no crop does, [toComposeSpec] leaves it off the wire for that reason,
 * and [isUntouched] has to agree or a customer who opened the crop tool and changed nothing would
 * pay for a re-encode.
 */
export function isClipFramed(clip: EditClip, manifestFit: EditFit = 'contain'): boolean {
  if (!isFullFrameRect(clip.crop)) return true;
  if (!isFullFrameRect(clip.rect)) return true;
  return clip.fit !== undefined && clip.fit !== manifestFit;
}

/* -------------------------------------------------------------------------------------------- */
/* Construction                                                                                   */
/* -------------------------------------------------------------------------------------------- */

export function defaultClipEdit(clipKey: string, durationMs: number, id: string = clipKey): EditClip {
  return {
    id,
    clipKey,
    inMs: 0,
    outMs: Math.max(100, Math.round(durationMs)),
    speed: 1,
    volume: 1,
    muted: false,
  };
}

/**
 * How long a picture is held when it lands on the timeline. Three seconds is what every phone
 * editor gives a photo: long enough to be seen, short enough that a run of them reads as a
 * slideshow rather than a wait.
 */
export const PICTURE_CLIP_MS = 3000;

/**
 * The "source" a picture is given, which is how far either of its handles can be pulled.
 *
 * Twice the longest post, with the segment starting in the middle of it, so that a picture can be
 * pulled out to the length of a whole post from EITHER end and no trim ever meets the source's own
 * edge. A picture's segment is placed there rather than at 0 because the left handle of a segment
 * at 0 can only ever shorten it, and a customer pulling a photo's left edge expects it to grow.
 */
export const PICTURE_SOURCE_MS = 2 * MAX_POST_MS;

/** Where a picture's segment starts in its source: the middle, so both handles have room. */
const PICTURE_IN_MS = MAX_POST_MS;

/** A picture segment running `lengthMs`, trimmed out of the middle of its source. */
export function defaultPictureEdit(clipKey: string, id: string = clipKey, lengthMs: number = PICTURE_CLIP_MS): EditClip {
  return {
    id,
    clipKey,
    inMs: PICTURE_IN_MS,
    outMs: PICTURE_IN_MS + Math.max(MIN_CLIP_MS, Math.round(lengthMs)),
    speed: 1,
    volume: 1,
    muted: false,
    image: true,
  };
}

export function emptyManifest(): EditManifest {
  return {
    version: MANIFEST_VERSION,
    clips: [],
    videoTracks: [],
    durationMs: 0,
    filterId: 'none',
    filterIntensity: 1,
    adjust: neutralAdjust(),
    /*
     * A clip FILLS the frame it is put in, and a shape that does not match is cropped rather than
     * bordered. It is what every editor a customer has used does - open one, add a clip, and the
     * picture is edge to edge - and the reason is the same in all of them: black bars are not a
     * decision anybody makes, they are what happens when nobody does, and a post is a thing to be
     * watched rather than a document to be preserved whole. `Fit` on the tool row puts the bars
     * back for the customer who wants all of the picture, which is a choice they can see.
     *
     * It is the whole post's fit, and so the default for every clip that carries none of its own:
     * a second clip of another shape added later fills the frame exactly as the first one did.
     */
    fit: 'cover',
    originalMuted: false,
    overlays: [],
    music: null,
    voiceovers: [],
    output: { ...DEFAULT_OUTPUT },
  };
}

/**
 * Brings any manifest this package has ever written up to the current shape, filling what an older
 * one did not have. Version 1 had one voiceover, no segment ids, text-only overlays sized by
 * `fontScale`, and no filter intensity or Adjust.
 *
 * Version 2 to version 3 adds nothing at all, on purpose: a version-2 manifest simply has no crop,
 * no placement rectangle and no per-segment fit, and absence is exactly what the renderer did
 * before those existed. Nothing is defaulted in on its behalf - a whole-frame crop written into
 * every clip would be the same picture but a different spec, and every engine would lose the fast
 * path it takes when the fields are missing. A version-2 manifest reopened today renders frame for
 * frame as it did.
 *
 * Version 3 to version 4 adds nothing either, for the same reason: a version-3 manifest simply has
 * no second video track, and an empty `videoTracks` is the whole of what one video layer ever
 * meant. The migration is the empty array, and [toComposeSpec] turns that back into a spec with no
 * `tracks` key - byte for byte the spec version 3 produced.
 *
 * Version 4 to version 5 adds nothing for the third time: a version-4 manifest simply has no angle
 * on any placement rectangle, and absent is upright, which is the only thing a rectangle could be
 * before. A `rotationDeg` of 0 is not written onto anything. It would be the same picture, a
 * different spec, and the end of the byte-for-byte guarantee that lets a single untouched clip be
 * posted without a re-encode.
 *
 * Version 7 to version 8 adds transitions between base clips, and nothing is written into an older
 * manifest for them: a version-7 manifest simply has no `transitionIn` on any clip, and absent is a
 * cut, which is all a boundary could be before.
 *
 * Version 8 to version 9 adds pictures on the timeline, and again nothing is written into an older
 * manifest: a version-8 manifest has no `image` on any segment, and absent is a video, which is all
 * a segment could be before.
 */
export function normaliseManifest(input: unknown): EditManifest {
  const raw = (input ?? {}) as Record<string, any>;
  const base = emptyManifest();

  // One set of ids for the WHOLE manifest, base track and extra tracks together. Every op that
  // takes a clip takes its id and nothing else, so two clips sharing one id on different layers
  // would be two clips a customer could never tell apart or address separately.
  const usedIds = new Set<string>();
  const clips: EditClip[] = readClips(raw['clips'], usedIds, true);

  // A track with no clips is dropped rather than kept: it renders nothing, the native parsers
  // reject it outright, and an empty lane in the timeline is a thing a customer cannot get rid of.
  // The cap counts the base track, so only MAX_VIDEO_TRACKS - 1 of these survive.
  const videoTracks: EditVideoTrack[] = (Array.isArray(raw['videoTracks']) ? raw['videoTracks'] : [])
    .map((t: any, i: number): EditVideoTrack => ({
      id: typeof t?.id === 'string' && t.id ? t.id : `vt-${i}`,
      clips: readClips(t?.clips, usedIds, false),
      startMs: Math.max(0, Math.round(num(t?.startMs, 0))),
      z: Math.max(0, Math.round(num(t?.z, i + 1))),
      opacity: clamp(num(t?.opacity, 1), 0, 1),
    }))
    .filter((track: EditVideoTrack) => track.clips.length > 0)
    .slice(0, MAX_VIDEO_TRACKS - 1);

  const overlays: EditOverlay[] = Array.isArray(raw['overlays'])
    ? raw['overlays'].map((o: any): EditOverlay => {
        const common: OverlayCommon = {
          id: String(o.id),
          cx: num(o.cx, 0.5),
          cy: num(o.cy, 0.5),
          scale: clamp(
            typeof o.scale === 'number' ? o.scale : typeof o.fontScale === 'number' ? o.fontScale / OVERLAY_BASE.textFont : 1,
            MIN_SCALE,
            MAX_SCALE,
          ),
          rotationDeg: num(o.rotationDeg, 0),
          opacity: clamp(num(o.opacity, 1), 0, 1),
          startMs: Math.max(0, num(o.startMs, 0)),
          endMs: Math.max(0, num(o.endMs, 0)),
        };
        switch (o.kind) {
          case 'sticker':
            return { ...common, kind: 'sticker', emoji: o.emoji ?? null, assetId: o.assetId ?? null };
          case 'image':
            return { ...common, kind: 'image', uri: String(o.uri), fileName: String(o.fileName ?? ''), aspect: num(o.aspect, 1) };
          case 'effect':
            return { ...common, kind: 'effect', effectId: String(o.effectId) };
          default: {
            // Version 1 drew its letters on a dark translucent plate when it had a background. A
            // plate now takes the colour and picks the letters itself, so the nearest look is a
            // dark soft plate - the letters come out white.
            const v1Plate = !o.effect && !!o.background;
            const effect: TextEffect = o.effect ?? (v1Plate ? 'plateSoft' : 'shadow');
            return {
              ...common,
              kind: 'text',
              text: String(o.text ?? ''),
              styleId: String(o.styleId ?? 'classic'),
              color: v1Plate ? '#000000' : String(o.color ?? '#ffffff'),
              effect,
              align: o.align ?? 'center',
            };
          }
        }
      })
    : [];

  const voiceovers: EditVoiceover[] = Array.isArray(raw['voiceovers'])
    ? raw['voiceovers'].map((v: any, i: number) => ({
        id: String(v.id ?? `vo-${i}`),
        uri: String(v.uri),
        startMs: Math.max(0, num(v.startMs, 0)),
        durationMs: Math.max(0, num(v.durationMs, 0)),
        volume: clamp(num(v.volume, 1), 0, 1),
      }))
    : raw['voice']
      ? [
          {
            id: 'vo-0',
            uri: String(raw['voice'].uri),
            startMs: Math.max(0, num(raw['voice'].startMs, 0)),
            durationMs: Math.max(0, num(raw['voice'].durationMs, 0)),
            volume: clamp(num(raw['voice'].volume, 1), 0, 1),
          },
        ]
      : [];

  const m = raw['music'];
  const music: EditMusic | null = m
    ? {
        uri: String(m.uri),
        fileName: String(m.fileName ?? 'Music'),
        sourceDurationMs: Math.max(0, num(m.sourceDurationMs, 0)),
        inMs: Math.max(0, num(m.inMs, 0)),
        outMs: Math.max(0, num(m.outMs, 0)),
        startMs: Math.max(0, num(m.startMs, 0)),
        volume: clamp(num(m.volume, 0.6), 0, 1),
        loop: m.loop ?? true,
        fadeOutMs: Math.max(0, num(m.fadeOutMs, 400)),
      }
    : null;

  return {
    version: MANIFEST_VERSION,
    clips,
    videoTracks,
    // Not clamped to the clips here: a stored tail shorter than the base track is simply a tail
    // nobody can see, and `totalDurationMs` takes the larger of the two anyway. Clamping would need
    // the sequence sum computed twice on every read of every stored edit to change nothing.
    durationMs: Math.max(0, Math.round(num(raw['durationMs'], 0))),
    filterId: typeof raw['filterId'] === 'string' ? raw['filterId'] : base.filterId,
    filterIntensity: clamp(num(raw['filterIntensity'], 1), 0, 1),
    adjust: { ...neutralAdjust(), ...(raw['adjust'] ?? {}) },
    /*
     * What was STORED, and `contain` for a manifest that stored nothing - which is not what a new
     * edit opens on any more. A manifest with no `fit` is one written before the field existed,
     * and every one of those rendered contained; defaulting it to today's `cover` would re-crop a
     * saved draft on the way back in, which is the byte-for-byte promise the migration notes above
     * make, broken silently and on somebody's finished work.
     */
    fit: raw['fit'] === 'cover' ? 'cover' : 'contain',
    originalMuted: !!raw['originalMuted'],
    overlays,
    music,
    voiceovers: voiceovers.sort((a, b) => a.startMs - b.startMs),
    // Absent is [DEFAULT_OUTPUT], which is the frame every manifest written before version 7 was
    // rendered at - so one of those reopens at the size it was always going to be, and its
    // fractions go on meaning what they meant.
    output: normaliseOutput(raw['output']),
  };
}

/**
 * Brings a saved manifest back in line with the host's clip list, which may have changed in the
 * meantime: clips added since are appended, segments of clips removed are dropped, and the order
 * the manifest remembers wins.
 *
 * @param clipKeys the host's clips, in their own order.
 * @param durations source duration per clip key, for trimming new clips to their full length.
 * @param pictures the keys among `clipKeys` whose source is a picture, which arrive as a picture
 *   segment of [PICTURE_CLIP_MS] rather than a video trimmed to its whole length.
 */
export function reconcileManifest(
  manifest: EditManifest | undefined,
  clipKeys: string[],
  durations: ReadonlyMap<string, number>,
  pictures: ReadonlySet<string> = new Set(),
): EditManifest {
  const current = manifest ? normaliseManifest(manifest) : emptyManifest();
  const known = new Set(clipKeys);
  const kept = current.clips.filter((edit) => known.has(edit.clipKey));

  // Extra layers are reconciled but never grown: a source the host has added belongs on the base
  // timeline, where the customer put every other one, and silently appending it to a picture-in-
  // picture layer would drop a clip on top of their video without anybody asking for it. A layer
  // left with nothing goes, because an empty track is not a state the manifest holds.
  const videoTracks = current.videoTracks
    .map((track) => ({ ...track, clips: track.clips.filter((edit) => known.has(edit.clipKey)) }))
    .filter((track) => track.clips.length > 0);

  // Both what the extra layers are holding and what the base is holding count here, which is why
  // they are reconciled first. A source that is ONLY on a layer is already in the post, so leaving
  // it out of `seen` would read it as a source the host had just added and drop a second copy of
  // it onto the base timeline, underneath the picture in picture the customer built with it. And an
  // appended clip landing on an id a layer already holds would make the pair indistinguishable,
  // because every op takes a clip id and stops at the first clip that answers to it.
  const seen = new Set(kept.map((edit) => edit.clipKey));
  const usedIds = new Set(kept.map((edit) => edit.id));
  for (const track of videoTracks) {
    for (const edit of track.clips) {
      seen.add(edit.clipKey);
      usedIds.add(edit.id);
    }
  }
  const added = clipKeys
    .filter((key) => !seen.has(key))
    .map((key) => {
      let id = key;
      while (usedIds.has(id)) id = `${id}~`;
      usedIds.add(id);
      return pictures.has(key) ? defaultPictureEdit(key, id) : defaultClipEdit(key, durations.get(key) ?? 0, id);
    });

  return { ...current, clips: withoutLeadingTransition([...kept, ...added]), videoTracks };
}

/**
 * How long a SEQUENCE of segments runs, after every trim and speed change - and, on the base track,
 * less every transition's overlap, because the incoming clip of a transition starts under the end
 * of the outgoing one. A layer's clips carry no transitions, so a layer is the plain sum it always was.
 */
export function clipsDurationMs(clips: readonly EditClip[]): number {
  const sum = clips.reduce((total, clip) => total + Math.max(0, clip.outMs - clip.inMs) / (clip.speed || 1), 0);
  if (!clips.some(clip => clip.transitionIn)) return sum;
  return transitionSpans(clips).reduce((total, span) => total - span.ms, sum);
}

/**
 * The same clips with the first one's [EditClip.transitionIn] taken off - there is nothing before
 * the first clip for it to come in from. The same array when there was nothing to take off, so an
 * op that did not touch a transition still hands back the objects it was given.
 */
export function withoutLeadingTransition(clips: EditClip[]): EditClip[] {
  const first = clips[0];
  if (!first?.transitionIn) return clips;
  const bare = { ...first };
  delete bare.transitionIn;
  return [bare, ...clips.slice(1)];
}

/**
 * How long the post's own CONTENT runs: the base track, and every layer measured from where that
 * layer starts.
 *
 * The base track alone was the answer, and it was the wrong one the moment a layer could outlast
 * it. Splitting a video and carrying the second half onto a layer of its own is the plainest way
 * there: the base loses that half, so the post got SHORTER, and the half now sitting on the layer
 * began exactly where the post had just stopped - drawn nowhere, played never, and cut out of the
 * export, while the timeline went on showing it. A post is as long as the things on it.
 *
 * A caller measuring ONE track passes `{ clips }` on its own and gets the sequence sum, which is
 * what a track's length has always been.
 */
export function contentDurationMs(
  manifest: Pick<EditManifest, 'clips'> & Partial<Pick<EditManifest, 'videoTracks'>>,
): number {
  let longest = clipsDurationMs(manifest.clips);
  for (const track of manifest.videoTracks ?? []) {
    // From where the layer STARTS, because `startMs` delays it rather than seeking into it - so a
    // two second clip on a layer that begins at ten seconds ends at twelve, not at two.
    longest = Math.max(longest, Math.max(0, track.startMs) + clipsDurationMs(track.clips));
  }
  return longest;
}

/**
 * How long the finished video runs: everything the post holds, or the tail a customer has pulled
 * past all of it.
 *
 * Takes the larger of the two rather than trusting [EditManifest.durationMs], so a manifest built
 * by hand, or one whose content has grown since the end was last dragged, cannot ask for an output
 * that cuts its own footage off.
 */
export function totalDurationMs(
  manifest: Pick<EditManifest, 'clips'> &
    Partial<Pick<EditManifest, 'videoTracks'>> &
    Partial<Pick<EditManifest, 'durationMs'>>,
): number {
  return Math.max(contentDurationMs(manifest), Math.max(0, manifest.durationMs ?? 0));
}

/**
 * Each source clip once, in the order it first appears - the base track first, then every extra
 * video layer. This is the list of sources the post actually uploads and the list [toComposeSpec]
 * needs a file for, so a layer's footage has to be in it or a split screen would be posted with
 * half of itself missing.
 */
export function uniqueClipKeys(manifest: Pick<EditManifest, 'clips' | 'videoTracks'>): string[] {
  const keys = manifest.clips.map((clip) => clip.clipKey);
  for (const track of manifest.videoTracks) keys.push(...track.clips.map((clip) => clip.clipKey));
  return [...new Set(keys)];
}

/**
 * Whether anything was actually changed. A single clip left exactly as it was can be posted as it
 * is rather than re-encoded, which is faster and kinder to the picture.
 *
 * `sourceAspect` is that clip's own oriented width / height, which the post's `cover` fit makes the
 * difference between a picture that is identical to the file and one that is cropped out of it.
 * Left out, it is unknown, and an unknown shape is never posted untouched.
 */
export function isUntouched(manifest: EditManifest, durations: ReadonlyMap<string, number>, sourceAspect = 0): boolean {
  if (manifest.clips.length !== 1) return false;
  // A picture is not a video, however little was done to it: there is no file on disk to post
  // instead, only the render that turns the still into one.
  if (manifest.clips[0].image) return false;
  // A frame that is not this package's own is a render by itself. Posting the file on disk instead
  // would hand back the shape and the size THAT happens to be, which is the one thing a customer
  // who chose a frame said it was not.
  if (!sameOutput(manifest.output, DEFAULT_OUTPUT)) return false;
  // A second layer is two pictures at once, which no single file on disk is, however little was
  // done to the clip underneath it.
  if (manifest.videoTracks.length > 0) return false;
  if (resolveFilterOps(manifest).length > 0) return false;
  if (manifest.originalMuted) return false;
  /*
   * `cover` is what a new edit opens on, and on a clip already the frame's shape it does nothing
   * whatsoever - which is the ordinary case and the one this fast path exists for. On any other
   * shape it crops, and the file on disk is the picture UNcropped: posting it would hand back more
   * than the customer was shown, which is the one direction this shortcut must never fail in.
   * `contain` is the other way round - the file is the picture without the bars around it - and
   * that has always been thought a fair trade.
   *
   * The shape comes from the source itself, measured off the video element; 0 is "not known yet",
   * and an unknown shape answers the safe way, which is to render.
   */
  if (manifest.fit === 'cover' && !fillsFrame(sourceAspect, manifest.output)) return false;
  if (manifest.overlays.length > 0) return false;
  if (manifest.music || manifest.voiceovers.length > 0) return false;
  return manifest.clips.every((clip) => {
    const source = durations.get(clip.clipKey) ?? 0;
    const untrimmed = clip.inMs === 0 && (source === 0 || Math.abs(clip.outMs - source) <= 100);
    // A cropped or reframed clip is a different picture from the file on disk, however little else
    // was done to it, so it has to go through the renderer rather than be posted as it is.
    return untrimmed && clip.speed === 1 && clip.volume === 1 && !clip.muted && !isClipFramed(clip, manifest.fit);
  });
}

/**
 * Whether a source of this shape already fills a frame of that one, so that `cover` has nothing to
 * crop off it. The tolerance is there because neither number is exact: a 1082x1920 clip - a width
 * rounded up to the even one an encoder insists on - is the same picture as a 1080x1920 one to
 * every eye, and `cover` would scale it by a fifth of a percent and take a pixel off each side.
 */
function fillsFrame(sourceAspect: number, output: EditOutput): boolean {
  if (!(sourceAspect > 0)) return false;
  const frame = output.width / output.height;
  return Math.abs(sourceAspect - frame) <= frame * 0.005;
}

/* -------------------------------------------------------------------------------------------- */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The four decimals a stored rectangle and a resolved filter amount are both held at. */
export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A stored fit, or `undefined` for anything else - including the absence that means "the post's". */
function readFit(value: unknown): EditFit | undefined {
  return value === 'cover' || value === 'contain' ? value : undefined;
}

/**
 * A stored list of segments, brought up to the current shape. Shared by the base track and every
 * extra video track so the two can never drift: a clip on the second layer is the same kind of
 * thing as a clip on the first, carrying the same trim, speed, sound and framing, and the ONLY
 * difference between the layers is which rectangle of the frame their clips are drawn in.
 *
 * `usedIds` is threaded through rather than owned here because ids are unique across the whole
 * manifest, not within one track.
 *
 * `base` is the one difference the two kinds of track have: only the base track has transitions,
 * and never on its first clip. A transition whose id this version does not know is dropped rather
 * than kept, so no engine is ever handed a kind it cannot draw.
 */
function readClips(value: unknown, usedIds: Set<string>, base: boolean): EditClip[] {
  if (!Array.isArray(value)) return [];
  return value.map((c: any, index: number) => {
    let id = typeof c?.id === 'string' && c.id ? c.id : String(c?.clipKey);
    while (usedIds.has(id)) id = `${id}~`;
    usedIds.add(id);
    const clip: EditClip = {
      id,
      clipKey: String(c?.clipKey),
      inMs: num(c?.inMs, 0),
      outMs: num(c?.outMs, 100),
      speed: clamp(num(c?.speed, 1), MIN_SPEED, MAX_SPEED),
      volume: clamp(num(c?.volume, 1), 0, 1),
      muted: !!c?.muted,
    };
    // Assigned rather than listed, so a clip that has none of these keeps none of them: an
    // `undefined` under the key is still a key, and it would survive a round trip through a
    // structured clone and read as "framed" to anything checking with `in`.
    const crop = normaliseRect(c?.crop);
    if (crop) clip.crop = crop;
    const rect = normalisePlacement(c?.rect);
    if (rect) clip.rect = rect;
    const fit = readFit(c?.fit);
    if (fit) clip.fit = fit;
    const transition = base && index > 0 ? normaliseTransition(c?.transitionIn) : null;
    if (transition) clip.transitionIn = transition;
    // A picture plays at 1x whatever was stored: a still sped up is only a shorter still, and a
    // speed on one would be a length nobody can see the source of.
    if (c?.image === true) {
      clip.image = true;
      clip.speed = 1;
    }
    return clip;
  });
}
