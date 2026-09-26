/**
 * The edit operations an agent can ask for, as a table of names.
 *
 * `src/editor/edit-ops.ts` is already the whole vocabulary of an edit, and this file adds nothing to
 * it: every entry below reads a few values out of a JSON object and does what the editor's own UI
 * does. For most that is calling the same function; the five that set something on the whole post
 * (`setFilter`, `setAdjust`, `setFit`, `setOriginalMuted`, `setOutput`) have none in `edit-ops.ts`,
 * so they set those fields here exactly as the editor's store does. That is the point. An agent
 * driving this package and a customer dragging a clip must land on the SAME manifest, or the two
 * halves of the product disagree about what an edit is, and the only way to be sure of that is for
 * the agent's path to have no maths of its own.
 *
 * Two things are added, both of them about being driven by something that cannot see the screen:
 *
 *  - An op that names something the manifest does not have FAILS. The editor's functions return the
 *    manifest unchanged for a clip id that is not there, because a UI cannot ask for one: the
 *    button belongs to a clip that exists. An agent absolutely can, usually by carrying an id over
 *    from an earlier version of the edit, and a silent no-op is the worst possible answer - the
 *    agent reads back a manifest, sees its op did nothing, and has no idea whether the op was
 *    refused or ignored. So the guards below look the id up first and throw naming it.
 *
 *  - An op the editor answers with `null` - the capacity limits, the moves that cannot be made -
 *    throws with the reason spelled out rather than the `null`, because `null` arriving at an agent
 *    is a value it will try to edit.
 *
 * `totalMs` is never taken from the caller. Three ops need it, and it is a function of the manifest
 * ([totalDurationMs]) rather than a choice, so an agent passing its own would be passing a number
 * the editor would have computed differently.
 *
 * One thing is taken away, when the host asks: every zoom op, on an app that has turned Zoom off
 * (`editing.zoom`, the same setting its editor reads). The server built on these ops keeps no zoom
 * in any post while Zoom is off - `tools.ts` refuses a manifest that holds one at the door - so
 * there is no zoom for `updateZoom`, `setZoomWindow` or `deleteZoom` to act on, and `addZoom` and
 * `duplicateZoom` would put one in. [applyEditOps] is where that is decided, per call, for the
 * reason written on it, and [ZOOM_OPS] says why no other op in the table can make a zoom either.
 */
import {
  DEFAULT_ZOOM_MS,
  DEFAULT_ZOOM_RAMP_MS,
  DEFAULT_ZOOM_SCALE,
  MAX_LAYERS,
  MAX_VIDEO_TRACKS,
  MAX_ZOOMS,
  MIN_ZOOM_MS,
  ZOOM_EASES,
  aspectOf,
  defaultClipEdit,
  normaliseOutput,
  outputFor,
  qualityOf,
  totalDurationMs,
  type EditAdjust,
  type EditClip,
  type EditFit,
  type EditManifest,
  type EditMusic,
  type EditOverlay,
  type EditPlacement,
  type EditRect,
  type EditTransition,
  type EditVoiceover,
  type EditZoom,
  type OutputAspect,
  type TextAlign,
  type TextEffect,
} from '../editor/edit-manifest';
import { OVERLAY_ANIMATIONS, normaliseOverlayAnimation } from '../editor/motion';
import { DEFAULT_TRANSITION_MS, TRANSITIONS, isTransitionKind } from '../editor/transitions';
import {
  addOverlay,
  addVideoTrack,
  addVoiceover,
  duplicateClip,
  duplicateOverlay,
  findClip,
  findOverlay,
  findVideoTrack,
  findVoiceover,
  insertClip,
  joinWithNext,
  moveClip,
  moveClipToTrack,
  moveLayer,
  moveLayerTo,
  moveVoiceover,
  patchClip,
  patchMusic,
  patchOverlay,
  patchVoiceover,
  removeClip,
  removeOverlay,
  removeVideoTrack,
  removeVoiceover,
  replaceClipSource,
  resetClipFraming,
  setClipCrop,
  setClipFit,
  setClipRect,
  setClipRotation,
  setClipSpeed,
  setAllTransitions,
  setClipTransition,
  setMusic,
  setOverlayWindow,
  setPostDuration,
  setTrackOpacity,
  setTrackStart,
  splitClipAt,
  splitOverlayAt,
  swapTrackZ,
  trimClip,
  addZoom,
  deleteZoom,
  duplicateZoom,
  findZoom,
  setZoomWindow,
  updateZoom,
  type ClipDropTarget,
  type LayerMove,
  type ZoomPatch,
} from '../editor/edit-ops';
import { applyLayoutPreset, layoutPresets, type LayoutPresetId } from '../editor/layout-presets';
/*
 * Type only, and the one thing this server takes from the editor's host contract. It is the same
 * type rather than a lookalike so that what `zoom` means is written in one place, on
 * `EditorEditingOptions`, and so a host can hand the MCP server the very `editing` object it hands
 * the editor, as a variable or written out in place. The import is erased from the JavaScript, so
 * the server never loads the host contract.
 *
 * What it costs the `mcp/` tree is `mcp/host/host.types.{js,d.ts}`, emitted because the file is in
 * the program: the declaration is what `ops.d.ts` names, the JavaScript - `RenderFailedError`, the
 * one runtime value in it - is loaded by nothing here, and the file's own imports are the editor
 * core that is already in the tree, so `mcp/` stays self-contained and still deletes whole.
 */
import type { EditorEditingOptions } from '../host/host.types';

