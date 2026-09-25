import type { EditManifest, RasterContext } from '../editor';

/**
 * Everything the editor needs from the application that hosts it.
 *
 * The editor owns the edit: the manifest, the undo stack, every gesture, every sheet and every
 * pixel. It owns no file, no picker, no encoder and no device measurement, because those differ
 * between a Capacitor app, a React web app and a Vue web app, and a UI package that guessed at
 * them would be wrong in two of the three. The whole object is handed to the editor as a plain
 * property, once.
 *
 * Every field is optional. A host that supplies nothing gets the browser defaults in
 * `host/defaults.ts`: file inputs for the pickers, a `<video>` element for the duration probe,
 * a canvas for the filmstrip, no haptics and no render. That editor is a real editor - it edits,
 * and it hands back a manifest - which is the right behaviour on the web rather than a degraded
 * one.
 */
export interface VideoEditorHost {
  media?: EditorMediaHost;
  render?: EditorRenderHost;
  platform?: EditorPlatformHost;
  /** What the finished post may be: which shapes, which resolutions, which rates. */
  output?: EditorOutputOptions;
  /** The edits where more than one answer is defensible, and which one this app wants. */
  editing?: EditorEditingOptions;
}

/**
 * Behaviour the editor cannot settle on its own, because the right answer depends on the app.
 *
 * Every field is optional and an absent one takes the editor's own default, so a host that says
 * nothing here behaves exactly as it always has.
 */
export interface EditorEditingOptions {
  /**
   * Whether Replace keeps the length of the segment it is filling. Defaults to TRUE.
   *
   * True treats Replace as a swap: the segment is a hole of a particular size in the sequence and
   * the new footage is trimmed to that size, so nothing after it moves. That is what an app whose
   * posts have a designed shape wants - swapping one shot for a longer take should not re-cut
   * everything behind it.
   *
   * False takes the whole of the new file instead, which lengthens the post. An app whose posts are
   * a loose pile of clips may prefer that: there, a segment's length is not a decision anybody made
   * and holding onto it only throws footage away.
   */
  replaceKeepsLength?: boolean;

  /**
   * Whether a PICTURE can go on the timeline beside the videos. Defaults to FALSE.
   *
   * On, every way a clip gets onto the timeline - Add clip, a second video layer, Replace - offers
   * pictures as well as videos, through [EditorMediaHost.pickMedia]. A picture lands three seconds
   * long and is then a segment like any other: trimmed from either end, cut, joined, duplicated,
   * reordered, framed, dressed with a transition. It has no speed and no sound, so it has no Speed
   * or Volume tool.
   *
   * Off is what every host got before pictures existed, and it is still the right answer for an
   * app whose posts are footage and nothing else. It governs what the pickers OFFER: a manifest
   * that already holds a picture, or a `sources` list with one in it, is still edited and rendered
   * as one.
   *
   * The render has to be able to draw one too, and all three of the package's engines do: web,
   * Android and iOS. So does the gallery a host may draw its own picker from, which lists pictures
   * among the videos on Android and iOS when it is asked to (`listGalleryVideos({ images: true })`).
   * A host that renders some other way has to be able to draw a picture before it turns this on,
   * or a post with one fails at the very end, with the editing already done.
   */
  pictures?: boolean;
}

/**
 * What this app allows the editor to offer for the finished post.
 *
 * It is the host's decision and not this package's, because the two apps using this editor want
 * different things: one posts to a feed with a 100MB ceiling and has no business offering 4K, and
 * the other builds 4K because that is the whole point of it. The editor used to answer that by
 * quietly holding the bitrate down to one app's upload limit, which made the second app's 4K a
 * bigger, softer 1080p and gave nobody anything to read about why.
 *
 * So the app says what it allows, in the plainest terms it has - a list of rungs - and the editor
 * offers exactly those. What the DEVICE can encode is a separate question and is still asked of the
 * device: an app may offer 4K on a phone that cannot encode it, and that chip is greyed out with
 * its own reason.
 *
 * Every field is optional and an absent one means "all of them", or for `maxBytes` no ceiling, so a
 * host that says nothing gets the whole ladder, which is what every host got before this existed.
 */
