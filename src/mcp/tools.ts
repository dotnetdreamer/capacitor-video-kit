/**
 * The five tools, their schemas and what they do, with no MCP SDK anywhere in the file.
 *
 * `server.ts` is the only module that imports the SDK, and it does nothing but hand this table to
 * it. That split is not tidiness: the SDK is an optional dependency this package may be built
 * entirely without (see `tsconfig.mcp.json` and `scripts/build-mcp.mjs`), and the tests below this
 * file run the tools directly, so the behaviour is tested in a Node process that has never opened a
 * transport or spoken a line of protocol.
 *
 *
 * WHAT THESE TOOLS DO AND DO NOT DO
 *
 * They build and change an `EditManifest`, which is the document the editor's UI produces and the
 * one thing the Swift and Kotlin engines are written against. They do not render. Rendering is
 * `toComposeSpec` plus a `RasterContext`, and a raster context is a canvas: text is measured with a
 * loaded web font, stickers and photos are decoded, and every layer comes back as a PNG. None of
 * that exists in a Node process, and faking it would produce a video that did not match what the
 * customer saw, which is the one promise the rasteriser exists to keep.
 *
 * So the division is real rather than a first cut: everything an edit IS can be done here, and the
 * last step - turning it into pixels - belongs to the device that has the screen it was edited on.
 * A manifest built here is handed to `<ve-editor>` through its `manifest` property, or straight to
 * `toComposeSpec` in the app, and renders exactly as one built by dragging.
 *
 *
 * THE STORE
 *
 * A manifest is 200-odd lines of JSON and an edit is usually a dozen ops, so a stateless server
 * would spend most of its tokens on an agent posting the same document back and forth. The tools
 * therefore keep manifests under short ids, and every tool that reads one takes EITHER a
 * `manifestId` or an inline `manifest`. Inline is not a fallback: it is how an agent picks up a
 * manifest the app already has, and how an app's saved draft is edited without being imported
 * first. What comes back is always stored, so the answer to an inline call is an id the next op can
 * use.
 *
 * The store is per server instance and lives in memory. It is a working surface, not a database:
 * the manifest that matters is the one the agent has taken away. What it keeps are copies of its
 * own, never an object a caller holds, so a host running the server in its own process can do as
 * it likes with an answer, or with what it sent, without touching the post stored from it
 * ([ManifestStore] says why the copy is made where it is).
 *
 *
 * WHAT THE HOST HAS TURNED OFF
 *
 * An app that turns Zoom off in its editor (`editing.zoom`) turns it off here with the same setting,
 * and here the rule is one sentence: while Zoom is off, no post on this server holds a zoom.
 *
 * Nothing can bring one in. Every zoom op is refused and left out of everything an agent reads about
 * what it can do - `ops.ts` says why that is all five, and why no other op can make one. Every tool
 * that takes a manifest whole - `manifest_inspect`, `manifest_validate` and `manifest_edit`, the
 * three with a `manifest` argument - refuses one that holds a zoom, saying so, before anything is
 * stored and before any op runs. What is judged is the manifest as `normaliseManifest` leaves it,
 * the very object the store would keep, so no spelling or shape of the field slips past: no `zooms`
 * at all, an empty list and entries the normaliser drops as meaningless are all a post with no zoom,
 * and anything that survives it as a zoom is refused. And every result that hands back or stores a
 * manifest checks that it holds none. That last one cannot fire unless the two before it are
 * broken, so when it does it says it is a bug and fails the call, rather than quietly taking the
 * zoom back out of a post the agent is about to read.
 *
 * The door is these tools', not the ops': [applyEditOps] refuses the zoom ops and leaves a zoom it
 * is handed where it was. A host that builds a tool of its own on `applyEditOps` therefore adds the
 * door itself, with [refuseZooms], which is exported for that.
 *
 * That is STRICTER than the editor, on purpose. The editor with Zoom off takes away its two ways to
 * add a zoom and still shows, edits and deletes one an old draft carries, and it can afford to: a
 * person can only use the tools on screen, so any zoom in front of them came from a draft. An agent
 * writes JSON. A zoom it typed into a manifest is the same object as one a draft saved - the same
 * fields, and no history to tell the two apart - so a server that kept a draft's zoom would keep the
 * agent's as well, and all a host could do was compare the zoom ids that came back with the ones it
 * handed out, which an agent beats by reusing an id. Holding no zoom at all is the rule that has no
 * such hole. What it costs is a draft saved before the app turned Zoom off that still holds one:
 * the agent is told to take the zoom out before it can work on the post, where the editor would
 * have kept it.
 *
 * With Zoom on, the default, none of this runs, and a manifest's zooms go through every tool exactly
 * as they always have. The setting is per set of tools, like the store, and for the same reason.
 */
