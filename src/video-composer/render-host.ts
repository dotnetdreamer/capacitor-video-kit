import { Capacitor, type PluginListenerHandle } from '@capacitor/core';

import { MissingClipError, toComposeSpec, type ComposeSpecIds, type EditManifest } from '../editor';
import { debugError } from '../host/debug';
import {
  RenderFailedError,
  type EditorEncodeSupport,
  type EditorRenderHost,
  type EditorSource,
  type RenderFailureCode,
  type RenderRequest,
} from '../host/host.types';
import { readFileBlob } from '../host/read-file';

import { batchIdRefusal } from './batch-id';
import type { ComposeFailureCode, ComposeResult, ComposeSpec } from './definitions';
import { VideoComposer } from './index';
import { RenderInputError, withNativeRenderInputs } from './render-inputs';

/*
 * The editor's render host over the package's own composer, which every host was writing for
 * itself around the same calls and getting wrong in the same places: listeners attached after the
 * job had already finished, a cancel sent before the composer had the job, a cancel's own answer
 * logged as a broken render, a failure blamed on a segment id the host had never heard of, a size
 * ceiling the quality sheet warned about and the render never passed on.
 *
 * `EditorRenderHost` and the rest are the editor's types, from `host/host.types`, and the one value
 * taken from there is `RenderFailedError`, which this plugin build carries a copy of. By the brand
 * every instance carries, that copy is `instanceof` every other copy of the class on the page - the
 * editor's, whichever door a host loaded it through, and the one a host tests with itself. The
 * raster context is NOT built here: it resolves sticker URLs against the Stencil runtime the editor
 * was loaded with, which this half of the package has none of, so the editor hands its own over as
 * `RenderRequest.raster`.
 */

/** Where the ids of remembered render folders are kept unless the host names a key of its own. */
const RENDER_FOLDERS_KEY = 'capacitor-video-kit.render-folders';

/** How many of those ids are kept unless the host says otherwise. See [DiscardPreviousRenders.remember]. */
const REMEMBERED_FOLDERS = 16;

/**
 * The folders of renders on this page that have not settled yet, from every host this module made.
 *
 * Deleting one of these is not tidying up: `cleanup` forgets the jobs writing into the folder, and
 * a forgotten job sends no final event - iOS `JobRegistry.forget` suppresses its events, Android's
 * `cleanup` emits none - so the render waiting on that event would never settle, its listeners
 * would stay on and its staged inputs would wait a day for the launch sweep. It is easy to reach:
 * the customer backs out of the export screen and taps Next again at once, and an iOS job that was
 * cancelled is still closing its file when the second render deletes earlier folders. So such a
 * folder is passed over and stays on the list, and whichever discard comes after it has settled
 * deletes it.
 */
const unsettled = new Set<string>();

/** The render a [ComposerRenderHostOptions.toSource] hook is turning into a source. */
export interface ComposedRender {
  jobId: string;
  /** The folder the file is in, which `VideoComposer.cleanup({ batchId })` deletes. */
  batchId: string;
  /** The edit it was rendered from. */
  manifest: EditManifest;
}

/** How [ComposerRenderHostOptions.discardPreviousRenders] remembers the folders it will delete. */
export interface DiscardPreviousRenders {
  /**
   * The `localStorage` key the folder ids are written under. Defaults to
   * `capacitor-video-kit.render-folders`; a host that kept its own list before this existed names
   * that key, so the folders it already remembered are still deleted.
   */
  storageKey?: string;
  /**
   * How many ids are kept, newest last. Defaults to 16. A folder whose cleanup keeps failing would
   * otherwise stay on the list for good, and the native sweep of week-old job folders is what
   * finally takes one that falls off the end.
   */
  remember?: number;
}

export interface ComposerRenderHostOptions {
  /**
   * The ids of one render: its job, and the folder its file is written into. Called once per render,
   * and both must be new every time, because `compose` with the id of a job that already exists
   * answers with that job rather than starting another. A batch id that is empty, `.` or `..` fails
   * the render as `unknown` before anything is started (see [renderIds]). Defaults to
   * `render-<time>-<random>` and `edit-<time>-<random>`, which a log reads more easily than a UUID
   * and which need no secure context: `crypto.randomUUID` is missing from a page served over plain
   * http, such as a phone pointed at a development server on the local network.
   */
  ids?: () => ComposeSpecIds;