export interface EditorOutputOptions {
  /** Ids from `OUTPUT_QUALITIES`, in any order; the editor shows them smallest first. */
  qualities?: readonly string[];
  /** Frame rates from `OUTPUT_FPS`. */
  fps?: readonly number[];
  /** Shapes. An app whose feed is vertical may offer `['9:16']` and show no shape row at all. */
  aspects?: readonly ('9:16' | '16:9')[];
  /**
   * The frame a post starts at, when the manifest it opens with does not name one.
   *
   * It must be one of the frames this host allows; one that is not is ignored in favour of the
   * smallest rung that is, because a post that starts on a frame its own editor will not offer is a
   * post whose quality sheet opens with nothing lit.
   */
  initial?: { width: number; height: number; fps: number };
  /**
   * The most bytes a finished video may have: this app's upload limit, when it has one. Rounded down
   * to whole bytes; absent, or anything that does not round down to at least one byte - zero, a
   * negative, a fraction under one, not a finite number - is no ceiling at all, which is what every
   * host had before this.
   *
   * It is a limit on the FILE and not on the rungs, so it greys out nothing. The quality sheet marks
   * a rung whose size estimate is over it, and the customer may still choose it, because the rate
   * behind an estimate is one the encoder is allowed to spend less than: a still or dark post often
   * comes in well under. The render is what holds the file to it - the editor hands it on as
   * [RenderRequest.maxBytes] for `toComposeSpec` to write as the spec's `output.maxBytes` - and a
   * render that passes it fails `too_large`, which the editor says in a sentence of its own.
   *
   * An app that builds 4K for its own use sets none. One that posts to a server refusing anything
   * over 100 MB sets that, and a customer who picks 4K for a long post is told before the upload
   * rather than by it.
   */
  maxBytes?: number;
}

/**
 * A source file as the host knows it. The host may carry its own fields on these objects (a feed
 * application might carry `file`, `uploaded` and the rest of its own clip type); the editor never
 * reads them and hands the same objects back when the edit is done.
 */
export interface EditorSource {
  /** Stable for the life of the edit. The manifest stores THIS, never a URL. */
  key: string;
  fileName: string;
  /** Something the WebView can play right now: an http, blob or data URL. */
  playbackUrl?: string;
  /** Where the file actually is, when that is not a URL: `file://`, `content://`, a bare path. */
  sourcePath?: string;
  /** Poster frame, in whatever form `platform.fileUrl` can turn into a loadable URL. */
  thumbnailUrl?: string;
  /**
   * What the file is. Absent is a video, which is every source a host handed over before pictures
   * could go on the timeline; `image` is a still, which the editor holds for as long as its segment
   * runs rather than playing. See [EditorEditingOptions.pictures].
   */
  kind?: 'video' | 'image';
}

/**
 * The only door to the device.
 *
 * Each of these RESOLVES WITH NULL on a cancel and REJECTS on a real failure. The editor shows a
 * different thing for each, and a host that rejects on a cancel makes every picker look broken.
 *
 * On Capacitor, `composerMediaHost()` from the package root is this with the composer behind the
 * probe, the filmstrip, the microphone and, when asked, the sound library, so all a host brings is
 * its own pickers and its `release`, where it has any.
 */
export interface EditorMediaHost {
  pickVideo(): Promise<EditorSource | null>;
  /**
   * A video OR a picture, for a clip on the timeline, when the host lets pictures on there (see
   * [EditorEditingOptions.pictures]). A picture comes back with `kind: 'image'`, and a source with
   * no `kind` is taken to be a video.
   *
   * Optional: a host that allows pictures and leaves this out has its clip pickers fall back to
   * `pickVideo`, which offers videos only. The browser default offers both.
   *
   * Not the Overlay tool's picker: a photo laid OVER the video as a layer is still `pickImage`.
   */
  pickMedia?(): Promise<EditorSource | null>;
  pickImage(): Promise<PickedImage | null>;
  pickAudio(): Promise<PickedAudio | null>;

  /**
   * The container's length in milliseconds, or 0 when the file opens but reports no finite length.
   * Rejects only when the file cannot be opened at all.
   */
  probeDuration(source: EditorSource): Promise<number>;

  /**
   * Frames for the filmstrip, one per entry of `timesMs`, as URLs the WebView can load. Fewer than
   * asked for is fine; an empty array means the editor falls back to the poster frame.
   */
  thumbnails(request: ThumbnailRequest): Promise<string[]>;

  /**
   * The sounds this customer has kept, and how one more gets in there.
   *
   * Absent, there is no Sound sheet at all: "Add sound" opens `pickAudio` directly, which is what
   * every host did before this existed and is still the right answer for one with nowhere durable
   * to put a file.
   */
  sounds?: EditorSoundLibrary;

