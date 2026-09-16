import {
  MAX_LAYERS,
  MAX_SCALE,
  MAX_SPEED,
  MAX_VIDEO_TRACKS,
  MIN_CLIP_MS,
  MIN_LAYER_MS,
  MIN_SCALE,
  MIN_SPEED,
  clamp,
  isFullFrameRect,
  normaliseRect,
  sameRect,
  totalDurationMs,
  type EditClip,
  type EditFit,
  type EditManifest,
  type EditMusic,
  type EditOverlay,
  type EditRect,
  type EditVideoTrack,
  type EditVoiceover,
} from './edit-manifest';

/**
 * Every change an editor can make to a manifest, as pure functions.
 *
 * Each one takes a manifest and returns a NEW one (or the same object when nothing changed, or
 * `null` when the change is not possible - a split too close to an edge, a layer past the cap), so
 * an editor can keep snapshots for undo by reference and never has to deep-copy anything. None of
 * them know about a UI, a player or a platform; ids are always handed in by the caller.
 */

/* -------------------------------------------------------------------------------------------- */
/* Timeline                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** One clip segment placed on the OUTPUT timeline. */
export interface TimelineSlot {
  clip: EditClip;
  index: number;
  startMs: number;
  durationMs: number;
}

export function clipDurationMs(clip: EditClip): number {
  return Math.max(0, clip.outMs - clip.inMs) / (clip.speed || 1);
}

export function timelineSlots(manifest: Pick<EditManifest, 'clips'>): TimelineSlot[] {
  let cursor = 0;
  return manifest.clips.map((clip, index) => {
    const durationMs = clipDurationMs(clip);
    const slot = { clip, index, startMs: cursor, durationMs };
    cursor += durationMs;
    return slot;
  });
}

/** The segment playing at `outputMs`. The very end of the timeline belongs to the last segment. */
export function slotAt(manifest: Pick<EditManifest, 'clips'>, outputMs: number): TimelineSlot | null {
  const slots = timelineSlots(manifest);
  if (!slots.length) return null;
  return slots.find((slot) => outputMs < slot.startMs + slot.durationMs) ?? slots[slots.length - 1];
}

/** Source time inside a segment for an output time, clamped to the segment's trim. */
export function sourceMsAt(slot: TimelineSlot, outputMs: number): number {
  const into = clamp(outputMs - slot.startMs, 0, slot.durationMs);
  return clamp(slot.clip.inMs + into * (slot.clip.speed || 1), slot.clip.inMs, slot.clip.outMs);
}

/* -------------------------------------------------------------------------------------------- */
/* Clips                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * A segment anywhere in the manifest - the base track or any extra video layer. Ids are unique
 * across the whole manifest for exactly this reason: every op takes a clip id and nothing else, so
 * a clip on the second layer has to be reachable and patchable by the same call the first layer's
 * clips use, or the crop tool and the volume sheet would work on one layer only.
 */
export function findClip(manifest: EditManifest, clipId: string): EditClip | null {
  const base = manifest.clips.find((clip) => clip.id === clipId);
  if (base) return base;
  for (const track of manifest.videoTracks) {
    const found = track.clips.find((clip) => clip.id === clipId);
    if (found) return found;
  }
  return null;
}

/** Which layer a segment is on: `null` for the base track, otherwise the extra track's id. */
export function trackIdOfClip(manifest: EditManifest, clipId: string): string | null | undefined {
  if (manifest.clips.some((clip) => clip.id === clipId)) return null;
  const track = manifest.videoTracks.find((t) => t.clips.some((clip) => clip.id === clipId));
  return track ? track.id : undefined;
}

