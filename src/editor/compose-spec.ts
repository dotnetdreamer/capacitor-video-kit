import type { ComposeOverlay, ComposeSpec } from '../video-composer/definitions';

import {
  DEFAULT_OUTPUT,
  filterPreset,
  totalDurationMs,
  videoBitrateFor,
  type EditManifest,
} from './edit-manifest';
import { rasteriseText } from './overlay-raster';

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

/**
 * The one translation from an edit to something the native composer renders.
 *
 * Every number the preview used is carried across unchanged - trims, speeds, the CSS filter ops, the
 * 0..1 overlay centre and its clockwise rotation - and the text overlays are rasterised here, at
 * OUTPUT pixel scale, so the native side only ever places bitmaps.
 *
 * @param uriByKey the file each clip key refers to (`file://` or `content://`).
 */
export function toComposeSpec(
  manifest: EditManifest,
  uriByKey: ReadonlyMap<string, string>,
  ids: ComposeSpecIds,
  fontFamily = 'system-ui, -apple-system, Roboto, sans-serif',
): ComposeSpec {
  const totalMs = Math.round(totalDurationMs(manifest));

  const clips = manifest.clips.map((edit) => {
    const uri = uriByKey.get(edit.clipKey);
    if (!uri) throw new MissingClipError(edit.clipKey);
    return {
      key: edit.clipKey,
      uri,
      inMs: Math.max(0, Math.round(edit.inMs)),
      outMs: Math.max(Math.round(edit.inMs) + 100, Math.round(edit.outMs)),
      speed: edit.speed,
      volume: edit.volume,
      muted: edit.muted,
      fit: manifest.fit,
    };
  });

  const overlays: ComposeOverlay[] = manifest.overlays
    .filter((overlay) => overlay.text.trim().length > 0)
    .map((overlay) => {
      const raster = rasteriseText({
        text: overlay.text,
        fontSizePx: Math.round(DEFAULT_OUTPUT.width * overlay.fontScale),
        color: overlay.color,
        background: overlay.background,
        fontFamily,
      });
      const endMs = overlay.endMs > 0 ? overlay.endMs : totalMs;
      return {
        id: overlay.id,
        png: raster.png,
        wPx: raster.wPx,
        hPx: raster.hPx,
        cx: overlay.cx,
        cy: overlay.cy,
        rotationDeg: overlay.rotationDeg,
        startMs: Math.max(0, Math.round(overlay.startMs)),
        endMs: Math.max(Math.round(overlay.startMs) + 100, Math.round(endMs)),
        opacity: 1,
      };
    });

  return {
    jobId: ids.jobId,
    pendingPostId: ids.pendingPostId,
    clips,
    output: {
      ...DEFAULT_OUTPUT,
      videoBitrate: videoBitrateFor(totalMs),
      audioBitrate: 128_000,
    },
    filter: filterPreset(manifest.filterId).ops,
    overlays,
    audio: {
      originalMuted: manifest.originalMuted,
      originalVolume: 1,
      music: manifest.music
        ? {
            uri: manifest.music.uri,
            startMs: manifest.music.startMs,
            inMs: 0,
            // Longer than any post can run; the composer clips the track to the video's end.
            outMs: 3_600_000,
            volume: manifest.music.volume,
            loop: manifest.music.loop,
            fadeInMs: 0,
            fadeOutMs: 400,
          }
        : null,
      voiceover: manifest.voice
        ? [
            {
              uri: manifest.voice.uri,
              startMs: manifest.voice.startMs,
              durationMs: manifest.voice.durationMs,
              volume: manifest.voice.volume,
            },
          ]
        : [],
    },
    // A little way in, so the poster is a frame of the video rather than a fade from black.
    posterAtMs: Math.min(500, Math.max(0, totalMs - 1)),
  };
}