  /**
   * Takes back what the edit stopped using, once, immediately before the editor hands its result
   * back. Never during the edit: a clip whose every segment was deleted stays in the store so that
   * an undo can bring it back, and only the customer tapping Next settles which ones are gone.
   *
   * Both lists go over because what a source costs, and what two sources share, is knowledge the
   * editor does not have - it never sees a file, only a key and a URL. In the host application the same gallery
   * video picked twice is two keys and ONE path, so a path a kept source still reads must not be
   * unlinked, and that check can only be made here.
   *
   * Absent, every dropped clip is held until the app is killed: up to 100 MB of recording each,
   * and nothing anywhere reports it.
   */
  release?(request: ReleaseRequest): void;

  /** Absent means the voiceover sheet does not offer itself. */
  voice?: EditorVoiceHost;
}

export interface PickedImage {
  uri: string;
  fileName: string;
  /** Width over height AS THE WEBVIEW WILL DRAW IT, after EXIF orientation, not as stored. */
  aspect: number;
}

export interface PickedAudio {
  uri: string;
  fileName: string;
  /** 0 when the file plays but reports no finite length. */
  sourceDurationMs: number;
}

/**
 * One clip from `pickMediaFiles`, and how long it runs.
 *
 * The length travels beside the source rather than on it because [EditorSource] has no room for
 * one, and the step before the editor often needs it: a template's four second slot cannot be cut
 * out of a three second clip, and something has to notice that before a manifest is written.
 */
export interface PickedMediaFile {
  source: EditorSource;
  /**
   * 0 for a picture, which has no length of its own - the editor gives it one - and for a video
   * that opens but reports no finite length, or never opens at all.
   */
  durationMs: number;
}

/**
 * One track in the customer's own sound library: audio pulled out of a video, kept so that the next
 * post can use it without going and finding that video again.
 *
 * It is a PickedAudio with an identity and a date on it, and the two are what the library adds:
 * `id` is what a delete names, and `savedAt` is what the list is ordered by. The editor reads all
 * five fields and writes none of them - a saved sound is the host's record, and the editor only
 * ever copies its `uri` into the manifest the way a picked file's is copied.
 */
export interface SavedSound {
  /** The host's own, stable for as long as the sound exists. Never shown. */
  id: string;
  /** Playable as it stands, or turnable into one by `platform.fileUrl`. */
  uri: string;
  /** What the list shows. The video it came out of, usually, with the extension taken off. */
  fileName: string;
  /** 0 when the file plays but reports no finite length; the row then shows no time. */
  durationMs: number;
  /** Milliseconds since the epoch. The list is newest first. */
  savedAt: number;
  /** The video the sound was taken out of, when that is worth saying under the name. */
  sourceName?: string;
}

/**
 * Where extracted sounds are kept between edits.
 *
 * The editor owns none of this for the same reason it owns no file: a library is bytes on a disk
 * that outlive the edit, and what "a disk" is differs between a Capacitor app, a plain page and a
 * test. So the editor asks for the list, asks for one more to be made, and asks for one to go; the
 * host decides where any of it lives and hands back records.
 *
 * `extract` is the whole of the feature on this side. The editor picks the video - with the picker
 * it already has, so the library never grows one of its own - and hands it over; the host pulls the
 * audio track out of it, keeps the result somewhere durable, and answers with the record. It is the
 * one call here that can take real time, and the editor shows its own progress over it.
 *
 * Every method REJECTS on a real failure. `extract` resolves with null only for a video that has no
 * sound in it at all, which is a thing to say plainly rather than an error.
 */
export interface EditorSoundLibrary {
  /** Newest first. An empty list is the normal state of a new install, not a failure. */
  list(): Promise<readonly SavedSound[]>;

  /**
   * Pulls the audio out of `source`, keeps it, and answers with the record. Null when the video
   * carries no audio track.
   */
  extract(source: EditorSource): Promise<SavedSound | null>;

  /** Deletes one sound and its file. Silent about an id that is already gone. */
  remove(id: string): Promise<void>;
}

export interface ThumbnailRequest {
  source: EditorSource;
  /** Whole multiples of one step, so a host with a disk cache keyed by time can answer from it. */
  timesMs: readonly number[];
  maxHeight: number;
  /**
   * True asks for the exact frame rather than the keyframe before it. Costs roughly three keyframe
   * seeks per tile, and the editor only asks for it on short clips.
   */
  precise: boolean;
}