/** One op: a name, and whatever that name reads. Deliberately loose - each entry validates its own. */
export interface EditOp {
  op: string;
  [key: string]: unknown;
}

/**
 * A refused op, carrying the index it was at in the list.
 *
 * The index matters more than it looks. Ops are applied in order and each one sees the last one's
 * manifest, so an agent that sent eight ops and got "no clip 'c3'" needs to know whether that was
 * op 1, against the manifest it was looking at, or op 7, against a manifest five removals later.
 */
export class EditOpError extends Error {
  constructor(
    readonly op: string,
    readonly index: number,
    message: string,
  ) {
    super(`op ${index} (${op}): ${message}`);
    this.name = 'EditOpError';
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Reading a value out of an op                                                                   */
/* -------------------------------------------------------------------------------------------- */

/*
 * These throw plain `Error`s. `applyEditOps` catches everything one op throws and re-wraps it as an
 * `EditOpError` with the name and the index, so nothing down here has to know either.
 */

function str(op: Record<string, unknown>, key: string): string {
  const value = op[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`"${key}" must be a non-empty string`);
  return value;
}

function optionalStr(op: Record<string, unknown>, key: string): string | undefined {
  const value = op[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string`);
  return value;
}

function num(op: Record<string, unknown>, key: string): number {
  const value = op[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`"${key}" must be a finite number`);
  return value;
}

function optionalNum(op: Record<string, unknown>, key: string, fallback: number): number {
  const value = op[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`"${key}" must be a finite number`);
  return value;
}

function bool(op: Record<string, unknown>, key: string): boolean {
  const value = op[key];
  if (typeof value !== 'boolean') throw new Error(`"${key}" must be true or false`);
  return value;
}

function optionalBool(op: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = op[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`"${key}" must be true or false`);
  return value;
}

function oneOf<T extends string>(op: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = str(op, key);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`"${key}" must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function optionalOneOf<T extends string>(op: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T): T {
  if (op[key] === undefined || op[key] === null) return fallback;
  return oneOf(op, key, allowed);
}

/** An object, or `null` for the ops whose whole meaning is "take it away". */
function nullableObject(op: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = op[key];
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`"${key}" must be an object or null`);
  return value as Record<string, unknown>;
}

function object(op: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = nullableObject(op, key);
  if (value === null) throw new Error(`"${key}" must be an object`);
  return value;
}

/**
 * x/y/w/h, all four required, and none of them checked beyond being numbers: `setClipCrop` and
 * `setClipRect` normalise what they are given, and a second opinion here would be the one that is
 * wrong the day the manifest's rules move.
 *
 * `path` is only for the message. A bare `"w" must be a finite number` says nothing about which of
 * the two rectangles an op carries was the bad one.
 */
function readRect(raw: Record<string, unknown>, path: string): EditRect {
  const at = (key: string) => {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`"${path}.${key}" must be a finite number`);
    return value;
  };
  return { x: at('x'), y: at('y'), w: at('w'), h: at('h') };
}

/**
 * A rectangle that may also be turned.
 *
 * A missing angle stays missing rather than becoming 0. The manifest means two different things by
 * those - absent is upright and takes the render's untouched path, `rotationDeg: 0` is a turn of
 * nothing that does not - so defaulting one to the other here would quietly cost a post the fast
 * path it was on.
 */
function readPlacement(raw: Record<string, unknown>, path: string): EditPlacement {
  const rect = readRect(raw, path);
  const rotation = raw['rotationDeg'];
  if (rotation === undefined || rotation === null) return rect;
  if (typeof rotation !== 'number' || !Number.isFinite(rotation)) {
    throw new Error(`"${path}.rotationDeg" must be a finite number`);
  }
  return { ...rect, rotationDeg: rotation };
}

/* -------------------------------------------------------------------------------------------- */
/* Guards                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/*
 * What every op does before it touches anything: prove the thing it names is there. The editor's
 * own functions return the manifest unchanged instead, which is right for a UI and wrong here.
 */

/**
 * `transition` as `{kind, durationMs?}`, or null for a cut. An unknown kind is refused here with the
 * list of the ones there are, rather than being quietly stored as a cut by the op.
 */
function transitionOf(op: Record<string, unknown>): EditTransition | null {
  const value = nullableObject(op, 'transition');
  if (value === null) return null;
  const kind = str(value, 'kind');
  if (!isTransitionKind(kind)) throw new Error(`"kind" must be one of ${TRANSITIONS.map(t => t.id).join(', ')}`);
  const durationMs = value['durationMs'] === undefined ? DEFAULT_TRANSITION_MS : num(value, 'durationMs');
  return { kind, durationMs };
}

function requireClip(manifest: EditManifest, clipId: string): EditClip {
  const clip = findClip(manifest, clipId);
  if (!clip) throw new Error(`no clip "${clipId}" - ids on this post: ${clipIds(manifest).join(', ') || 'none'}`);
  return clip;
}

function requireOverlay(manifest: EditManifest, id: string): EditOverlay {
  const overlay = findOverlay(manifest, id);
  const ids = manifest.overlays.map(o => o.id);
  if (!overlay) throw new Error(`no layer "${id}" - layers on this post: ${ids.join(', ') || 'none'}`);
  return overlay;
}

function requireTrack(manifest: EditManifest, trackId: string): void {
  if (findVideoTrack(manifest, trackId)) return;
  const ids = manifest.videoTracks.map(t => t.id);
  throw new Error(`no video track "${trackId}" - tracks on this post: ${ids.join(', ') || 'none (only the base track)'}`);
}

function requireVoiceover(manifest: EditManifest, id: string): EditVoiceover {
  const take = findVoiceover(manifest, id);
  const ids = manifest.voiceovers.map(v => v.id);
  if (!take) throw new Error(`no voiceover "${id}" - takes on this post: ${ids.join(', ') || 'none'}`);
  return take;
}

/** Every clip id on the post, base track and video tracks together - the ids an op may name. */
function clipIds(manifest: EditManifest): string[] {
  return [...manifest.clips, ...manifest.videoTracks.flatMap(track => track.clips)].map(clip => clip.id);
}

/** An id an op is about to introduce must not already be in use, or two clips become unaddressable. */
function requireFreeClipId(manifest: EditManifest, id: string): void {
  if (clipIds(manifest).includes(id)) throw new Error(`clip id "${id}" is already on this post`);
}

function requireFreeLayerId(manifest: EditManifest, id: string): void {
  if (manifest.overlays.some(overlay => overlay.id === id)) throw new Error(`layer id "${id}" is already on this post`);
}

function requireZoom(manifest: EditManifest, id: string): EditZoom {
  const zoom = findZoom(manifest, id);
  const ids = manifest.zooms.map(z => z.id);
  if (!zoom) throw new Error(`no zoom "${id}" - zooms on this post: ${ids.join(', ') || 'none'}`);
  return zoom;
}

function requireFreeZoomId(manifest: EditManifest, id: string): void {
  if (findZoom(manifest, id)) throw new Error(`zoom id "${id}" is already on this post`);
}

/** What [addZoom] and [duplicateZoom] answer `null` with at the cap, said before they are called. */
function requireZoomRoom(manifest: EditManifest): void {
  if (manifest.zooms.length >= MAX_ZOOMS) throw new Error(`this post already has the maximum of ${MAX_ZOOMS} zooms`);
}

/** The look fields a zoom op may carry, each optional; the window goes through setZoomWindow. */
function zoomPatchOf(op: Record<string, unknown>): ZoomPatch {
  const patch: ZoomPatch = {};
  if (op['cx'] !== undefined) patch.cx = num(op, 'cx');
  if (op['cy'] !== undefined) patch.cy = num(op, 'cy');
  if (op['scale'] !== undefined) patch.scale = num(op, 'scale');
  if (op['rampMs'] !== undefined) patch.rampMs = num(op, 'rampMs');
  if (op['rampOutMs'] !== undefined) patch.rampOutMs = num(op, 'rampOutMs');
  if (op['ease'] !== undefined) patch.ease = oneOf(op, 'ease', ZOOM_EASES);
  if (op['chain'] !== undefined) patch.chain = bool(op, 'chain');
  return patch;
}

/** What [addOverlay] and [splitOverlayAt] answer `null` with, said before they are called. */
function requireLayerRoom(manifest: EditManifest): void {
  if (manifest.overlays.length >= MAX_LAYERS) throw new Error(`this post already has the maximum of ${MAX_LAYERS} layers`);
}

/* -------------------------------------------------------------------------------------------- */
/* The overlay an `add*` op builds                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * The fields every layer kind shares, with the defaults the editor's own sheets use: centred, full
 * size, upright, opaque, and on screen for the whole post.
 *
 * `endMs` of 0 is not "zero milliseconds", it is "until the end", so it is the right default rather
 * than a placeholder for one.
 */
function overlayCommon(op: Record<string, unknown>, id: string) {
  const animation = animationOf(op['animation']);
  return {
    id,
    cx: optionalNum(op, 'cx', 0.5),
    cy: optionalNum(op, 'cy', 0.5),
    scale: optionalNum(op, 'scale', 1),
    rotationDeg: optionalNum(op, 'rotationDeg', 0),
    opacity: optionalNum(op, 'opacity', 1),
    startMs: optionalNum(op, 'startMs', 0),
    endMs: optionalNum(op, 'endMs', 0),
    ...(animation ? { animation } : {}),
  };
}

/**
 * A layer's `animation` as an op gives it, or null for none. Every move's id is checked against the
 * catalogue and REFUSED when it is not in it: the manifest's own reader drops a move it cannot draw
 * without a word, which is right for a draft written by a newer build and wrong for an agent that
 * mistyped `pop`. The lengths are the normaliser's to clamp, the way the editor's sheet has them.
 */
function animationOf(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('"animation" must be an object or null');
  for (const part of ['in', 'out', 'loop'] as const) {
    const move = (value as Record<string, unknown>)[part];
    if (move === undefined || move === null) continue;
    if (typeof move !== 'object' || Array.isArray(move)) throw new Error(`"animation.${part}" must be an object`);
    const ids = OVERLAY_ANIMATIONS[part].map(preset => preset.id);
    const id = (move as Record<string, unknown>)['id'];
    if (typeof id !== 'string' || !ids.includes(id)) throw new Error(`"animation.${part}.id" must be one of ${ids.join(', ')}`);
  }
  return normaliseOverlayAnimation(value);
}

const TEXT_EFFECTS: readonly TextEffect[] = ['none', 'plate', 'plateSoft', 'outline', 'shadow'];
const TEXT_ALIGNS: readonly TextAlign[] = ['left', 'center', 'right'];
const FITS: readonly EditFit[] = ['contain', 'cover'];
const LAYER_MOVES: readonly LayerMove[] = ['forward', 'backward', 'front', 'back'];
const ASPECTS: readonly OutputAspect[] = ['9:16', '16:9'];

/* -------------------------------------------------------------------------------------------- */
/* The table                                                                                      */
/* -------------------------------------------------------------------------------------------- */

type Apply = (manifest: EditManifest, op: Record<string, unknown>) => EditManifest;

const OPS: Record<string, Apply> = {
  /* ---- the base track ---- */

  trimClip: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    return trimClip(manifest, clipId, num(op, 'inMs'), num(op, 'outMs'), num(op, 'sourceDurationMs'));
  },

  setClipSpeed: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    return setClipSpeed(manifest, clipId, num(op, 'speed'));
  },