  /**
   * The finished file as the source the editor hands back on Next, as [VideoEditorResult.stitched].
   *
   * The editor does nothing with that source but hand it back, so what it carries is the host's
   * business: a host that uploads reads the file into a `File` here, which [readRenderFile] does,
   * named by [containerOf], and one that saves to the gallery wants its name. Defaults to `{ key: 'edited-<jobId>', fileName, sourcePath: result.uri,
   * thumbnailUrl: result.posterUri }`, with no `thumbnailUrl` when no poster could be cut. There is
   * no `playbackUrl` because nothing needs one: the editor plays a source that has none through
   * `platform.fileUrl(sourcePath)`, and on the web `sourcePath` is already a `blob:` URL. `fileName`
   * is `edited.mp4`, or `edited.webm` for the file a browser with no MP4 encoder renders.
   *
   * A hook that throws fails the render: a `RenderFailedError` it threw reaches the editor as it is,
   * and anything else as `unknown`, logged. It is not called for a job that finished after the
   * customer called the render off, since the editor would throw away whatever it made: a hook that
   * reads the file into a `File` would read tens of megabytes for nobody. That render rejects as the
   * abort instead, and with [discardPreviousRenders] on, its folder goes with the next discard.
   */
  toSource?: (result: ComposeResult, render: ComposedRender) => EditorSource | Promise<EditorSource>;

  /**
   * Deletes the folders of this host's earlier renders before each new one starts, and gives the
   * host [ComposerRenderHost.discardRenders] to do the same when its flow ends. Off by default.
   *
   * For a host whose render is only ever on its way somewhere else - an upload that reads it into a
   * `File` - and that should not leave a trail of 40 MB files behind a customer who edits, steps
   * back and edits again. A host that keeps its renders, in a draft or a library, leaves it off.
   *
   * The ids are written down in `localStorage` as each render starts rather than held in memory,
   * because the folders that need it most are the runs that did not end tidily: an app killed mid
   * render leaves a folder the native sweep will not touch for a week, and an id only in memory is
   * lost with it. An id whose cleanup fails is kept for the next attempt, and so is the folder of a
   * render on this page that has not settled yet - a cancelled job still closing its file - because
   * deleting that one would leave its render waiting for good (see [unsettled]).
   */
  discardPreviousRenders?: boolean | DiscardPreviousRenders;

  /**
   * Where a failure is reported: a render the composer refused or failed, an input that could not be
   * staged, a `toSource` hook that threw, a cleanup that did not go through, a platform that could
   * not be asked what it can encode. Defaults to the package's debug switch (`host/debug.ts`), which
   * the editor sets from `platform.debug`, so these lines appear exactly when the editor's own do. A
   * host that wants the reason behind every failed render in production, where the editor can only
   * show one of four fixed sentences, passes its own.
   *
   * Nothing that goes wrong once the customer has called the render off is reported, the `cancelled`
   * that answers this host's own cancel included: it is the customer backing out of the export
   * screen, not a failure, and the render settles as the abort.
   */
  log?: (...details: unknown[]) => void;
}

/** The editor's render host, and the one thing a host with discarded renders calls on it itself. */
export interface ComposerRenderHost extends EditorRenderHost {
  /**
   * Required here where [EditorRenderHost] leaves it optional, because this host always has an
   * answer: the composer's, or none (`[]`) when the composer cannot be asked, which the editor reads
   * as "offer every frame". A host that wraps this one hands it straight through, with no fallback
   * of its own for a method that is never missing.
   */
  encodeSupport(frames: readonly { width: number; height: number; fps: number }[]): Promise<readonly EditorEncodeSupport[]>;

  /**
   * Deletes every render folder this host has remembered, keeping for next time any whose cleanup
   * failed and any whose render has not settled yet. Never rejects. Does nothing unless
   * [ComposerRenderHostOptions.discardPreviousRenders] is on; with it on, a host calls this when its
   * flow ends either way, so the last render is not left on disk.
   */
  discardRenders(): Promise<void>;
}

