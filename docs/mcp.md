# MCP server

[Documentation](README.md) / [Project overview](../README.md)

- [The MCP server](#the-mcp-server)
  - [The tools](#the-tools)
  - [What it deliberately does not do](#what-it-deliberately-does-not-do)
  - [Running it](#running-it)
  - [Turning Zoom off for agents](#turning-zoom-off-for-agents)
  - [Leaving it out](#leaving-it-out)

## The MCP server

An agent that can call these tools can build a post: lay out the base track, trim and split it, put
a second video over it, add text, stickers, photos and effects, place sounds and voiceover and put
them through audio effects, choose the frame. What it produces is an `EditManifest`, the same
document the editor's own UI produces, because the tools call the same functions the UI's buttons
call. Hand the result to `<ve-editor>` through its `manifest` property, or straight to
`toComposeSpec`, and it renders exactly as an edit made by dragging.

It is **off unless it is asked for**, and the section below on leaving it out is the important half
of this one if you are shipping an app.

### The tools

| Tool | What it does |
|---|---|
| `manifest_create` | Starts a post, optionally with its base track laid out and its frame chosen |
| `manifest_edit` | Applies a list of edit ops in order, all or nothing |
| `manifest_inspect` | Reads a post back: durations, rows, layers, sound, and the colour ops the render will actually apply |
| `manifest_validate` | Runs a manifest through the editor's own normaliser and says what had to change |
| `catalog_list` | The filter, effect, audio effect, layout and text style ids, the frames on offer, every edit op's parameters, and the limits |

Three of the five change nothing and say so through MCP's `readOnlyHint`.

A manifest is around 200 lines of JSON and an edit is usually a dozen ops, so the server keeps
manifests under short ids: every tool returns a `manifestId`, and every tool that reads one takes
either that or an inline `manifest`. Inline is not a fallback. It is how a draft the app already has
gets edited without being imported first, and what comes back is stored either way.

What the server stores is a copy of its own. A host running it in process - calling a tool's `run`
itself, or through an SDK client on `InMemoryTransport`, which hands objects across as they are -
holds the very manifest an answer carries, and can change it, or what it sent, without touching the
post stored under that `manifestId`.

Two things are worth knowing before driving it:

**An op that names something the post does not have is refused, not ignored.** The editor's own
functions return the manifest unchanged for a clip id that is not there, which is right for a UI,
where the button belongs to a clip that exists. An agent can name anything, usually by carrying an
id over from an earlier version of the edit, and a silent no-op leaves it unable to tell "refused"
from "ignored". So the error names the id and lists the ones there are. A music edit the editor would
not keep - a section or a stop under 100 ms - is refused the same way, with the reason; a `patchMusic`
with only a `startMs` moves the stop along with the sound, as the editor's Move does; both fades
run from 0 to 10000 ms; and a sound's `speed` runs from 0.25 to 4, as a clip's does, a slower one
sent to `patchAudio` on its own stopping where the next sound on its lane begins, as the editor's
Speed sheet does. A sound has no effect of its own: a sound op that sends `effect` or
`effectSettings` is refused, and the refusal says where effects went.
Sounds sit on audio lanes: `addAudio` places one at its `startMs`, sounds on
one lane play one after another and lanes play together, so a sound that would overlap another goes
on a lane of its own, and one the agent puts on a named lane where it does not fit is refused. A
post's single `music` joins the lanes as their first sound on the first `addAudio`, as it does in the
editor. `splitAudio` cuts a sound in two on its lane and `duplicateAudio` puts a copy straight after
it, as the audio row's Cut and Duplicate do; a cut that leaves a half under 100 ms is refused.
`reorderAudio` carries a sound to another place in its lane's order, as holding it on the timeline
does: the sounds it passes close up behind it, each keeping its length and settings.

Audio effects are layers over the post's time, as they are in the editor: from a layer's `startMs`
to its `endMs`, everything heard - every clip's own sound, every sound on every lane, every
voiceover - goes through its effect. `addAudioEffect` puts one down with its `effect`,
`"megaphone"` or `"slowReverb"`, anything else refused with the list, running to the end of the
post unless it is given an `endMs`. A layer running past the end of the post is cut there, and one
starting less than 100 ms before the end is refused, saying where the post ends. One word of a line
gets a megaphone from a layer over just that word. `effectSettings` moves the effect's sliders, 0 to
100 each - the megaphone's `intensity` and `tone`, slow + reverb's `reverb` and `room` - and a
slider the effect has not got is refused with the ones it has. `speed` is slow + reverb's Slow, 0.5
to 1 and 0.8 unless it is set: what the layer covers plays from its start that much slower, and
lower, as a record does, and at the layer's end the sound jumps to where the post is, skipping what
the slowing left unplayed. Any other effect refuses a `speed`.

The layers stack, as the picture's layers do. The manifest's `audioEffects` runs bottom to top, any
number of layers (up to 50) may cover the same moment, the same effect again included, and a new
one goes on top. Where layers cover the same time, a later one works on what the ones before it
made, so the order is part of the sound: a megaphone over slow + reverb puts the slowed room through
the horn, and slow + reverb over a megaphone slows the horn and puts it in the room. Slows multiply,
so two slow + reverb layers at 0.8 over the same time play it at 0.64x. `moveAudioEffect` moves a
layer `"forward"` or `"backward"` one place, or to the `"front"`, the top, or the `"back"`, as the
layer's Forward, Backward, To front and To back do, and is refused when the layer is already at that
end of the stack. `moveAudioEffectTo` puts it at an exact place, 0 being the bottom, as holding it
on the timeline and dropping it there does; a place the stack has not got is refused, and the place
it already has changes nothing. The summary lists the layers in stack order, numbered from the
bottom, each with the layers under it that it shares time with.

`patchAudioEffect` changes a layer as the sheet does - another effect comes on at its defaults, and
the sliders it names move while the rest stay where they are - and moves or trims its window
anywhere on the post, over or under other layers, as a drag on the timeline does. It keeps its
place in the stack; a window under 100 ms is refused, and one running past the end of the post
ends there. `splitAudioEffect` cuts a layer in two, both halves where it was in the stack.
`duplicateAudioEffect` puts a copy straight after it in time and one place above it in the stack,
and is refused only when the layer ends less than 100 ms before the end of the post.
`removeAudioEffect` takes a layer away. A draft saved when effects were a sound's own opens with
each one as a layer over where its sound was heard.

**A list of ops is all or nothing.** A list that fails at op 5 leaves the manifest exactly as it
was, and the message names the op and its position, because "no clip c3" means something different
at op 1 than it does at op 7 with five removals behind it.

### What it deliberately does not do

It does not render. Rendering is `toComposeSpec` plus a `RasterContext`, and a raster context is a
canvas: text is measured with its real loaded font, stickers and photos are decoded, and every layer
comes back as a PNG. None of that exists in a Node process, and faking it would produce a video that
did not match what the customer saw, which is the one promise the rasteriser exists to keep.

So the line is real rather than a first cut. Everything an edit **is** can be done here; turning it
into pixels belongs to the device with the screen it was edited on.

It does not read footage either. What a clip shows ([Reading what footage shows](media.md#reading-what-footage-shows)) is the phone's
image recogniser looking at the file, and a Node process has neither the file nor the recogniser; an
agent that wants a clip's scenes gets them from the app that holds the clip, as the app's own input.

### Running it

```json
{
  "mcpServers": {
    "capacitor-video-kit": {
      "command": "node",
      "args": ["/absolute/path/to/capacitor-video-kit/mcp/mcp/stdio.js"]
    }
  }
}
```

Or inside something that already runs, with a transport of its own:

```ts
import { createVideoKitMcpServer } from 'capacitor-video-kit/mcp';

const server = createVideoKitMcpServer({ version: '1.3.0' });
await server.connect(myTransport);
```

The doubled `mcp/mcp/` is `tsc` output, not a typo: `src/mcp/` imports the editor core out of
`src/editor/`, so the common root is `src` and the emitted tree mirrors it, with `mcp/editor/` and
`mcp/data/` beside the server. That is what makes `mcp/` self-contained and safe to delete whole.

### Turning Zoom off for agents

An app that turns Zoom off in its editor (`editing.zoom`, under [The edits the host
settles](editor-customization.md#the-edits-the-host-settles)) turns it off here with the same setting, and then no post on
its server holds a zoom. On the stdio process it is one argument:

```json
{
  "mcpServers": {
    "capacitor-video-kit": {
      "command": "node",
      "args": ["/absolute/path/to/capacitor-video-kit/mcp/mcp/stdio.js", "--no-zoom"]
    }
  }
}
```

A client that cannot pass arguments sets `CAPACITOR_VIDEO_KIT_MCP_ZOOM=0` in the entry's `env`
instead (`false`, `off` and `no` also do). Either one turns Zoom off, neither can turn it back on
against the other, and the line the server writes to stderr when it starts says which one did.

In code it is the editor's own `editing` type, so a host can pass on the setting it already has,
held in a variable or written out with the editor's other fields beside `zoom`. Only `zoom` is read
here; `pictures`, `replaceKeepsLength` and `savesDrafts` are taken and have no op to govern:

```ts
const server = createVideoKitMcpServer({ version: '1.3.0', editing: { pictures: true, zoom: false } });

// Or, for a host that builds the tool list itself:
const tools = createTools({ editing: host.editing });
```

The setting belongs to one server, like its store of manifests: two servers in one process each keep
their own. Each settles it when its tools are built, so changing the object afterwards changes
nothing an agent has already been told.

| | Zoom on, the default | Zoom off |
|---|---|---|
| `addZoom`, `duplicateZoom`, `updateZoom`, `setZoomWindow`, `deleteZoom` | Applied | Refused with "zoom is turned off for this app", and the list they were in fails whole, as any refused op does |
| A manifest passed in whole - to `manifest_inspect`, `manifest_validate` or `manifest_edit` - that holds a zoom, whoever put it there | Taken in, zooms kept | Refused before it is stored or any op runs, saying how many zooms it holds and which, and to send `"zooms": []` |
| A manifest passed in whole with no zoom: no `zooms` at all, `"zooms": []`, or entries the normaliser drops | Taken in | Taken in |
| `manifest_edit`'s description and op schema, `catalog_list`'s `ops` | Every op | Every op but the five zoom ops, with a line saying Zoom is off |
| The `manifest` argument's description | As always | Adds that a manifest holding a zoom is refused |
| `catalog_list`'s `limits` | With the zoom limits | Without any of them, and a line saying why they are missing |
| The summary in every answer's text, for a post with no zoom | Has a `Zooms: none` line | Says nothing about zooms |

#### No zoom on the server at all

With Zoom off the rule is one sentence: no post on the server holds a zoom. Nothing an agent sends
can put one there. The zoom ops are refused, and no other op touches a post's zooms - the tests run
every one of them over a post with none, and each op is checked for it as it runs anyway. Every tool
that takes a manifest whole judges it after the editor's own normaliser has read it, which is the
very object the server would store, so whatever the normaliser keeps as a zoom is refused and
whatever it drops as meaningless was never a zoom. Last, every answer that hands back or stores a
manifest checks that it holds none. That check cannot fire unless the two before it are broken, so
when it does it fails the call and says it is a bug, rather than quietly taking a zoom back out of a
post the agent is about to read.

That is **stricter than the editor**, on purpose. The editor with Zoom off still shows, edits and
deletes a zoom an old draft carries, and it can afford to: a person can only use the tools on screen,
so with the Zoom tile gone any zoom in front of them came from a draft. An agent writes JSON. A zoom
it types into a manifest is the same object as one a draft saved - the same fields, and no history
to tell the two apart - so a server that kept a draft's zoom would keep the agent's as well. Checking
afterwards does not close that: comparing the zoom ids that come back with the ones handed out is
beaten by an agent that reuses an id. Holding no zoom at all is the rule with no such hole in it.

What it costs is a draft saved before the app turned Zoom off that still holds a zoom. Handed to the
server, it is refused with the zoom's id and the agent is told to send `"zooms": []`, so the post the
app gets back has none where its editor would have kept one. An app that wants such a draft's zoom
kept has it edited in the editor, or leaves Zoom on for the server.

#### A tool of your own on `applyEditOps`

Refusing a manifest that already holds a zoom is the server's tools' job, not `applyEditOps`'s.
Handed `{ editing: { zoom: false } }`, `applyEditOps` refuses the five zoom ops and that is all: a
zoom already in the manifest it is given comes back where it was, untouched. So a host that builds a
tool of its own on it has to refuse such a manifest itself, and `refuseZooms` is the check the tools
make, exported for that. It throws the same `ToolError`, in the same words, the tools answer with:

```ts
import { applyEditOps, refuseZooms } from 'capacitor-video-kit/mcp';
import { normaliseManifest } from 'capacitor-video-kit/editor';

const manifest = normaliseManifest(args.manifest); // the manifest the ops will run over
refuseZooms(manifest); // throws, naming the zooms, when it holds any
const next = applyEditOps(manifest, args.ops, { editing: { zoom: false } });
```

Hand it the manifest as `normaliseManifest` leaves it, as the tools do, so that what counts as a
zoom is the editor's own reading of the field. Handed one that was never normalised it refuses more
rather than less: any non-empty `zooms` list is refused, entries the normaliser would drop included.

#### Refused rather than guessed at

Two things stop the server rather than starting it wrong, because a wrong guess would start a server
with Zoom on for a host that asked for it off:

- **Any argument other than `--no-zoom`, and any value of `CAPACITOR_VIDEO_KIT_MCP_ZOOM` that is
  neither on nor off.** The process does not start: the reason goes to stderr and it exits with
  status 2, so `--no-zooms` is found the day the configuration is written rather than the day an
  agent adds a zoom.
- **`editing` beside `tools` in `createVideoKitMcpServer`.** `editing` configures the tools the
  server builds itself, and throws when it has nothing to configure. Pass it to the `createTools`
  call that built your own.

### Leaving it out

`@modelcontextprotocol/sdk` brings around 190 packages with it, a web framework and a JOSE
implementation among them, and none of that belongs anywhere near an app bundle. So an app that
wants nothing to do with the server pays nothing for it, and does not have to remember a flag to get
that:

| What you have | What the build does |
|---|---|
| No `@modelcontextprotocol/sdk` installed | Skips it, says so in one line, and leaves no `mcp/` behind |
| The SDK installed | Builds it |
| `CAPACITOR_VIDEO_KIT_MCP=0` | Never builds it, and deletes an `mcp/` an earlier build left |
| `CAPACITOR_VIDEO_KIT_MCP=1` | Builds it, and **fails** if the SDK is missing, because a build told to produce the server and quietly not doing so is how a client discovers it instead |

The SDK is an **optional peer dependency**, so the first row is what an app gets without doing
anything. Four things keep it that way and each one is load bearing:

- `src/mcp/` is excluded from `src/tsconfig.json` and `tsconfig.stencil.json`, so the editor build
  never compiles it. Left in, Stencil would copy it into `dist/collection`, which is published, and
  an app bundling the editor would be bundling a tool server it has no use for.
- It is not in `tsconfig.json`'s `include` either, so the plugin build never emits it.
- `server.ts` is the only file in the package that imports the SDK, and only `capacitor-video-kit/mcp`
  reaches it. No other entry point leads there, so no bundler follows it.
- `files` names `mcp/**` rather than `mcp/`. That is not cosmetic: Stencil's package.json validation
  resolves every non-glob entry and fails the whole build when one is missing, and this directory is
  missing on purpose whenever the server was not built.

To check for yourself that nothing leaked:

```sh
npm run build:package
grep -rl modelcontextprotocol dist/ plugin/ loader/   # nothing
```
