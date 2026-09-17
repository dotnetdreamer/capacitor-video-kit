import type { EditManifest } from '../editor';

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
}

/**
 * A source file as the host knows it. The host may carry its own fields on these objects (choisy
 * carries `file`, `uploaded` and the rest of its `VideoClip`); the editor never reads them and
 * hands the same objects back when the edit is done.
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
}

/**
 * The only door to the device.
 *
 * Each of these RESOLVES WITH NULL on a cancel and REJECTS on a real failure. The editor shows a
 * different thing for each, and a host that rejects on a cancel makes every picker look broken.
 */
export interface EditorMediaHost {
  pickVideo(): Promise<EditorSource | null>;
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
   * Takes back what the edit stopped using, once, immediately before the editor hands its result
   * back. Never during the edit: a clip whose every segment was deleted stays in the store so that
   * an undo can bring it back, and only the customer tapping Next settles which ones are gone.
   *
   * Both lists go over because what a source costs, and what two sources share, is knowledge the
   * editor does not have - it never sees a file, only a key and a URL. In choisy the same gallery
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

/** How a render ended without a video. The editor shows a different sentence for each. */
export type RenderFailureCode = 'no_space' | 'unreadable_input' | 'unknown';

/**
 * What `EditorRenderHost.render` rejects with when it could not produce a file.
 *
 * A class rather than a code on a plain Error because the editor has to tell a disk that filled up
 * from a clip it cannot read, and `instanceof` is the one test that survives a host wrapping the
 * rejection on its way back up.
 */
export class RenderFailedError extends Error {
  constructor(
    readonly code: RenderFailureCode,
    message: string,
    /** The `EditorSource.key` that could not be read, when the failure names one. */
    readonly sourceKey?: string,
  ) {
    super(message);
    this.name = 'RenderFailedError';
  }
}

export interface EditorRenderHost {
  /** False greys nothing: the editor still edits, and Next hands back the manifest unrendered. */
  isSupported(): Promise<boolean>;

  /**
   * Turns the edit into a file. Rejects with [RenderFailedError].
   *
   * The editor has already made every layer's bitmap current before this is called, so the host
   * only has to call `toComposeSpec` with the same raster context and run it.
   */
  render(request: RenderRequest): Promise<EditorSource>;
}

export interface RenderRequest {
  manifest: EditManifest;
  /** Each source the edit still uses, once, in the order it first appears. */
  sources: readonly EditorSource[];
  /** 0 to 1. Called on the host's own cadence; the editor throttles nothing. */
  onProgress(progress: number): void;
  /** Aborts when the customer leaves the editor mid render. */
  signal: AbortSignal;
}

export interface EditorPlatformHost {
  /**
   * A URL the WebView can load for whatever the picker or the recorder handed back. Defaults to the
   * identity function, which is right for a plain web host. On Capacitor this is one line:
   * `uri => /^(https?:|blob:|data:)/i.test(uri) ? uri : Capacitor.convertFileSrc(uri)`.
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
   * whatever it does with a back press. Defaults to registering nothing. In choisy this is
   * `platform.backButton.subscribeWithPriority(101, handler)`, where 101 beats Ionic's overlay
   * handler at 100.
   */
  registerBackHandler?(handler: () => boolean): () => void;

  /**
   * Presents a confirmation. Resolves with the `role` of the button pressed, or null on a dismiss.
   * Defaults to the package's own alert; choisy supplies AlertController so the two alerts keep
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
   * In choisy it is `() => VideoComposer.systemInsets()`, which measures the overlap between the
   * bars and the WebView rather than the bars themselves, so a WebView already sitting above them
   * answers 0 and nothing is padded twice. The editor asks on its way in and again whenever the
   * window changes size, and it remembers the answer per window height, so this may be a real
   * round trip to the platform.
   */
  measureInsets?(): Promise<EditorInsets>;

  /** Guards the package's console output, the way `AppConstant.DEBUG` does in choisy. */
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

/** What the editor hands back when the customer taps Next. */
export interface VideoEditorResult {
  /** The originals, in the order the customer left them and without the ones they removed. */
  sources: EditorSource[];
  manifest: EditManifest;
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
 * it in the same two lines on a phone and in a page. Null, the editor greys nothing and simply hands
 * the manifest back unrendered.
 */
export interface ResolvedEditorHost {
  media: EditorMediaHost;
  render: EditorRenderHost | null;
  platform: ResolvedPlatformHost;
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