import {
  DEFAULT_OUTPUT,
  FILTER_CATEGORIES,
  FILTER_PRESETS,
  MANIFEST_VERSION,
  MAX_LAYERS,
  MAX_POST_MS,
  MAX_VIDEO_TRACKS,
  MIN_CLIP_MS,
  MIN_LAYER_MS,
  MAX_ZOOMS,
  MAX_ZOOM_RAMP_MS,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_MS,
  MIN_ZOOM_SCALE,
  ZOOM_CHAIN_GAP_MS,
  OUTPUT_FPS,
  OUTPUT_QUALITIES,
  defaultClipEdit,
  emptyManifest,
  normaliseManifest,
  outputFor,
  totalDurationMs,
  type EditManifest,
} from '../editor/edit-manifest';
import { insertClip } from '../editor/edit-ops';
import { EFFECT_CATEGORIES, EFFECT_PRESETS } from '../editor/effects';
import { layoutPresets } from '../editor/layout-presets';
import { DEFAULT_TRANSITION_MS, MAX_TRANSITION_MS, MIN_TRANSITION_MS, TRANSITIONS, TRANSITION_CATEGORIES } from '../editor/transitions';
import { DEFAULT_TEXT_STYLE_ID, TEXT_STYLES, TEXT_STYLE_CATEGORIES } from '../data/text-styles';
import { applyEditOps, opNamesFor, zoomOffered, type EditOp, type McpEditingOptions } from './ops';
import { summariseManifest } from './summary';

/* -------------------------------------------------------------------------------------------- */
/* What a tool is                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/** A JSON Schema object, hand written. Loose on purpose: this is handed to the client as-is. */
export type JsonSchema = Record<string, unknown>;

/**
 * Exactly the shape MCP's `CallToolResult` wants, so `server.ts` can return one unchanged.
 *
 * A `type` rather than an `interface`, and it has to stay one: the SDK's result type carries an
 * index signature, and TypeScript gives an anonymous object type an implicit one while an interface
 * never gets one. Written as an interface this is unassignable to `CallToolResult`, and the error
 * says only that a string index signature is missing, which is not a sentence that leads anywhere.
 */
export type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** MCP's hints. `readOnlyHint` is the one that matters: three of these five change nothing. */
  annotations: { readOnlyHint: boolean; idempotentHint?: boolean };
  run(args: Record<string, unknown>): ToolResult;
}

/** Thrown by a tool for input it will not act on. `server.ts` turns it into an MCP tool error. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/* -------------------------------------------------------------------------------------------- */
/* The store                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * The manifests this set of tools holds, each one a copy that nothing outside the store holds.
 *
 * Over stdio an answer is text, and nobody can reach back into the store through it. A host that
 * runs the server in its own process cannot say the same: it calls `run` itself, or goes through an
 * SDK client on `InMemoryTransport`, which hands objects across as they are, and either way it
 * holds the very object the call answered with. When that object was the stored one, a host that
 * changed its answer changed the post under that id, behind every check here - and with Zoom off
 * could leave a zoom in the store that only [requireNoZoom] would find, a call later, as a bug.
 *
 * So [put] keeps a copy, and the copy is made on the way IN rather than on the way out, for the
 * same price: every answer that carries a manifest also stores it, so either way is one copy per
 * answer. In is the one that also cuts the store loose from what a caller SENDS, and that is real:
 * `patchOverlay` and `patchMusic` spread an op's patch onto the post as it was handed over, and the
 * normaliser carries a few fields through as it finds them, so the manifest a call builds can hold
 * the caller's own objects. What goes out is then never what is stored. [get] hands the stored copy
 * to the ops, which build a new manifest rather than change the one they are given, and to
 * [manifestResult], which puts a fresh copy under the same id as it answers - so the object it
 * hands back stopped being the store's in the same step.
 *
 * Not a frozen copy, which would cost more and give less: it has to be made on every answer just
 * the same and then walked a second time to freeze it, and it hands an in-process host an answer
 * that throws the moment the host edits it, when the answer is the host's to edit.
 *
 * A JSON copy rather than a structured clone, because a manifest is a JSON document - it is what an
 * app saves and what stdio carries - and this is the copy that saving and sending make: the store
 * holds exactly what an agent over the wire would be handed back.
 */
class ManifestStore {
  private readonly manifests = new Map<string, EditManifest>();
  private next = 1;

  put(manifest: EditManifest, id?: string): string {
    const key = id ?? `m${this.next++}`;
    this.manifests.set(key, JSON.parse(JSON.stringify(manifest)) as EditManifest);
    return key;
  }

  get(id: string): EditManifest {
    const manifest = this.manifests.get(id);
    if (!manifest) {
      const known = [...this.manifests.keys()];
      throw new ToolError(
        `no manifest "${id}" is open${known.length > 0 ? ` - open ids: ${known.join(', ')}` : ''}. ` +
          'Pass the manifest inline as "manifest" instead, or start one with manifest_create.',
      );
    }
    return manifest;
  }

