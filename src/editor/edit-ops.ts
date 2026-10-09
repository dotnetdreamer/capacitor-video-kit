import { MAX_AUDIO_EFFECTS } from '../video-composer/definitions';

import {
  MAX_LAYERS,
  MAX_POST_MS,
  MAX_SCALE,
  MAX_SPEED,
  MAX_VIDEO_TRACKS,
  MAX_ZOOMS,
  MIN_CLIP_MS,
  MIN_ZOOM_MS,
  MIN_LAYER_MS,
  MIN_SCALE,
  MIN_SPEED,
  PICTURE_CLIP_MS,
  clamp,
  contentDurationMs,
  defaultPictureEdit,
  isFullFrameRect,
  normaliseAudioEffect,
  normaliseBackground,
  normalisePlacement,
  normaliseSpeed,
  normaliseZoom,
  normaliseRect,
  sameRect,
  totalDurationMs,
  withoutLeadingTransition,
  type EditAudioEffect,
  type EditClip,
  type EditAudioClip,
  type EditAudioTrack,
  type EditFit,
  type EditManifest,
  type EditMusic,
  type EditOverlay,
  type EditPlacement,
  type EditRect,
  type EditTransition,
  type EditVideoTrack,
  type EditVoiceover,
  type EditZoom,
  type LayoutAnimation,
} from './edit-manifest';
import { normaliseLayoutAnimation, sameLayoutAnimation } from './layout-animation';
import { normaliseOverlayAnimation, sameOverlayAnimation } from './motion';
import { sameSoundEffectSettings } from './sound-effects';
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
  patch: Partial<Omit<EditClip, 'id' | 'crop' | 'rect' | 'fit' | 'transitionIn' | 'image'>> & ClipFramingPatch & { transitionIn?: EditTransition | null; image?: true | null },
): EditManifest {
  const current = findClip(manifest, clipId);
  if (!current) return manifest;
  const next = withFraming({ ...current, ...patch } as EditClip, patch);
  if ('transitionIn' in patch) {
    if (patch.transitionIn) next.transitionIn = { kind: patch.transitionIn.kind, durationMs: patch.transitionIn.durationMs };
    else delete next.transitionIn;
  }
  // The key goes rather than being left as `null`: a video segment carries no `image` at all.
  if ('image' in patch && !patch.image) delete next.image;
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

/** A picture keeps 1x: a still sped up is only a shorter still, which is what trimming it is for. */
export function setClipSpeed(manifest: EditManifest, clipId: string, speed: number): EditManifest {
  if (findClip(manifest, clipId)?.image) return manifest;
  return patchClip(manifest, clipId, { speed: normaliseSpeed(speed) });
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
 *
 * `picture` says the new source is a still. It lands as a picture segment (see
 * [EditClip.image]): the length it plays for on the OUTPUT timeline is kept when `keepLength` is,
 * because a picture has no speed to hold that length in source time, and is [PICTURE_CLIP_MS]
 * otherwise, because a still has no whole length to take. A video replacing a picture takes the
 * picture's length the same way it takes any segment's, and stops being one.
 */
export function replaceClipSource(manifest: EditManifest, clipId: string, clipKey: string, sourceDurationMs: number, keepLength = true, picture = false): EditManifest {
  if (picture) {
    const found = findClip(manifest, clipId);
    if (!found) return manifest;
    const window = defaultPictureEdit(clipKey, clipId, keepLength ? clipDurationMs(found) : PICTURE_CLIP_MS);
    return patchClip(manifest, clipId, { clipKey, inMs: window.inMs, outMs: window.outMs, speed: 1, image: true });
  }

  const current = keepLength ? findClip(manifest, clipId) : null;
  const wanted = current ? current.outMs - current.inMs : sourceDurationMs;

  return patchClip(manifest, clipId, {
    clipKey,
    inMs: 0,
    outMs: Math.max(MIN_CLIP_MS, Math.round(Math.min(wanted, sourceDurationMs))),
    image: null,
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
 *    and every engine already stops it with the picture;
 *  - a zoom is treated like a voiceover: dropped, or shortened to reach the cut and dropped if that
 *    leaves less than [MIN_ZOOM_MS]. Its ramps are squeezed when it is read, so a shortened zoom
 *    still eases back out before the new end. Left in place, a zoom past the cut would come back
 *    into the black tail the next time the end was pulled out.
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
    ...(manifest.audioTracks
      ? {
          audioTracks: manifest.audioTracks.map(track => ({ ...track, clips: track.clips.filter(clip => clip.startMs < end) })).filter(track => track.clips.length > 0),
        }
      : {}),
    voiceovers,
    zooms: cutZooms(manifest.zooms, end),
    ...(manifest.audioEffects ? { audioEffects: cutAudioEffects(manifest.audioEffects, end) } : {}),
  };
}

/** The audio effect layers cut at `end`: one starting after it goes, one running past it ends there. */
function cutAudioEffects(layers: EditAudioEffect[], end: number): EditAudioEffect[] {
  const cut = layers.filter(layer => end - layer.startMs >= MIN_LAYER_MS).map(layer => (layer.endMs > end ? { ...layer, endMs: end } : layer));
  return cut.length === layers.length && cut.every((layer, i) => layer === layers[i]) ? layers : cut;
}

function cutZooms(zooms: EditZoom[], end: number): EditZoom[] {
  // Only a zoom the cut SHORTENED is held to [MIN_ZOOM_MS]. A template's punch is shorter than that
  // to begin with, and a cut that never reached it has no business taking it away.
  const cut = zooms
    .filter(zoom => zoom.startMs < end)
    .filter(zoom => zoom.endMs <= end || end - zoom.startMs >= MIN_ZOOM_MS)
    .map(zoom => (zoom.endMs > end ? { ...zoom, endMs: end } : zoom));
  // The same array when the cut missed every zoom, so a caller comparing by identity sees no change.
  return cut.length === zooms.length && cut.every((zoom, i) => zoom === zooms[i]) ? zooms : cut;
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
 * The canvas colour, `#rrggbb`: what shows wherever no video picture is drawn. Black - or anything that
 * is not a colour - takes the key off, so a post coloured and put back to black is the post it was,
 * down to its keys, and its spec is the one it always was.
 */
export function setBackground(manifest: EditManifest, colour: string | null): EditManifest {
  const next = normaliseBackground(colour);
  if (next === manifest.background) return manifest;
  const updated: EditManifest = { ...manifest };
  if (next) updated.background = next;
  else delete updated.background;
  return updated;
}

/**
 * How the layer's arrangement opens as it comes on screen and closes as it goes, or `null` for one
 * that holds still all the way through - the arrangement every layer had before arrangements moved.
 *
 * Normalised on the way in, so an id this version does not know is no animation and a length outside
 * the range is held to it. `null` takes the key off rather than leaving it undefined: a layer that
 * holds still is one with no key, which is what keeps its clips on the wire byte for byte as they were.
 */
export function setTrackLayoutAnimation(manifest: EditManifest, trackId: string, animation: LayoutAnimation | null): EditManifest {
  const current = findVideoTrack(manifest, trackId);
  if (!current) return manifest;
  const next = normaliseLayoutAnimation(animation);
  if (sameLayoutAnimation(current.layoutAnimation, next)) return manifest;
  const track: EditVideoTrack = { ...current };
  if (next) track.layoutAnimation = next;
  else delete track.layoutAnimation;
  return { ...manifest, videoTracks: manifest.videoTracks.map(one => (one.id === trackId ? track : one)) };
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
  // The same moves handed in again as a new object - a sheet re-picking the preset it is showing -
  // are the same animation, and so no change and no undo step.
  if (next.animation && current.animation && sameOverlayAnimation(next.animation, current.animation)) next.animation = current.animation;
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

/**
 * Cuts a layer in two at `atMs`; the right half gets `newId` and sits directly above the left.
 *
 * A layer's animation is shared out the way a cut shares out a clip's transitions: the left half
 * keeps how the layer ARRIVES and the right half how it LEAVES, and both keep its loop. Anything else
 * would be a layer that pops in twice or fades out in the middle of the screen at the cut, where the
 * customer asked for nothing but a place to change it.
 */
export function splitOverlayAt(manifest: EditManifest, id: string, atMs: number, newId: string, totalMs: number): EditManifest | null {
  const index = manifest.overlays.findIndex(overlay => overlay.id === id);
  if (index < 0 || manifest.overlays.length >= MAX_LAYERS) return null;
  const overlay = manifest.overlays[index];
  const end = overlayEndMs(overlay, totalMs);
  const cut = Math.round(atMs);
  if (cut - overlay.startMs < MIN_LAYER_MS || end - cut < MIN_LAYER_MS) return null;
  const overlays = [...manifest.overlays];
  overlays.splice(index, 1, withoutMove({ ...overlay, endMs: cut }, 'out'), withoutMove({ ...overlay, id: newId, startMs: cut }, 'in'));
  return { ...manifest, overlays };
}

/** A layer with one of its animation's moves taken off, and the key itself when nothing is left. */
function withoutMove<T extends EditOverlay>(overlay: T, move: 'in' | 'out'): T {
  if (!overlay.animation?.[move]) return overlay;
  const rest = { ...overlay.animation };
  delete rest[move];
  const copy: T = { ...overlay, animation: rest };
  if (!rest.in && !rest.out && !rest.loop) delete copy.animation;
  return copy;
}

function normaliseLayer<T extends EditOverlay>(overlay: T): T {
  const layer: T = {
    ...overlay,
    cx: clamp(overlay.cx, 0, 1),
    cy: clamp(overlay.cy, 0, 1),
    scale: clamp(overlay.scale, MIN_SCALE, MAX_SCALE),
    opacity: clamp(overlay.opacity, 0, 1),
    startMs: Math.max(0, Math.round(overlay.startMs)),
    endMs: Math.max(0, Math.round(overlay.endMs)),
  };
  // Held to what the manifest reader would make of it, and the KEY taken off when nothing is left -
  // a patch of `animation: undefined` or `null` is how a sheet takes a layer's moves away, and an
  // `undefined` left under the key would survive a structured clone and read as present to `in`. An
  // animation already in shape comes back as the very object, so a patch that did not touch it is
  // still no change at all.
  const animation = normaliseOverlayAnimation(overlay.animation);
  if (animation) layer.animation = animation;
  else delete layer.animation;
  return layer;
}

/* -------------------------------------------------------------------------------------------- */
/* Zooms                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/*
 * Zooms are one lane with one camera, so these keep the list the way [EditManifest.zooms] promises
 * it - sorted, never overlapping - rather than leaving that to a normalise on the way back in. A
 * window that could overlap would make the camera two functions of time, and the preview and three
 * engines could each pick a different one.
 *
 * They sit on the OUTPUT timeline, like overlays: no clip or track op moves them, and only
 * [cutPostTo] cuts them.
 */

export function findZoom(manifest: EditManifest, id: string): EditZoom | null {
  return manifest.zooms.find(zoom => zoom.id === id) ?? null;
}

/** The zoom whose window holds `outputMs` - there is at most one. */
export function zoomAt(manifest: EditManifest, outputMs: number): EditZoom | null {
  return manifest.zooms.find(zoom => outputMs >= zoom.startMs && outputMs < zoom.endMs) ?? null;
}

/**
 * How long a zoom starting at `startMs` may run before it would reach the next zoom or the end of the
 * post. 0 when `startMs` is inside a zoom. The [voiceRoomAt] rule, for the same one-lane reason.
 */
export function zoomRoomAt(manifest: EditManifest, startMs: number, totalMs: number, ignoreId?: string): number {
  const zooms = manifest.zooms.filter(zoom => zoom.id !== ignoreId);
  if (zooms.some(zoom => startMs >= zoom.startMs && startMs < zoom.endMs)) return 0;
  const next = zooms.filter(zoom => zoom.startMs >= startMs).sort((a, b) => a.startMs - b.startMs)[0];
  return Math.max(0, Math.min(next ? next.startMs : totalMs, totalMs) - startMs);
}

/**
 * Adds a zoom, SHORTENED to the room it has before the next zoom and the end of the post - a zoom
 * dropped just before another is still the zoom the customer meant, only shorter. Null at
 * [MAX_ZOOMS], for an id already in use, and when less than [MIN_ZOOM_MS] fits.
 */
export function addZoom(manifest: EditManifest, zoom: EditZoom, totalMs: number): EditManifest | null {
  if (manifest.zooms.length >= MAX_ZOOMS || findZoom(manifest, zoom.id)) return null;
  const startMs = Math.max(0, Math.round(zoom.startMs));
  const room = zoomRoomAt(manifest, startMs, totalMs);
  if (room < MIN_ZOOM_MS) return null;
  const length = clamp(Math.round(zoom.endMs - zoom.startMs), MIN_ZOOM_MS, room);
  const placed = normaliseZoom({ ...zoom, startMs, endMs: startMs + length });
  return { ...manifest, zooms: sortedZooms([...manifest.zooms, placed]) };
}

/** The parts of a zoom that are not its window. Timing has one owner, [setZoomWindow], which keeps the lane apart. */
export type ZoomPatch = Partial<Pick<EditZoom, 'cx' | 'cy' | 'scale' | 'rampMs' | 'rampOutMs' | 'ease' | 'chain'>>;

/**
 * Changes a zoom's area, level, ramps, ease or chaining, held to what the editor offers
 * ([normaliseZoom]). The same manifest when nothing changed, so a slider let go where it started
 * records no undo step.
 */
export function updateZoom(manifest: EditManifest, id: string, patch: ZoomPatch): EditManifest {
  const current = findZoom(manifest, id);
  if (!current) return manifest;
  const picked: ZoomPatch = {};
  if (patch.cx !== undefined) picked.cx = patch.cx;
  if (patch.cy !== undefined) picked.cy = patch.cy;
  if (patch.scale !== undefined) picked.scale = patch.scale;
  if (patch.rampMs !== undefined) picked.rampMs = patch.rampMs;
  if (patch.rampOutMs !== undefined) picked.rampOutMs = patch.rampOutMs;
  if (patch.ease !== undefined) picked.ease = patch.ease;
  if (patch.chain !== undefined) picked.chain = patch.chain;
  const next = normaliseZoom({ ...current, ...picked });
  if (sameFields(current, next)) return manifest;
  return { ...manifest, zooms: manifest.zooms.map(zoom => (zoom.id === id ? next : zoom)) };
}

/**
 * The one ramp the zoom sheet shows: the longer of the two. For a zoom the editor made that is simply
 * its ramp; for a template's push-in it is the push, where the move out it does not make would read 0.
 */
export function zoomRampMs(zoom: Pick<EditZoom, 'rampMs' | 'rampOutMs'>): number {
  return Math.max(zoom.rampMs, zoom.rampOutMs ?? zoom.rampMs);
}

/**
 * What setting that one ramp to `ms` writes, given the ramps the zoom had when the gesture began.
 *
 * A zoom with one ramp gets `rampMs` alone, as it always has. A zoom with two is scaled whole, so the
 * longer ramp becomes `ms` and the other keeps its share: a push-in dragged shorter is a quicker
 * push-in that still holds to the cut, and a pull-out a quicker pull-out. Writing `rampMs` alone would
 * move a ramp the sheet is not showing - on a pull-out the slider would stay put under the finger
 * while a move in nobody asked for appeared. Two ramps of 0 have no shape to keep, and both take `ms`.
 *
 * `from` is the zoom as it was when the drag STARTED, not as the last frame of it wrote it: a drag
 * through 0 and back would otherwise lose the shape at the bottom and come back symmetric.
 */
export function zoomRampPatch(from: Pick<EditZoom, 'rampMs' | 'rampOutMs'>, ms: number): ZoomPatch {
  const target = Math.max(0, Math.round(ms));
  if (from.rampOutMs === undefined) return { rampMs: target };
  const longest = zoomRampMs(from);
  if (!(longest > 0)) return { rampMs: target, rampOutMs: target };
  return { rampMs: Math.round((target * from.rampMs) / longest), rampOutMs: Math.round((target * from.rampOutMs) / longest) };
}

/**
 * Sets when a zoom runs, keeping it at least [MIN_ZOOM_MS] long and between its neighbours and the
 * end of the post. The neighbours are found from where the zoom IS, not where it is being dragged,
 * so a drag stops at the next zoom instead of jumping over it (the [moveVoiceover] rule). A whole
 * window dragged keeps its length. No room at all is the same manifest.
 */
export function setZoomWindow(manifest: EditManifest, id: string, startMs: number, endMs: number, totalMs: number): EditManifest {
  const zoom = findZoom(manifest, id);
  if (!zoom) return manifest;
  const others = manifest.zooms.filter(other => other.id !== id);
  const before = others.filter(other => other.endMs <= zoom.startMs).sort((a, b) => b.endMs - a.endMs)[0];
  const after = others.filter(other => other.startMs >= zoom.endMs).sort((a, b) => a.startMs - b.startMs)[0];
  const lo = before ? before.endMs : 0;
  const hi = after ? after.startMs : Math.max(totalMs, lo);
  if (hi - lo < MIN_ZOOM_MS) return manifest;
  const [start, end] = clampSpan(startMs, endMs, lo, hi, zoom.startMs, zoom.endMs, MIN_ZOOM_MS);
  if (start === zoom.startMs && end === zoom.endMs) return manifest;
  return { ...manifest, zooms: sortedZooms(manifest.zooms.map(other => (other.id === id ? { ...zoom, startMs: start, endMs: end } : other))) };
}

/**
 * A copy placed straight after the original, as long as the original where there is room and
 * shortened where there is less. The two touch, so the camera holds the area across both rather than
 * zooming out and back in - unless the original is kept apart ([EditZoom.chain]), which the copy is
 * too. Null when less than [MIN_ZOOM_MS] fits there, or at [MAX_ZOOMS].
 */
export function duplicateZoom(manifest: EditManifest, id: string, newId: string, totalMs: number): EditManifest | null {
  const zoom = findZoom(manifest, id);
  if (!zoom) return null;
  return addZoom(manifest, { ...zoom, id: newId, startMs: zoom.endMs, endMs: zoom.endMs + (zoom.endMs - zoom.startMs) }, totalMs);
}

export function deleteZoom(manifest: EditManifest, id: string): EditManifest {
  if (!findZoom(manifest, id)) return manifest;
  return { ...manifest, zooms: manifest.zooms.filter(zoom => zoom.id !== id) };
}

function sortedZooms(zooms: EditZoom[]): EditZoom[] {
  return [...zooms].sort((a, b) => a.startMs - b.startMs);
}

/*
 * Audio effect layers stack as the picture's layers do: [EditManifest.audioEffects] runs bottom to top,
 * and where two cover the same moment the upper one works on what the lower one made - a megaphone
 * over slow + reverb puts the slowed room through the megaphone. Any number may cover a moment, the
 * same effect again included, and each moves on its own: nothing here keeps them apart, and the order
 * is changed only on purpose ([moveAudioEffect]). They sit on the OUTPUT timeline, like the zooms: no
 * clip or sound op moves them, and only [cutPostTo] cuts them.
 */

export function findAudioEffect(manifest: EditManifest, id: string): EditAudioEffect | null {
  return manifest.audioEffects?.find(layer => layer.id === id) ?? null;
}

/**
 * Adds a layer on top of the others, wherever they are, cut at the end of the post and never under
 * [MIN_LAYER_MS]. Null at [MAX_AUDIO_EFFECTS], for an id already in use, for an effect this version
 * does not know, and for a start too near the end of the post for [MIN_LAYER_MS] to fit.
 */
export function addAudioEffect(manifest: EditManifest, layer: EditAudioEffect, totalMs: number): EditManifest | null {
  const layers = manifest.audioEffects ?? [];
  if (layers.length >= MAX_AUDIO_EFFECTS || findAudioEffect(manifest, layer.id)) return null;
  const placed = placedAudioEffect(layer, Math.round(layer.startMs), Math.round(layer.endMs), totalMs);
  return placed ? { ...manifest, audioEffects: [...layers, placed] } : null;
}

/**
 * `layer` from `startMs` to `endMs`, held to the post: never before 0, cut at its end, and at least
 * [MIN_LAYER_MS] long. Null where the post has no [MIN_LAYER_MS] left after `startMs`, or for an
 * effect [normaliseAudioEffect] does not keep.
 */
function placedAudioEffect(layer: EditAudioEffect, startMs: number, endMs: number, totalMs: number): EditAudioEffect | null {
  const start = Math.max(0, startMs);
  if (totalMs - start < MIN_LAYER_MS) return null;
  return normaliseAudioEffect({ ...layer, startMs: start, endMs: clamp(endMs, start + MIN_LAYER_MS, totalMs) }, layer.id);
}

/** What a layer is, apart from where it is: [setAudioEffectWindow] owns the timing. */
export type AudioEffectPatch = Partial<Pick<EditAudioEffect, 'effect' | 'effectSettings' | 'speed'>>;

/**
 * Changes a layer's effect, its sliders or its Slow, held to what each effect offers
 * ([normaliseAudioEffect]). Another effect comes on at its defaults - sliders and Slow alike - unless
 * the patch says otherwise, as a filter does: one effect's room size means nothing to another. The
 * same manifest when nothing changed (an id this version does not know, a value where it already is),
 * so a slider let go where it started records no undo step.
 */
export function updateAudioEffect(manifest: EditManifest, id: string, patch: AudioEffectPatch): EditManifest {
  const current = findAudioEffect(manifest, id);
  if (!current) return manifest;
  const effect = patch.effect ?? current.effect;
  const another = effect !== current.effect;
  const next = normaliseAudioEffect(
    {
      ...current,
      effect,
      effectSettings: patch.effectSettings ?? (another ? undefined : current.effectSettings),
      speed: patch.speed ?? (another ? undefined : current.speed),
    },
    id,
  );
  if (!next || sameAudioEffect(current, next)) return manifest;
  return { ...manifest, audioEffects: manifest.audioEffects!.map(layer => (layer.id === id ? next : layer)) };
}

/** One of a layer's sliders moved to `value` on its 0..100 scale. The same edit back for a slider its effect has not got. */
export function setAudioEffectSetting(manifest: EditManifest, id: string, key: string, value: number): EditManifest {
  const layer = findAudioEffect(manifest, id);
  return layer ? updateAudioEffect(manifest, id, { effectSettings: { ...layer.effectSettings, [key]: value } }) : manifest;
}

/**
 * Sets when a layer runs, held to the post and at least [MIN_LAYER_MS] long, whatever else covers that
 * time: [setZoomWindow]'s rules with the whole post for room, a window dragged whole keeping its length.
 * Its place in the stack stays where it is.
 */
export function setAudioEffectWindow(manifest: EditManifest, id: string, startMs: number, endMs: number, totalMs: number): EditManifest {
  const layer = findAudioEffect(manifest, id);
  if (!layer || totalMs < MIN_LAYER_MS) return manifest;
  const [start, end] = clampSpan(startMs, endMs, 0, totalMs, layer.startMs, layer.endMs, MIN_LAYER_MS);
  if (start === layer.startMs && end === layer.endMs) return manifest;
  return { ...manifest, audioEffects: manifest.audioEffects!.map(other => (other.id === id ? { ...layer, startMs: start, endMs: end } : other)) };
}

/**
 * A copy straight after the original in time, as long as it and cut at the end of the post, one place
 * above it in the stack as a picture layer's copy is ([duplicateOverlay]). Null when less than
 * [MIN_LAYER_MS] of the post is left after the original, at the cap, or for an id already in use.
 */
export function duplicateAudioEffect(manifest: EditManifest, id: string, newId: string, totalMs: number): EditManifest | null {
  const layers = manifest.audioEffects ?? [];
  const index = layers.findIndex(layer => layer.id === id);
  if (index < 0 || layers.length >= MAX_AUDIO_EFFECTS || findAudioEffect(manifest, newId)) return null;
  const layer = layers[index]!;
  const copy = placedAudioEffect({ ...layer, id: newId }, layer.endMs, layer.endMs + (layer.endMs - layer.startMs), totalMs);
  if (!copy) return null;
  const audioEffects = [...layers];
  audioEffects.splice(index + 1, 0, copy);
  return { ...manifest, audioEffects };
}

/**
 * A layer cut in two at `atMs`, the second half `newId`, both the effect the layer was - so one half
 * can be given another - and both where the layer was in the stack, the second just above the first,
 * as a picture layer's halves are ([splitOverlayAt]). Null when either half would be under
 * [MIN_LAYER_MS], at the cap, or for an id already in use.
 */
export function splitAudioEffect(manifest: EditManifest, id: string, atMs: number, newId: string): EditManifest | null {
  const layers = manifest.audioEffects ?? [];
  const index = layers.findIndex(layer => layer.id === id);
  if (index < 0 || layers.length >= MAX_AUDIO_EFFECTS || findAudioEffect(manifest, newId)) return null;
  const layer = layers[index]!;
  const cut = Math.round(atMs);
  if (cut - layer.startMs < MIN_LAYER_MS || layer.endMs - cut < MIN_LAYER_MS) return null;
  const audioEffects = [...layers];
  audioEffects.splice(index, 1, { ...layer, endMs: cut }, { ...layer, id: newId, startMs: cut });
  return { ...manifest, audioEffects };
}

/**
 * Changes where a layer is in the stack, as [moveLayer] changes a picture layer's: `front` is the top,
 * which works on what every layer under it made. The same manifest when it is already there.
 */
export function moveAudioEffect(manifest: EditManifest, id: string, move: LayerMove): EditManifest {
  const layers = manifest.audioEffects ?? [];
  const from = layers.findIndex(layer => layer.id === id);
  if (from < 0) return manifest;
  const last = layers.length - 1;
  const to = move === 'forward' ? Math.min(last, from + 1) : move === 'backward' ? Math.max(0, from - 1) : move === 'front' ? last : 0;
  return moveAudioEffectTo(manifest, id, to);
}

/** Puts a layer at an exact place in the stack, 0 being the bottom, as [moveLayerTo] does a picture layer. */
export function moveAudioEffectTo(manifest: EditManifest, id: string, toIndex: number): EditManifest {
  const layers = manifest.audioEffects ?? [];
  const from = layers.findIndex(layer => layer.id === id);
  if (from < 0) return manifest;
  const to = clamp(Math.round(toIndex), 0, layers.length - 1);
  if (to === from) return manifest;
  const audioEffects = [...layers];
  const [moved] = audioEffects.splice(from, 1);
  audioEffects.splice(to, 0, moved!);
  return { ...manifest, audioEffects };
}

export function deleteAudioEffect(manifest: EditManifest, id: string): EditManifest {
  if (!findAudioEffect(manifest, id)) return manifest;
  const audioEffects = manifest.audioEffects!.filter(layer => layer.id !== id);
  // The key goes with the last layer, so a post that had one and lost it is stored as one that never did.
  if (audioEffects.length > 0) return { ...manifest, audioEffects };
  const { audioEffects: _gone, ...rest } = manifest;
  return rest;
}

function sameAudioEffect(a: EditAudioEffect, b: EditAudioEffect): boolean {
  return a.effect === b.effect && a.speed === b.speed && a.startMs === b.startMs && a.endMs === b.endMs && sameSoundEffectSettings(a.effectSettings, b.effectSettings);
}

/**
 * [clampWindow] between `lo` and `hi` instead of the whole post, and with its own floor: the edge
 * that moved gives way, and a window dragged whole stops at the bounds with its length intact.
 */
function clampSpan(startMs: number, endMs: number, lo: number, hi: number, prevStart: number, prevEnd: number, min: number): [number, number] {
  const prevLen = prevEnd - prevStart;
  if (startMs !== prevStart && endMs !== prevEnd && Math.abs(endMs - startMs - prevLen) <= 1) {
    const len = clamp(prevLen, min, hi - lo);
    const shifted = Math.round(clamp(startMs, lo, hi - len));
    return [shifted, shifted + len];
  }
  let start = Math.round(clamp(startMs, lo, hi - min));
  let end = Math.round(clamp(endMs, lo + min, hi));
  const movedStart = start !== prevStart;
  const movedEnd = end !== prevEnd;
  if (end - start < min) {
    if (movedStart && !movedEnd) start = end - min;
    else end = start + min;
  }
  start = Math.max(lo, start);
  end = Math.min(hi, Math.max(end, start + min));
  return [start, end];
}

/* -------------------------------------------------------------------------------------------- */
/* Sound                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * The length of the music section itself, before any looping, in the FILE's milliseconds: one pass
 * lasts this divided by [musicSpeed] on the post. 0 when the track length is unknown.
 */
export function musicSectionMs(music: EditMusic): number {
  const out = music.outMs > 0 ? music.outMs : music.sourceDurationMs;
  return out > 0 ? Math.max(0, out - music.inMs) : 0;
}

/**
 * How fast the music's section plays: its [EditMusic.speed], or 1x for a sound that has none. Held
 * to the range here too, because `setMusic` stores whatever it is handed.
 */
export function musicSpeed(music: Pick<EditMusic, 'speed'>): number {
  const speed = music.speed;
  return speed !== undefined && Number.isFinite(speed) && speed > 0 ? clamp(speed, MIN_SPEED, MAX_SPEED) : 1;
}

/** The first pass's offset into the section, wrapped after a whole number of loops. */
export function musicPhaseMs(music: EditMusic): number {
  const section = musicSectionMs(music);
  const phase = Math.round(music.phaseMs ?? 0);
  return section > 0 ? ((phase % section) + section) % section : 0;
}

/** The latest the music can be heard until: its own stop when it has one, or the end of the video. */
export function musicStopMs(music: Pick<EditMusic, 'endMs'>, totalMs: number): number {
  return music.endMs > 0 ? Math.min(music.endMs, totalMs) : totalMs;
}

/**
 * Where the music is heard on the output timeline. A sound played once runs for what is left of its
 * section after the phase, at its speed - so not always a whole number of milliseconds.
 */
export function musicWindow(music: EditMusic, totalMs: number): { startMs: number; endMs: number } {
  const section = musicSectionMs(music);
  const startMs = Math.min(music.startMs, totalMs);
  const stopMs = musicStopMs(music, totalMs);
  const endMs = music.loop || section === 0 ? stopMs : Math.min(stopMs, music.startMs + (section - musicPhaseMs(music)) / musicSpeed(music));
  return { startMs, endMs: Math.max(startMs, endMs) };
}

/**
 * The music moved whole to `startMs`. A stop it has moves with it, so what is heard keeps its length,
 * and a stop carried to the end of the video or past it becomes "until the end" again.
 */
export function musicMovedTo(music: EditMusic, startMs: number, totalMs: number): Pick<EditMusic, 'startMs' | 'endMs'> {
  const start = Math.round(startMs);
  if (!(music.endMs > 0)) return { startMs: start, endMs: 0 };
  const end = Math.round(music.endMs + start - music.startMs);
  return { startMs: start, endMs: end >= totalMs ? 0 : end };
}

/** Position inside the TRACK for an output time, or null when the music is silent there. */
export function musicSourceMsAt(music: EditMusic, outputMs: number, totalMs: number): number | null {
  const { startMs, endMs } = musicWindow(music, totalMs);
  if (outputMs < startMs || outputMs >= endMs) return null;
  const section = musicSectionMs(music);
  // Into the file, which goes by at the sound's speed.
  const into = (outputMs - startMs) * musicSpeed(music);
  const from = musicPhaseMs(music) + into;
  return music.inMs + (section > 0 && music.loop ? from % section : from);
}

/**
 * What the music's fades leave of its level at an output time, 0..1: up from silence over the first
 * `fadeInMs` of the window it is heard in ([musicWindow]) and down to silence over the last
 * `fadeOutMs` of it, each a straight line in amplitude, and the product of the two where they
 * overlap - the rule [ComposeMusic] states and every engine draws. The preview multiplies by this,
 * so a fade is heard before it is rendered.
 *
 * The fades belong to that WINDOW, and a looping sound's seams play no part in them. They used to
 * belong to its first and last repetitions, cut to each one's length, and that lost the fade out
 * whenever the last repetition was short: the end handle can stop a loop anywhere, and a video is
 * almost never a whole number of passes long - WebKit even reads a 12 s song as 11975 ms, which left
 * a 60 s post a 125 ms last pass. The sound then ran at full level into a hard cut while the Volume
 * sheet said "Fade out 10.0s". Now a fade out always reaches silence exactly where the sound stops.
 */
export function musicFadeAt(music: EditMusic, outputMs: number, totalMs: number): number {
  const { startMs, endMs } = musicWindow(music, totalMs);
  if (endMs <= startMs) return 1;

  let gain = 1;
  const fadeInMs = music.fadeInMs ?? 0;
  if (fadeInMs > 0) gain *= clamp((outputMs - startMs) / fadeInMs, 0, 1);
  const fadeOutMs = music.fadeOutMs;
  if (fadeOutMs > 0) gain *= clamp((endMs - outputMs) / fadeOutMs, 0, 1);
  return gain;
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
  // `|| 0` for music a host built before the field existed.
  next.endMs = Math.max(0, Math.round(next.endMs || 0));
  if (next.phaseMs !== undefined) {
    next.phaseMs = Math.round(next.phaseMs || 0);
    if (next.phaseMs === 0) delete next.phaseMs;
  }
  next.fadeOutMs = Math.max(0, Math.round(next.fadeOutMs || 0));
  // Left absent on music that never had one, so a patch of something else is not a change.
  if (next.fadeInMs !== undefined) next.fadeInMs = Math.max(0, Math.round(next.fadeInMs || 0));
  // And taken off at 1x, which is what a sound with no speed plays at.
  if (next.speed !== undefined) {
    next.speed = normaliseSpeed(next.speed);
    if (next.speed === 1) delete next.speed;
  }
  if (next.outMs > 0 && next.outMs - next.inMs < MIN_LAYER_MS) return manifest;
  if (next.endMs > 0 && next.endMs - next.startMs < MIN_LAYER_MS) return manifest;
  if (sameFields(manifest.music, next)) return manifest;
  return { ...manifest, music: next };
}

/** A placed sound, regardless of which audio lane holds it. */
export function findAudioClip(manifest: EditManifest, id: string): EditAudioClip | null {
  for (const track of manifest.audioTracks ?? []) {
    const clip = track.clips.find(one => one.id === id);
    if (clip) return clip;
  }
  return null;
}

export function audioTrackIdOfClip(manifest: EditManifest, id: string): string | null {
  return manifest.audioTracks?.find(track => track.clips.some(clip => clip.id === id))?.id ?? null;
}

/** A sound's audible interval. Its clip keeps the same timing rules as the original music. */
export function audioClipWindow(clip: EditAudioClip, totalMs: number): { startMs: number; endMs: number } {
  return musicWindow(clip, totalMs);
}

/** Where a sound sits whatever the post's length: one that plays to the end runs on for ever. */
function wholeAudioWindow(clip: EditAudioClip): { startMs: number; endMs: number } {
  return musicWindow(clip, Number.POSITIVE_INFINITY);
}

/**
 * Whether a sound can share a lane with `others`.
 *
 * Neighbours are kept apart over the whole of each sound, not just the part this post's length lets
 * be heard: a post cut shorter and then made longer again would otherwise bring two sounds on one
 * lane together, and a lane plays one sound at a time. A post with a length must hear a moment of
 * the sound; one with none yet, an edit whose first layer is a sound, takes it as it is.
 */
function audioFits(clip: EditAudioClip, others: readonly EditAudioClip[], totalMs: number): boolean {
  const whole = wholeAudioWindow(clip);
  if (!Number.isFinite(whole.startMs) || whole.endMs - whole.startMs < MIN_LAYER_MS) return false;
  if (totalMs > 0) {
    const heard = audioClipWindow(clip, totalMs);
    if (heard.endMs - heard.startMs < MIN_LAYER_MS) return false;
  }
  return others.every(other => {
    const taken = wholeAudioWindow(other);
    return whole.endMs <= taken.startMs || whole.startMs >= taken.endMs;
  });
}

/** The nearest gap that can hold a whole sound; a drop onto a clip snaps beside it. */
function nearestAudioPlacement(clip: EditAudioClip, others: readonly EditAudioClip[], atMs: number, totalMs: number): EditAudioClip | null {
  const wanted = Math.max(0, Math.round(atMs));
  // Whole lengths, which is what [audioFits] keeps apart. One that plays to the end has no edge
  // before another sound, and the non-finite candidates that gives are dropped. A sped-up sound's
  // length is rarely whole milliseconds, so each edge is rounded away from the sound it meets.
  const own = wholeAudioWindow(clip);
  const length = own.endMs - own.startMs;
  const edges = [wanted, 0, Math.floor(totalMs - length)];
  for (const other of others) {
    const taken = wholeAudioWindow(other);
    edges.push(Math.ceil(taken.endMs), Math.floor(taken.startMs - length));
  }
  const choices = edges
    .filter(start => Number.isFinite(start))
    .map(start => ({ ...clip, ...musicMovedTo(clip, Math.max(0, Math.round(start)), totalMs) }))
    .filter(next => audioFits(next, others, totalMs))
    .sort((a, b) => Math.abs(a.startMs - wanted) - Math.abs(b.startMs - wanted));
  return choices[0] ?? null;
}

/**
 * The post's music as sound `id`, alone on a new first lane `trackId`. The music is one sound with no
 * lane, so anything that makes a second sound out of it - a cut, a copy, another sound added - puts it
 * on a lane first. Null when there is no music, or when either id is already taken.
 */
export function musicAsAudioLane(manifest: EditManifest, id: string, trackId: string): EditManifest | null {
  const music = manifest.music;
  const existing = manifest.audioTracks ?? [];
  if (!music || findAudioClip(manifest, id) || existing.some(track => track.id === trackId)) return null;
  const track: EditAudioTrack = { id: trackId, clips: [{ ...music, id }] };
  return { ...manifest, music: null, audioTracks: [track, ...existing] };
}

/** Turns the old single sound into the first audio lane only when an added clip can land. */
function withLegacyAudioLane(manifest: EditManifest, incomingClipId: string, incomingTrackId: string): EditManifest {
  if (!manifest.music) return manifest;
  const existing = manifest.audioTracks ?? [];
  const clipIds = new Set([incomingClipId, ...existing.flatMap(track => track.clips.map(clip => clip.id))]);
  const trackIds = new Set([incomingTrackId, ...existing.map(track => track.id)]);
  const unique = (base: string, used: Set<string>): string => {
    let id = base;
    for (let suffix = 1; used.has(id); suffix++) id = `${base}-${suffix}`;
    return id;
  };
  return musicAsAudioLane(manifest, unique('legacy-music', clipIds), unique('legacy-audio-track', trackIds)) ?? manifest;
}

/** Adds a sound at its requested output time, on the first lane with room or a new lane. */
export function addAudioClip(manifest: EditManifest, clip: EditAudioClip, newTrackId: string, targetTrackId?: string): EditManifest | null {
  if (!clip.uri || findAudioClip(manifest, clip.id)) return null;
  const total = totalDurationMs(manifest);
  const placed: EditAudioClip = { ...clip, startMs: Math.max(0, Math.round(clip.startMs)) };
  const base = withLegacyAudioLane(manifest, clip.id, newTrackId);
  const tracks = base.audioTracks ?? [];
  const target = targetTrackId ? tracks.find(track => track.id === targetTrackId) : tracks.find(track => audioFits(placed, track.clips, total));
  if (targetTrackId && !target) return null;
  if (target) {
    if (!audioFits(placed, target.clips, total)) return null;
    return {
      ...base,
      audioTracks: tracks.map(track => (track.id === target.id ? { ...track, clips: [...track.clips, placed].sort((a, b) => a.startMs - b.startMs) } : track)),
    };
  }
  if (tracks.some(track => track.id === newTrackId)) return null;
  if (!audioFits(placed, [], total)) return null;
  return { ...base, audioTracks: [...tracks, { id: newTrackId, clips: [placed] }] };
}

/** Deletes one sound and removes its lane when it becomes empty. */
export function removeAudioClip(manifest: EditManifest, id: string): EditManifest {
  if (!findAudioClip(manifest, id)) return manifest;
  const tracks = (manifest.audioTracks ?? []).map(track => ({ ...track, clips: track.clips.filter(clip => clip.id !== id) })).filter(track => track.clips.length > 0);
  if (tracks.length > 0) return { ...manifest, audioTracks: tracks };
  const { audioTracks: _removed, ...rest } = manifest;
  return rest as EditManifest;
}

/** Updates one sound without allowing it to cover a neighbour on the same lane. */
export function patchAudioClip(manifest: EditManifest, id: string, patch: Partial<EditMusic>): EditManifest {
  const clip = findAudioClip(manifest, id);
  const trackId = audioTrackIdOfClip(manifest, id);
  if (!clip || !trackId) return manifest;
  const updated = patchMusic({ ...manifest, music: clip }, patch).music;
  if (!updated || sameFields(clip, updated)) return manifest;
  const next: EditAudioClip = { ...updated, id };
  const total = totalDurationMs(manifest);
  const track = manifest.audioTracks!.find(one => one.id === trackId)!;
  if (
    !audioFits(
      next,
      track.clips.filter(one => one.id !== id),
      total,
    )
  )
    return manifest;
  return {
    ...manifest,
    audioTracks: manifest.audioTracks!.map(one =>
      one.id === trackId ? { ...one, clips: one.clips.map(item => (item.id === id ? next : item)).sort((a, b) => a.startMs - b.startMs) } : one,
    ),
  };
}

/**
 * Loop on or off. A sound with another after it on its lane repeats up to that one: "until the end
 * of the video" would run over it, and a lane plays one sound at a time. A stop it already has is
 * kept, being before that neighbour by construction.
 */
export function setAudioLoop(manifest: EditManifest, id: string, loop: boolean): EditManifest {
  const clip = findAudioClip(manifest, id);
  const lane = manifest.audioTracks?.find(track => track.clips.some(one => one.id === id));
  if (!clip || !lane) return manifest;
  // Sorted by start, so the first one starting later is the next one along.
  const next = loop && !(clip.endMs > 0) ? lane.clips.find(one => one.startMs > clip.startMs) : undefined;
  return patchAudioClip(manifest, id, next ? { loop, endMs: next.startMs } : { loop });
}

/**
 * What a sound at another speed is patched with: the speed, and - when slowing it down would run it
 * into the next sound on its lane - a stop where that one begins, as Loop stops at it. A lane plays one
 * sound at a time, and refusing the slower speed outright would leave the Speed sheet's knob springing
 * back with nothing said. Its place, its trim and a stop it already has all stay; a stop it has is
 * before that neighbour by construction, so it needs no other.
 */
export function audioSpeedPatch(manifest: EditManifest, id: string, speed: number): Partial<EditMusic> {
  const patch: Partial<EditMusic> = { speed: normaliseSpeed(speed) };
  const clip = findAudioClip(manifest, id);
  const lane = manifest.audioTracks?.find(track => track.clips.some(one => one.id === id));
  if (!clip || !lane || clip.endMs > 0) return patch;
  // Sorted by start, so the first one starting later is the next one along.
  const next = lane.clips.find(one => one.startMs > clip.startMs);
  if (!next || wholeAudioWindow({ ...clip, ...patch }).endMs <= next.startMs) return patch;
  return { ...patch, endMs: next.startMs };
}

/** One sound on the lanes at another speed; see [audioSpeedPatch] for what else may change with it. */
export function setAudioSpeed(manifest: EditManifest, id: string, speed: number): EditManifest {
  return patchAudioClip(manifest, id, audioSpeedPatch(manifest, id, speed));
}

/** The post's music at another speed. Nothing shares its lane, so it only ever runs longer or shorter. */
export function setMusicSpeed(manifest: EditManifest, speed: number): EditManifest {
  return patchMusic(manifest, { speed: normaliseSpeed(speed) });
}

/**
 * Another file under a placed sound, which is what Replace is for: trying a different song in the same
 * place. Where it starts, its lane, its level, its fades and its loop are the customer's and stay; the
 * trim was cut from the old file and goes. A sound that ran on with no stop is stopped where the next
 * one on its lane begins, since the new file may be longer than the gap. Null when it would not fit.
 */
export function replaceAudioClip(manifest: EditManifest, id: string, file: Pick<EditMusic, 'uri' | 'fileName' | 'sourceDurationMs'>): EditManifest | null {
  const clip = findAudioClip(manifest, id);
  const lane = manifest.audioTracks?.find(track => track.clips.some(one => one.id === id));
  if (!clip || !lane || !file.uri) return null;
  const next = lane.clips.find(one => one.startMs > clip.startMs);
  const { phaseMs: _trimmed, ...kept } = clip;
  const replaced: EditAudioClip = {
    ...kept,
    uri: file.uri,
    fileName: file.fileName,
    sourceDurationMs: Math.max(0, file.sourceDurationMs),
    inMs: 0,
    outMs: 0,
    endMs: clip.endMs > 0 ? clip.endMs : next ? next.startMs : 0,
  };
  if (
    !audioFits(
      replaced,
      lane.clips.filter(one => one.id !== id),
      totalDurationMs(manifest),
    )
  )
    return null;
  return {
    ...manifest,
    audioTracks: manifest.audioTracks!.map(track => (track === lane ? { ...track, clips: track.clips.map(one => (one.id === id ? replaced : one)) } : track)),
  };
}

/** Where a sound lifted from a lane is being dropped. */
export type AudioDropTarget = { kind: 'track'; trackId: string } | { kind: 'new'; index: number };

/** Moves a sound to another lane, opening one when dropped in a gap between rows. */
export function moveAudioClipToTrack(manifest: EditManifest, id: string, target: AudioDropTarget, atMs: number, newTrackId: string): EditManifest | null {
  const clip = findAudioClip(manifest, id);
  const fromId = audioTrackIdOfClip(manifest, id);
  if (!clip || !fromId) return null;
  const original = manifest.audioTracks ?? [];
  const fromIndex = original.findIndex(track => track.id === fromId);
  const remaining = original.map(track => ({ ...track, clips: track.clips.filter(one => one.id !== id) })).filter(track => track.clips.length > 0);
  const total = totalDurationMs(manifest);
  const asked = Math.max(0, Math.round(atMs));
  if (target.kind === 'track') {
    const destination = remaining.find(track => track.id === target.trackId);
    if (!destination) return null;
    const moving = nearestAudioPlacement(clip, destination.clips, asked, total);
    if (!moving) return null;
    const tracks = remaining.map(track => (track.id === destination.id ? { ...track, clips: [...track.clips, moving].sort((a, b) => a.startMs - b.startMs) } : track));
    return { ...manifest, audioTracks: tracks };
  }
  const emptied = remaining.length < original.length;
  let index = clamp(Math.round(target.index), 0, original.length);
  if (emptied && index > fromIndex) index--;
  index = clamp(index, 0, remaining.length);
  const ownRow = emptied && index === fromIndex ? original[fromIndex] : null;
  if (!ownRow && remaining.some(track => track.id === newTrackId)) return null;
  const moving = nearestAudioPlacement(clip, [], asked, total);
  if (!moving) return null;
  const tracks: EditAudioTrack[] = [...remaining];
  tracks.splice(index, 0, { id: ownRow?.id ?? newTrackId, clips: [moving] });
  return { ...manifest, audioTracks: tracks };
}

/** Moves a sound sideways inside its lane, stopping at other sounds and the post's ends. */
export function moveAudioClip(manifest: EditManifest, id: string, atMs: number): EditManifest {
  const clip = findAudioClip(manifest, id);
  const trackId = audioTrackIdOfClip(manifest, id);
  if (!clip || !trackId) return manifest;
  const total = totalDurationMs(manifest);
  const others = manifest.audioTracks!.find(track => track.id === trackId)!.clips.filter(one => one.id !== id);
  const next = nearestAudioPlacement(clip, others, atMs, total);
  return next ? patchAudioClip(manifest, id, { startMs: next.startMs, endMs: next.endMs }) : manifest;
}

/**
 * Carries a sound to another position in its lane's sequence, like a video segment's reorder.
 *
 * Sounds have places of their own rather than the video's gapless sequence, so only the block the
 * sound crosses is rebuilt. Its first start and the gaps between its positions stay put, and each
 * sound brings its length, source section, phase and fades with it. A sound clipped by the post's
 * end brings its played length, with an explicit stop at its new end: otherwise its hidden tail
 * would cover its next neighbour, and a longer file than the post could not be swapped at all.
 * Fractional-speed lengths reserve their last millisecond: all starts are whole milliseconds, and
 * rounding one down would overlap its neighbour.
 */
export function reorderAudioClip(manifest: EditManifest, id: string, toIndex: number): EditManifest {
  if (!Number.isFinite(toIndex)) return manifest;
  const lane = manifest.audioTracks?.find(track => track.clips.some(clip => clip.id === id));
  if (!lane) return manifest;
  const from = lane.clips.findIndex(clip => clip.id === id);
  const to = clamp(Math.round(toIndex), 0, lane.clips.length - 1);
  if (from === to) return manifest;

  const total = totalDurationMs(manifest);
  const first = Math.min(from, to);
  const last = Math.max(from, to);
  const block = lane.clips.slice(first, last + 1);
  const wholeWindows = block.map(clip => wholeAudioWindow(clip));
  const bounded = wholeWindows.map(window => !Number.isFinite(window.endMs) || window.endMs > total);
  const windows = block.map((clip, index) => (bounded[index] ? audioClipWindow(clip, total) : wholeWindows[index]!));
  const lengths = windows.map(window => Math.ceil(window.endMs - window.startMs));
  const gaps = windows.slice(0, -1).map((window, index) => block[index + 1]!.startMs - Math.ceil(window.endMs));
  if (
    windows.some(window => !Number.isFinite(window.startMs) || !Number.isFinite(window.endMs) || window.endMs - window.startMs < MIN_LAYER_MS) ||
    gaps.some(gap => !Number.isFinite(gap) || gap < 0)
  )
    return manifest;

  const order = block.map((_, index) => index);
  const [moving] = order.splice(from - first, 1);
  order.splice(to - first, 0, moving!);
  let startMs = block[0]!.startMs;
  const reordered = order.map((index, position) => {
    const original = block[index]!;
    const delta = startMs - original.startMs;
    // Keep a stop even at the post's end. musicMovedTo clears it there, which would make a
    // previously bounded loop overlap its next neighbour when the post is extended again.
    const endMs = bounded[index] ? startMs + lengths[index]! : original.endMs > 0 ? original.endMs + delta : 0;
    const placed = startMs === original.startMs && endMs === original.endMs ? original : { ...original, startMs, endMs };
    startMs += lengths[index]! + (gaps[position] ?? 0);
    return placed;
  });
  const clips = [...lane.clips.slice(0, first), ...reordered, ...lane.clips.slice(last + 1)];
  if (
    !reordered.every(clip =>
      audioFits(
        clip,
        clips.filter(other => other !== clip),
        total,
      ),
    )
  )
    return manifest;
  return {
    ...manifest,
    audioTracks: manifest.audioTracks!.map(track => (track === lane ? { ...track, clips } : track)),
  };
}

/**
 * Cuts a sound in two at `atMs` on the post, both halves on its lane: the left keeps the sound's id and
 * the right is `newId`. Played one after the other they are the sound as it was, so each half is what
 * its own handle would have made of it ([musicEndTrim], [musicStartTrim] in the timeline). A sound
 * played once is cut in its FILE: the left half's section ends where the right half's begins, and a
 * stop it had goes with the right half. A looping sound keeps its whole section in both halves: the
 * left stops repeating at the cut, and the right takes the repeats up where they had got to, as the
 * phase of its first pass.
 *
 * The fades are shared out as a cut shares out a layer's animation ([splitOverlayAt]): the left half
 * keeps how the sound comes in and the right half how it goes out, so the cut is not a dip to silence.
 * Null when either half would be heard for less than [MIN_LAYER_MS], or trimmed to less of its file.
 */
export function splitAudioClipAt(manifest: EditManifest, id: string, atMs: number, newId: string): EditManifest | null {
  const clip = findAudioClip(manifest, id);
  const lane = manifest.audioTracks?.find(track => track.clips.some(one => one.id === id));
  if (!clip || !lane || findAudioClip(manifest, newId)) return null;
  const total = totalDurationMs(manifest);
  const heard = audioClipWindow(clip, total);
  const cut = Math.round(atMs);
  if (cut - heard.startMs < MIN_LAYER_MS || heard.endMs - cut < MIN_LAYER_MS) return null;
  // The file goes by at the sound's speed, so the cut is that much further into it.
  const into = (cut - clip.startMs) * musicSpeed(clip);
  const { phaseMs: _phase, fadeInMs: _fadeIn, ...plain } = clip;
  let left: EditAudioClip;
  let right: EditAudioClip;
  if (clip.loop) {
    // Not wrapped, as the start handle leaves it: each engine wraps it against the section it measures.
    const phaseMs = (clip.phaseMs ?? 0) + Math.round(into);
    left = { ...clip, endMs: cut, fadeOutMs: 0 };
    right = { ...plain, id: newId, startMs: cut, ...(phaseMs !== 0 ? { phaseMs } : {}) };
  } else {
    // A sped-up sound rarely reaches the cut on a whole millisecond of its file: the left half's end is
    // rounded down and the right half's start up, so neither runs into the other.
    const inMs = clip.inMs + musicPhaseMs(clip);
    const fadeIn = clip.fadeInMs !== undefined ? { fadeInMs: clip.fadeInMs } : {};
    left = { ...plain, ...fadeIn, inMs, outMs: Math.floor(inMs + into), endMs: 0, fadeOutMs: 0 };
    right = { ...plain, id: newId, inMs: Math.ceil(inMs + into), startMs: cut };
  }
  const others = lane.clips.filter(one => one.id !== id);
  if (!trimsHold(left) || !trimsHold(right) || !audioFits(left, others, total) || !audioFits(right, [...others, left], total)) return null;
  return {
    ...manifest,
    audioTracks: manifest.audioTracks!.map(track => (track === lane ? { ...track, clips: [...others, left, right].sort((a, b) => a.startMs - b.startMs) } : track)),
  };
}

/**
 * A lane's sounds with every run that plays on unbroken as the one sound it is: the halves of a cut
 * that nothing has been done to since, which are the same stretch of the same file, at the same
 * speed and level, with no fade where they meet. What goes to the engines and to the preview, so a cut
 * is heard as nothing at all - two items of one file meet with a seam the engines cannot close
 * ([splitAudioClipAt]; Media3 starts a sound inside its file on a codec frame, without the frame
 * before it). Each run keeps its first sound's id; a sound alone is returned as it was.
 */
export function joinContinuousAudio(clips: readonly EditAudioClip[]): EditAudioClip[] {
  const joined: EditAudioClip[] = [];
  clips.forEach((clip, index) => {
    const before = clips[index - 1];
    const run = joined[joined.length - 1];
    if (before && run && playsOn(before, clip)) {
      // The run is its first sound heard on to where the last one ends.
      joined[joined.length - 1] = { ...run, outMs: run.loop ? run.outMs : clip.outMs, endMs: clip.endMs, fadeOutMs: clip.fadeOutMs };
    } else {
      joined.push(clip);
    }
  });
  return joined;
}

/**
 * Whether `next` carries `sound` on unbroken: the same file at the same speed and level, nothing
 * fading where they meet, and `next` starting where `sound` stops - on the post and in the file, to
 * within the millisecond a cut rounds a sped-up sound by. A loop goes on in the same section, its
 * repeats where the earlier one's had got to; a sound played once ends on its section, which the
 * next one starts its own on.
 */
function playsOn(sound: EditAudioClip, next: EditAudioClip): boolean {
  if (next.uri !== sound.uri || musicSpeed(next) !== musicSpeed(sound) || next.volume !== sound.volume || next.loop !== sound.loop) return false;
  if (sound.fadeOutMs > 0 || (next.fadeInMs ?? 0) > 0) return false;
  const speed = musicSpeed(sound);
  if (sound.loop) {
    const phase = (sound.phaseMs ?? 0) + (next.startMs - sound.startMs) * speed;
    return next.inMs === sound.inMs && next.outMs === sound.outMs && sound.endMs > 0 && next.startMs === sound.endMs && Math.abs((next.phaseMs ?? 0) - phase) <= 1;
  }
  if (!(sound.outMs > 0) || sound.endMs > 0) return false;
  const endsMs = sound.startMs + (sound.outMs - sound.inMs - musicPhaseMs(sound)) / speed;
  return Math.abs(next.startMs - endsMs) <= 1 && Math.abs(next.inMs + musicPhaseMs(next) - sound.outMs) <= 1;
}

/**
 * A copy of a sound, straight after it on the post: on its own lane when the whole copy fits there,
 * else on the first lane it fits on, else on a new lane `newTrackId` under its own. A sound heard to the
 * end of the post has no after, so its copy goes where it is, on another lane, as a layer's copy goes
 * over the layer ([duplicateOverlay]). The copy is the sound's in everything else - its trim, level,
 * fades, loop and speed - and a stop the sound has moves with it ([musicMovedTo]).
 *
 * Null when the copy could not be heard anywhere, or when either id is taken.
 */
export function duplicateAudioClip(manifest: EditManifest, id: string, newId: string, newTrackId: string): EditManifest | null {
  const clip = findAudioClip(manifest, id);
  const tracks = manifest.audioTracks ?? [];
  const own = tracks.findIndex(track => track.clips.some(one => one.id === id));
  if (!clip || own < 0 || findAudioClip(manifest, newId)) return null;
  const total = totalDurationMs(manifest);
  // Up to a whole millisecond, as a sound picked after it is: a sped-up sound rarely ends on one.
  const end = Math.ceil(wholeAudioWindow(clip).endMs);
  const after = Number.isFinite(end) && end + MIN_LAYER_MS <= total;
  const copy: EditAudioClip = { ...clip, id: newId, ...(after ? musicMovedTo(clip, end, total) : {}) };
  const fits = (track: EditAudioTrack): boolean => audioFits(copy, track.clips, total);
  const target = after && fits(tracks[own]) ? tracks[own] : tracks.find((track, index) => index !== own && fits(track));
  if (target) {
    return {
      ...manifest,
      audioTracks: tracks.map(track => (track === target ? { ...track, clips: [...track.clips, copy].sort((a, b) => a.startMs - b.startMs) } : track)),
    };
  }
  if (tracks.some(track => track.id === newTrackId) || !audioFits(copy, [], total)) return null;
  return { ...manifest, audioTracks: [...tracks.slice(0, own + 1), { id: newTrackId, clips: [copy] }, ...tracks.slice(own + 1)] };
}

/** Whether a sound's trim and its stop each leave [MIN_LAYER_MS], the floor [patchMusic] holds both to. */
function trimsHold(sound: EditMusic): boolean {
  return !(sound.outMs > 0 && sound.outMs - sound.inMs < MIN_LAYER_MS) && !(sound.endMs > 0 && sound.endMs - sound.startMs < MIN_LAYER_MS);
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
    sameTransition(a.transitionIn, b.transitionIn) &&
    !!a.image === !!b.image
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
