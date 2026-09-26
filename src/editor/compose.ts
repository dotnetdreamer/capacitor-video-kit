import type { ComposeClip, ComposeOverlay, ComposeOverlayMotion, ComposePlacement, ComposeRect, ComposeSpec, ComposeTrack } from '../video-composer/definitions';

import {
  MAX_SPEED,
  MIN_LAYER_MS,
  byteCeiling,
  clamp,
  isFullFrameRect,
  isUprightRect,
  rectRotationDeg,
  resolveFilterOps,
  clipsDurationMs,
  totalDurationMs,
  videoBitrateFor,
  type EditClip,
  type EditFit,
  type EditManifest,
  type EditOverlay,
  type EditPlacement,
  type EditRect,
} from './edit-manifest';
import { overlayEndMs } from './edit-ops';
import { compileOverlayMotion, overlayRasterDetail } from './motion';
import { rasteriseOverlay } from './overlay-raster';
import type { RasterContext } from './raster-context';
import { compileTransition, transitionSpans } from './transitions';
import { compileCamera } from './zoom';

export interface ComposeSpecIds {
  jobId: string;
  batchId: string;
}

/**
 * What the host holds the finished file to, which is not part of the edit: the same manifest may be
 * rendered by an app with an upload limit and by one without.
 */
export interface ComposeSpecLimits {
  /**
   * The spec's `output.maxBytes`: the host's upload limit, usually [RenderRequest.maxBytes] passed
   * straight on. Written in whole bytes, rounded down; absent, null, or anything that does not round
   * down to at least one byte writes no ceiling at all (see [byteCeiling]).
   */
  maxBytes?: number | null;
}

/** Thrown when a manifest names a clip the host has no file for. */
export class MissingClipError extends Error {
  constructor(readonly clipKey: string) {
    super(`clip ${clipKey} has no file`);
  }
}

/** Longer than any post can run; the composer clips a track of unknown length to the video's end. */
const UNKNOWN_TRACK_END_MS = 3_600_000;

/**
 * The one translation from an edit to something the native composer renders.
 *
 * This file is not called `compose-spec.ts`, after the `ComposeSpec` it builds, and it must not be
 * renamed to anything else ending in `spec`. Stencil's emitter drops every file whose emitted path
 * contains the substring `spec.`, taking `compose-spec.js` with the real test files, and the module
 * then never reaches the bundler as JavaScript at all. What the build says instead names the line
 * rather than the cause:
 *
 *   Rollup: Parse Error: src/editor/compose-spec.ts (1:12): Expected ',', got '{'
 *
 * Every number the preview used is carried across unchanged - trims, speeds, the resolved colour
 * ops, each layer's 0..1 centre, clockwise rotation, opacity and time window - and every layer is
 * rasterised here by [rasteriseOverlay], the same function that draws the preview's bitmaps, so the
 * native side only ever places PNGs and the posted video matches what the customer saw.
 *
 * Asynchronous because drawing a layer is: a text layer waits for its web font to load before it is
 * measured, and photos and stickers have to be decoded before they can be drawn. Layers are drawn
 * one after another rather than all at once, so a phone holds one layer's canvas at a time instead
 * of thirty. Rejects with [MissingClipError] for a clip without a file - a clip on an extra video
 * layer needs one exactly as a base clip does - and with the rasteriser's error for a photo or
 * sticker that cannot be loaded.
 *
 * @param uriByKey the file each clip key refers to (`file://` or `content://`).
 * @param raster the host's fonts, stickers and file URLs. Its `output` must be `manifest.output`, the frame this spec
 *   renders (`DEFAULT_OUTPUT`), because every `wPx`/`hPx` is measured against it.
 * @param limits the host's size ceiling, written as `output.maxBytes` only when there is one, so a host with no upload
 *   limit sends exactly the spec it always sent.
 */