export interface ReleaseRequest {
  /** Every source the result carries. Untouched by the host, including their files and URLs. */
  kept: readonly EditorSource[];
  /** The rest of what the editor was given, which nothing after this call can reach. */
  dropped: readonly EditorSource[];
}

export interface EditorVoiceHost {
  /** Asks for the microphone permission when needed. */
  start(): Promise<void>;
  stop(): Promise<{ uri: string; durationMs: number }>;
}

/**
 * How a render ended without a video. The editor shows a different sentence for each.
 *
 * `too_large` is the composer's own code of that name: the file passed [EditorOutputOptions.maxBytes].
 */
export type RenderFailureCode = 'no_space' | 'unreadable_input' | 'too_large' | 'unknown';

/**
 * The mark every [RenderFailedError] carries, under a registered symbol so that every copy of the
 * class on the page writes and reads the same key.
 */
const RENDER_FAILED: unique symbol = Symbol.for('capacitor-video-kit.render-failed');

/**
 * What `EditorRenderHost.render` rejects with when it could not produce a file.
 *
 * A class rather than a code on a plain Error because the editor has to tell a disk that filled up
 * from a clip it cannot read, and `instanceof` is the test a host reaches for.
 *
 * `instanceof` is answered by a brand rather than by the prototype chain, because a page holds
 * several copies of this class and there is no arranging that away. The editor's own bundle has
 * one, `capacitor-video-kit/dist/components` and `capacitor-video-kit/ui` are other builds with one
 * each, and the plugin at the package root has one for `composerRenderHost` to throw. By the
 * prototype chain an error from one copy is not an instance of another. The editor stopped relying
 * on that some time ago and reads a failure's `name` and code as well (`renderFailureCode` in
 * `ve-editor.tsx`), so the customer hears the right sentence either way; what the brand fixes is
 * `instanceof` everywhere else. A host that tested a failure with the class from one door and got it
 * from another was told it was not a `RenderFailedError`, which is why a host once had to take the
 * class from the lazily loaded editor chunk rather than import it, and an error whose `name`
 * something rewrote on its way up was not recognised by any test. Each instance carries the
 * `Symbol.for` key above, the same key in every copy, and each copy's `instanceof` looks for it. A
 * subclass, should anyone write one, is still tested by its prototype chain, since the brand says
 * only that something is a `RenderFailedError`.
 */
export class RenderFailedError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this === RenderFailedError && typeof value === 'object' && value !== null && RENDER_FAILED in value) return true;
    return Function.prototype[Symbol.hasInstance].call(this, value);
  }

  constructor(
    readonly code: RenderFailureCode,
    message: string,
    /** The `EditorSource.key` that could not be read, when the failure names one. */
    readonly sourceKey?: string,
  ) {
    super(message);
    this.name = 'RenderFailedError';
    // Not enumerable, so the mark stays out of a logged error and out of anything that copies one.
    Object.defineProperty(this, RENDER_FAILED, { value: true });
  }
}

/**
 * What one frame of a resolution ladder came back as. The plugin's `EncodeSupport` in every field
 * that matters, restated here so the editor's host contract does not depend on the composer's.
 */
export interface EditorEncodeSupport {
  width: number;
  height: number;
  fps: number;
  supported: boolean;
  /** Why not, written to be SHOWN: a greyed chip with nothing beside it reads as a broken app. */
  reason?: string;
}

export interface EditorRenderHost {
  /** False greys nothing: the editor still edits, and Next hands back the manifest unrendered. */
  isSupported(): Promise<boolean>;

  /**
   * Turns the edit into a file. Rejects with [RenderFailedError].
   *
   * The editor has already made every layer's bitmap current before this is called, so the host
   * only has to call `toComposeSpec` with [RenderRequest.raster] and run it. On Capacitor, and in a
   * browser the package's web composer can render in, that is all `composerRenderHost()` from the
   * package root does, and a host has nothing of this to write.
   */
  render(request: RenderRequest): Promise<EditorSource>;

  /**
   * Which of these frames this device can actually encode.
   *
   * Optional, and a host that leaves it out is taken at its word that it can encode anything it is
   * asked for - which is what every host meant before a customer could choose the frame at all.
   * A host that HAS an answer should give it: a resolution offered and then refused at the end of
   * the render is the one failure this question exists to prevent, and it is discovered after the
   * editing rather than before it.
   */
  encodeSupport?(frames: readonly { width: number; height: number; fps: number }[]): Promise<readonly EditorEncodeSupport[]>;
}