  setClipVolume: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    return patchClip(manifest, clipId, { volume: num(op, 'volume') });
  },

  setClipTransition: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    const index = manifest.clips.findIndex(clip => clip.id === clipId);
    if (index < 0) throw new Error(`"${clipId}" is on a video track, and only the base track has transitions`);
    if (index === 0) throw new Error(`"${clipId}" is the first clip of the base track, so there is nothing for it to come in from`);
    return setClipTransition(manifest, clipId, transitionOf(op));
  },

  setAllTransitions: (manifest, op) => setAllTransitions(manifest, transitionOf(op)),

  setClipMuted: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    return patchClip(manifest, clipId, { muted: bool(op, 'muted') });
  },

  setClipFit: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    const fit = op['fit'] === null ? null : oneOf(op, 'fit', FITS);
    return setClipFit(manifest, clipId, fit);
  },

  setClipCrop: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    const raw = nullableObject(op, 'crop');
    return setClipCrop(manifest, clipId, raw === null ? null : readRect(raw, 'crop'));
  },

  setClipRect: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    const raw = nullableObject(op, 'rect');
    return setClipRect(manifest, clipId, raw === null ? null : readPlacement(raw, 'rect'));
  },

  setClipRotation: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    return setClipRotation(manifest, clipId, num(op, 'rotationDeg'));
  },

  resetClipFraming: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    return resetClipFraming(manifest, clipId);
  },

  splitClip: (manifest, op) => {
    const newId = str(op, 'newId');
    requireFreeClipId(manifest, newId);
    const atMs = num(op, 'atMs');
    const next = splitClipAt(manifest, atMs, newId);
    if (!next) {
      throw new Error(`nothing to split at ${atMs}ms - a split needs to land at least 200ms from both ends of a base clip`);
    }
    return next;
  },

  joinWithNext: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    const next = joinWithNext(manifest, clipId);
    if (!next) {
      throw new Error(`"${clipId}" cannot be joined to the one after it - they have to be the same source, ` + `at the same speed, and meet frame to frame`);
    }
    return next;
  },

  duplicateClip: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    const newId = str(op, 'newId');
    requireFreeClipId(manifest, newId);
    const next = duplicateClip(manifest, clipId, newId);
    if (!next) throw new Error(`"${clipId}" cannot be duplicated - the post is already at its length limit`);
    return next;
  },

  removeClip: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    const next = removeClip(manifest, clipId);
    if (!next) throw new Error(`"${clipId}" is the last clip of the base track, which fixes how long the post runs`);
    return next;
  },

  moveClip: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    return moveClip(manifest, clipId, num(op, 'toIndex'));
  },

  insertClip: (manifest, op) => {
    const clipKey = str(op, 'clipKey');
    const id = optionalStr(op, 'id') ?? clipKey;
    requireFreeClipId(manifest, id);
    const afterClipId = optionalStr(op, 'afterClipId') ?? null;
    if (afterClipId) requireClip(manifest, afterClipId);
    return insertClip(manifest, defaultClipEdit(clipKey, num(op, 'durationMs'), id), afterClipId);
  },

  /*
   * `false`, where the editor's own Replace defaults to true.
   *
   * Not an oversight and not a divergence that crept in: this is a programmatic op whose caller
   * states `sourceDurationMs` on purpose, so honouring it is the whole of what was asked. The
   * editor's Replace is a gesture over a segment somebody already sized, which is why it keeps
   * that size instead. Both go through the one implementation so neither can drift from it.
   */
  replaceClipSource: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    return replaceClipSource(manifest, clipId, str(op, 'clipKey'), num(op, 'sourceDurationMs'), false);
  },

  setPostDuration: (manifest, op) => setPostDuration(manifest, num(op, 'durationMs')),

  /* ---- video tracks over the base ---- */

  addVideoTrack: (manifest, op) => {
    const trackId = str(op, 'trackId');
    if (findVideoTrack(manifest, trackId)) throw new Error(`track id "${trackId}" is already on this post`);
    const clipKey = str(op, 'clipKey');
    const clipId = optionalStr(op, 'clipId') ?? clipKey;
    requireFreeClipId(manifest, clipId);
    const next = addVideoTrack(manifest, defaultClipEdit(clipKey, num(op, 'durationMs'), clipId), trackId);
    if (!next) throw new Error(`this post already has the maximum of ${MAX_VIDEO_TRACKS} video tracks, the base counted`);
    return next;
  },

  removeVideoTrack: (manifest, op) => {
    const trackId = str(op, 'trackId');
    requireTrack(manifest, trackId);
    return removeVideoTrack(manifest, trackId);
  },

  setTrackStart: (manifest, op) => {
    const trackId = str(op, 'trackId');
    requireTrack(manifest, trackId);
    return setTrackStart(manifest, trackId, num(op, 'startMs'));
  },

  setTrackOpacity: (manifest, op) => {
    const trackId = str(op, 'trackId');
    requireTrack(manifest, trackId);
    return setTrackOpacity(manifest, trackId, num(op, 'opacity'));
  },

  swapTrackZ: (manifest, op) => {
    const trackId = str(op, 'trackId');
    requireTrack(manifest, trackId);
    return swapTrackZ(manifest, trackId);
  },

  moveClipToTrack: (manifest, op) => {
    const clipId = str(op, 'clipId');
    requireClip(manifest, clipId);
    const target = readDropTarget(manifest, object(op, 'target'));
    const newTrackId = str(op, 'newTrackId');
    const next = moveClipToTrack(manifest, clipId, target, num(op, 'atMs'), newTrackId);
    if (!next) {
      throw new Error(
        `"${clipId}" cannot be moved there - the last clip of the base track may not leave it, a clip ` +
          `cannot be dropped back on the row it is already on, and a new track needs room under the ` +
          `limit of ${MAX_VIDEO_TRACKS}`,
      );
    }
    return next;
  },

  applyLayoutPreset: (manifest, op) => {
    const trackId = str(op, 'trackId');
    requireTrack(manifest, trackId);
    const ids = layoutPresets().map(preset => preset.id);
    const presetId = str(op, 'presetId');
    if (!ids.includes(presetId as LayoutPresetId)) throw new Error(`"presetId" must be one of ${ids.join(', ')}`);
    return applyLayoutPreset(manifest, trackId, presetId as LayoutPresetId);
  },

  /* ---- layers ---- */

  addText: (manifest, op) => {
    const id = str(op, 'id');
    requireFreeLayerId(manifest, id);
    requireLayerRoom(manifest);
    return added(manifest, {
      ...overlayCommon(op, id),
      kind: 'text',
      text: str(op, 'text'),
      styleId: optionalStr(op, 'styleId') ?? 'classic',
      color: optionalStr(op, 'color') ?? '#ffffff',
      effect: optionalOneOf(op, 'effect', TEXT_EFFECTS, 'none'),
      align: optionalOneOf(op, 'align', TEXT_ALIGNS, 'center'),
    });
  },

  addSticker: (manifest, op) => {
    const id = str(op, 'id');
    requireFreeLayerId(manifest, id);
    requireLayerRoom(manifest);
    const emoji = optionalStr(op, 'emoji') ?? null;
    const assetId = optionalStr(op, 'assetId') ?? null;
    // Exactly one, because the rasteriser draws an emoji with the device font and a sticker from a
    // file, and a layer carrying both says nothing about which picture was wanted.
    if ((emoji === null) === (assetId === null)) throw new Error('exactly one of "emoji" and "assetId" is needed');
    return added(manifest, { ...overlayCommon(op, id), kind: 'sticker', emoji, assetId });
  },

  addImage: (manifest, op) => {
    const id = str(op, 'id');
    requireFreeLayerId(manifest, id);
    requireLayerRoom(manifest);
    return added(manifest, {
      ...overlayCommon(op, id),
      kind: 'image',
      uri: str(op, 'uri'),
      fileName: optionalStr(op, 'fileName') ?? '',
      aspect: optionalNum(op, 'aspect', 1),
    });
  },

  addEffect: (manifest, op) => {
    const id = str(op, 'id');
    requireFreeLayerId(manifest, id);
    requireLayerRoom(manifest);
    return added(manifest, { ...overlayCommon(op, id), kind: 'effect', effectId: str(op, 'effectId') });
  },

  patchOverlay: (manifest, op) => {
    const id = str(op, 'id');
    requireOverlay(manifest, id);
    const patch = object(op, 'patch');
    // `kind` is what decides which of the four shapes a layer is, and changing it under the fields
    // that belong to the old one leaves a layer that is neither.
    if ('kind' in patch) throw new Error('a layer’s "kind" cannot be patched - remove it and add the kind you want');
    if ('id' in patch) throw new Error('a layer’s "id" cannot be patched');
    // Checked as an add checks it, on a copy rather than the caller's own object; null takes the
    // layer's moves away.
    const fields = 'animation' in patch ? { ...patch, animation: animationOf(patch['animation']) } : patch;
    return patchOverlay(manifest, id, fields as Record<string, unknown>);
  },

  removeOverlay: (manifest, op) => {
    const id = str(op, 'id');
    requireOverlay(manifest, id);
    return removeOverlay(manifest, id);
  },

  duplicateOverlay: (manifest, op) => {
    const id = str(op, 'id');
    requireOverlay(manifest, id);
    const newId = str(op, 'newId');
    requireFreeLayerId(manifest, newId);
    requireLayerRoom(manifest);
    const next = duplicateOverlay(manifest, id, newId);
    if (!next) throw new Error(`this post already has the maximum of ${MAX_LAYERS} layers`);
    return next;
  },

  moveLayer: (manifest, op) => {
    const id = str(op, 'id');
    requireOverlay(manifest, id);
    return moveLayer(manifest, id, oneOf(op, 'move', LAYER_MOVES));
  },

  moveLayerTo: (manifest, op) => {
    const id = str(op, 'id');
    requireOverlay(manifest, id);
    return moveLayerTo(manifest, id, num(op, 'toIndex'));
  },

  setOverlayWindow: (manifest, op) => {
    const id = str(op, 'id');
    requireOverlay(manifest, id);
    return setOverlayWindow(manifest, id, num(op, 'startMs'), num(op, 'endMs'), totalDurationMs(manifest));
  },

  splitOverlay: (manifest, op) => {
    const id = str(op, 'id');
    requireOverlay(manifest, id);
    const newId = str(op, 'newId');
    requireFreeLayerId(manifest, newId);
    requireLayerRoom(manifest);
    const atMs = num(op, 'atMs');
    const next = splitOverlayAt(manifest, id, atMs, newId, totalDurationMs(manifest));
    if (!next) throw new Error(`"${id}" cannot be split at ${atMs}ms - both halves need to be at least 100ms long`);
    return next;
  },

  /* ---- music and voiceover ---- */

  setMusic: (manifest, op) => {
    const raw = nullableObject(op, 'music');
    if (raw === null) return setMusic(manifest, null);
    const music: EditMusic = {
      uri: str(raw, 'uri'),
      fileName: optionalStr(raw, 'fileName') ?? '',
      sourceDurationMs: optionalNum(raw, 'sourceDurationMs', 0),
      inMs: optionalNum(raw, 'inMs', 0),
      outMs: optionalNum(raw, 'outMs', 0),
      startMs: optionalNum(raw, 'startMs', 0),
      volume: optionalNum(raw, 'volume', 1),
      loop: optionalBool(raw, 'loop', false),
      fadeOutMs: optionalNum(raw, 'fadeOutMs', 0),
    };
    return setMusic(manifest, music);
  },

  patchMusic: (manifest, op) => {
    if (!manifest.music) throw new Error('this post has no music to patch - use setMusic first');
    return patchMusic(manifest, object(op, 'patch') as Partial<EditMusic>);
  },

  addVoiceover: (manifest, op) => {
    const id = str(op, 'id');
    if (findVoiceover(manifest, id)) throw new Error(`voiceover id "${id}" is already on this post`);
    const take: EditVoiceover = {
      id,
      uri: str(op, 'uri'),
      startMs: num(op, 'startMs'),
      durationMs: num(op, 'durationMs'),
      volume: optionalNum(op, 'volume', 1),
    };
    const next = addVoiceover(manifest, take, totalDurationMs(manifest));
    if (!next) throw new Error(`there is no room at ${take.startMs}ms - takes never overlap, and a take runs at least 100ms`);
    return next;
  },

  patchVoiceover: (manifest, op) => {
    const id = str(op, 'id');
    requireVoiceover(manifest, id);
    return patchVoiceover(manifest, id, { volume: num(op, 'volume') });
  },

  moveVoiceover: (manifest, op) => {
    const id = str(op, 'id');
    requireVoiceover(manifest, id);
    return moveVoiceover(manifest, id, num(op, 'startMs'), totalDurationMs(manifest));
  },

  removeVoiceover: (manifest, op) => {
    const id = str(op, 'id');
    requireVoiceover(manifest, id);
    return removeVoiceover(manifest, id);
  },

  /* ---- zooms ---- */

  addZoom: (manifest, op) => {
    const id = str(op, 'id');
    requireFreeZoomId(manifest, id);
    requireZoomRoom(manifest);
    const startMs = num(op, 'startMs');
    const zoom: EditZoom = {
      id,
      startMs,
      endMs: optionalNum(op, 'endMs', startMs + DEFAULT_ZOOM_MS),
      cx: 0.5,
      cy: 0.5,
      scale: DEFAULT_ZOOM_SCALE,
      rampMs: DEFAULT_ZOOM_RAMP_MS,
      ease: 'smooth',
      ...zoomPatchOf(op),
    };
    const next = addZoom(manifest, zoom, totalDurationMs(manifest));
    if (!next) throw new Error(`there is no room for a zoom at ${startMs}ms - zooms never overlap, and a zoom runs at least ${MIN_ZOOM_MS}ms before the next one and the end`);
    return next;
  },

  updateZoom: (manifest, op) => {
    const id = str(op, 'id');
    requireZoom(manifest, id);
    return updateZoom(manifest, id, zoomPatchOf(op));
  },

  setZoomWindow: (manifest, op) => {
    const id = str(op, 'id');
    requireZoom(manifest, id);
    return setZoomWindow(manifest, id, num(op, 'startMs'), num(op, 'endMs'), totalDurationMs(manifest));
  },

  duplicateZoom: (manifest, op) => {
    const id = str(op, 'id');
    const newId = str(op, 'newId');
    requireZoom(manifest, id);
    requireFreeZoomId(manifest, newId);
    requireZoomRoom(manifest);
    const next = duplicateZoom(manifest, id, newId, totalDurationMs(manifest));
    if (!next) throw new Error(`there is no room for a copy right after zoom "${id}" - it needs ${MIN_ZOOM_MS}ms before the next zoom and the end`);
    return next;
  },

  deleteZoom: (manifest, op) => {
    const id = str(op, 'id');
    requireZoom(manifest, id);
    return deleteZoom(manifest, id);
  },

  /* ---- the look of the whole post ---- */

  setFilter: (manifest, op) => ({
    ...manifest,
    filterId: str(op, 'filterId'),
    filterIntensity: optionalNum(op, 'intensity', manifest.filterIntensity),
  }),

  setAdjust: (manifest, op) => {
    const patch = object(op, 'patch');
    const keys: (keyof EditAdjust)[] = ['brightness', 'contrast', 'saturation', 'warmth', 'tint', 'fade'];
    const adjust = { ...manifest.adjust };
    for (const key of Object.keys(patch)) {
      if (!keys.includes(key as keyof EditAdjust)) throw new Error(`"patch.${key}" is not an Adjust field`);
      adjust[key as keyof EditAdjust] = num(patch, key);
    }
    return { ...manifest, adjust };
  },

  setFit: (manifest, op) => ({ ...manifest, fit: oneOf(op, 'fit', FITS) }),

  setOriginalMuted: (manifest, op) => ({ ...manifest, originalMuted: bool(op, 'muted') }),

  /**
   * The frame the post renders at, either by the three choices the editor's sheet offers or by
   * pixels outright. The sheet's way is first because it is the one that cannot produce a frame no
   * encoder will take.
   */
  setOutput: (manifest, op) => {
    if (op['width'] !== undefined || op['height'] !== undefined) {
      return {
        ...manifest,
        output: normaliseOutput({
          width: num(op, 'width'),
          height: num(op, 'height'),
          fps: optionalNum(op, 'fps', manifest.output.fps),
        }),
      };
    }
    const aspect = optionalOneOf(op, 'aspect', ASPECTS, aspectOf(manifest.output));
    const qualityId = optionalStr(op, 'qualityId') ?? qualityOf(manifest.output).id;
    const fps = optionalNum(op, 'fps', manifest.output.fps);
    return { ...manifest, output: outputFor(aspect, qualityId, fps) };
  },
};