export async function toComposeSpec(
  manifest: EditManifest,
  uriByKey: ReadonlyMap<string, string>,
  ids: ComposeSpecIds,
  raster: RasterContext,
  limits: ComposeSpecLimits = {},
): Promise<ComposeSpec> {
  const totalMs = Math.round(totalDurationMs(manifest));

  const clips: ComposeClip[] = baseClips(manifest, uriByKey);

  // Resolved here beside the base clips rather than further down, so a layer whose footage the host
  // has no file for fails before the phone has spent a second drawing bitmaps for a render that was
  // never going to happen. `null` rather than an empty list, because the key it becomes is left off
  // the wire entirely and there is nothing in between.
  const tracks: ComposeTrack[] | null =
    manifest.videoTracks.length > 0
      ? manifest.videoTracks.map(track => ({
          id: track.id,
          clips: track.clips.map(edit => wireClip(edit, manifest.fit, uriByKey)),
          startMs: Math.max(0, Math.round(track.startMs)),
          z: track.z,
          opacity: clamp(track.opacity, 0, 1),
        }))
      : null;

  const overlays: ComposeOverlay[] = [];
  // Manifest order is drawing order: the native render stacks bitmaps in array order.
  for (const overlay of manifest.overlays) {
    // An empty text layer is only a placeholder in the editor, and a layer that starts at the very
    // end would never be on screen.
    if (overlay.kind === 'text' && overlay.text.trim().length === 0) continue;
    if (overlay.startMs >= totalMs - 1) continue;

    const { startMs, endMs } = overlayWireWindow(overlay, totalMs);
    const motion = compileOverlayMotion({ startMs, endMs }, overlay.animation, overlay.kind);

    // The preview's own bitmap when the editor vouches for it (see RasterContext.drawn): the same
    // function, context and key drew it, so drawing it again here would only repeat the decode and
    // the PNG encode. Anything it does not vouch for is drawn exactly as before, errors included.
    //
    // Except a layer whose motion MAGNIFIES it - a slam, a pop, a grow out - which is drawn again with
    // up to half as many pixels again as its resting size, so it is not soft exactly while it is
    // largest. `wPx`/`hPx` stay the resting size: every engine scales the bitmap it decodes to them.
    const detail = overlayRasterDetail(motion);
    const bitmap = detail > 1 ? await rasteriseOverlay(overlay, raster, { detail }) : (raster.drawn?.(overlay) ?? (await rasteriseOverlay(overlay, raster)));
    // An effect covers the frame: its bitmap is the whole picture, so it is never moved or turned.
    const fullFrame = overlay.kind === 'effect';
    const wire: ComposeOverlay = {
      id: overlay.id,
      png: bitmap.png,
      wPx: bitmap.wPx,
      hPx: bitmap.hPx,
      cx: fullFrame ? 0.5 : overlay.cx,
      cy: fullFrame ? 0.5 : overlay.cy,
      rotationDeg: fullFrame ? 0 : overlay.rotationDeg,
      startMs,
      endMs,
      opacity: clamp(overlay.opacity, 0, 1),
    };
    // Only for a layer that moves, and assigned after the object for the reason a clip's crop is: a
    // still layer is the overlay this package has always sent, byte for byte, and every engine tests
    // the ABSENCE of the key once, when it builds its plan, to place it exactly as it always has.
    if (motion) wire.motion = motion;
    overlays.push(wire);
  }

  const music = manifest.music;
  const maxBytes = byteCeiling(limits.maxBytes);

  const spec: ComposeSpec = {
    jobId: ids.jobId,
    batchId: ids.batchId,
    clips,
    output: {
      ...manifest.output,
      videoBitrate: videoBitrateFor(manifest.output),
      audioBitrate: 128_000,
      ...(maxBytes !== null ? { maxBytes } : {}),
    },
    filter: resolveFilterOps(manifest),
    overlays,
    audio: {
      originalMuted: manifest.originalMuted,
      originalVolume: 1,
      music: music
        ? {
            uri: music.uri,
            startMs: Math.max(0, Math.round(music.startMs)),
            inMs: Math.max(0, Math.round(music.inMs)),
            outMs: Math.round(music.outMs > 0 ? music.outMs : music.sourceDurationMs > 0 ? music.sourceDurationMs : UNKNOWN_TRACK_END_MS),
            volume: music.volume,
            loop: music.loop,
            fadeInMs: 0,
            fadeOutMs: Math.max(0, Math.round(music.fadeOutMs)),
          }
        : null,
      voiceover: [...manifest.voiceovers]
        .sort((a, b) => a.startMs - b.startMs)
        .map(take => ({
          uri: take.uri,
          startMs: Math.max(0, Math.round(take.startMs)),
          durationMs: Math.max(0, Math.round(take.durationMs)),
          volume: take.volume,
        })),
    },
    // A little way in, so the poster is a frame of the video rather than a fade from black.
    posterAtMs: Math.min(500, Math.max(0, totalMs - 1)),
  };

  // Set only when there is a layer to set, with the key left off entirely otherwise. An empty
  // `tracks` and a missing one say the same thing to a reader and different things to every engine:
  // the missing key is what keeps a one-layer post on the single-sequence path it has always taken,
  // and a single untouched clip is posted with no re-encode at all on the strength of it. Assigned
  // after the object for the same reason a clip's crop is.
  if (tracks) spec.tracks = tracks;

  // Only when the customer has actually pulled the end past the base track. Left off otherwise, for
  // the reason `tracks` is: a post nobody has stretched produces the spec this package has always
  // produced, byte for byte, and every engine keeps the path it takes for one.
  const baseMs = Math.round(clipsDurationMs(manifest.clips));
  if (totalMs > baseMs) spec.durationMs = totalMs;

  // Only when a zoom is visible, for the reason `tracks` is: a post with no zoom is the spec this
  // package has always produced, byte for byte, and every engine decides once, when it builds its
  // plan, that there is no camera to apply. [compileCamera] answers `null` by the same test
  // [isUntouched] makes, so the fast path and the wire can never disagree.
  const camera = compileCamera(manifest.zooms ?? [], totalMs);
  if (camera) spec.camera = camera;

  return spec;
}