/**
 * The editor's render host, through `VideoComposer`: `host.render` in one line on a phone and in a
 * page alike.
 *
 * It is not gated on `Capacitor.isNativePlatform()`. `VideoComposer` has a real web implementation
 * that renders through WebCodecs or `MediaRecorder`, and `isSupported` asks `capabilities()` of
 * whichever implementation is loaded, so a browser that cannot render says so itself and the editor
 * asks the customer about posting the clips as they are for a reason that is true.
 *
 * What a render does, in order: it deletes earlier renders when asked to; it reads each clip by
 * the URL its engine can open (see [readableUri]); it builds the spec with the editor's own raster
 * context and the host's size ceiling, `RenderRequest.maxBytes`, without which a post the upload
 * will refuse is built in full first; it gives a native engine files in place of the `blob:` URLs a
 * page holds, through `withNativeRenderInputs`; it runs the job (see [runJob]); and it answers the
 * file as the host's source, through [ComposerRenderHostOptions.toSource]. Every failure rejects
 * with a `RenderFailedError` on the editor's union, whichever of those steps it came from: the
 * composer's `no_space`, `unreadable_input` and `too_large` carried across, an input that could not
 * be staged read the same way (`RenderInputError`), and everything else `unknown`, with the source to
 * blame when there is one (see [asRenderFailure]). A render the customer called off rejects with the
 * signal's reason instead, whatever else went wrong after they did, and none of that is logged: each
 * step that can fail asks the signal before it reports anything.
 *
 * It does not call `prepareJob`. That call takes ownership of its inputs and MOVES them into the
 * job folder, and the originals still belong to whatever step recorded or picked them: the customer
 * can step back, watch them, remove one and come forward again. The composer reads each clip where
 * it is, and the job folder only ever holds the output.
 */
export function composerRenderHost(options: ComposerRenderHostOptions = {}): ComposerRenderHost {
  const log = options.log ?? debugError;
  const ids = options.ids ?? newIds;
  const toSource = options.toSource ?? defaultSource;
  const folders = options.discardPreviousRenders
    ? renderFolders(options.discardPreviousRenders === true ? {} : options.discardPreviousRenders, log)
    : null;

  return {
    async isSupported(): Promise<boolean> {
      try {
        return (await VideoComposer.capabilities()).supported;
      } catch (error) {
        // A platform that cannot even be asked is one that cannot render, and the editor's own
        // question says that better than an unhandled rejection does.
        log('[composerRenderHost] capabilities() failed', error);
        return false;
      }
    },

    /*
     * Straight through to the composer, which asks the device rather than the platform: Android
     * reads `MediaCodecInfo` and iOS asks VideoToolbox. A composer that cannot answer leaves the
     * ladder alone rather than greying all of it out, because the editor offers a frame it has no
     * answer for, which is what every host meant before the frame was a choice at all.
     */
    async encodeSupport(frames): Promise<readonly EditorEncodeSupport[]> {
      try {
        return (await VideoComposer.encodeSupport({ frames: [...frames] })).frames;
      } catch (error) {
        log('[composerRenderHost] encodeSupport() failed', error);
        return [];
      }
    },

    async render(request: RenderRequest): Promise<EditorSource> {
      const { manifest, sources, signal } = request;
      signal.throwIfAborted();
      await folders?.discard();
      // The discard awaits the bridge once per folder, and a customer can call the export off in it.
      signal.throwIfAborted();

      const native = Capacitor.isNativePlatform();
      const uriByKey = new Map<string, string>();
      for (const source of sources) {
        const uri = readableUri(source, native);
        if (uri) uriByKey.set(source.key, uri);
      }
      const { jobId, batchId } = renderIds(ids, log);

      let spec: ComposeSpec;
      try {
        spec = await toComposeSpec(manifest, uriByKey, { jobId, batchId }, request.raster, { maxBytes: request.maxBytes });
      } catch (error) {
        /*
         * Refused before any segment id was handed out, so a missing clip already names the host's
         * source. `instanceof` is sound here because the class and the function that throws it are
         * the one module this file imports. Logged as well as mapped: the editor shows one of four
         * fixed sentences and none of them can carry a reason. Unless the customer called the
         * render off while the layers were being drawn, which makes it the abort.
         */
        signal.throwIfAborted();
        log('[composerRenderHost] toComposeSpec refused', error);
        if (error instanceof MissingClipError) {
          throw new RenderFailedError('unreadable_input', error.message, error.clipKey);
        }
        throw new RenderFailedError('unknown', String(error));
      }
      // Drawing every layer takes a while on a phone, and a customer can call the export off in it.
      signal.throwIfAborted();

      // Written down BEFORE the encode starts, because the folder exists from the moment the
      // composer touches it, and an app killed mid render is the case that strands one.
      unsettled.add(batchId);
      folders?.remember(batchId);
      try {
        /*
         * Every `blob:` URL in the spec - a sound from the browser's library, a track the default
         * picker read in, a clip a host kept as bytes - is written out as a file on a phone first
         * and deleted once the job has settled. That is why the job settles on its own terminal
         * event and never on `compose`'s answer: the staged files are deleted the moment it settles.
         */
        const result = await withNativeRenderInputs(spec, (prepared) => runJob(prepared, request, log), signal);
        // A job that finished after all, its cancel having lost the race with the last frame: the
        // editor has already let go of this render, so nothing is made of its file.
        signal.throwIfAborted();
        return await toSource(result, { jobId, batchId, manifest });
      } catch (error) {
        throw asRenderFailure(error, manifest, signal, log);
      } finally {
        unsettled.delete(batchId);
      }
    },

    async discardRenders(): Promise<void> {
      await folders?.discard();
    },
  };
}