/**
 * Every op name there is, sorted - what the tool description lists and what the tests count.
 *
 * Frozen, because it is exported and `readonly` is a type, which a host written in plain JavaScript
 * never sees. It is also what [opNamesFor] hands every set of tools with Zoom on, as it is, so a
 * name pushed onto it from outside would turn up in the catalogue of servers that had already told
 * their agents which ops there are.
 */
export const OP_NAMES: readonly string[] = Object.freeze(Object.keys(OPS).sort());

/* -------------------------------------------------------------------------------------------- */
/* What the host has turned off                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * The editor's `editing` options, taken whole, of which this server reads `zoom` and nothing else.
 *
 * Whole rather than picked, so that a host can pass on the setting it already has however it
 * writes it. A `Pick` of `zoom` alone took a variable holding the editor's object and refused the
 * same object written out in place - `{ pictures: true, zoom: false }` is an object literal with a
 * property too many to TypeScript - which is exactly how an app writes its editor's settings, and
 * what the README tells a host to hand over.
 *
 * The other two have no op to govern, and are taken and left unread. `replaceKeepsLength` decides
 * what the Replace GESTURE does to a segment somebody already sized, and `replaceClipSource` is not
 * that gesture: its caller states the length outright (see the note on the op). `pictures` decides
 * what the clip pickers offer, and there is no picker here: `insertClip` and `addVideoTrack` put a
 * source down by its key, as footage. `zoom` is different in kind: it decides whether a post may
 * hold a kind of edit at all, and on this server, off, the answer is that it may not.
 */
