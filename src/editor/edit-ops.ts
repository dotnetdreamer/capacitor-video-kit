import {
  MAX_LAYERS,
  MAX_POST_MS,
  MAX_SCALE,
  MAX_SPEED,
  MAX_VIDEO_TRACKS,
  MIN_CLIP_MS,
  MIN_LAYER_MS,
  MIN_SCALE,
  MIN_SPEED,
  clamp,
  contentDurationMs,
  isFullFrameRect,
  normalisePlacement,
  normaliseRect,
  sameRect,
  totalDurationMs,
  withoutLeadingTransition,
  type EditClip,
  type EditFit,
  type EditManifest,
  type EditMusic,
  type EditOverlay,
  type EditPlacement,
  type EditRect,
  type EditTransition,
  type EditVideoTrack,
  type EditVoiceover,
} from './edit-manifest';
import { normaliseTransition, transitionSpans } from './transitions';

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

/**
 * One clip segment placed on the OUTPUT timeline.
 *
 * The slots of a sequence are a PARTITION of it - every instant belongs to exactly one - even where
 * a transition overlaps two clips. A clip's slot ends where the next clip starts, so the last
 * `tailMs` of the clip is not in its own slot: it plays UNDER the start of the next one, whose
 * first `transitionInMs` is the transition. `slotAt`, `sourceMsAt` and everything built on them
 * keep answering with one clip per instant, which is the clip the playhead, the split and the Edit
 * tool are about.
 */
export interface TimelineSlot {
  clip: EditClip;
  index: number;
  startMs: number;
  /** The slot's own length: the clip's, less the [tailMs] the next clip starts over. */
  durationMs: number;
  /** How long the transition INTO this clip runs from [startMs], 0 for a cut. */
  transitionInMs: number;
  /** How much of this clip plays under the next one's transition, after [durationMs]. 0 for a cut. */
  tailMs: number;
}

export function clipDurationMs(clip: EditClip): number {
  return Math.max(0, clip.outMs - clip.inMs) / (clip.speed || 1);
}

export function timelineSlots(manifest: Pick<EditManifest, 'clips'>): TimelineSlot[] {
  const spans = transitionSpans(manifest.clips);
  let cursor = 0;
  return manifest.clips.map((clip, index) => {
    const tailMs = spans[index + 1]?.ms ?? 0;
    const durationMs = clipDurationMs(clip) - tailMs;
    const slot = { clip, index, startMs: cursor, durationMs, transitionInMs: spans[index].ms, tailMs };
    cursor += durationMs;
    return slot;
  });
}

/** The segment playing at `outputMs`. The very end of the timeline belongs to the last segment. */
export function slotAt(manifest: Pick<EditManifest, 'clips'>, outputMs: number): TimelineSlot | null {
  const slots = timelineSlots(manifest);
  if (!slots.length) return null;
  return slots.find(slot => outputMs < slot.startMs + slot.durationMs) ?? slots[slots.length - 1];
}

/**
 * A transition running at some instant: the two clips on screen at once, and how far through it is.
 * `to` is the clip whose slot the instant is in - the one [slotAt] answers with - and `from` is the
 * outgoing clip, playing the tail its own slot gave up.
 */
export interface TransitionWindow {
  /** Index of the INCOMING clip on the base track. */
  index: number;
  from: EditClip;
  to: EditClip;
  /** Where the window starts on the output timeline: the incoming clip's slot start. */
  startMs: number;
  durationMs: number;
  /** 0..1 through the window. */
  progress: number;
  /** Where in the outgoing clip's SOURCE the instant lands, speed applied. */
  fromSourceMs: number;
  /** Where in the incoming clip's source it lands. */
  toSourceMs: number;
}

/**
 * The transition window `outputMs` is inside, or null at every instant that shows one clip.
 * Takes the slots rather than the manifest because the preview asks on every frame, and the store
 * already holds them.
 */
export function transitionWindowAt(slots: readonly TimelineSlot[], outputMs: number): TransitionWindow | null {
  for (const slot of slots) {
    if (slot.startMs > outputMs) break;
    if (slot.transitionInMs <= 0 || outputMs >= slot.startMs + slot.transitionInMs) continue;
    const from = slots[slot.index - 1]?.clip;
    if (!from) return null;
    const into = Math.max(0, outputMs - slot.startMs);
    return {
      index: slot.index,
      from,
      to: slot.clip,
      startMs: slot.startMs,
      durationMs: slot.transitionInMs,
      progress: Math.min(1, into / slot.transitionInMs),
      fromSourceMs: Math.min(from.outMs, from.outMs - (slot.transitionInMs - into) * (from.speed || 1)),
      toSourceMs: sourceMsAt(slot, outputMs),
    };
  }
  return null;
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
  const base = manifest.clips.find(clip => clip.id === clipId);
  if (base) return base;
  for (const track of manifest.videoTracks) {
    const found = track.clips.find(clip => clip.id === clipId);
    if (found) return found;
  }
  return null;
}