/**
 * Where a layer is on screen on the OUTPUT timeline, as the wire carries it: its start in whole
 * milliseconds, and its end with "until the end" resolved against the post and held at least
 * [MIN_LAYER_MS] after the start. The window a layer's motion is compiled over, so the preview reads
 * its moves against the same two numbers the render does.
 */
export function overlayWireWindow(overlay: Pick<EditOverlay, 'startMs' | 'endMs'>, totalMs: number): { startMs: number; endMs: number } {
  const startMs = Math.max(0, Math.round(overlay.startMs));
  const endMs = Math.max(startMs + MIN_LAYER_MS, Math.round(overlayEndMs(overlay, totalMs)));
  return { startMs, endMs };
}

/**
 * The motion `toComposeSpec` sends for a layer, or null for one that does not move: its animation
 * compiled over [overlayWireWindow]. The live preview reads the same keys through `overlayMotionAt`,
 * so a layer moves on screen exactly as it will in the file.
 */
export function overlayMotionFor(overlay: EditOverlay, totalMs: number): ComposeOverlayMotion | null {
  if (!overlay.animation) return null;
  return compileOverlayMotion(overlayWireWindow(overlay, totalMs), overlay.animation, overlay.kind);
}

/**
 * The base track on the wire, with every transition LOWERED so no engine has to do its arithmetic.
 *
 * A transition overlaps two clips, and neither native sequence type can hold two items at once. So
 * the outgoing clip is sent stopping where the incoming one starts, and the part of it that plays
 * under the transition travels on the incoming clip as [ComposeTransition.from] - the same clip,
 * trimmed to its last moments. The base track stays the flat sequence every engine already builds,
 * the tails go on one extra sequence, and an engine that has never heard of transitions still
 * renders a video of the right length with a cut where each one was.
 *
 * The overlap is carried in whole milliseconds of the OUTGOING clip's source, the unit the wire
 * trims in, and [transitionSpan] measured it the same way - so the editor's timeline and the render
 * agree about where every clip starts.
 */
function baseClips(manifest: EditManifest, uriByKey: ReadonlyMap<string, string>): ComposeClip[] {
  const spans = transitionSpans(manifest.clips);
  const wired = manifest.clips.map(edit => wireClip(edit, manifest.fit, uriByKey));
  // A segment sent with more source than it has ([sourceStretch]) gives a transition that much more
  // of it too, so the overlap runs the output time it runs in the editor.
  const stretches = manifest.clips.map(sourceStretch);
  return wired.map((clip, i) => {
    const giving = Math.round((spans[i + 1]?.sourceMs ?? 0) * stretches[i]);
    const lowered: ComposeClip = giving > 0 ? { ...clip, outMs: clip.outMs - giving } : clip;
    const span = spans[i];
    const kind = manifest.clips[i].transitionIn?.kind;
    const compiled = span.sourceMs > 0 && kind ? compileTransition(kind) : null;
    if (!compiled) return lowered;
    const outgoing = wired[i - 1];
    lowered.transitionIn = {
      ...structuredCloneOf(compiled),
      // The outgoing clip whole - its sound, its speed, its framing - and only its last moments.
      from: { ...outgoing, inMs: outgoing.outMs - Math.round(span.sourceMs * stretches[i - 1]) },
    };
    return lowered;
  });
}

/** A plain copy of the cached (and frozen) compiled transition, so nothing downstream shares it. */
function structuredCloneOf<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * One segment on the wire. Shared by the base track and by every extra video layer, because a clip
 * on the second layer is the same kind of thing as one on the first - the same trim, speed, sound
 * and framing - and a second copy of this mapping is exactly how the two layers would quietly start
 * disagreeing about which rectangle or which fit a clip is drawn with.
 */