/**
 * The URL a clip is read by, which the two kinds of engine answer differently.
 *
 * `sourcePath` is the file itself, and whenever there is one it is what every engine is given. With
 * none, the web engine opens whatever URL the page can, so `playbackUrl` is a readable clip there -
 * an object URL from the editor's own picker among them, which leaving out once refused every edit
 * made in a browser as unreadable. A native engine opens files, and of the URLs a page holds it can
 * be given a `blob:` one alone, which `withNativeRenderInputs` writes out as a file first; a WebView
 * URL such as Capacitor's local server is nothing it can open. A clip with only that is left out,
 * so `toComposeSpec` names it in a `MissingClipError` rather than the render failing deeper down
 * with less to go on.
 */
function readableUri(source: EditorSource, native: boolean): string | undefined {
  if (source.sourcePath) return source.sourcePath;
  if (!native || source.playbackUrl?.startsWith('blob:')) return source.playbackUrl;
  return undefined;
}

/**
 * One compose job, from the listeners to the file or the failure.
 *
 * The plugin holds no `PluginCall` open across a render - `compose` answers with the job id at once
 * and the rest arrives as events - so the listeners go on BEFORE compose is called: a two-second
 * clip can finish faster than an `await` takes to come back, and a job that ended between the call
 * and the subscription would report to nobody. Every event carries a job id because a host may have
 * more than one job in flight, and another job's is ignored rather than mistaken for this one's.
 * The listeners come off however the job ends.
 *
 * The signal is honoured at the one moment a cancel can name the job: once `compose` has answered.
 * An abort before that never starts the job at all. An abort while `compose` is on its way is
 * cancelled the moment it answers, because a cancel sent earlier goes to a job id the composer has
 * not heard of and is lost, and the encode then runs to the end on a phone whose editor has gone.
 * The promise still waits for the job's own terminal event, for the reason [composerRenderHost]
 * gives, and once the signal is aborted every failure the job reports settles as the abort itself
 * and is not logged. Mostly that is the `cancelled` that answers this cancel, and logging it made
 * every export somebody called off read as a broken render; but a job can end some other way after
 * the cancel was sent - an encoder that broke as it landed, an iOS job `interrupted` because the
 * customer left the app on their way out - and the editor has let go of the render either way. So
 * can `compose` itself, rejecting once the customer has left. A cancel nobody here asked for, with
 * the signal still live, is reported like any other failure.
 */