/** Which layer a segment is on: `null` for the base track, otherwise the extra track's id. */
export function trackIdOfClip(manifest: EditManifest, clipId: string): string | null | undefined {
  if (manifest.clips.some(clip => clip.id === clipId)) return null;
  const track = manifest.videoTracks.find(t => t.clips.some(clip => clip.id === clipId));
  return track ? track.id : undefined;
}

export function patchClip(
  manifest: EditManifest,
  clipId: string,
  patch: Partial<Omit<EditClip, 'id' | 'crop' | 'rect' | 'fit' | 'transitionIn'>> & ClipFramingPatch & { transitionIn?: EditTransition | null },
): EditManifest {
  const current = findClip(manifest, clipId);
  if (!current) return manifest;
  const next = withFraming({ ...current, ...patch } as EditClip, patch);
  if ('transitionIn' in patch) {
    if (patch.transitionIn) next.transitionIn = { kind: patch.transitionIn.kind, durationMs: patch.transitionIn.durationMs };
    else delete next.transitionIn;
  }
  if (sameClip(current, next)) return manifest;
  if (manifest.clips.some(clip => clip.id === clipId)) {
    return { ...manifest, clips: manifest.clips.map(clip => (clip.id === clipId ? next : clip)) };
  }
  return {
    ...manifest,
    videoTracks: manifest.videoTracks.map(track =>
      track.clips.some(clip => clip.id === clipId) ? { ...track, clips: track.clips.map(clip => (clip.id === clipId ? next : clip)) } : track,
    ),
  };
}

export function setClipSpeed(manifest: EditManifest, clipId: string, speed: number): EditManifest {
  return patchClip(manifest, clipId, { speed: Math.round(clamp(speed, MIN_SPEED, MAX_SPEED) * 100) / 100 });
}

/** What an absent rectangle already means, spelled out for the one op that has to turn it. */
const WHOLE_FRAME: EditRect = { x: 0, y: 0, w: 1, h: 1 };

/**
 * How a segment is framed, as a patch. `null` is the instruction to go back to the default, and it
 * is a different thing from leaving the key out, which is the instruction to change nothing - the
 * same distinction [patchOverlay] draws, spelled out here because "no crop" is itself a value a
 * customer can ask for.
 */
export interface ClipFramingPatch {
  crop?: EditRect | null;
  rect?: EditPlacement | null;
  fit?: EditFit | null;
}

/** The part of the source that is kept, 0..1 of the oriented frame. `null` is the whole of it. */
export function setClipCrop(manifest: EditManifest, clipId: string, crop: EditRect | null): EditManifest {
  return patchClip(manifest, clipId, { crop });
}

/**
 * Where the segment is drawn on the output frame, 0..1, and at what angle. `null` is the whole
 * frame the right way up, as it always was.
 *
 * Position, size and angle in one call because a free-canvas gesture settles all three at once: a
 * pinch that turns as it moves is one thing the customer did, so it is one op, one undo step, and
 * one comparison against what was there before.
 */
export function setClipRect(manifest: EditManifest, clipId: string, rect: EditPlacement | null): EditManifest {
  return patchClip(manifest, clipId, { rect });
}

/**
 * Turns the segment where it stands, clockwise, about its rectangle's centre - the units and the
 * sense a layer's own `rotationDeg` already has.
 *
 * A segment with no rectangle is turned in the one it is drawn in anyway, the whole frame, because
 * that is the picture the customer has their fingers on. Back at upright the rectangle goes with
 * the angle: an angle is the only reason a whole-frame rectangle is ever worth storing, so a clip
 * turned and put straight again is the unframed clip it was, and it posts without a re-encode as it
 * did before anybody touched it.
 */
export function setClipRotation(manifest: EditManifest, clipId: string, rotationDeg: number): EditManifest {
  const clip = findClip(manifest, clipId);
  if (!clip) return manifest;
  return patchClip(manifest, clipId, { rect: { ...(clip.rect ?? WHOLE_FRAME), rotationDeg } });
}

/** This segment's own fit. `null` hands it back to the whole post's [EditManifest.fit]. */
export function setClipFit(manifest: EditManifest, clipId: string, fit: EditFit | null): EditManifest {
  return patchClip(manifest, clipId, { fit });
}

/**
 * Back to the whole source drawn upright over the whole frame, fitted the way the rest of the post
 * is - the "Reset" a crop tool offers, and precisely the state every manifest written before
 * version 3 is already in. All three fields go together because a rectangle without the fit that
 * was chosen for it is not a state a customer ever asked for, and the angle goes with the rectangle
 * it turns.
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
export function trimClip(manifest: EditManifest, clipId: string, inMs: number, outMs: number, sourceDurationMs: number): EditManifest {
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
  // The left piece keeps the transition that brings the clip in; the new cut between the two
  // pieces is a cut, and the boundary after the right piece is the next clip's to describe.
  const left: EditClip = { ...clip, outMs: cut };
  const right: EditClip = withoutTransition({ ...clip, id: newId, inMs: cut });
  const clips = [...manifest.clips];
  clips.splice(slot.index, 1, left, right);
  return { ...manifest, clips };
}

/** Whether the segment can be joined with the one after it - two halves of an earlier split. */
export function canJoinWithNext(manifest: EditManifest, clipId: string): boolean {
  const index = manifest.clips.findIndex(clip => clip.id === clipId);
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
    // A transition between the halves is a boundary somebody chose to keep and dress. Joining would
    // throw it away without a word, so the halves stay two until it is taken off.
    !b.transitionIn &&
    Math.abs(a.outMs - b.inMs) <= 1
  );
}

