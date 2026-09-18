import type { ComposeClip, ComposeOverlay, ComposePlacement, ComposeRect, ComposeSpec, ComposeTrack } from '../video-composer/definitions';

import {
  MIN_LAYER_MS,
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
  type EditPlacement,
  type EditRect,
} from './edit-manifest';
import { overlayEndMs } from './edit-ops';
import { rasteriseOverlay } from './overlay-raster';
import type { RasterContext } from './raster-context';

export interface ComposeSpecIds {
  jobId: string;
  pendingPostId: string;
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
 */
export async function toComposeSpec(
  manifest: EditManifest,
  uriByKey: ReadonlyMap<string, string>,
  ids: ComposeSpecIds,
  raster: RasterContext,
): Promise<ComposeSpec> {
  const totalMs = Math.round(totalDurationMs(manifest));

  const clips: ComposeClip[] = manifest.clips.map((edit) => wireClip(edit, manifest.fit, uriByKey));

  // Resolved here beside the base clips rather than further down, so a layer whose footage the host
  // has no file for fails before the phone has spent a second drawing bitmaps for a render that was
  // never going to happen. `null` rather than an empty list, because the key it becomes is left off
  // the wire entirely and there is nothing in between.
  const tracks: ComposeTrack[] | null =
    manifest.videoTracks.length > 0
      ? manifest.videoTracks.map((track) => ({
          id: track.id,
          clips: track.clips.map((edit) => wireClip(edit, manifest.fit, uriByKey)),
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

    const bitmap = await rasteriseOverlay(overlay, raster);
    const startMs = Math.max(0, Math.round(overlay.startMs));
    const endMs = Math.max(startMs + MIN_LAYER_MS, Math.round(overlayEndMs(overlay, totalMs)));
    // An effect covers the frame: its bitmap is the whole picture, so it is never moved or turned.
    const fullFrame = overlay.kind === 'effect';
    overlays.push({
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
    });
  }

  const music = manifest.music;

  const spec: ComposeSpec = {
    jobId: ids.jobId,
    pendingPostId: ids.pendingPostId,
    clips,
    output: {
      ...manifest.output,
      videoBitrate: videoBitrateFor(manifest.output),
      audioBitrate: 128_000,
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
            outMs: Math.round(
              music.outMs > 0
                ? music.outMs
                : music.sourceDurationMs > 0
                  ? music.sourceDurationMs
                  : UNKNOWN_TRACK_END_MS,
            ),
            volume: music.volume,
            loop: music.loop,
            fadeInMs: 0,
            fadeOutMs: Math.max(0, Math.round(music.fadeOutMs)),
          }
        : null,
      voiceover: [...manifest.voiceovers]
        .sort((a, b) => a.startMs - b.startMs)
        .map((take) => ({
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

  return spec;
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
  const clip: ComposeClip = {
    // The segment id, not the clip key: split and duplicate put several segments over one source,
    // and a failure reported against a key could not say which of them it was.
    key: edit.id,
    uri,
    inMs: Math.max(0, Math.round(edit.inMs)),
    outMs: Math.max(Math.round(edit.inMs) + 100, Math.round(edit.outMs)),
    speed: edit.speed,
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