export type McpEditingOptions = EditorEditingOptions;

export interface EditOpsOptions {
  /**
   * The host's settings. Absent, or a field absent, is the editor's own default: every op is there.
   *
   * `zoom: false` refuses the five zoom ops, and that is all it does here. The manifest the ops are
   * applied to is not judged: a zoom already in it comes back where it was, untouched. The server
   * never hands this function such a manifest, because its tools refuse one at the door before an
   * op runs - but that door is in `tools.ts`, not here. A host that builds a tool of its own on
   * this function, with Zoom off, has to refuse a manifest that holds a zoom itself: `refuseZooms`,
   * exported from `capacitor-video-kit/mcp` beside this, is the tools' own door, for it to call on
   * the normalised manifest before handing it over.
   */
  editing?: McpEditingOptions;
}

/**
 * The zoom ops, all five, which are the ones an app with Zoom off refuses.
 *
 * All five, where the editor takes away only its two ways to ADD one - the Zoom tile, and Duplicate
 * on a selected zoom's row - and leaves a zoom an old draft carries changeable and deletable. The
 * editor can afford to: a person can only use the tools on screen, so every zoom in front of them
 * came from a draft. An agent writes JSON, and a zoom it typed into a manifest is the same object as
 * one a draft saved, so the tools refuse a manifest that holds any zoom at the door (`tools.ts`
 * says so at length). With no post on the server holding a zoom, `updateZoom`, `setZoomWindow` and
 * `deleteZoom` have nothing to act on, and are refused and left out of the list with the other two
 * rather than offered as ops that can only ever fail.
 *
 * No other op can make a zoom. Every other entry in the table answers with a manifest built as
 * `{ ...manifest, ...what it changed }`, and it gets there one of two ways. Most call the editor
 * function the editor's own control calls. The five that set something on the whole post -
 * `setFilter`, `setAdjust`, `setFit`, `setOriginalMuted` and `setOutput` - have no such function in
 * `edit-ops.ts` to call, so they spread the manifest right here and set the field or two they own
 * (`setFilter` sets the filter and its intensity), the way the editor's store does for the same
 * controls. Neither way touches `zooms`: splitting,
 * duplicating and moving clips copy clips, the layer ops copy layers, the two open-ended patches
 * land on one layer (`patchOverlay`) or on the music (`patchMusic`), never on the manifest, and the
 * five each name the fields they set. `zooms` rides through every one of them as the very array
 * it came in as, which on this server is empty. The tests run every op there is over a post with no
 * zoom to keep that true, and [applyEditOps] checks it on every op anyway, because a check is what
 * survives the day somebody adds an op that copies a template's zooms in with its clips.
 *
 * Frozen for the reason [OP_NAMES] is, with more riding on it: [applyEditOps] reads this list on
 * every call to decide what it refuses, so emptied from outside it would let every server in the
 * process with Zoom off take zoom ops again, while each one's `manifest_edit` description, settled
 * when its tools were built, still told its agent there were none.
 */
