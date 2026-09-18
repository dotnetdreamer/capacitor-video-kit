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
 * the manifest that matters is the one the agent has taken away.
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
import { DEFAULT_TEXT_STYLE_ID, TEXT_STYLES, TEXT_STYLE_CATEGORIES } from '../data/text-styles';
import { OP_NAMES, applyEditOps, type EditOp } from './ops';
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

class ManifestStore {
  private readonly manifests = new Map<string, EditManifest>();
  private next = 1;

  put(manifest: EditManifest, id?: string): string {
    const key = id ?? `m${this.next++}`;
    this.manifests.set(key, manifest);
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
 * The two ways in, on every tool that reads a manifest. Neither is `required`, because exactly one
 * of them is, and JSON Schema says that with `oneOf`, which enough clients render badly that the
 * pair is better spelled out in the description and checked in `resolve` below.
 */
const MANIFEST_INPUT: Record<string, JsonSchema> = {
  manifestId: {
    type: 'string',
    description: 'An id returned by an earlier call. Use this OR "manifest", not both.',
  },
  manifest: {
    type: 'object',
    description:
      'A manifest passed in whole, for one the server has not seen. Any version this package has ' +
      'ever written is accepted and brought up to date. Use this OR "manifestId".',
  },
};

/** The id, the manifest and its summary: what every tool that produces a manifest answers with. */
function manifestResult(store: ManifestStore, manifest: EditManifest, id?: string, note?: string): ToolResult {
  const manifestId = store.put(manifest, id);
  const summary = summariseManifest(manifest);
  return {
    content: [{ type: 'text', text: note ? `${note}\n\n${summary}` : summary }],
    structuredContent: { manifestId, manifest: manifest as unknown as Record<string, unknown> },
  };
}

/** `manifestId` or `manifest`, and the id to write the answer back to if there was one. */
function resolve(store: ManifestStore, args: Record<string, unknown>): { manifest: EditManifest; id?: string } {
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
    return { manifest: normaliseManifest(inline) };
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
 */
export const OP_REFERENCE: Record<string, string> = {
  /* the base track */
  trimClip: 'clipId, inMs, outMs, sourceDurationMs - sets the part of the source this clip plays.',
  setClipSpeed: 'clipId, speed (0.25..4) - pitch is preserved.',
  setClipVolume: 'clipId, volume (0..1).',
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

  /* the whole post */
  setFilter: 'filterId, intensity? (0..1) - see the "filters" section.',
  setAdjust: 'patch - any of brightness, contrast, saturation, warmth, tint (each -1..1), fade (0..1).',
  setFit: 'fit ("contain" | "cover") - the post’s fit, and the default for a clip with none.',
  setOriginalMuted: 'muted - mutes every clip’s own sound, leaving music and voiceover alone.',
  setOutput:
    'either aspect? ("9:16" | "16:9"), qualityId? and fps?, or width and height outright with fps?. ' +
    'Anything left out keeps what the post has.',
};

/* -------------------------------------------------------------------------------------------- */
/* The tools                                                                                      */
/* -------------------------------------------------------------------------------------------- */

const CATALOG_SECTIONS = ['filters', 'effects', 'layouts', 'textStyles', 'output', 'ops', 'limits'] as const;
type CatalogSection = (typeof CATALOG_SECTIONS)[number];

/**
 * Builds the five tools over a store of their own.
 *
 * A function rather than a constant because the store is state: two servers in one process, which
 * is what the tests are, must not be able to see each other's manifests.
 */
export function createTools(): ToolDefinition[] {
  const store = new ManifestStore();

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

        return manifestResult(store, manifest);
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
        properties: { manifest: { type: 'object', description: 'The manifest to check, in whole.' } },
        required: ['manifest'],
      },
      run(args) {
        const input = args['manifest'];
        if (typeof input !== 'object' || input === null || Array.isArray(input)) {
          throw new ToolError('"manifest" must be an object');
        }
        const raw = input as Record<string, unknown>;
        const manifest = normaliseManifest(raw);

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

        return manifestResult(store, manifest, undefined, notes.join(' '));
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
      inputSchema: { type: 'object', properties: { ...MANIFEST_INPUT } },
      run(args) {
        const { manifest, id } = resolve(store, args);
        return manifestResult(store, manifest, id);
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
        `The ops are: ${OP_NAMES.join(', ')}. ` +
        'Call catalog_list with section "ops" for what each one reads.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          ...MANIFEST_INPUT,
          ops: {
            type: 'array',
            minItems: 1,
            description: 'Applied in order. Each item is {"op": <name>, ...the values that op reads}.',
            items: {
              type: 'object',
              properties: { op: { type: 'string', enum: [...OP_NAMES] } },
              required: ['op'],
              additionalProperties: true,
            },
          },
        },
        required: ['ops'],
      },
      run(args) {
        const { manifest, id } = resolve(store, args);
        const ops = args['ops'];
        if (!Array.isArray(ops) || ops.length === 0) throw new ToolError('"ops" must be a non-empty array');

        const before = totalDurationMs(manifest);
        const next = applyEditOps(manifest, ops as EditOp[]);
        const after = totalDurationMs(next);

        const note =
          `Applied ${ops.length} op${ops.length === 1 ? '' : 's'}.` +
          (before === after ? '' : ` The post went from ${Math.round(before)}ms to ${Math.round(after)}ms.`);
        return manifestResult(store, next, id, note);
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
          const { data, lines } = catalogSection(section);
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

function catalogSection(section: CatalogSection): { data: unknown; lines: string } {
  switch (section) {
    case 'filters': {
      const data = FILTER_PRESETS.map((preset) => ({ id: preset.id, label: preset.label, category: preset.category }));
      return {
        data: { categories: FILTER_CATEGORIES, presets: data },
        lines: `Filters (setFilter filterId):\n${byCategory(data)}`,
      };
    }
    case 'effects': {
      const data = EFFECT_PRESETS.map((preset) => ({ id: preset.id, label: preset.label, category: preset.category }));
      return {
        data: { categories: EFFECT_CATEGORIES, presets: data },
        lines: `Full-frame effects (addEffect effectId):\n${byCategory(data)}`,
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
        data: { categories: TEXT_STYLE_CATEGORIES, default: DEFAULT_TEXT_STYLE_ID, styles: data },
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
      return {
        data: OP_REFERENCE,
        lines:
          'Edit ops (manifest_edit), each one {"op": <name>, ...}:\n' +
          OP_NAMES.map((name) => `  ${name} - ${OP_REFERENCE[name]}`).join('\n'),
      };
    }
    case 'limits': {
      const data = {
        manifestVersion: MANIFEST_VERSION,
        maxLayers: MAX_LAYERS,
        maxVideoTracks: MAX_VIDEO_TRACKS,
        maxPostMs: MAX_POST_MS,
        minClipMs: MIN_CLIP_MS,
        minLayerMs: MIN_LAYER_MS,
        clipSpeed: { min: 0.25, max: 4 },
      };
      return {
        data,
        lines:
          'Limits:\n' +
          `  manifest version ${MANIFEST_VERSION}\n` +
          `  at most ${MAX_LAYERS} layers, and ${MAX_VIDEO_TRACKS} video tracks with the base counted\n` +
          `  a post runs at most ${MAX_POST_MS}ms; a clip at least ${MIN_CLIP_MS}ms and a layer at least ${MIN_LAYER_MS}ms\n` +
          '  clip speed is 0.25x to 4x, with pitch preserved',
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