  ids(): string[] {
    return [...this.manifests.keys()];
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Shared schema fragments                                                                        */
/* -------------------------------------------------------------------------------------------- */

/*
 * Said wherever an agent is told it may hand a manifest in whole, when Zoom is off, so the first it
 * hears of the rule is not the refusal.
 */
const ZOOM_OFF_MANIFEST =
  ' Zoom is turned off for this app, so a manifest that holds a zoom is refused: leave "zooms" empty.';

/*
 * The two ways in, on every tool that reads a manifest. Neither is `required`, because exactly one
 * of them is, and JSON Schema says that with `oneOf`, which enough clients render badly that the
 * pair is better spelled out in the description and checked in `resolve` below.
 */
function manifestInput(editing: McpEditingOptions): Record<string, JsonSchema> {
  return {
    manifestId: {
      type: 'string',
      description: 'An id returned by an earlier call. Use this OR "manifest", not both.',
    },
    manifest: {
      type: 'object',
      description:
        'A manifest passed in whole, for one the server has not seen. Any version this package has ' +
        'ever written is accepted and brought up to date. Use this OR "manifestId".' +
        (editing.zoom ? '' : ZOOM_OFF_MANIFEST),
    },
  };
}

/**
 * The door, with Zoom off: a manifest handed in whole that holds a zoom goes no further.
 *
 * Given the manifest AFTER `normaliseManifest`, never the raw input, because that is the object that
 * would be stored and edited, and the normaliser is the one place that decides what the field means:
 * `"zooms": {}`, an entry with no numeric window or one too short to keep are no zoom to it, and are
 * none here, while an entry with no id, a duplicated id or a scale out of range is read into a zoom
 * there - so it is one here, and refused. Judging the raw JSON instead would be a second opinion
 * about what a zoom is, and the two would disagree the first time the normaliser learned a new
 * spelling.
 *
 * The message is written for an agent that may have been handed a draft rather than have written the
 * zoom itself, so it says whose rule it is and exactly what to change, and nothing about fault.
 *
 * Exported, because the door is here and not in [applyEditOps]. With Zoom off that function refuses
 * the five zoom ops and nothing more: a zoom already in the manifest it is given comes back where it
 * was. So a host that builds a tool of its own on `applyEditOps` has no door unless it adds one, and
 * this is the one to add - called on the manifest `normaliseManifest` gives it, the one it is about
 * to hand `applyEditOps`, it throws the same [ToolError] in the same words as these tools.
 *
 * Handed a manifest that was never normalised, it errs the safe way rather than guessing: any
 * non-empty `zooms` list is refused, entries the normaliser would have dropped included, and
 * anything that is not a list is let by, which the normaliser reads as no zoom too. So it can refuse
 * more than the tools would, never less. Read as `unknown` for that reason, and because a host in
 * plain JavaScript can hand it anything.
 */
export function refuseZooms(manifest: EditManifest): void {
  const zooms: unknown = (manifest as { zooms?: unknown } | null | undefined)?.zooms;
  if (!Array.isArray(zooms) || zooms.length === 0) return;
  const count = zooms.length;
  const ids = zooms
    .map((zoom: { id?: unknown } | null) => (typeof zoom?.id === 'string' ? `"${zoom.id}"` : 'one with no id'))
    .join(', ');
  throw new ToolError(
    `Zoom is turned off for this app, and this manifest holds ${count === 1 ? '1 zoom' : `${count} zooms`} ` +
      `(${ids}). Take ${count === 1 ? 'it' : 'them'} out - "zooms": [] - and pass the manifest again: ` +
      'while Zoom is off no post on this server holds a zoom, and the app’s editor offers none.',
  );
}

/**
 * The same rule checked on the way OUT, as an invariant rather than a door.
 *
 * Every manifest a tool answers with came in through [refuseZooms] or was built here from nothing,
 * and every op that could put a zoom in is refused, so this cannot fire unless one of those is
 * broken. That is the case it is for: it fails the call and says it is a bug, and the store never
 * takes the manifest. Stripping the zoom instead would hand the agent a post that differs from the
 * one its ops made, with nothing to say why, and would hide the bug from whoever could fix it.
 *
 * Read as `unknown` because it is a check on what the type promises, not a use of it: a `zooms`
 * that is not an array at all is not a post with no zoom either.
 */
function requireNoZoom(manifest: EditManifest): void {
  const zooms: unknown = manifest.zooms;
  const held = Array.isArray(zooms) ? zooms.length : zooms === undefined || zooms === null ? 0 : 1;
  if (held === 0) return;
  throw new ToolError(
    `internal error: this answer would hold ${held === 1 ? 'a zoom' : `${held} zooms`} while Zoom is turned ` +
      'off for this app, which nothing here should be able to produce. That is a bug in ' +
      'capacitor-video-kit, not in the request; the manifest was not stored.',
  );
}

/**
 * The id, the manifest and its summary: what every tool that produces a manifest answers with, and
 * the one place a manifest is stored, so the check on the way out is made here, before `put`.
 *
 * It is also the one way a manifest leaves these tools, which is what lets the store's copy be made
 * once, in `put`: the `manifest` handed back is the one the call built, and the store keeps its own
 * copy of it, so nothing a caller does to its answer reaches the post under `manifestId`. A tool
 * added later that answers with a stored manifest has to come through here for that to hold.
 */
function manifestResult(
  store: ManifestStore,
  editing: McpEditingOptions,
  manifest: EditManifest,
  id?: string,
  note?: string,
): ToolResult {
  if (!editing.zoom) requireNoZoom(manifest);
  const manifestId = store.put(manifest, id);
  const summary = summariseManifest(manifest, { editing });
  return {
    content: [{ type: 'text', text: note ? `${note}\n\n${summary}` : summary }],
    structuredContent: { manifestId, manifest: manifest as unknown as Record<string, unknown> },
  };
}

/**
 * `manifestId` or `manifest`, and the id to write the answer back to if there was one.
 *
 * Only the inline manifest goes through [refuseZooms]. One named by id is one this set of tools
 * stored, through [manifestResult], under the same setting it is read with now, and a copy nobody
 * outside the store has held since ([ManifestStore] says why that matters).
 */
function resolve(
  store: ManifestStore,
  editing: McpEditingOptions,
  args: Record<string, unknown>,
): { manifest: EditManifest; id?: string } {
  const id = args['manifestId'];
  const inline = args['manifest'];
  if (typeof id === 'string' && id.length > 0) {
    if (inline !== undefined) throw new ToolError('pass "manifestId" or "manifest", not both');
    return { manifest: store.get(id), id };
  }
  if (inline !== undefined && inline !== null) {
    if (typeof inline !== 'object' || Array.isArray(inline)) throw new ToolError('"manifest" must be an object');
    // Normalised rather than trusted: an inline manifest may be an older version, hand written, or
    // one an agent edited as plain JSON, and `normaliseManifest` is the only thing that knows what
    // each of those has to become.
    const manifest = normaliseManifest(inline);
    if (!editing.zoom) refuseZooms(manifest);
    return { manifest };
  }
  throw new ToolError('one of "manifestId" or "manifest" is needed');
}

/* -------------------------------------------------------------------------------------------- */
/* The op reference                                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * What each op reads, one line each.
 *
 * It is here rather than in the `manifest_edit` schema because forty ops fully typed would be a
 * schema an order of magnitude larger than every other tool in this server put together, sent to
 * the client on every tools/list whether an edit is coming or not. So the schema says "an op is an
 * object with a known name" and this table is served by `catalog_list`, which an agent calls once
 * when it needs it.
 *
 * A test asserts this covers exactly [OP_NAMES]. Adding an op without a line here fails it.
 *
 * It is the whole table, whatever a host has turned off. `catalog_list` serves each set of tools a
 * copy that leaves out the ops its host refuses ([opReferenceFor]), and never touches this one: it
 * is exported, and a host that turned Zoom off for one server must not take `addZoom`'s line away
 * from another server in the same process, or from anything else reading it.
 */
export const OP_REFERENCE: Record<string, string> = {
  /* the base track */
  trimClip: 'clipId, inMs, outMs, sourceDurationMs - sets the part of the source this clip plays.',
  setClipSpeed: 'clipId, speed (0.25..4) - pitch is preserved.',
  setClipVolume: 'clipId, volume (0..1).',
  setClipTransition:
    'clipId, transition ({kind, durationMs?} or null) - how this base clip takes over from the one before it; ' +
    'see the "transitions" section. The two clips overlap, so the post gets that much shorter.',
  setAllTransitions: 'transition ({kind, durationMs?} or null) - the same transition on every boundary of the base track.',
  setClipMuted: 'clipId, muted - drops this clip’s sound whatever its volume says.',
  setClipFit: 'clipId, fit ("contain" | "cover" | null) - null falls back to the post’s own fit.',
  setClipCrop: 'clipId, crop ({x,y,w,h} in 0..1 of the source frame, or null for all of it).',
  setClipRect: 'clipId, rect ({x,y,w,h,rotationDeg?} on the output frame, or null for the whole frame).',
  setClipRotation: 'clipId, rotationDeg - clockwise, about the placement rectangle’s centre.',
  resetClipFraming: 'clipId - takes the crop, the rectangle and the per-clip fit back off.',
  splitClip: 'atMs, newId - cuts the base clip at that point on the output timeline in two.',
  joinWithNext: 'clipId - undoes a split; only for two halves of one source that still meet.',
  duplicateClip: 'clipId, newId - the copy lands directly after the original.',
  removeClip: 'clipId - refuses the last clip of the base track.',
  moveClip: 'clipId, toIndex - reorders within the row the clip is on.',
  insertClip: 'clipKey, durationMs, id?, afterClipId? - appends when afterClipId is left out.',
  replaceClipSource: 'clipId, clipKey, sourceDurationMs - keeps the clip, swaps the footage under it.',
  setPostDuration: 'durationMs - holds the post open past the base track; black after it ends.',

  /* video tracks */
  addVideoTrack: 'clipKey, durationMs, trackId, clipId? - opens a new video layer over the base.',
  removeVideoTrack: 'trackId.',
  setTrackStart: 'trackId, startMs - where the whole layer begins on the output timeline.',
  setTrackOpacity: 'trackId, opacity (0..1).',
  swapTrackZ: 'trackId - swaps this layer with the one above it.',
  moveClipToTrack:
    'clipId, target ({kind:"base"} | {kind:"track",trackId} | {kind:"new",index}), atMs, newTrackId - ' +
    'newTrackId is only used when the target is "new".',
  applyLayoutPreset: 'trackId, presetId - see the "layouts" section for the ids.',

  /* layers */
  addText:
    'id, text, styleId?, color?, effect?, align?, and the layer fields cx, cy, scale, rotationDeg, ' +
    'opacity, startMs, endMs. endMs of 0 means "to the end of the post".',
  addSticker: 'id, exactly one of emoji or assetId, plus the layer fields.',
  addImage: 'id, uri, fileName?, aspect?, plus the layer fields.',
  addEffect: 'id, effectId, plus the layer fields. opacity is the effect’s strength.',
  patchOverlay: 'id, patch - any of the layer’s own fields except id and kind.',
  removeOverlay: 'id.',
  duplicateOverlay: 'id, newId.',
  moveLayer: 'id, move ("forward" | "backward" | "front" | "back") - drawing order.',
  moveLayerTo: 'id, toIndex.',
  setOverlayWindow: 'id, startMs, endMs - when the layer is on screen.',
  splitOverlay: 'id, atMs, newId - two layers where there was one.',

  /* sound */
  setMusic: 'music ({uri, fileName?, sourceDurationMs?, inMs?, outMs?, startMs?, volume?, loop?, fadeOutMs?}) or null.',
  patchMusic: 'patch - any of the music fields. Fails when the post has no music yet.',
  addVoiceover: 'id, uri, startMs, durationMs, volume? - takes never overlap.',
  patchVoiceover: 'id, volume.',
  moveVoiceover: 'id, startMs - held clear of the takes either side.',
  removeVoiceover: 'id.',

  /* zooms */
  addZoom:
    'id, startMs, endMs? (default startMs + 3000), cx?, cy? (centre of the area, 0..1 of the frame), scale? (1.1..4, default 2), ' +
    'rampMs? (0..2000, the move in and again out, inside the window; 0 is a cut), ease? ("smooth" | "snappy" | "steady") - ' +
    'the camera closes in on that area of the VIDEO (text and stickers stay put). Zooms never overlap; shortened to fit before the next one.',
  updateZoom: 'id, and any of cx, cy, scale, rampMs, ease.',
  setZoomWindow: 'id, startMs, endMs - held between the zooms either side and the end. Zooms under 1s apart pan from one area to the next.',
  duplicateZoom: 'id, newId - a copy straight after the original.',
  deleteZoom: 'id.',

  /* the whole post */
  setFilter: 'filterId, intensity? (0..1) - see the "filters" section.',
  setAdjust: 'patch - any of brightness, contrast, saturation, warmth, tint (each -1..1), fade (0..1).',
  setFit: 'fit ("contain" | "cover") - the post’s fit, and the default for a clip with none.',
  setOriginalMuted: 'muted - mutes every clip’s own sound, leaving music and voiceover alone.',
  setOutput:
    'either aspect? ("9:16" | "16:9"), qualityId? and fps?, or width and height outright with fps?. ' +
    'Anything left out keeps what the post has.',
};

/** [OP_REFERENCE] as these settings leave it: a copy, in the same order, without the refused ops. */
function opReferenceFor(opNames: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(OP_REFERENCE).filter(([name]) => opNames.includes(name)));
}

/* -------------------------------------------------------------------------------------------- */
/* The tools                                                                                      */
/* -------------------------------------------------------------------------------------------- */

const CATALOG_SECTIONS = ['filters', 'effects', 'transitions', 'layouts', 'textStyles', 'output', 'ops', 'limits'] as const;
type CatalogSection = (typeof CATALOG_SECTIONS)[number];

/*
 * What `manifest_edit`'s description and `catalog_list`'s `ops` say with Zoom off, in the same words
 * in both, since an agent may read either one first and must not come away with two stories.
 */
const ZOOM_OFF_OPS =
  'Zoom is turned off for this app, so there are no zoom ops: no post here holds a zoom, and a ' +
  'manifest passed in with one is refused.';

export interface VideoKitToolsOptions {
  /**
   * The host's editing settings, as its editor takes them - pass the same object, held in a
   * variable or written out in place with the editor's other fields beside `zoom`. Only `zoom` is
   * read ([McpEditingOptions] says why the others have nothing to govern here), and it defaults to
   * on exactly as the editor's does:
   *
   * ```ts
   * createTools({ editing: { pictures: false, zoom: false } });
   * ```
   *
   * Off, no post these tools hold has a zoom. Every zoom op is refused and left out of the op list
   * in `manifest_edit`'s description and schema and of `catalog_list`, the zoom limits and the
   * summary's "Zooms: none" go with them, and a manifest handed in whole that holds a zoom is
   * refused before it is stored - whether a saved draft put the zoom there or the agent wrote it
   * into the JSON itself, since nothing tells the two apart. That is stricter than the editor, and
   * the header of this file says why.
   */
  editing?: McpEditingOptions;
}

/**
 * Builds the five tools over a store of their own.
 *
 * A function rather than a constant because the store is state: two servers in one process, which
 * is what the tests are, must not be able to see each other's manifests. What the host has turned
 * off is held the same way, per call, for the same reason.
 */
export function createTools(options: VideoKitToolsOptions = {}): ToolDefinition[] {
  const store = new ManifestStore();

  /*
   * Settled once, here, into an object of this function's own. The op list is written into
   * `manifest_edit`'s description and schema below, which a client reads at tools/list and keeps,
   * so a host that changed the object it passed in afterwards would leave an agent reading one list
   * and being held to another. A copy cannot be changed from outside, and neither can the two lists
   * in `ops.ts` it is read against, which are frozen for the same reason.
   */
  const editing: McpEditingOptions = { zoom: zoomOffered(options.editing) };
  const opNames = opNamesFor(editing);

  return [
    {
      name: 'manifest_create',
      title: 'Start a post',
      description:
        'Starts a new edit manifest, optionally with its base track already laid out and its output ' +
        'frame chosen. Sources are given as a key and a duration: the key is whatever the app uses to ' +
        'find the file later (the manifest never holds a path), and the duration is the source’s ' +
        'full length in milliseconds, which is what the trim is measured against. Returns a manifestId ' +
        'that every other tool here takes.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          sources: {
            type: 'array',
            description: 'The base track, in order. An empty list is a valid post that renders nothing yet.',
            items: {
              type: 'object',
              properties: {
                clipKey: { type: 'string', description: 'The app’s key for the file.' },
                durationMs: { type: 'number', description: 'The source’s full length.' },
                id: { type: 'string', description: 'The clip’s id on this post. Defaults to clipKey.' },
              },
              required: ['clipKey', 'durationMs'],
            },
          },
          aspect: { type: 'string', enum: ['9:16', '16:9'], description: 'Defaults to 9:16, a vertical post.' },
          qualityId: {
            type: 'string',
            enum: OUTPUT_QUALITIES.map((quality) => quality.id),
            description: 'Named by the frame’s short side. Defaults to 720p.',
          },
          fps: { type: 'number', enum: [...OUTPUT_FPS], description: 'Defaults to 30.' },
        },
      },
      run(args) {
        let manifest = emptyManifest();

        const aspect = args['aspect'];
        const qualityId = args['qualityId'];
        const fps = args['fps'];
        if (aspect !== undefined || qualityId !== undefined || fps !== undefined) {
          manifest = {
            ...manifest,
            output: outputFor(
              (aspect as '9:16' | '16:9') ?? '9:16',
              (qualityId as string) ?? '720p',
              (fps as number) ?? DEFAULT_OUTPUT.fps,
            ),
          };
        }

        for (const [index, raw] of readSources(args['sources']).entries()) {
          const id = raw.id ?? raw.clipKey;
          if (manifest.clips.some((clip) => clip.id === id)) {
            throw new ToolError(`sources[${index}]: two clips would share the id "${id}" - give one an "id" of its own`);
          }
          manifest = insertClip(manifest, defaultClipEdit(raw.clipKey, raw.durationMs, id));
        }

        return manifestResult(store, editing, manifest);
      },
    },

    {
      name: 'manifest_validate',
      title: 'Check a manifest',
      description:
        'Runs a manifest through the same normaliser the editor runs it through when a post is reopened, ' +
        'and reports what it had to change. That covers three different things at once: a manifest from ' +
        'an older version of this package is migrated, out-of-range numbers are clamped to what the ' +
        'render will actually do, and anything the manifest could not mean is dropped. Use it on any ' +
        'manifest that did not come out of these tools before acting on what it says.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          manifest: {
            type: 'object',
            description: 'The manifest to check, in whole.' + (editing.zoom ? '' : ZOOM_OFF_MANIFEST),
          },
        },
        required: ['manifest'],
      },
      run(args) {
        const input = args['manifest'];
        if (typeof input !== 'object' || input === null || Array.isArray(input)) {
          throw new ToolError('"manifest" must be an object');
        }
        const raw = input as Record<string, unknown>;
        const manifest = normaliseManifest(raw);
        // Refused rather than reported in the notes below: a check that answered "this holds a zoom"
        // and still stored it under an id would have let the zoom onto the server by the side door.
        if (!editing.zoom) refuseZooms(manifest);

        const notes: string[] = [];
        const version = raw['version'];
        if (typeof version !== 'number') notes.push(`No version on the input; read as version ${MANIFEST_VERSION}.`);
        else if (version < MANIFEST_VERSION) notes.push(`Migrated from version ${version} to ${MANIFEST_VERSION}.`);
        else if (version > MANIFEST_VERSION) {
          notes.push(
            `The input says version ${version}, which is NEWER than the ${MANIFEST_VERSION} this build knows. ` +
              'Anything that version added has been dropped.',
          );
        }

        // A field-by-field diff would be a second normaliser to keep in step with the first, so what
        // is reported instead is the plain fact of whether anything moved, and the normalised
        // manifest itself is returned for the caller to compare against if it wants the detail.
        const changed = JSON.stringify(raw) !== JSON.stringify(manifest);
        notes.push(changed ? 'The manifest was changed on the way in; the normalised one is below.' : 'Nothing had to change.');

        return manifestResult(store, editing, manifest, undefined, notes.join(' '));
      },
    },

    {
      name: 'manifest_inspect',
      title: 'Read a post',
      description:
        'Reads a manifest back: how long the post runs, what is on the base track and on each video ' +
        'layer over it, every layer with its id and time window, the music and voiceover, and the ' +
        'colour operations the render will actually apply once the filter, its intensity and the ' +
        'Adjust sliders are folded together.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: { type: 'object', properties: manifestInput(editing) },
      run(args) {
        const { manifest, id } = resolve(store, editing, args);
        return manifestResult(store, editing, manifest, id);
      },
    },

    {
      name: 'manifest_edit',
      title: 'Change a post',
      description:
        'Applies a list of edit operations in order, each one to what the one before it left. These are ' +
        'the same operations the editor’s own UI performs, so an edit made here and an edit made by ' +
        'dragging produce the same manifest.\n\n' +
        'Nothing is applied halfway: if any op is refused the whole list is, the manifest is left as it ' +
        'was, and the error names the op and its position in the list. An op that names a clip, layer, ' +
        'track or take the post does not have is refused rather than ignored.\n\n' +
        `The ops are: ${opNames.join(', ')}. ` +
        (editing.zoom ? '' : `${ZOOM_OFF_OPS} `) +
        'Call catalog_list with section "ops" for what each one reads.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          ...manifestInput(editing),
          ops: {
            type: 'array',
            minItems: 1,
            description: 'Applied in order. Each item is {"op": <name>, ...the values that op reads}.',
            items: {
              type: 'object',
              properties: { op: { type: 'string', enum: [...opNames] } },
              required: ['op'],
              additionalProperties: true,
            },
          },
        },
        required: ['ops'],
      },
      run(args) {
        const { manifest, id } = resolve(store, editing, args);
        const ops = args['ops'];
        if (!Array.isArray(ops) || ops.length === 0) throw new ToolError('"ops" must be a non-empty array');

        const before = totalDurationMs(manifest);
        const next = applyEditOps(manifest, ops as EditOp[], { editing });
        const after = totalDurationMs(next);

        const note =
          `Applied ${ops.length} op${ops.length === 1 ? '' : 's'}.` +
          (before === after ? '' : ` The post went from ${Math.round(before)}ms to ${Math.round(after)}ms.`);
        return manifestResult(store, editing, next, id, note);
      },
    },

    {
      name: 'catalog_list',
      title: 'List what a post can be made of',
      description:
        'The fixed lists an edit draws on: the filter presets, the full-frame effects, the layout ' +
        'presets for arranging a second video over the first, the text styles, the output frames on ' +
        'offer, what every edit op reads, and the limits a post is held to. Ask for one section or ' +
        'leave it out for all of them.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: [...CATALOG_SECTIONS], description: 'Leave out for everything.' },
        },
      },
      run(args) {
        const asked = args['section'];
        if (asked !== undefined && !CATALOG_SECTIONS.includes(asked as CatalogSection)) {
          throw new ToolError(`"section" must be one of ${CATALOG_SECTIONS.join(', ')}`);
        }
        const sections = asked ? [asked as CatalogSection] : [...CATALOG_SECTIONS];
        const catalog: Record<string, unknown> = {};
        const text: string[] = [];
        for (const section of sections) {
          const { data, lines } = catalogSection(section, editing, opNames);
          catalog[section] = data;
          text.push(lines);
        }
        return { content: [{ type: 'text', text: text.join('\n\n') }], structuredContent: catalog };
      },
    },
  ];
}