export const ZOOM_OPS: readonly string[] = Object.freeze([
  'addZoom',
  'deleteZoom',
  'duplicateZoom',
  'setZoomWindow',
  'updateZoom',
]);

/**
 * Whether these settings leave Zoom on. Only an explicit `false` takes it away, which is the rule
 * `resolveEditorHost` applies for the editor: a host that has never heard of the setting keeps what
 * it has always had.
 */
export function zoomOffered(editing?: McpEditingOptions): boolean {
  return editing?.zoom !== false;
}

/** The ops these settings leave an agent, sorted: [OP_NAMES] less whatever the host turned off. */
export function opNamesFor(editing?: McpEditingOptions): readonly string[] {
  return zoomOffered(editing) ? OP_NAMES : OP_NAMES.filter((name) => !ZOOM_OPS.includes(name));
}

/*
 * Written for the agent, which did nothing wrong: the op is a real one, and it is this app that does
 * not take it. So the message says whose decision it was, and that there is nothing to do about it
 * but leave zooms out, so the next attempt is not the same op with its values changed.
 */
function zoomOffMessage(name: string): string {
  const why =
    name === 'addZoom'
      ? 'none can be added'
      : name === 'duplicateZoom'
        ? 'a copy of one would be a new zoom'
        : `there is no zoom for ${name} to act on`;
  return (
    `zoom is turned off for this app, so no post on this server holds a zoom, and ${why}. ` +
    'Leave zooms out of the edit: the app’s editor offers none.'
  );
}