export function joinWithNext(manifest: EditManifest, clipId: string): EditManifest | null {
  if (!canJoinWithNext(manifest, clipId)) return null;
  const index = manifest.clips.findIndex(clip => clip.id === clipId);
  const clips = [...manifest.clips];
  const [a, b] = clips.splice(index, 2);
  clips.splice(index, 0, { ...a, outMs: b.outMs });
  return { ...manifest, clips };
}

/**
 * Inserts a copy straight after the segment. The copy starts on a cut: the transition the original
 * came in with is about the boundary before the original, and the new boundary is somewhere else.
 */
export function duplicateClip(manifest: EditManifest, clipId: string, newId: string): EditManifest | null {
  const index = manifest.clips.findIndex(clip => clip.id === clipId);
  if (index < 0) return null;
  const clips = [...manifest.clips];
  clips.splice(index + 1, 0, withoutTransition({ ...clips[index], id: newId }));
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
  if (manifest.clips.some(clip => clip.id === clipId)) {
    if (manifest.clips.length <= 1) return null;
    // The clip after it keeps its transition, now coming in from the clip before the gap - unless it
    // is the first clip now, with nothing to come in from.
    return { ...manifest, clips: withoutLeadingTransition(manifest.clips.filter(clip => clip.id !== clipId)) };
  }
  const owner = manifest.videoTracks.find(track => track.clips.some(clip => clip.id === clipId));
  if (!owner) return null;
  return {
    ...manifest,
    videoTracks: manifest.videoTracks
      .map(track => (track.id === owner.id ? { ...track, clips: track.clips.filter(clip => clip.id !== clipId) } : track))
      .filter(track => track.clips.length > 0),
  };
}

/**
 * A segment carried to another place in the sequence it is already on - the base track's, or an
 * extra layer's. Which layer it is on is read from the clip rather than passed in, because a
 * reorder is a drag that never left its row and the caller counted its indices against that row.
 */
export function moveClip(manifest: EditManifest, clipId: string, toIndex: number): EditManifest {
  const trackId = trackIdOfClip(manifest, clipId);
  if (trackId === undefined) return manifest;
  if (trackId === null) {
    // A transition travels with the clip it brings in, and is lost only by a clip carried to the
    // front, where there is nothing for it to come in from.
    const clips = reordered(manifest.clips, clipId, toIndex);
    return clips === manifest.clips ? manifest : { ...manifest, clips: withoutLeadingTransition(clips) };
  }
  const track = findVideoTrack(manifest, trackId);
  if (!track) return manifest;
  const clips = reordered(track.clips, clipId, toIndex);
  if (clips === track.clips) return manifest;
  return {
    ...manifest,
    videoTracks: manifest.videoTracks.map(t => (t.id === trackId ? { ...t, clips } : t)),
  };
}

