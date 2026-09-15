import {
  MAX_LAYERS,
  MAX_SCALE,
  MAX_SPEED,
  MIN_CLIP_MS,
  MIN_LAYER_MS,
  MIN_SCALE,
  MIN_SPEED,
  clamp,
  type EditClip,
  type EditManifest,
  type EditMusic,
  type EditOverlay,
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

export function findClip(manifest: EditManifest, clipId: string): EditClip | null {
  return manifest.clips.find((clip) => clip.id === clipId) ?? null;
}

export function patchClip(manifest: EditManifest, clipId: string, patch: Partial<Omit<EditClip, 'id'>>): EditManifest {
  const current = findClip(manifest, clipId);
  if (!current) return manifest;
  const next = { ...current, ...patch };
  if (sameFields(current, next)) return manifest;
  return {
    ...manifest,
    clips: manifest.clips.map((clip) => (clip.id === clipId ? next : clip)),
  };
}

export function setClipSpeed(manifest: EditManifest, clipId: string, speed: number): EditManifest {
  return patchClip(manifest, clipId, { speed: Math.round(clamp(speed, MIN_SPEED, MAX_SPEED) * 100) / 100 });
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

/** Null for the last segment: a post needs at least one. */
export function removeClip(manifest: EditManifest, clipId: string): EditManifest | null {
  if (manifest.clips.length <= 1 || !findClip(manifest, clipId)) return null;
  return { ...manifest, clips: manifest.clips.filter((clip) => clip.id !== clipId) };
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