export function patchClip(
  manifest: EditManifest,
  clipId: string,
  patch: Partial<Omit<EditClip, 'id' | 'crop' | 'rect' | 'fit'>> & ClipFramingPatch,
): EditManifest {
  const current = findClip(manifest, clipId);
  if (!current) return manifest;
  const next = withFraming({ ...current, ...patch } as EditClip, patch);
  if (sameClip(current, next)) return manifest;
  if (manifest.clips.some((clip) => clip.id === clipId)) {
    return { ...manifest, clips: manifest.clips.map((clip) => (clip.id === clipId ? next : clip)) };
  }
  return {
    ...manifest,
    videoTracks: manifest.videoTracks.map((track) =>
      track.clips.some((clip) => clip.id === clipId)
        ? { ...track, clips: track.clips.map((clip) => (clip.id === clipId ? next : clip)) }
        : track,
    ),
  };
}

export function setClipSpeed(manifest: EditManifest, clipId: string, speed: number): EditManifest {
  return patchClip(manifest, clipId, { speed: Math.round(clamp(speed, MIN_SPEED, MAX_SPEED) * 100) / 100 });
}

/**
 * How a segment is framed, as a patch. `null` is the instruction to go back to the default, and it
 * is a different thing from leaving the key out, which is the instruction to change nothing - the
 * same distinction [patchOverlay] draws, spelled out here because "no crop" is itself a value a
 * customer can ask for.
 */
export interface ClipFramingPatch {
  crop?: EditRect | null;
  rect?: EditRect | null;
  fit?: EditFit | null;
}

/** The part of the source that is kept, 0..1 of the oriented frame. `null` is the whole of it. */
export function setClipCrop(manifest: EditManifest, clipId: string, crop: EditRect | null): EditManifest {
  return patchClip(manifest, clipId, { crop });
}

/** Where the segment is drawn on the output frame, 0..1. `null` is the whole frame, as it always was. */
export function setClipRect(manifest: EditManifest, clipId: string, rect: EditRect | null): EditManifest {
  return patchClip(manifest, clipId, { rect });
}

/** This segment's own fit. `null` hands it back to the whole post's [EditManifest.fit]. */
export function setClipFit(manifest: EditManifest, clipId: string, fit: EditFit | null): EditManifest {
  return patchClip(manifest, clipId, { fit });
}

/**
 * Back to the whole source drawn over the whole frame, fitted the way the rest of the post is -
 * the "Reset" a crop tool offers, and precisely the state every manifest written before version 3
 * is already in. All three fields go together because a rectangle without the fit that was chosen
 * for it is not a state a customer ever asked for.
 */
export function resetClipFraming(manifest: EditManifest, clipId: string): EditManifest {
  return patchClip(manifest, clipId, { crop: null, rect: null, fit: null });
}

/**
 * Sets a segment's trim, keeping it inside its source and at least [MIN_CLIP_MS] long. The edge
 * being moved gives way, never the one that is not.
 *
 * @param sourceDurationMs 0 when unknown, which lifts the upper bound.
 */
export function trimClip(
  manifest: EditManifest,
  clipId: string,
  inMs: number,
  outMs: number,
  sourceDurationMs: number,
): EditManifest {
  const clip = findClip(manifest, clipId);
  if (!clip) return manifest;
  const max = sourceDurationMs > 0 ? sourceDurationMs : Number.MAX_SAFE_INTEGER;
  let nextIn = Math.round(clamp(inMs, 0, max));
  let nextOut = Math.round(clamp(outMs, 0, max));
  if (nextIn !== clip.inMs) nextIn = Math.min(nextIn, nextOut - MIN_CLIP_MS);
  if (nextOut !== clip.outMs) nextOut = Math.max(nextOut, nextIn + MIN_CLIP_MS);
  nextIn = Math.max(0, nextIn);
  nextOut = Math.min(max, Math.max(nextOut, nextIn + MIN_CLIP_MS));
  if (nextIn === clip.inMs && nextOut === clip.outMs) return manifest;
  return patchClip(manifest, clipId, { inMs: nextIn, outMs: nextOut });
}

/**
 * Cuts the segment under `outputMs` in two. The left piece keeps the id; the right piece gets
 * `newId`. Null when either piece would be shorter than [MIN_CLIP_MS] of source.
 */