async function runJob(
  spec: ComposeSpec,
  { manifest, onProgress, signal }: RenderRequest,
  log: (...details: unknown[]) => void,
): Promise<ComposeResult> {
  let finish!: (result: ComposeResult) => void;
  let fail!: (error: unknown) => void;
  const outcome = new Promise<ComposeResult>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // A failure can arrive while `compose` is still being awaited, before anything awaits this.
  void outcome.catch(() => undefined);

  const handles = await listen([
    VideoComposer.addListener('progress', (event) => {
      if (event.jobId === spec.jobId) onProgress(event.progress);
    }),
    VideoComposer.addListener('completed', (event) => {
      if (event.jobId === spec.jobId) finish(event);
    }),
    VideoComposer.addListener('failed', (event) => {
      if (event.jobId !== spec.jobId) return;
      if (signal.aborted) {
        fail(signal.reason);
        return;
      }
      log('[composerRenderHost] compose failed', event.code, event.message, event.clipKey ?? '');
      fail(new RenderFailedError(renderFailure(event.code), event.message, sourceKeyOf(manifest, event.clipKey)));
    }),
  ]);

  let composed = false;
  const cancel = (): void => {
    if (composed) void VideoComposer.cancel({ jobId: spec.jobId }).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    try {
      await VideoComposer.compose(spec);
    } catch (error) {
      signal.throwIfAborted();
      log('[composerRenderHost] compose() rejected', error);
      throw new RenderFailedError('unknown', String(error));
    }
    composed = true;
    if (signal.aborted) cancel();
    return await outcome;
  } finally {
    /*
     * Off the moment the job settles, either way. The editor aborts the signal when it leaves the
     * document, and it leaves as soon as a render succeeds, so a listener left on it sent `cancel`
     * for a job the composer had already finished, after every render.
     */
    signal.removeEventListener('abort', cancel);
    await removeAll(handles);
  }
}

/**
 * The listeners [runJob] asked for, once every one of them is on.
 *
 * One that the bridge refused fails the render before `compose` is called, since a job nobody is
 * listening to reports to nobody, and the ones that did go on are taken off again first rather than
 * left filtering for a job id that will never come.
 */
async function listen(attaching: Promise<PluginListenerHandle>[]): Promise<PluginListenerHandle[]> {
  const attached = await Promise.allSettled(attaching);
  const handles = attached.flatMap((each) => (each.status === 'fulfilled' ? [each.value] : []));
  const refused = attached.find((each): each is PromiseRejectedResult => each.status === 'rejected');
  if (refused) {
    await removeAll(handles);
    throw refused.reason;
  }
  return handles;
}

/** A listener that will not come off is no reason to fail a render that has already settled. */
async function removeAll(handles: readonly PluginListenerHandle[]): Promise<void> {
  await Promise.all(handles.map((handle) => handle.remove().catch(() => undefined)));
}

/**
 * Whatever a render threw after its job was set up, as what the editor is handed.
 *
 * A render the customer called off is the abort, whatever else went wrong once they had - a staged
 * input that stopped reading, a job that finished anyway, a `toSource` hook that failed on a file
 * nobody will use - because the editor has already let go of it and must not be told anything else,
 * and none of it is logged. After that, a `RenderFailedError` goes as it is: a job's own failure is
 * one already, logged where it was made (see [runJob]), and one a `toSource` hook threw is the
 * hook's own answer, already worded for the editor. A `RenderInputError` is read exactly as the
 * job's `failed` event is: its code onto the editor's union and its clip back to the host's source,
 * which is how a clip a phone holds only as a revoked `blob:` URL is still reported as the unreadable
 * clip it is. Anything else - a listener the bridge refused, a hook's own error - is `unknown`.
 *
 * Everything but the abort and a `RenderFailedError` is logged here, because the editor shows one of
 * four fixed sentences and none of them can carry a reason.
 */
function asRenderFailure(
  error: unknown,
  manifest: EditManifest,
  signal: AbortSignal,
  log: (...details: unknown[]) => void,
): unknown {
  if (signal.aborted) return signal.reason;
  if (error instanceof RenderFailedError) return error;
  if (error instanceof RenderInputError) {
    log('[composerRenderHost] could not stage a render input', error.code, error.message, error.clipKey ?? '');
    return new RenderFailedError(renderFailure(error.code), error.message, sourceKeyOf(manifest, error.clipKey));
  }
  log('[composerRenderHost] render failed', error);
  return new RenderFailedError('unknown', String(error));
}

/**
 * The composer's failure as one the editor has a sentence for.
 *
 * `too_large` goes through because its sentence is the only one that tells the customer what to
 * change - a lower quality or a shorter video - where `unknown` says to try again, and trying again
 * builds the same file. Everything else that is not a full disk or an unreadable file is `unknown`
 * on purpose: an encoder, a muxer and an interrupted job are all "your edited video could not be
 * built" to the customer.
 */