/**
 * Whether `after` holds a zoom `before` did not, by object rather than by id: an op that is not a
 * zoom op carries `zooms` through as the same array holding the same objects, so any zoom object
 * that was not there before is one the op made, whatever id it wears.
 */
function gainedZoom(before: EditManifest, after: EditManifest): boolean {
  const had = new Set<unknown>(before.zooms ?? []);
  return (after.zooms ?? []).some((zoom) => !had.has(zoom));
}

/* -------------------------------------------------------------------------------------------- */

/**
 * Applies a list of ops in order, each one to what the one before it left.
 *
 * Nothing is applied in place and nothing is applied halfway: a list that fails at op 5 leaves the
 * caller's manifest exactly as it was, because the four that succeeded only ever built new objects
 * on the way to a value this function then does not return.
 *
 * `options.editing` is read on every call rather than set anywhere once. The table above is shared
 * by everything in the process, and two servers in one process - which the tests are, and which a
 * host serving two apps would be - must not be able to change what the other one allows. A refused
 * op is refused before any of its values are read, so an agent is never told to fix an id on an op
 * that was never going to be taken, and it fails the whole list like any other refusal.
 *
 * With Zoom off it refuses the zoom ops, and it checks after every other op that the op put no zoom
 * in ([ZOOM_OPS] says why none can). It does not judge the manifest it is handed: that is the
 * caller's, and the tools judge it at the door before it gets here. A host calling this directly
 * with a draft that holds a zoom gets that zoom back where it was, untouched and unreachable - so a
 * host whose own tool calls this refuses such a draft first, with `refuseZooms` from `tools.ts`
 * ([EditOpsOptions.editing] has the whole of it).
 */