function wireClip(edit: EditClip, manifestFit: EditFit, uriByKey: ReadonlyMap<string, string>): ComposeClip {
  const uri = uriByKey.get(edit.clipKey);
  if (!uri) throw new MissingClipError(edit.clipKey);
  if (edit.image) return pictureClip(edit, manifestFit, uri);
  const stretch = sourceStretch(edit);
  const clip: ComposeClip = {
    // The segment id, not the clip key: split and duplicate put several segments over one source,
    // and a failure reported against a key could not say which of them it was.
    key: edit.id,
    uri,
    inMs: Math.max(0, Math.round(edit.inMs)),
    outMs: Math.max(Math.round(edit.inMs) + MIN_WIRE_SOURCE_MS, Math.round(edit.outMs)),
    speed: stretch > 1 ? Math.min(MAX_SPEED, edit.speed * stretch) : edit.speed,
    volume: edit.volume,
    muted: edit.muted,
    // A segment may carry its own fit for the rectangle it sits in; without one it is the post's,
    // which is every clip of every manifest written before framing existed.
    fit: edit.fit ?? manifestFit,
  };
  // Set only when they say something. A crop of the whole frame and an upright rectangle covering
  // the whole frame are both "what the renderer did before crops existed", and every engine tests
  // for the ABSENCE of these fields once, when it builds its plan, to keep taking that path with no
  // extra work per frame. Writing a full-frame rectangle here would be the same picture at a real
  // cost, and it would stop an untouched clip producing the spec it produces today.
  const crop = wireRect(edit.crop);
  if (crop) clip.crop = crop;
  const rect = wirePlacement(edit.rect);
  if (rect) clip.rect = rect;
  return clip;
}

/** The least source a video segment is sent with; shorter trims are lengthened to it on the wire. */
const MIN_WIRE_SOURCE_MS = 100;

/**
 * How many times over a video segment's source is lengthened to reach [MIN_WIRE_SOURCE_MS], and so
 * how much faster it is sent: 1 for a segment that already has that much, or none at all.
 *
 * The floor is the wire's and it stays. What must not change with it is how long the segment PLAYS.
 * A template's hard slow on the hit is a 240 ms step at 0.3x - 72 ms of footage - and lengthened to
 * 100 ms at the same speed it would play for 333 ms: every cut after it would land that much after
 * its beat in the export, while the editor, which reads the manifest, showed them on it. Sent at the
 * speed that plays 100 ms of source in the step's own 240 ms instead, the export runs the editor's
 * timeline to the millisecond, and a slow that was 0.3x plays at 0.42x - which nobody can tell apart
 * on a single beat. A segment already at [MAX_SPEED] cannot go faster and keeps the old lengthening.
 */
function sourceStretch(edit: EditClip): number {
  if (edit.image) return 1;
  const span = Math.round(edit.outMs) - Math.round(edit.inMs);
  return span > 0 && span < MIN_WIRE_SOURCE_MS ? MIN_WIRE_SOURCE_MS / span : 1;
}

/**
 * A picture segment on the wire: its length from 0, silent, at 1x (see [ComposeClip.image]).
 *
 * The trim is REBASED to start at 0 rather than sent as the manifest has it. A picture's segment
 * sits in the middle of the long source it is given (see [EditClip.image]), and that number means
 * something to the editor's trim handles and nothing to an engine - which would only have to be
 * told to ignore it. What an engine needs is the length, and a picture's source time IS its output
 * time, so the transition arithmetic in [baseClips] that subtracts source milliseconds off `outMs`
 * works on the rebased numbers unchanged.
 */
function pictureClip(edit: EditClip, manifestFit: EditFit, uri: string): ComposeClip {
  const clip: ComposeClip = {
    key: edit.id,
    uri,
    inMs: 0,
    outMs: Math.max(100, Math.round(edit.outMs - edit.inMs)),
    speed: 1,
    volume: edit.volume,
    muted: true,
    fit: edit.fit ?? manifestFit,
    image: true,
  };
  const crop = wireRect(edit.crop);
  if (crop) clip.crop = crop;
  const rect = wirePlacement(edit.rect);
  if (rect) clip.rect = rect;
  return clip;
}

/** A rectangle worth putting on the wire, or `undefined` for one that says nothing. */
function wireRect(rect: EditRect | undefined): ComposeRect | undefined {
  if (!rect || isFullFrameRect(rect)) return undefined;
  // Copied field by field rather than passed through, so nothing a host happened to hang on its
  // own rectangle object rides across the bridge with it.
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

/**
 * Where the picture is drawn, and the angle it is turned to, for a segment that says something
 * about either. A whole-frame rectangle standing upright says nothing and goes no further.
 */
function wirePlacement(rect: EditPlacement | undefined): ComposePlacement | undefined {
  const wire = wireRect(rect);
  if (!wire) return undefined;
  // The key is left off for an upright rectangle rather than sent as 0, for the reason the whole
  // rectangle is left off for a clip nobody framed: a missing key is what tells every engine it has
  // no rotation to fold into its transform, and it is checked once when the plan is built.
  return isUprightRect(rect) ? wire : { ...wire, rotationDeg: rectRotationDeg(rect) };
}
