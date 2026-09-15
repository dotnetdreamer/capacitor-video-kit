import type { ComposeClip, ComposeOverlay, ComposeSpec } from '../video-composer/definitions';

import {
  DEFAULT_OUTPUT,
  MIN_LAYER_MS,
  clamp,
  resolveFilterOps,
  totalDurationMs,
  videoBitrateFor,
  type EditManifest,
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
 * Every number the preview used is carried across unchanged - trims, speeds, the resolved colour
 * ops, each layer's 0..1 centre, clockwise rotation, opacity and time window - and every layer is
 * rasterised here by [rasteriseOverlay], the same function that draws the preview's bitmaps, so the
 * native side only ever places PNGs and the posted video matches what the customer saw.
 *
 * Asynchronous because drawing a layer is: a text layer waits for its web font to load before it is
 * measured, and photos and stickers have to be decoded before they can be drawn. Layers are drawn
 * one after another rather than all at once, so a phone holds one layer's canvas at a time instead
 * of thirty. Rejects with [MissingClipError] for a clip without a file, and with the rasteriser's
 * error for a photo or sticker that cannot be loaded.
 *
 * @param uriByKey the file each clip key refers to (`file://` or `content://`).
 * @param raster the host's fonts, stickers and file URLs. Its `output` must be the frame this spec
 *   renders (`DEFAULT_OUTPUT`), because every `wPx`/`hPx` is measured against it.
 */
export async function toComposeSpec(
  manifest: EditManifest,
  uriByKey: ReadonlyMap<string, string>,
  ids: ComposeSpecIds,
  raster: RasterContext,
): Promise<ComposeSpec> {
  const totalMs = Math.round(totalDurationMs(manifest));

  const clips: ComposeClip[] = manifest.clips.map((edit) => {
    const uri = uriByKey.get(edit.clipKey);
    if (!uri) throw new MissingClipError(edit.clipKey);
    return {
      // The segment id, not the clip key: split and duplicate put several segments over one source,
      // and a failure reported against a key could not say which of them it was.
      key: edit.id,
      uri,
      inMs: Math.max(0, Math.round(edit.inMs)),
      outMs: Math.max(Math.round(edit.inMs) + 100, Math.round(edit.outMs)),
      speed: edit.speed,
      volume: edit.volume,
      muted: edit.muted,
      fit: manifest.fit,
    };
  });

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

  return {
    jobId: ids.jobId,
    pendingPostId: ids.pendingPostId,
    clips,
    output: {
      ...DEFAULT_OUTPUT,
      videoBitrate: videoBitrateFor(totalMs),
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
}