export interface RenderRequest {
  manifest: EditManifest;
  /** Each source the edit still uses, once, in the order it first appears. */
  sources: readonly EditorSource[];
  /** 0 to 1. Called on the host's own cadence; the editor throttles nothing. */
  onProgress(progress: number): void;
  /**
   * Aborts when the customer calls the export off from its screen, or the editor goes away mid
   * render. The editor stops waiting the moment it aborts, so a host that settles afterwards - with
   * the file or with a failure - is ignored either way.
   */
  signal: AbortSignal;
  /**
   * [EditorOutputOptions.maxBytes] as the editor resolved it, absent when the host set none. Handed
   * back so a render passes it to `toComposeSpec` rather than keep a second copy of the number,
   * which is what keeps the ceiling the quality sheet warned about and the one the render is held
   * to the same ceiling.
   */
  maxBytes?: number;
  /**
   * What `toComposeSpec` draws this render's layers with: the context the editor's own preview draws
   * with, made for the frame this render is at. A render passes it on as it comes.
   *
   * Handed over rather than built by the host because only the editor's bundle can build it
   * correctly. The sticker URLs in it resolve against the package's asset base, which falls back to
   * the base of the Stencil runtime the editor was loaded with, and a context built from any other
   * copy of the package - the plugin at its root has no Stencil runtime at all - can point a sticker
   * somewhere else and burn a different picture into the file than the customer saw. Its `fileUrl`
   * is the host's own `platform.fileUrl`, and its `output` is `manifest.output`, because every
   * layer's pixel size is measured against the frame: a context left on the default frame would
   * draw a 4K post's caption at 720p and burn it in soft.
   */
  raster: RasterContext;
}

export interface EditorPlatformHost {
  /**
   * A URL the WebView can load for whatever the picker or the recorder handed back. Defaults to
   * `webViewUrl`, which the package root exports: in a page with Capacitor a `file://`, a
   * `content://` or a bare path goes through `Capacitor.convertFileSrc`, and every other URL, and
   * every URL in a page without Capacitor, comes back as it came. So a Capacitor host leaves this
   * out; one whose files need something else - a server of its own - supplies it.
   */
  fileUrl?(uri: string): string;

  /** Defaults to doing nothing, which is what a browser and a phone without a motor both do. */
  haptic?(kind: HapticKind): void;

  /**
   * Defaults to a `visualViewport` implementation. On Capacitor, wire the four @capacitor/keyboard
   * events: the web shape and the native shape differ in timing as well as in numbers.
   */
  keyboard?: EditorKeyboardHost;

  /**
   * Registers the editor's own back handler and returns an unsubscribe. The handler answers whether
   * it consumed the press; false means the editor has nothing left to close and the host should do
   * whatever it does with a back press. Defaults to registering nothing. An Ionic host passes
   * `registerBackHandlerWith(platform)` with Ionic's `Platform`, which subscribes at 101, ahead of
   * Ionic's overlay handler at 100, and passes a press the editor did not consume on.
   */
  registerBackHandler?(handler: () => boolean): () => void;

  /**
   * Presents a confirmation. Resolves with the `role` of the button pressed, or null on a dismiss.
   * Defaults to the package's own alert; a host may supply its own AlertController so the two alerts keep
   * looking native.
   */
  confirm?(request: ConfirmRequest): Promise<string | null>;

  /**
   * How much of the WebView the system bars actually cover, so the editor can keep its first and
   * last rows out from under them. Defaults to absent, and the editor then pads with
   * `env(safe-area-inset-*, 0px)`, which is the right answer in a browser and is live besides.
   *
   * A native WebView is the reason this exists, because there `env()` is wrong in both directions:
   * it reads 0 at the bottom on Android phones laid out under a transparent navigation bar, so the
   * toolbar goes under the system buttons, and it keeps reporting the notch at the top after the
   * WebView has moved down below an opaque status bar, so a black band sits over the video. Which
   * of the two the app is in changes while the editor is open - coming back from a system picker
   * drops the launch's edge-to-edge flags - which is why this is a measurement the editor can take
   * again rather than a number it is given once.
   *
   * In a typical host it is `() => VideoComposer.systemInsets()`, which measures the overlap between the
   * bars and the WebView rather than the bars themselves, so a WebView already sitting above them
   * answers 0 and nothing is padded twice. The editor asks on its way in and again whenever the
   * window changes size, and it remembers the answer per window height, so this may be a real
   * round trip to the platform.
   */
  measureInsets?(): Promise<EditorInsets>;