/* -------------------------------------------------------------------------------------------- */

interface SourceInput {
  clipKey: string;
  durationMs: number;
  id?: string;
}

function readSources(value: unknown): SourceInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolError('"sources" must be an array');
  return value.map((raw, index) => {
    const source = raw as Record<string, unknown>;
    const clipKey = source?.['clipKey'];
    const durationMs = source?.['durationMs'];
    if (typeof clipKey !== 'string' || clipKey.length === 0) {
      throw new ToolError(`sources[${index}]: "clipKey" must be a non-empty string`);
    }
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
      throw new ToolError(`sources[${index}]: "durationMs" must be a positive number of milliseconds`);
    }
    const id = source['id'];
    if (id !== undefined && (typeof id !== 'string' || id.length === 0)) {
      throw new ToolError(`sources[${index}]: "id" must be a non-empty string when it is given`);
    }
    return { clipKey, durationMs, id: id as string | undefined };
  });
}

/**
 * One section of the catalogue, as this set of tools' settings leave it. Only `ops` and `limits`
 * depend on them; every other section is the same list whatever the host has turned off.
 */
function catalogSection(
  section: CatalogSection,
  editing: McpEditingOptions,
  opNames: readonly string[],
): { data: unknown; lines: string } {
  /*
   * The category lists are the editor's own module constants, the ones its sheets draw their tabs
   * from, so they go out as copies. Handed out as they are, an in-process host that tidied one up in
   * its answer - sorted it, dropped a tab it does not show - would have changed it for every server
   * in the process and for the editor itself, which is the sharing [ManifestStore] refuses too.
   */
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  switch (section) {
    case 'filters': {
      const data = FILTER_PRESETS.map((preset) => ({ id: preset.id, label: preset.label, category: preset.category }));
      return {
        data: { categories: copy(FILTER_CATEGORIES), presets: data },
        lines: `Filters (setFilter filterId):\n${byCategory(data)}`,
      };
    }
    case 'effects': {
      const data = EFFECT_PRESETS.map((preset) => ({ id: preset.id, label: preset.label, category: preset.category }));
      return {
        data: { categories: copy(EFFECT_CATEGORIES), presets: data },
        lines: `Full-frame effects (addEffect effectId):\n${byCategory(data)}`,
      };
    }
    case 'transitions': {
      const data = TRANSITIONS.map((preset) => ({ id: preset.id, label: preset.label, category: preset.category }));
      return {
        data: { categories: copy(TRANSITION_CATEGORIES), presets: data, durationMs: { min: MIN_TRANSITION_MS, max: MAX_TRANSITION_MS, default: DEFAULT_TRANSITION_MS } },
        lines:
          `Transitions between base clips (setClipTransition transition.kind), ${MIN_TRANSITION_MS}..${MAX_TRANSITION_MS}ms, ` +
          `default ${DEFAULT_TRANSITION_MS}ms, and never more than half of either clip:\n${byCategory(data)}`,
      };
    }
    case 'layouts': {
      const data = layoutPresets().map((preset) => ({ id: preset.id, label: preset.label }));
      return {
        data,
        lines:
          'Layout presets (applyLayoutPreset presetId), for arranging a video track over the base:\n' +
          data.map((preset) => `  ${preset.id} - ${preset.label}`).join('\n'),
      };
    }
    case 'textStyles': {
      const data = TEXT_STYLES.map((style) => ({ id: style.id, label: style.label, category: style.category }));
      return {
        data: { categories: copy(TEXT_STYLE_CATEGORIES), default: DEFAULT_TEXT_STYLE_ID, styles: data },
        lines: `Text styles (addText styleId, default "${DEFAULT_TEXT_STYLE_ID}"):\n${byCategory(data)}`,
      };
    }
    case 'output': {
      const data = {
        aspects: ['9:16', '16:9'],
        qualities: OUTPUT_QUALITIES.map((quality) => ({ ...quality })),
        fps: [...OUTPUT_FPS],
        default: { ...DEFAULT_OUTPUT },
      };
      const frames = OUTPUT_QUALITIES.map((quality) => {
        const portrait = outputFor('9:16', quality.id, 30);
        return `  ${quality.id} (${quality.label}) - ${portrait.width}x${portrait.height} standing, ` +
          `${portrait.height}x${portrait.width} laid down`;
      });
      return {
        data,
        lines:
          `Output frames (setOutput), ${OUTPUT_FPS.join(' or ')} fps, default ` +
          `${DEFAULT_OUTPUT.width}x${DEFAULT_OUTPUT.height} at ${DEFAULT_OUTPUT.fps}:\n${frames.join('\n')}`,
      };
    }
    case 'ops': {
      /*
       * The line about Zoom goes in the text and not the data, which stays the name-to-line table it
       * has always been, so a client that reads `ops` as that keeps working. What the data says
       * about Zoom it says by leaving the zoom ops out.
       */
      const reference = opReferenceFor(opNames);
      return {
        data: reference,
        lines:
          'Edit ops (manifest_edit), each one {"op": <name>, ...}:\n' +
          opNames.map((name) => `  ${name} - ${reference[name]}`).join('\n') +
          (editing.zoom ? '' : `\n${ZOOM_OFF_OPS}`),
      };
    }
    case 'limits': {
      /*
       * With Zoom off, every zoom limit goes. Each one only ever answered a question about a zoom a
       * post has or is gaining - how many, how short, how far in, how fast - and a post here has
       * none and gains none, so listing them would only suggest there was a zoom to hold to them.
       * The line that replaces them says why they are missing, so their absence does not read as
       * "no limit".
       */
      const data = {
        manifestVersion: MANIFEST_VERSION,
        maxLayers: MAX_LAYERS,
        maxVideoTracks: MAX_VIDEO_TRACKS,
        maxPostMs: MAX_POST_MS,
        minClipMs: MIN_CLIP_MS,
        minLayerMs: MIN_LAYER_MS,
        clipSpeed: { min: 0.25, max: 4 },
        transitionMs: { min: MIN_TRANSITION_MS, max: MAX_TRANSITION_MS },
        ...(editing.zoom
          ? {
              maxZooms: MAX_ZOOMS,
              minZoomMs: MIN_ZOOM_MS,
              zoomScale: { min: MIN_ZOOM_SCALE, max: MAX_ZOOM_SCALE },
              zoomRampMs: { min: 0, max: MAX_ZOOM_RAMP_MS },
              zoomChainGapMs: ZOOM_CHAIN_GAP_MS,
            }
          : {}),
      };
      const zooms = editing.zoom
        ? `  at most ${MAX_ZOOMS} zooms, each at least ${MIN_ZOOM_MS}ms, ${MIN_ZOOM_SCALE}x to ${MAX_ZOOM_SCALE}x, ` +
          `ramps 0 to ${MAX_ZOOM_RAMP_MS}ms; zooms under ${ZOOM_CHAIN_GAP_MS}ms apart pan from one to the next`
        : '  no zooms: Zoom is turned off for this app, so a post here holds none and gains none';
      return {
        data,
        lines:
          'Limits:\n' +
          `  manifest version ${MANIFEST_VERSION}\n` +
          `  at most ${MAX_LAYERS} layers, and ${MAX_VIDEO_TRACKS} video tracks with the base counted\n` +
          `  a post runs at most ${MAX_POST_MS}ms; a clip at least ${MIN_CLIP_MS}ms and a layer at least ${MIN_LAYER_MS}ms\n` +
          '  clip speed is 0.25x to 4x, with pitch preserved\n' +
          `  a transition runs ${MIN_TRANSITION_MS}ms to ${MAX_TRANSITION_MS}ms, and at most half of either clip it joins\n` +
          zooms,
      };
    }
  }
}

function byCategory(entries: { id: string; label: string; category: string }[]): string {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const group = groups.get(entry.category) ?? [];
    group.push(`${entry.id} (${entry.label})`);
    groups.set(entry.category, group);
  }
  return [...groups].map(([category, ids]) => `  ${category}: ${ids.join(', ')}`).join('\n');
}