export function splitClipAt(manifest: EditManifest, outputMs: number, newId: string): EditManifest | null {
  const slot = slotAt(manifest, outputMs);
  if (!slot) return null;
  const cut = Math.round(sourceMsAt(slot, outputMs));
  const { clip } = slot;
  if (cut - clip.inMs < MIN_CLIP_MS || clip.outMs - cut < MIN_CLIP_MS) return null;
  const left: EditClip = { ...clip, outMs: cut };
  const right: EditClip = { ...clip, id: newId, inMs: cut };
  const clips = [...manifest.clips];
  clips.splice(slot.index, 1, left, right);
  return { ...manifest, clips };
}

/** Whether the segment can be joined with the one after it - two halves of an earlier split. */
export function canJoinWithNext(manifest: EditManifest, clipId: string): boolean {
  const index = manifest.clips.findIndex((clip) => clip.id === clipId);
  const a = manifest.clips[index];
  const b = manifest.clips[index + 1];
  return (
    !!a &&
    !!b &&
    a.clipKey === b.clipKey &&
    a.speed === b.speed &&
    a.volume === b.volume &&
    a.muted === b.muted &&
    // Two halves of an earlier split still share their framing. Once one of them has been cropped
    // or moved on the frame they are no longer one shot, and joining them would throw that away.
    a.fit === b.fit &&
    sameRect(a.crop, b.crop) &&
    sameRect(a.rect, b.rect) &&
    Math.abs(a.outMs - b.inMs) <= 1
  );
}

export function joinWithNext(manifest: EditManifest, clipId: string): EditManifest | null {
  if (!canJoinWithNext(manifest, clipId)) return null;
  const index = manifest.clips.findIndex((clip) => clip.id === clipId);
  const clips = [...manifest.clips];
  const [a, b] = clips.splice(index, 2);
  clips.splice(index, 0, { ...a, outMs: b.outMs });
  return { ...manifest, clips };
}

/** Inserts a copy straight after the segment. */
export function duplicateClip(manifest: EditManifest, clipId: string, newId: string): EditManifest | null {
  const index = manifest.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return null;
  const clips = [...manifest.clips];
  clips.splice(index + 1, 0, { ...clips[index], id: newId });
  return { ...manifest, clips };
}

/**
 * Null for the last segment of the BASE track: a post needs at least one, and the base is what
 * fixes how long the post runs.
 *
 * A segment on an extra layer has no such floor, and the layer goes with its last clip - an empty
 * track renders nothing, the native parsers refuse it, and a lane a customer cannot get rid of is
 * not a state this manifest holds.
 */
export function removeClip(manifest: EditManifest, clipId: string): EditManifest | null {
  if (manifest.clips.some((clip) => clip.id === clipId)) {
    if (manifest.clips.length <= 1) return null;
    return { ...manifest, clips: manifest.clips.filter((clip) => clip.id !== clipId) };
  }
  const owner = manifest.videoTracks.find((track) => track.clips.some((clip) => clip.id === clipId));
  if (!owner) return null;
  return {
    ...manifest,
    videoTracks: manifest.videoTracks
      .map((track) =>
        track.id === owner.id ? { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) } : track,
      )
      .filter((track) => track.clips.length > 0),
  };
}

export function moveClip(manifest: EditManifest, clipId: string, toIndex: number): EditManifest {
  const from = manifest.clips.findIndex((clip) => clip.id === clipId);
  const to = clamp(Math.round(toIndex), 0, manifest.clips.length - 1);
  if (from < 0 || from === to) return manifest;
  const clips = [...manifest.clips];
  const [moved] = clips.splice(from, 1);
  clips.splice(to, 0, moved);
  return { ...manifest, clips };
}

/** Points a segment at a different source, keeping its speed and sound but not its trim. */
export function replaceClipSource(
  manifest: EditManifest,
  clipId: string,
  clipKey: string,
  sourceDurationMs: number,
): EditManifest {
  return patchClip(manifest, clipId, {
    clipKey,
    inMs: 0,
    outMs: Math.max(MIN_CLIP_MS, Math.round(sourceDurationMs)),
  });
}