/** The same list when the segment is not on it or is already there, so a no-op stays an identity. */
function reordered(clips: EditClip[], clipId: string, toIndex: number): EditClip[] {
  const from = clips.findIndex(clip => clip.id === clipId);
  const to = clamp(Math.round(toIndex), 0, clips.length - 1);
  if (from < 0 || from === to) return clips;
  const next = [...clips];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Points a segment at a different source, keeping its speed and its sound.
 *
 * `keepLength` decides the rest, and it is the host's decision because both answers are defensible
 * (see `EditorEditingOptions.replaceKeepsLength`):
 *
 * TRUE, the default, treats Replace as a SWAP. The segment is a hole of a particular size in the
 * sequence, and the new footage is trimmed to that size, so nothing after it moves. Without this,
 * swapping one shot for a longer take re-cuts everything behind it - which is a surprise in any
 * post whose shape somebody chose on purpose.
 *
 * FALSE takes the whole of the new file, which lengthens the post. That is the right answer where a
 * segment's length was never a decision and holding onto it would only throw footage away.
 *
 * Either way the trim starts at 0: there is no offset into a file nobody has seen worth guessing. A
 * new source SHORTER than the hole gives up what is not there rather than the segment claiming
 * frames the file does not have.
 */
export function replaceClipSource(manifest: EditManifest, clipId: string, clipKey: string, sourceDurationMs: number, keepLength = true): EditManifest {
  const current = keepLength ? findClip(manifest, clipId) : null;
  const wanted = current ? current.outMs - current.inMs : sourceDurationMs;

  return patchClip(manifest, clipId, {
    clipKey,
    inMs: 0,
    outMs: Math.max(MIN_CLIP_MS, Math.round(Math.min(wanted, sourceDurationMs))),
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Transitions                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * The transition into a base clip from the one before it. `null` makes the boundary a cut again.
 *
 * The same manifest back for anything that has no boundary before it - the first base clip, a
 * layer's clip, an id nobody has - and for a transition it already has. What is stored is what was
 * asked for, brought into the catalogue's range; the clips either side decide how much of it runs.
 */
export function setClipTransition(manifest: EditManifest, clipId: string, transition: EditTransition | null): EditManifest {
  const index = manifest.clips.findIndex(clip => clip.id === clipId);
  if (index <= 0) return manifest;
  const next = transition ? normaliseTransition(transition) : null;
  if (transition && !next) return manifest;
  return patchClip(manifest, clipId, { transitionIn: next });
}

/**
 * The same transition on every boundary of the base track, or `null` to make them all cuts. One op,
 * so "Apply to all" is one undo step however many boundaries it dressed.
 */
export function setAllTransitions(manifest: EditManifest, transition: EditTransition | null): EditManifest {
  const next = transition ? normaliseTransition(transition) : null;
  if (transition && !next) return manifest;
  let changed = false;
  const clips = manifest.clips.map((clip, index) => {
    if (index === 0) return clip;
    const patched = next ? { ...clip, transitionIn: { ...next } } : withoutTransition(clip);
    if (sameTransition(clip.transitionIn, patched.transitionIn)) return clip;
    changed = true;
    return patched;
  });
  return changed ? { ...manifest, clips } : manifest;
}

/** The clip with no [EditClip.transitionIn] - the same object when it had none. */
export function withoutTransition(clip: EditClip): EditClip {
  if (!clip.transitionIn) return clip;
  const bare = { ...clip };
  delete bare.transitionIn;
  return bare;
}

function sameTransition(a: EditTransition | undefined, b: EditTransition | undefined): boolean {
  return a === b || (!!a && !!b && a.kind === b.kind && a.durationMs === b.durationMs);
}

/** Appends a new source after `afterClipId` (or at the end). */
export function insertClip(manifest: EditManifest, clip: EditClip, afterClipId: string | null = null): EditManifest {
  const clips = [...manifest.clips];
  const index = afterClipId ? clips.findIndex(c => c.id === afterClipId) : -1;
  clips.splice(index >= 0 ? index + 1 : clips.length, 0, clip);
  return { ...manifest, clips };
}

/**
 * Pulls the end of the post past the base track, or lets it back in.
 *
 * Past the base track's last frame the picture is BLACK, which is the same frame every engine
 * already draws where a layer outlasts what is under it. What the tail is FOR is somewhere to put
 * things: a second video that plays after the first, a title card, a sound that runs on. Without it
 * the timeline is only ever as long as the footage on its bottom row.
 *
 * Never shorter than the base track, and stored as 0 once it is back inside it, so a post nobody has
 * stretched carries no tail at all and its spec is byte for byte the one this package has always
 * produced.
 */
export function setPostDuration(manifest: EditManifest, durationMs: number): EditManifest {
  // Never shorter than the post's own CONTENT, layers included. The end handle stretches a post
  // past what is on it; it does not cut a layer off, which is what trimming that layer is for.
  const content = contentDurationMs(manifest);
  const wanted = clamp(Math.round(durationMs), content, MAX_POST_MS);
  const next = wanted <= content ? 0 : wanted;
  return next === manifest.durationMs ? manifest : { ...manifest, durationMs: next };
}

/**
 * Cuts the post down to `durationMs`, through EVERYTHING on it.
 *
 * [setPostDuration] is the other half of the same grip and it is the gentle one: it moves the end
 * out past the footage and back in again, and it stops dead the moment it reaches the content,
 * because the tail is empty room and taking empty room away costs nobody anything. This is what
 * happens when the customer keeps pulling. The end is already against the last frame, there is no
 * more room to give back, and the only thing left to shorten is the post itself - so every row is
 * cut at the same instant: the base track, every video layer, every piece of text, every sticker
 * and effect, the voiceovers and the music.
 *
 * Destructive on purpose, and undoable for the same reason. The drag is wrapped in one gesture, so
 * the whole cut is one entry on the undo stack however many rows it touched, and a customer who
 * pulled too far gets all of it back with one tap.
 *
 * What each row does at the cut:
 *
 *  - a clip that ENDS before it is kept whole, one that STRADDLES it is shortened to meet it, and
 *    one that starts after it is dropped. Shortening is done in SOURCE time through the clip's own
 *    speed, because a clip at half speed gives up half as much source for the same output;
 *  - a layer whose every clip is gone goes with them, rather than being left as an empty row;
 *  - an overlay that starts after the cut is dropped, and one that runs past it has its end pulled
 *    in. An overlay with `endMs` of 0 already means "to the end of the post" and is left alone -
 *    [overlayEndMs] clamps it on the way out, so it follows the new end for free;
 *  - a voiceover is treated as an overlay with a length: dropped, or shortened to reach the cut;
 *  - music is dropped only if it began after the cut. A bed that started before it still plays,
 *    and every engine already stops it with the picture.
 *
 * `durationMs` is floored at [MIN_CLIP_MS], because a post with nothing left in it is not an edit,
 * and ceilinged at the content, so asking for more than there is falls through to the tail.
 */
export function cutPostTo(manifest: EditManifest, durationMs: number): EditManifest {
  const content = contentDurationMs(manifest);
  const end = clamp(Math.round(durationMs), MIN_CLIP_MS, content);
  // Not a cut at all: the end is still out in the tail, which is [setPostDuration]'s business.
  if (end >= content) return setPostDuration(manifest, durationMs);

  const voiceovers = manifest.voiceovers
    .filter(take => take.startMs < end)
    .map(take => (take.startMs + take.durationMs > end ? { ...take, durationMs: end - take.startMs } : take))
    .filter(take => take.durationMs >= MIN_LAYER_MS);

  return {
    ...manifest,
    // Back inside the content, so the post carries no tail: the same 0 a manifest nobody stretched
    // has, which is what keeps its spec byte for byte the one this package has always produced.
    durationMs: 0,
    clips: cutClipRow(manifest.clips, end, 0),
    videoTracks: manifest.videoTracks.map(track => ({ ...track, clips: cutClipRow(track.clips, end, Math.max(0, track.startMs)) })).filter(track => track.clips.length > 0),
    overlays: manifest.overlays.filter(overlay => overlay.startMs < end).map(overlay => (overlay.endMs > end ? { ...overlay, endMs: end } : overlay)),
    music: manifest.music && manifest.music.startMs < end ? manifest.music : null,
    voiceovers,
  };
}

/**
 * One row of clips cut at `end`, where the row itself begins at `startMs` on the output timeline.
 *
 * `startMs` is what makes this work for a layer as well as for the base track: a layer that begins
 * at ten seconds has its first clip's first frame at ten seconds, so the cut falls that much later
 * into the row. The base track passes 0 and gets the same arithmetic.
 */
function cutClipRow(clips: readonly EditClip[], end: number, startMs: number): EditClip[] {
  const kept: EditClip[] = [];
  // Walked by slot, so a clip that starts under the end of a transition starts where it is seen to.
  // A clip kept whole keeps its tail too: the next clip either survives the cut and needs it, or is
  // dropped, and then the tail is simply the end of the last clip.
  for (const slot of timelineSlots({ clips: clips as EditClip[] })) {
    const clip = slot.clip;
    const cursor = startMs + slot.startMs;
    if (cursor >= end) break;
    const durationMs = clipDurationMs(clip);
    const room = end - cursor;
    if (durationMs <= room) {
      kept.push(clip);
      continue;
    }
    // Straddles the cut. `room` is OUTPUT time and `outMs` is SOURCE time, so the speed is the
    // conversion between them - the same one [clipDurationMs] divides by on the way out.
    const outMs = Math.round(clip.inMs + room * (clip.speed || 1));
    // A sliver too short to be a segment is dropped rather than kept as one nobody can grab.
    if (outMs - clip.inMs >= MIN_CLIP_MS) kept.push({ ...clip, outMs });
    break;
  }
  return kept;
}

/* -------------------------------------------------------------------------------------------- */
/* Video tracks                                                                                   */
/* -------------------------------------------------------------------------------------------- */

export function findVideoTrack(manifest: EditManifest, trackId: string): EditVideoTrack | null {
  return manifest.videoTracks.find(track => track.id === trackId) ?? null;
}

/**
 * Starts another layer of video with one clip on it. Null once [MAX_VIDEO_TRACKS] layers are on the
 * post, the base track counted: refusing is the only honest answer to a cap, because a layer
 * accepted and silently dropped is a customer waiting for a picture that never arrives.
 *
 * The layer arrives UNPLACED, covering the frame like any other clip, and a layout preset or a drag
 * is what puts it somewhere. Placing it here would be this function guessing which arrangement the
 * customer wanted before they had said.
 */
export function addVideoTrack(manifest: EditManifest, clip: EditClip, trackId: string): EditManifest | null {
  if (manifest.videoTracks.length >= MAX_VIDEO_TRACKS - 1) return null;
  const track: EditVideoTrack = {
    id: trackId,
    clips: [clip],
    startMs: 0,
    // One above the highest layer there is, so a new one always arrives on top and no two ever
    // share a place in the drawing order. Counting the layers instead is not enough once a layer
    // from the middle can be taken off: the next one added would land on a `z` still in use.
    z: manifest.videoTracks.reduce((top, existing) => Math.max(top, existing.z), 0) + 1,
    opacity: 1,
  };
  return { ...manifest, videoTracks: [...manifest.videoTracks, track] };
}

/**
 * Where a segment lifted off the timeline is being put down.
 *
 * `index` counts ROWS DOWN THE SCREEN from the base track, which is the gap the customer actually
 * aimed at: 0 is the gap directly under the base track's filmstrip, 1 the gap under the layer below
 * that. It is not a `z` - `z` is a number nobody sees and this op renumbers it on every move - and
 * it is not an index into `videoTracks` either, because the row the segment came off may be emptied
 * by the move and take its gap with it.
 */
export type ClipDropTarget = { kind: 'base' } | { kind: 'track'; trackId: string } | { kind: 'new'; index: number };

/**
 * Carries one segment from the layer it is on to another one, or to a layer of its own opened
 * between two rows. Null when the move cannot be made, which is the answer to four things:
 *
 *  - the last segment of the BASE track, which fixes how long the post runs and may not be emptied;
 *  - a drop back onto the row it came from, which is [moveClip]'s job and not this one's;
 *  - a new layer once [MAX_VIDEO_TRACKS] of them are on the post, the base counted;
 *  - a drop onto a layer whose only segment IS the one being carried.
 *
 * `atMs` is where the segment was let go on the OUTPUT timeline. A new layer keeps it exactly - the
 * layer's own `startMs` is what a track has instead of a per-clip placement - and a drop onto a
 * track that is already there keeps only as much of it as a SEQUENCE can: its segments play one
 * after another with no gaps between them, so the nearest boundary is what the drop lands on.
 *
 * What the segment IS does not change: its trim, speed, sound and framing travel with it, rectangle
 * included. A clip arriving on a new layer with no rectangle covers the frame, exactly as
 * [addVideoTrack] leaves the layer it opens, and a layout preset or the crop tool is what places it.
 * Guessing an arrangement here would be guessing before the customer has said.
 */
export function moveClipToTrack(manifest: EditManifest, clipId: string, target: ClipDropTarget, atMs: number, newTrackId: string): EditManifest | null {
  const found = findClip(manifest, clipId);
  const fromTrackId = trackIdOfClip(manifest, clipId);
  if (!found || fromTrackId === undefined) return null;
  // A layer has no transitions, and a clip landing somewhere new on the base track lands on a cut.
  const clip = withoutTransition(found);
  if (fromTrackId === null && manifest.clips.length <= 1) return null;
  if (target.kind === 'base' && fromTrackId === null) return null;
  if (target.kind === 'track' && target.trackId === fromTrackId) return null;

  const fromRow = manifest.videoTracks.findIndex(track => track.id === fromTrackId);
  // Taken off FIRST, so everything below counts the row this move is about to empty as already
  // gone: the last segment of a layer carried onto a layer of its own is one layer swapped for
  // another, not a seventeenth one, and the gaps under it have all moved up a row.
  const lifted = removeClip(manifest, clipId);
  if (!lifted) return null;
  const emptied = lifted.videoTracks.length < manifest.videoTracks.length;

  if (target.kind === 'base') {
    return { ...lifted, clips: insertAtTime(lifted.clips, clip, 0, atMs) };
  }

  if (target.kind === 'track') {
    const owner = findVideoTrack(lifted, target.trackId);
    if (!owner) return null;
    return {
      ...lifted,
      videoTracks: lifted.videoTracks.map(track => (track.id === owner.id ? { ...track, clips: insertAtTime(track.clips, clip, track.startMs, atMs) } : track)),
    };
  }

  const rows = [...lifted.videoTracks].sort((a, b) => a.z - b.z);
  let index = clamp(Math.round(target.index), 0, manifest.videoTracks.length);
  if (emptied && fromRow >= 0 && index > fromRow) index -= 1;
  index = clamp(index, 0, rows.length);
  // The ONLY segment of a layer, put back in the gap that layer already filled: nothing has been
  // replaced, the layer has been slid along the timeline. It keeps its id, and with it its opacity,
  // the sheet that may be open on it and the selection this drop ends with. The gap above the row
  // and the gap below it are the same gap once the row itself is gone.
  const slid = emptied && fromRow >= 0 && index === fromRow ? findVideoTrack(manifest, fromTrackId as string) : null;
  if (!slid && lifted.videoTracks.length >= MAX_VIDEO_TRACKS - 1) return null;
  rows.splice(index, 0, {
    id: slid?.id ?? newTrackId,
    clips: [clip],
    startMs: Math.max(0, Math.round(atMs)),
    // Written by the restack below, which is the only thing that decides a layer's place in the
    // drawing order once the rows have been rearranged.
    z: 0,
    opacity: slid?.opacity ?? 1,
  });
  return { ...lifted, videoTracks: restack(rows) };
}

/**
 * `clip` put into a sequence at the place `atMs` falls, `startMs` being where that sequence's first
 * segment lands on the output timeline.
 *
 * Past the halfway line of a segment is the gap AFTER it, which is how every list a finger drops
 * something into decides between two places.
 */
function insertAtTime(clips: readonly EditClip[], clip: EditClip, startMs: number, atMs: number): EditClip[] {
  const into = atMs - startMs;
  let index = clips.length;
  // Measured by SLOT, so a transition's overlap counts once rather than twice.
  for (const slot of timelineSlots({ clips: clips as EditClip[] })) {
    if (into < slot.startMs + slot.durationMs / 2) {
      index = slot.index;
      break;
    }
  }
  const next = [...clips];
  next.splice(index, 0, clip);
  return next;
}

/**
 * The layers numbered 1 upwards in the order they are now in, the base track being 0 and nothing
 * sorting below it.
 *
 * `z` is the drawing order all four engines read, and the timeline draws its rows in the same
 * order: a row moved without its number moving with it is a timeline saying one picture is over
 * another while the frame says the opposite. Renumbering rather than leaving gaps also keeps
 * [addVideoTrack]'s "one above the highest" arriving on top of everything.
 */
function restack(tracks: readonly EditVideoTrack[]): EditVideoTrack[] {
  return tracks.map((track, i) => (track.z === i + 1 ? track : { ...track, z: i + 1 }));
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
  return { ...manifest, videoTracks: manifest.videoTracks.filter(track => track.id !== trackId) };
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
 * Puts a layer under the base, or back over it - the one control over the drawing order a customer
 * gets between the base track and a layer sitting on it.
 *
 * Done by moving the CLIPS between the two layers rather than by a `z` of its own, with `z` itself
 * left saying what the native parsers are allowed to assume, that the base track is 0 and nothing is
 * ever below it. The alternative is a layer at `z` -1, and then four engines have to agree about a
 * layer beneath the bottom one for a feature that is two rectangles.
 *
 * Each layer keeps its own rectangle and the PICTURES exchange them, which is what a customer means
 * by Swap: the video that was the inset is the big one underneath, and the one that filled the frame
 * is the inset over it. Carrying each rectangle along with its clips instead is a swap of `z` that
 * is right on paper and invisible or ruinous on the frame, because the arrangement swaps with the
 * pictures and lands back where it started: two halves of a split screen come out exactly where they
 * already were, and a corner inset goes UNDER a layer covering the whole frame, which is a customer
 * tapping Swap and watching one of their two videos disappear.
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
    clips: drawnIn(track.clips, manifest.clips[0].rect),
    // The base clips going up to the layer leave their transitions behind: a layer has none.
    videoTracks: manifest.videoTracks.map(t => (t.id === trackId ? { ...t, clips: drawnIn(manifest.clips, track.clips[0]?.rect).map(withoutTransition) } : t)),
  };
}

/**
 * These clips drawn where the layer they are moving to is drawn.
 *
 * A layer's rectangle is its first clip's, which is the same answer the layout row reads to decide
 * which arrangement is lit: a preset is written onto every clip of a layer at once, so they agree
 * unless one of them has been framed by hand, and then the first one is what the layer is on.
 * Absence is carried through as absence rather than as a whole-frame rectangle, because that is the
 * difference between a post that renders the way a post with one layer always has and one that
 * carries the framing maths on every frame.
 */
function drawnIn(clips: readonly EditClip[], rect: EditClip['rect']): EditClip[] {
  return clips.map(clip => {
    if (rect) return { ...clip, rect };
    if (!clip.rect) return clip;
    const moved = { ...clip };
    delete moved.rect;
    return moved;
  });
}

function patchTrack(manifest: EditManifest, trackId: string, patch: Partial<Omit<EditVideoTrack, 'id' | 'clips'>>): EditManifest {
  const current = findVideoTrack(manifest, trackId);
  if (!current) return manifest;
  const next = { ...current, ...patch };
  if (sameFields(current, next)) return manifest;
  return {
    ...manifest,
    videoTracks: manifest.videoTracks.map(track => (track.id === trackId ? next : track)),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Layers                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export function findOverlay(manifest: EditManifest, id: string): EditOverlay | null {
  return manifest.overlays.find(overlay => overlay.id === id) ?? null;
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

export function patchOverlay(manifest: EditManifest, id: string, patch: Partial<Omit<EditOverlay, 'id' | 'kind'>> & Record<string, unknown>): EditManifest {
  const current = findOverlay(manifest, id);
  if (!current) return manifest;
  const next = normaliseLayer({ ...current, ...patch } as EditOverlay);
  if (sameFields(current, next)) return manifest;
  return {
    ...manifest,
    overlays: manifest.overlays.map(overlay => (overlay.id === id ? next : overlay)),
  };
}

export function removeOverlay(manifest: EditManifest, id: string): EditManifest {
  if (!findOverlay(manifest, id)) return manifest;
  return { ...manifest, overlays: manifest.overlays.filter(overlay => overlay.id !== id) };
}

/** A copy directly above the original, nudged so the two are not exactly on top of each other. */
export function duplicateOverlay(manifest: EditManifest, id: string, newId: string): EditManifest | null {
  const index = manifest.overlays.findIndex(overlay => overlay.id === id);
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
  const from = manifest.overlays.findIndex(overlay => overlay.id === id);
  if (from < 0) return manifest;
  const last = manifest.overlays.length - 1;
  const to = move === 'forward' ? Math.min(last, from + 1) : move === 'backward' ? Math.max(0, from - 1) : move === 'front' ? last : 0;
  if (to === from) return manifest;
  const overlays = [...manifest.overlays];
  const [moved] = overlays.splice(from, 1);
  overlays.splice(to, 0, moved);
  return { ...manifest, overlays };
}

/** Puts a layer at an exact position in the drawing order, 0 being the bottom. */
export function moveLayerTo(manifest: EditManifest, id: string, toIndex: number): EditManifest {
  const from = manifest.overlays.findIndex(overlay => overlay.id === id);
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
export function setOverlayWindow(manifest: EditManifest, id: string, startMs: number, endMs: number, totalMs: number): EditManifest {
  const overlay = findOverlay(manifest, id);
  if (!overlay) return manifest;
  const [start, end] = clampWindow(startMs, endMs, totalMs, overlay.startMs, overlayEndMs(overlay, totalMs));
  return patchOverlay(manifest, id, { startMs: start, endMs: end >= totalMs - 1 ? 0 : end });
}

/** Cuts a layer in two at `atMs`; the right half gets `newId` and sits directly above the left. */
export function splitOverlayAt(manifest: EditManifest, id: string, atMs: number, newId: string, totalMs: number): EditManifest | null {
  const index = manifest.overlays.findIndex(overlay => overlay.id === id);
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
  return manifest.voiceovers.find(take => take.id === id) ?? null;
}

/**
 * How long a take starting at `startMs` may run before it would reach the next take or the end of
 * the video. 0 when `startMs` is inside an existing take.
 */
export function voiceRoomAt(manifest: EditManifest, startMs: number, totalMs: number, ignoreId?: string): number {
  const takes = manifest.voiceovers.filter(take => take.id !== ignoreId);
  if (takes.some(take => startMs >= take.startMs && startMs < take.startMs + take.durationMs)) return 0;
  const next = takes.filter(take => take.startMs >= startMs).sort((a, b) => a.startMs - b.startMs)[0];
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
    voiceovers: manifest.voiceovers.map(take => (take.id === id ? next : take)),
  };
}

/** Moves a take along the timeline, stopping at its neighbours and the ends of the video. */
export function moveVoiceover(manifest: EditManifest, id: string, startMs: number, totalMs: number): EditManifest {
  const take = findVoiceover(manifest, id);
  if (!take) return manifest;
  const others = manifest.voiceovers.filter(t => t.id !== id);
  const before = others.filter(t => t.startMs + t.durationMs <= take.startMs).sort((a, b) => b.startMs - a.startMs)[0];
  const after = others.filter(t => t.startMs >= take.startMs + take.durationMs).sort((a, b) => a.startMs - b.startMs)[0];
  const min = before ? before.startMs + before.durationMs : 0;
  const max = Math.max(min, (after ? after.startMs : Math.max(totalMs, take.startMs + take.durationMs)) - take.durationMs);
  const next = Math.round(clamp(startMs, min, max));
  if (next === take.startMs) return manifest;
  return {
    ...manifest,
    voiceovers: manifest.voiceovers.map(t => (t.id === id ? { ...t, startMs: next } : t)).sort((a, b) => a.startMs - b.startMs),
  };
}

export function removeVoiceover(manifest: EditManifest, id: string): EditManifest {
  if (!findVoiceover(manifest, id)) return manifest;
  return { ...manifest, voiceovers: manifest.voiceovers.filter(take => take.id !== id) };
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
  if ('crop' in patch) {
    const crop = worthKeeping(patch.crop ? normaliseRect(patch.crop) : undefined);
    if (crop) next.crop = crop;
    else delete next.crop;
  }
  if ('rect' in patch) {
    // Read as a placement, so a gesture that turned the clip as it moved it keeps its angle. The
    // crop above is read as a plain rectangle for the reason [EditClip.rect] gives: turning what is
    // sampled out of the source is a different operation that no engine performs.
    const rect = worthKeeping(patch.rect ? normalisePlacement(patch.rect) : undefined);
    if (rect) next.rect = rect;
    else delete next.rect;
  }
  if ('fit' in patch) {
    if (patch.fit) next.fit = patch.fit;
    else delete next.fit;
  }
  return next;
}

/**
 * A rectangle worth storing, or `undefined` for one that says nothing. A crop of the whole frame is
 * no crop, and an upright rectangle over the whole frame is no placement. Storing either would cost
 * the render its fast path and would make [isUntouched] send a clip nobody changed through a
 * re-encode.
 */
function worthKeeping<T extends EditRect>(rect: T | undefined): T | undefined {
  return rect && !isFullFrameRect(rect) ? rect : undefined;
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
    sameRect(a.rect, b.rect) &&
    sameTransition(a.transitionIn, b.transitionIn)
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

function clampWindow(startMs: number, endMs: number, totalMs: number, prevStart: number, prevEnd: number): [number, number] {
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