  /** Guards the package's console output, the way a host application's own debug flag does. */
  debug?: boolean;
}

/** What the system bars cover, in CSS pixels of the WebView. Never negative. */
export interface EditorInsets {
  /** The status bar, or a notch the WebView is laid out under. */
  top: number;
  /** The navigation bar or the gesture pill. */
  bottom: number;
}

export interface EditorKeyboardHost {
  /** Fires with the keyboard's height in CSS pixels, 0 when it is closed. Returns an unsubscribe. */
  subscribe(listener: (heightPx: number) => void): () => void;
  /** Raises the keyboard for a field the editor focused itself. */
  show?(): void;
}

export interface ConfirmRequest {
  header: string;
  message: string;
  buttons: readonly { text: string; role: string }[];
}

export type HapticKind = 'light' | 'medium' | 'selection' | 'success' | 'warning';

/** Why the customer left without a video, which the host's own navigation needs to tell apart. */
export type EditorCancelReason = 'back' | 'exit';

/**
 * The edit as it stands, which is the whole of what it takes to reopen it.
 *
 * Split out of [VideoEditorResult] because it is also what [VeEditor.veChange] carries, and the two
 * must not drift: a host that files a snapshot mid-edit and a host that files the finished result
 * are storing the same thing, so a draft written from either one opens the same way.
 */
export interface EditorSnapshot {
  /** The originals, in the order the customer left them and without the ones they removed. */
  sources: EditorSource[];
  manifest: EditManifest;
}

/** What the editor hands back when the customer taps Next. */
export interface VideoEditorResult extends EditorSnapshot {
  /** Absent when there was nothing to render. A single untouched clip is not re-encoded. */
  stitched?: EditorSource;
}

/**
 * A host with every optional part filled in, which is what the editor's own code is written
 * against. `resolveEditorHost()` is the only thing that builds one.
 *
 * `render` stays nullable because a render is something a host SUPPLIES rather than something this
 * file can find. It is null by default on every platform, the web included - the package does have a
 * browser engine now, behind `VideoComposer`, and reaching for it from here would pull the plugin
 * half into the editor half, which is the one dependency this package does not have. A host wires
 * it in one line on a phone and in a page alike, `render: composerRenderHost()` from the package
 * root. Null, the editor greys nothing and simply hands the manifest back unrendered.
 */
export interface ResolvedEditorHost {
  media: EditorMediaHost;
  render: EditorRenderHost | null;
  platform: ResolvedPlatformHost;
  /** Every field filled in, so nothing downstream has to ask what an absent one meant. */
  output: ResolvedOutputOptions;
  /** Likewise filled in. */
  editing: ResolvedEditingOptions;
}

export interface ResolvedEditingOptions {
  replaceKeepsLength: boolean;
  pictures: boolean;
}

export interface ResolvedOutputOptions {
  qualities: readonly string[];
  fps: readonly number[];
  aspects: readonly ('9:16' | '16:9')[];
  initial: { width: number; height: number; fps: number };
  /** Whole bytes, or null for no ceiling: an absent or unusable [EditorOutputOptions.maxBytes]. */
  maxBytes: number | null;
}

export interface ResolvedPlatformHost {
  fileUrl(uri: string): string;
  haptic(kind: HapticKind): void;
  keyboard: EditorKeyboardHost;
  registerBackHandler(handler: () => boolean): () => void;
  confirm: ((request: ConfirmRequest) => Promise<string | null>) | null;
  /**
   * Null rather than a browser measurement, and it is the one place the editor has to tell "nobody
   * measured" from "measured 0". A measurement that arrives is written onto the element as
   * `--ve-safe-top` and `--ve-safe-bottom`, which beats both the `env()` fallback in the editor's
   * own CSS and whatever a host set those properties to itself. So a default that read `env()` back
   * out of the page and handed it straight back would overwrite the host's value with a number the
   * browser was already applying. `envSafeAreaInsets()` is that reading, for a host that wants it.
   */
  measureInsets: (() => Promise<EditorInsets>) | null;
  debug: boolean;
}