/** Appends a new source after `afterClipId` (or at the end). */
export function insertClip(
  manifest: EditManifest,
  clip: EditClip,
  afterClipId: string | null = null,
): EditManifest {
  const clips = [...manifest.clips];
  const index = afterClipId ? clips.findIndex((c) => c.id === afterClipId) : -1;
  clips.splice(index >= 0 ? index + 1 : clips.length, 0, clip);
  return { ...manifest, clips };
}

/* -------------------------------------------------------------------------------------------- */
/* Video tracks                                                                                   */
/* -------------------------------------------------------------------------------------------- */

export function findVideoTrack(manifest: EditManifest, trackId: string): EditVideoTrack | null {
  return manifest.videoTracks.find((track) => track.id === trackId) ?? null;
}

/**
 * Starts a second layer of video with one clip on it. Null once [MAX_VIDEO_TRACKS] layers are on
 * the post, the base track counted: the cap is a decoder budget rather than a matter of taste, and
 * refusing is the only honest answer to it - a layer accepted and silently dropped is a customer
 * waiting for a picture that never arrives.
 *
 * The layer arrives UNPLACED, covering the frame like any other clip, and [applyLayoutPreset] is
 * what arranges the two. Placing it here would be this function guessing which arrangement the
 * customer wanted before they had said.
 */
export function addVideoTrack(manifest: EditManifest, clip: EditClip, trackId: string): EditManifest | null {
  if (manifest.videoTracks.length >= MAX_VIDEO_TRACKS - 1) return null;
  const track: EditVideoTrack = {
    id: trackId,
    clips: [clip],
    startMs: 0,
    // One above whatever is already there, so no two layers ever share a place in the drawing order.
    z: manifest.videoTracks.length + 1,
    opacity: 1,
  };
  return { ...manifest, videoTracks: [...manifest.videoTracks, track] };
}

/**
 * Takes a layer off the post.
 *
 * What it was arranged beside is left exactly as it is: the base keeps whatever rectangle a layout
 * wrote onto it, so a caller ending a split screen applies the `full` preset and then removes the
 * layer. Clearing the base here would be this function guessing, and the rectangle it threw away
 * might be one the customer set by hand in the crop tool rather than one a preset wrote.
 */
export function removeVideoTrack(manifest: EditManifest, trackId: string): EditManifest {
  if (!findVideoTrack(manifest, trackId)) return manifest;
  return { ...manifest, videoTracks: manifest.videoTracks.filter((track) => track.id !== trackId) };
}

/**
 * Where the layer's first clip lands on the output timeline. Clamped to the post, because the base
 * track is what fixes its length: a layer starting past the end is one every engine cuts away
 * entirely and the customer is left dragging a handle that does nothing.
 */
export function setTrackStart(manifest: EditManifest, trackId: string, startMs: number): EditManifest {
  return patchTrack(manifest, trackId, { startMs: Math.round(clamp(startMs, 0, totalDurationMs(manifest))) });
}

/** How far the whole layer is faded into what is under it. */
export function setTrackOpacity(manifest: EditManifest, trackId: string, opacity: number): EditManifest {
  return patchTrack(manifest, trackId, { opacity: clamp(opacity, 0, 1) });
}

/**
 * Puts the extra layer under the base, or back over it - the one control over the drawing order a
 * customer gets while there are two layers.
 *
 * Done by moving the CLIPS between the two layers rather than by a `z` of its own. Each clip
 * carries its own rectangle with it, so every picture stays exactly where it was on the frame and
 * the only thing that changes is which of them is drawn over the other: a swap of `z` in every way
 * anybody can see, with `z` itself left saying what the native parsers are allowed to assume, that
 * the base track is 0 and nothing is ever below it. The alternative is a layer at `z` -1, and then
 * four engines have to agree about a layer beneath the bottom one for a feature that is two
 * rectangles.
 *
 * The base track is what fixes how long the post runs, so swapping two layers of different lengths
 * changes it. Nothing else can be true while the base is the bottom layer, and it is the reason
 * this is one call rather than a `z` a customer could set to anything.
 */