function renderFailure(code: ComposeFailureCode): RenderFailureCode {
  return code === 'no_space' || code === 'unreadable_input' || code === 'too_large' ? code : 'unknown';
}

/**
 * The host's source key for the segment a failure names.
 *
 * The composer echoes the key each clip had on the wire, as `withNativeRenderInputs` does for a clip
 * it could not stage, and that is the SEGMENT's id, since split
 * and duplicate put several segments over one source and a key could not say which of them failed.
 * The host thinks in its own sources, so the id is turned back into the clip key, on the base track
 * or on any layer. An id that is no segment's - a sound, or nothing the manifest holds - names no
 * source, and the failure is reported without one rather than with a key the host never gave out.
 */
function sourceKeyOf(manifest: EditManifest, segmentId: string | undefined): string | undefined {
  if (!segmentId) return undefined;
  const segments = [manifest.clips, ...manifest.videoTracks.map((track) => track.clips)].flat();
  return segments.find((clip) => clip.id === segmentId)?.clipKey;
}

/** The default [ComposerRenderHostOptions.toSource]. */
async function defaultSource(result: ComposeResult, { jobId }: ComposedRender): Promise<EditorSource> {
  return {
    key: `edited-${jobId}`,
    fileName: `edited.${await renderContainer(result.uri)}`,
    sourcePath: result.uri,
    ...(result.posterUri ? { thumbnailUrl: result.posterUri } : {}),
  };
}

/**
 * What a finished render is, as the extension to name it with, from the MIME type its bytes came
 * with: `webm` for a type that says WebM, and `mp4` for anything else, no type at all included.
 *
 * So that nothing downstream has to guess at a WebM called `.mp4` - the feed's player, a server's
 * probe, a gallery filing it. Both native engines write H.264 in MP4 and always will, and Capacitor's
 * iOS local server answers a whole file with no type at all, so an empty or unknown type is MP4. The
 * web engine writes WebM in a browser that would encode nothing else, and its file is a `blob:` URL
 * with no extension to read, but the blob carries its type. For a
 * [ComposerRenderHostOptions.toSource] hook that reads the render itself; [readRenderFile] names
 * its `File` by this.
 */
export function containerOf(type: string): 'mp4' | 'webm' {
  return /webm/i.test(type) ? 'webm' : 'mp4';
}

/**
 * [containerOf] for the file a render answered, without reading it, for the default `toSource`.
 *
 * A native file is MP4. A `blob:` URL has no extension, so its blob's own type is asked: a `blob:`
 * fetch answers with it as the `Content-Type`, and the body is let go of unread. A fetch that fails
 * is taken as MP4, the name every render had before.
 */
async function renderContainer(uri: string): Promise<'mp4' | 'webm'> {
  if (!uri.startsWith('blob:')) return 'mp4';
  try {
    const response = await fetch(uri);
    void response.body?.cancel().catch(() => undefined);
    return containerOf(response.headers.get('content-type') ?? '');
  } catch {
    return 'mp4';
  }
}

/**
 * The finished render read into a `File` named `<name>.mp4`, or `.webm` for the WebM a browser with
 * no MP4 encoder writes ([containerOf]): for a [ComposerRenderHostOptions.toSource] hook whose host
 * sends the render somewhere - an upload - rather than keeping its name.
 *
 * `uri` is `ComposeResult.uri`, read by `readFileBlob` in `host/read-file`: a native engine's
 * `file://` through Capacitor's local server, the web engine's `blob:` as it is. The `File` is typed
 * as its bytes came, or `video/mp4` where they came with no type, which is how the iOS local server
 * answers a whole file and what every native render is. `name` defaults to `edited`, the default
 * `toSource`'s name.
 *
 * Rejects with a plain `Error` when there is nothing to send - a fetch that failed, an HTTP error, a
 * file of no bytes, which no render finishes as - so a hook that lets it through fails the render as
 * `unknown`, with the reason logged, rather than handing an upload an empty `File` the server
 * refuses after the customer waited for it. A response with no HTTP status is not an error by
 * itself: `fetch` reads the iOS local server's answer for a whole file as status 0, not `ok`, with
 * every byte behind it, so a check of `ok` alone refuses a good render there. `readFileBlob` says
 * more.
 */