export function applyEditOps(manifest: EditManifest, ops: readonly EditOp[], options: EditOpsOptions = {}): EditManifest {
  const zoom = zoomOffered(options.editing);
  let current = manifest;
  for (const [index, op] of ops.entries()) {
    const name = typeof op?.op === 'string' ? op.op : '';
    // Its own properties only. The table is a plain object, and `constructor` or `toString` is a
    // property of every one without being an op: looked up as one, the first did nothing and the
    // second handed back a string as the manifest.
    const apply = Object.hasOwn(OPS, name) ? OPS[name] : undefined;
    if (!apply) {
      // The ops THIS caller has, so an app with Zoom off never lists addZoom as a way out.
      throw new EditOpError(name || '(missing)', index, `unknown op. The ops there are: ${opNamesFor(options.editing).join(', ')}`);
    }
    if (!zoom && ZOOM_OPS.includes(name)) throw new EditOpError(name, index, zoomOffMessage(name));
    let next: EditManifest;
    try {
      next = apply(current, op as Record<string, unknown>);
    } catch (error) {
      if (error instanceof EditOpError) throw error;
      throw new EditOpError(name, index, error instanceof Error ? error.message : String(error));
    }
    // Outside the try, so it is not re-wrapped as though the agent's values were at fault. If this
    // ever fires, the op table has grown an op that copies zooms in from somewhere, and the list is
    // refused whole rather than the zoom quietly taken back out of a post the agent will read.
    if (!zoom && gainedZoom(current, next)) {
      throw new EditOpError(
        name,
        index,
        'this op put a zoom into the post while Zoom is turned off for this app. That is a bug in ' +
          'capacitor-video-kit, not in the edit; nothing was applied.',
      );
    }
    current = next;
  }
  return current;
}

/* -------------------------------------------------------------------------------------------- */

/** [addOverlay] only answers `null` for a full post, and the caller has already ruled that out. */
function added(manifest: EditManifest, overlay: EditOverlay): EditManifest {
  const next = addOverlay(manifest, overlay);
  if (!next) throw new Error(`this post already has the maximum of ${MAX_LAYERS} layers`);
  return next;
}

function readDropTarget(manifest: EditManifest, raw: Record<string, unknown>): ClipDropTarget {
  const kind = oneOf(raw, 'kind', ['base', 'track', 'new'] as const);
  if (kind === 'base') return { kind: 'base' };
  if (kind === 'new') return { kind: 'new', index: num(raw, 'index') };
  const trackId = str(raw, 'trackId');
  requireTrack(manifest, trackId);
  return { kind: 'track', trackId };
}