export function swapTrackZ(manifest: EditManifest, trackId: string): EditManifest {
  const track = findVideoTrack(manifest, trackId);
  if (!track || manifest.clips.length === 0) return manifest;
  return {
    ...manifest,
    clips: track.clips,
    videoTracks: manifest.videoTracks.map((t) => (t.id === trackId ? { ...t, clips: manifest.clips } : t)),
  };
}

function patchTrack(
  manifest: EditManifest,
  trackId: string,
  patch: Partial<Omit<EditVideoTrack, 'id' | 'clips'>>,
): EditManifest {
  const current = findVideoTrack(manifest, trackId);
  if (!current) return manifest;
  const next = { ...current, ...patch };
  if (sameFields(current, next)) return manifest;
  return {
    ...manifest,
    videoTracks: manifest.videoTracks.map((track) => (track.id === trackId ? next : track)),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Layers                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export function findOverlay(manifest: EditManifest, id: string): EditOverlay | null {
  return manifest.overlays.find((overlay) => overlay.id === id) ?? null;
}

/** Where a layer stops on the output timeline, with "until the end" resolved. */
export function overlayEndMs(overlay: Pick<EditOverlay, 'endMs'>, totalMs: number): number {
  return overlay.endMs > 0 ? Math.min(overlay.endMs, totalMs) : totalMs;
}

/** The same gate the native render applies: `startMs <= t < endMs`, with the last frame included. */
export function isOverlayVisibleAt(overlay: EditOverlay, outputMs: number, totalMs: number): boolean {
  const end = overlayEndMs(overlay, totalMs);
  return outputMs >= overlay.startMs && (outputMs < end || (end >= totalMs && outputMs >= totalMs - 1));
}

/** Adds a layer on top of every other one. Null at [MAX_LAYERS]. */
export function addOverlay(manifest: EditManifest, overlay: EditOverlay): EditManifest | null {
  if (manifest.overlays.length >= MAX_LAYERS) return null;
  return { ...manifest, overlays: [...manifest.overlays, normaliseLayer(overlay)] };
}

export function patchOverlay(
  manifest: EditManifest,
  id: string,
  patch: Partial<Omit<EditOverlay, 'id' | 'kind'>> & Record<string, unknown>,
): EditManifest {
  const current = findOverlay(manifest, id);
  if (!current) return manifest;
  const next = normaliseLayer({ ...current, ...patch } as EditOverlay);
  if (sameFields(current, next)) return manifest;
  return {
    ...manifest,
    overlays: manifest.overlays.map((overlay) => (overlay.id === id ? next : overlay)),
  };
}

export function removeOverlay(manifest: EditManifest, id: string): EditManifest {
  if (!findOverlay(manifest, id)) return manifest;
  return { ...manifest, overlays: manifest.overlays.filter((overlay) => overlay.id !== id) };
}

/** A copy directly above the original, nudged so the two are not exactly on top of each other. */
export function duplicateOverlay(manifest: EditManifest, id: string, newId: string): EditManifest | null {
  const index = manifest.overlays.findIndex((overlay) => overlay.id === id);
  if (index < 0 || manifest.overlays.length >= MAX_LAYERS) return null;
  const source = manifest.overlays[index];
  const copy = normaliseLayer({
    ...source,
    id: newId,
    cx: source.kind === 'effect' ? source.cx : clamp(source.cx + 0.05, 0, 1),
    cy: source.kind === 'effect' ? source.cy : clamp(source.cy + 0.05, 0, 1),
  });
  const overlays = [...manifest.overlays];
  overlays.splice(index + 1, 0, copy);
  return { ...manifest, overlays };
}

export type LayerMove = 'forward' | 'backward' | 'front' | 'back';

/** Changes the drawing order. `front` is drawn last, over everything. */
export function moveLayer(manifest: EditManifest, id: string, move: LayerMove): EditManifest {
  const from = manifest.overlays.findIndex((overlay) => overlay.id === id);
  if (from < 0) return manifest;
  const last = manifest.overlays.length - 1;
  const to =
    move === 'forward' ? Math.min(last, from + 1)
    : move === 'backward' ? Math.max(0, from - 1)
    : move === 'front' ? last
    : 0;
  if (to === from) return manifest;
  const overlays = [...manifest.overlays];
  const [moved] = overlays.splice(from, 1);
  overlays.splice(to, 0, moved);
  return { ...manifest, overlays };
}

/** Puts a layer at an exact position in the drawing order, 0 being the bottom. */
export function moveLayerTo(manifest: EditManifest, id: string, toIndex: number): EditManifest {
  const from = manifest.overlays.findIndex((overlay) => overlay.id === id);
  const to = clamp(Math.round(toIndex), 0, manifest.overlays.length - 1);
  if (from < 0 || from === to) return manifest;
  const overlays = [...manifest.overlays];
  const [moved] = overlays.splice(from, 1);
  overlays.splice(to, 0, moved);
  return { ...manifest, overlays };
}

/**
 * Sets when a layer shows, keeping it at least [MIN_LAYER_MS] long and inside the video. An end at
 * (or past) the end of the video is stored as "until the end", so the layer keeps covering the
 * whole tail when a clip is added later.
 */
export function setOverlayWindow(
  manifest: EditManifest,
  id: string,
  startMs: number,
  endMs: number,
  totalMs: number,
): EditManifest {
  const overlay = findOverlay(manifest, id);
  if (!overlay) return manifest;
  const [start, end] = clampWindow(startMs, endMs, totalMs, overlay.startMs, overlayEndMs(overlay, totalMs));
  return patchOverlay(manifest, id, { startMs: start, endMs: end >= totalMs - 1 ? 0 : end });
}

/** Cuts a layer in two at `atMs`; the right half gets `newId` and sits directly above the left. */
export function splitOverlayAt(
  manifest: EditManifest,
  id: string,
  atMs: number,
  newId: string,
  totalMs: number,
): EditManifest | null {
  const index = manifest.overlays.findIndex((overlay) => overlay.id === id);
  if (index < 0 || manifest.overlays.length >= MAX_LAYERS) return null;
  const overlay = manifest.overlays[index];
  const end = overlayEndMs(overlay, totalMs);
  const cut = Math.round(atMs);
  if (cut - overlay.startMs < MIN_LAYER_MS || end - cut < MIN_LAYER_MS) return null;
  const overlays = [...manifest.overlays];
  overlays.splice(index, 1, { ...overlay, endMs: cut }, { ...overlay, id: newId, startMs: cut });
  return { ...manifest, overlays };
}

function normaliseLayer<T extends EditOverlay>(overlay: T): T {
  return {
    ...overlay,
    cx: clamp(overlay.cx, 0, 1),
    cy: clamp(overlay.cy, 0, 1),
    scale: clamp(overlay.scale, MIN_SCALE, MAX_SCALE),
    opacity: clamp(overlay.opacity, 0, 1),
    startMs: Math.max(0, Math.round(overlay.startMs)),
    endMs: Math.max(0, Math.round(overlay.endMs)),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Sound                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** The length of the music section itself, before any looping. 0 when the track length is unknown. */
export function musicSectionMs(music: EditMusic): number {
  const out = music.outMs > 0 ? music.outMs : music.sourceDurationMs;
  return out > 0 ? Math.max(0, out - music.inMs) : 0;
}

/** Where the music is heard on the output timeline. */
export function musicWindow(music: EditMusic, totalMs: number): { startMs: number; endMs: number } {
  const section = musicSectionMs(music);
  const startMs = Math.min(music.startMs, totalMs);
  const endMs = music.loop || section === 0 ? totalMs : Math.min(totalMs, music.startMs + section);
  return { startMs, endMs: Math.max(startMs, endMs) };
}

/** Position inside the TRACK for an output time, or null when the music is silent there. */
export function musicSourceMsAt(music: EditMusic, outputMs: number, totalMs: number): number | null {
  const { startMs, endMs } = musicWindow(music, totalMs);
  if (outputMs < startMs || outputMs >= endMs) return null;
  const section = musicSectionMs(music);
  const into = outputMs - startMs;
  return music.inMs + (section > 0 && music.loop ? into % section : into);
}

export function setMusic(manifest: EditManifest, music: EditMusic | null): EditManifest {
  return { ...manifest, music };
}

export function patchMusic(manifest: EditManifest, patch: Partial<EditMusic>): EditManifest {
  if (!manifest.music) return manifest;
  const next = { ...manifest.music, ...patch };
  next.volume = clamp(next.volume, 0, 1);
  next.inMs = Math.max(0, Math.round(next.inMs));
  next.outMs = Math.max(0, Math.round(next.outMs));
  next.startMs = Math.max(0, Math.round(next.startMs));
  if (next.outMs > 0 && next.outMs - next.inMs < MIN_LAYER_MS) return manifest;
  if (sameFields(manifest.music, next)) return manifest;
  return { ...manifest, music: next };
}

export function findVoiceover(manifest: EditManifest, id: string): EditVoiceover | null {
  return manifest.voiceovers.find((take) => take.id === id) ?? null;
}

/**
 * How long a take starting at `startMs` may run before it would reach the next take or the end of
 * the video. 0 when `startMs` is inside an existing take.
 */
export function voiceRoomAt(manifest: EditManifest, startMs: number, totalMs: number, ignoreId?: string): number {
  const takes = manifest.voiceovers.filter((take) => take.id !== ignoreId);
  if (takes.some((take) => startMs >= take.startMs && startMs < take.startMs + take.durationMs)) return 0;
  const next = takes.filter((take) => take.startMs >= startMs).sort((a, b) => a.startMs - b.startMs)[0];
  return Math.max(0, Math.min(next ? next.startMs : totalMs, totalMs) - startMs);
}

/** Adds a take, shortened to the room it has. Null when there is no room at all. */
export function addVoiceover(manifest: EditManifest, take: EditVoiceover, totalMs: number): EditManifest | null {
  const room = voiceRoomAt(manifest, take.startMs, totalMs);
  if (room < MIN_LAYER_MS) return null;
  const placed = { ...take, startMs: Math.round(take.startMs), durationMs: Math.round(Math.min(take.durationMs, room)) };
  return { ...manifest, voiceovers: [...manifest.voiceovers, placed].sort((a, b) => a.startMs - b.startMs) };
}

export function patchVoiceover(manifest: EditManifest, id: string, patch: Partial<Pick<EditVoiceover, 'volume'>>): EditManifest {
  const current = findVoiceover(manifest, id);
  if (!current) return manifest;
  const next = { ...current, ...patch, volume: clamp(patch.volume ?? current.volume, 0, 1) };
  if (sameFields(current, next)) return manifest;
  return {
    ...manifest,
    voiceovers: manifest.voiceovers.map((take) => (take.id === id ? next : take)),
  };
}

/** Moves a take along the timeline, stopping at its neighbours and the ends of the video. */
export function moveVoiceover(manifest: EditManifest, id: string, startMs: number, totalMs: number): EditManifest {
  const take = findVoiceover(manifest, id);
  if (!take) return manifest;
  const others = manifest.voiceovers.filter((t) => t.id !== id);
  const before = others.filter((t) => t.startMs + t.durationMs <= take.startMs).sort((a, b) => b.startMs - a.startMs)[0];
  const after = others.filter((t) => t.startMs >= take.startMs + take.durationMs).sort((a, b) => a.startMs - b.startMs)[0];
  const min = before ? before.startMs + before.durationMs : 0;
  const max = Math.max(min, (after ? after.startMs : Math.max(totalMs, take.startMs + take.durationMs)) - take.durationMs);
  const next = Math.round(clamp(startMs, min, max));
  if (next === take.startMs) return manifest;
  return {
    ...manifest,
    voiceovers: manifest.voiceovers
      .map((t) => (t.id === id ? { ...t, startMs: next } : t))
      .sort((a, b) => a.startMs - b.startMs),
  };
}

export function removeVoiceover(manifest: EditManifest, id: string): EditManifest {
  if (!findVoiceover(manifest, id)) return manifest;
  return { ...manifest, voiceovers: manifest.voiceovers.filter((take) => take.id !== id) };
}

/* -------------------------------------------------------------------------------------------- */

/**
 * Whether a patched copy still holds exactly what the original held. The patch ops hand back the
 * manifest they were given in that case, as every op promises: an editor keeps undo snapshots by
 * reference, and a new object with the same values would be an undo step that undoes nothing (a
 * speed chip tapped twice, a slider released where it started, a layer's window set to itself).
 */
/**
 * A clip with its framing applied: each of the three fields normalised when it was given, and
 * DELETED rather than set to `undefined` when it was cleared or came out as the whole frame.
 *
 * The deletion is the whole point. A missing `crop` is what tells [toComposeSpec] to leave the
 * field off the wire, and a missing field on the wire is what tells every engine to take the path
 * it took before crops existed - one check when the plan is built, none per frame. A key holding
 * `undefined` looks the same to a reader and survives a round trip through the manifest as a key,
 * so it would cost exactly that.
 */
function withFraming(clip: EditClip, patch: ClipFramingPatch): EditClip {
  const next: EditClip = { ...clip };
  if ('crop' in patch) setRect(next, 'crop', patch.crop);
  if ('rect' in patch) setRect(next, 'rect', patch.rect);
  if ('fit' in patch) {
    if (patch.fit) next.fit = patch.fit;
    else delete next.fit;
  }
  return next;
}

function setRect(clip: EditClip, key: 'crop' | 'rect', value: EditRect | null | undefined): void {
  const normalised = value ? normaliseRect(value) : undefined;
  // A crop of the whole frame is no crop. Storing it would cost the render its fast path and would
  // make [isUntouched] send a clip nobody changed through a re-encode.
  if (normalised && !isFullFrameRect(normalised)) clip[key] = normalised;
  else delete clip[key];
}

/**
 * Whether a patched segment still says exactly what the original said. Written out field by field
 * rather than run through [sameFields] because two rectangles holding the same four numbers are
 * different objects, and an identity comparison on them would report a change every time a crop
 * gesture settled back where it started.
 */
function sameClip(a: EditClip, b: EditClip): boolean {
  return (
    a.clipKey === b.clipKey &&
    a.inMs === b.inMs &&
    a.outMs === b.outMs &&
    a.speed === b.speed &&
    a.volume === b.volume &&
    a.muted === b.muted &&
    a.fit === b.fit &&
    sameRect(a.crop, b.crop) &&
    sameRect(a.rect, b.rect)
  );
}

function sameFields<T extends object>(a: T, b: T): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const key of keys) {
    if (x[key] !== y[key]) return false;
  }
  return true;
}

function clampWindow(
  startMs: number,
  endMs: number,
  totalMs: number,
  prevStart: number,
  prevEnd: number,
): [number, number] {
  const total = Math.max(MIN_LAYER_MS, totalMs);
  // Both edges moved by the same amount: the whole window is being dragged, and it stops at the
  // ends of the video with its length intact rather than being squashed against them.
  const prevLen = prevEnd - prevStart;
  if (startMs !== prevStart && endMs !== prevEnd && Math.abs(endMs - startMs - prevLen) <= 1) {
    const len = Math.min(Math.max(prevLen, MIN_LAYER_MS), total);
    const shifted = Math.round(clamp(startMs, 0, total - len));
    return [shifted, shifted + len];
  }
  let start = Math.round(clamp(startMs, 0, total - MIN_LAYER_MS));
  let end = Math.round(clamp(endMs, MIN_LAYER_MS, total));
  // The edge that moved gives way.
  const movedStart = start !== prevStart;
  const movedEnd = end !== prevEnd;
  if (end - start < MIN_LAYER_MS) {
    if (movedStart && !movedEnd) start = end - MIN_LAYER_MS;
    else end = start + MIN_LAYER_MS;
  }
  start = Math.max(0, start);
  end = Math.min(total, Math.max(end, start + MIN_LAYER_MS));
  return [start, end];
}