export async function readRenderFile(uri: string, name = 'edited'): Promise<File> {
  const bytes = await readFileBlob(uri);
  const type = bytes.type || 'video/mp4';
  return new File([bytes], `${name}.${containerOf(type)}`, { type });
}

/**
 * The ids [ComposerRenderHostOptions.ids] answers for one render, refused as `unknown` when the
 * folder id could name something other than a folder of its own.
 *
 * The ids refused are the ones every engine's `compose`, `prepareJob` and `cleanup` refuse as
 * `invalid_spec` ([batchIdRefusal]): the empty id, `.` and `..`, which natively name the folder
 * every job's folder is in or the one above it. No default makes such an id, and one a host's
 * function answered is stopped here, before `compose` or a later `cleanup` is handed it or the
 * folders a discard remembers write it down. A function that throws is a failed render the same
 * way. The job id only ever goes into a file name after a prefix, and `compose` answers for it.
 */
function renderIds(ids: () => ComposeSpecIds, log: (...details: unknown[]) => void): ComposeSpecIds {
  let answered: ComposeSpecIds;
  try {
    answered = ids();
  } catch (error) {
    log('[composerRenderHost] ids() threw', error);
    throw new RenderFailedError('unknown', String(error));
  }
  if (!isFolderId(answered.batchId)) {
    log('[composerRenderHost] ids() answered a batch id no folder can have', answered.batchId);
    throw new RenderFailedError('unknown', `Unusable render folder id: ${JSON.stringify(answered.batchId)}`);
  }
  return answered;
}

/** Whether a batch id names one folder of its own under the job folders: see [batchIdRefusal]. */
function isFolderId(id: unknown): id is string {
  return batchIdRefusal(id) === null;
}

/** The default [ComposerRenderHostOptions.ids]. */
function newIds(): ComposeSpecIds {
  return { jobId: newId('render'), batchId: newId('edit') };
}

/** `crypto.getRandomValues` rather than `randomUUID`, which a page on plain http does not have. */
function newId(prefix: string): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, '0'));
  return `${prefix}-${Date.now().toString(36)}-${random.join('')}`;
}

/**
 * The render folders a host with [ComposerRenderHostOptions.discardPreviousRenders] has made, as
 * written down in `localStorage`.
 *
 * Storage that cannot be read or written - a WebView with it disabled, a value somebody else wrote
 * under the key - is an empty list and a no-op, because a render must not fail over its own
 * housekeeping; the native sweep of week-old job folders is the backstop. An entry that is not a
 * folder id of its own (see [renderIds]) is dropped as it is read, since the key may be one a host
 * kept its own list under, and `cleanup` of `..` would delete every job folder and the one above.
 */
function renderFolders(
  { storageKey = RENDER_FOLDERS_KEY, remember = REMEMBERED_FOLDERS }: DiscardPreviousRenders,
  log: (...details: unknown[]) => void,
) {
  const read = (): string[] => {
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(isFolderId) : [];
    } catch {
      return [];
    }
  };

  const write = (ids: readonly string[]): void => {
    try {
      const kept = ids.slice(Math.max(0, ids.length - remember));
      if (kept.length === 0) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(kept));
    } catch (error) {
      log('[composerRenderHost] could not write down the render folders', error);
    }
  };

  return {
    remember(batchId: string): void {
      write([...read(), batchId]);
    },

    /*
     * The list is read again before it is written back, and only the folders actually deleted come
     * off it: an id whose cleanup failed stays for the next attempt, one whose render has not settled
     * is not touched (see [unsettled]), and one written down by a render that started while this was
     * deleting is not lost.
     */
    async discard(): Promise<void> {
      const deleted = new Set<string>();
      for (const batchId of read()) {
        if (unsettled.has(batchId)) continue;
        try {
          await VideoComposer.cleanup({ batchId });
          deleted.add(batchId);
        } catch (error) {
          log('[composerRenderHost] cleanup failed', batchId, error);
        }
      }
      if (deleted.size > 0) write(read().filter((id) => !deleted.has(id)));
    },
  };
}
