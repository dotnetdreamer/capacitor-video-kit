/**
 * The `VideoComposer` plugin's call surface.
 *
 * It is a file of its own rather than part of `definitions.ts` for one reason: it is the only thing
 * in the composer's contract that names a Capacitor type, and `definitions.ts` is reached by
 * `capacitor-video-kit/editor`, which a web editor imports with no Capacitor anywhere in its tree.
 * Keeping the two apart is what lets that entry point's declarations resolve on their own.
 */
import type { PluginListenerHandle } from '@capacitor/core';

import type {
  CapabilitiesResult,
  CheckMediaOptions,
  CheckMediaResult,
  DeleteSoundOptions,
  EncodeFrame,
  EncodeSupport,
  ExtractAudioOptions,
  ExtractAudioResult,
  GalleryAccessOptions,
  GalleryAccessResult,
  GalleryThumbnailOptions,
  GalleryThumbnailResult,
  ListGalleryVideosOptions,
  ListGalleryVideosResult,
  ListSoundsResult,
  MediaAccessOptions,
  MediaAccessResult,
  PickAudioFileResult,
  ReleaseMediaOptions,
  ReleaseRenderInputsOptions,
  ResolveGalleryVideoOptions,
  ResolveGalleryVideoResult,
  RetainMediaOptions,
  RetainMediaResult,
  SweepMediaOptions,
  SweepMediaResult,
  CleanupOptions,
  ComposeCompletedEvent,
  ComposeFailedEvent,
  ComposeProgressEvent,
  ComposeSpec,
  JobIdOptions,
  JobState,
  PrepareJobOptions,
  PrepareJobResult,
  ProbeOptions,
  ProbeResult,
  SaveToGalleryOptions,
  SaveToGalleryResult,
  StageRenderInputOptions,
  StageRenderInputResult,
  StartVoiceRecordingOptions,
  SystemInsetsResult,
  ThumbnailsOptions,
  ThumbnailsResult,
  VoiceRecordingResult,
} from './definitions';

export interface VideoComposerPlugin {
  /**
   * Starts a render and resolves immediately with the job id. The outcome arrives as a `completed`
   * or `failed` event; both are retained until consumed, and `getState` can always be asked instead.
   */
  compose(spec: ComposeSpec): Promise<{ jobId: string }>;

  /** Stops a running render and emits `failed` with code `cancelled`. Safe on unknown ids. */
  cancel(options: JobIdOptions): Promise<void>;

  /** Rejects with `job_not_found` when the process has been restarted since `compose`. */
  getState(options: JobIdOptions): Promise<JobState>;

  probe(options: ProbeOptions): Promise<ProbeResult>;

  thumbnails(options: ThumbnailsOptions): Promise<ThumbnailsResult>;

  /**
   * Pulls a video's audio track out into a file of its own and, by default, keeps it in the sound
   * library. Rejects `unreadable_input` for a video that cannot be opened and `no_space` when the
   * disk would not take the copy; a video with no sound in it resolves with `hasAudio: false`.
   */
  extractAudio(options: ExtractAudioOptions): Promise<ExtractAudioResult>;

  /**
   * Every sound kept by [extractAudio], newest first.
   *
   * The library IS the folder: each sound is a file and a small record beside it, so nothing can
   * drift apart the way a list held in the WebView and files held natively would. A record whose
   * file has gone is dropped on the way out rather than reported.
   */
  listSounds(): Promise<ListSoundsResult>;

  /** Deletes one kept sound and its file. Silent about an id that is already gone. */
  deleteSound(options: DeleteSoundOptions): Promise<void>;

  /**
   * Copies a finished video out of the app and into the device's own gallery.
   *
   * The far end of [compose], and the reason it lives here rather than in each host: a render
   * lands in the app's private storage, where no gallery app can see it and nobody holding the
   * phone can reach it - so an app that stops at `compose` has produced a video only it can open,
   * which to a customer is the same as producing none. Every host was therefore writing this, and
   * getting it wrong the same way, because the obvious answers are the broken ones. Copying into
   * the app's external media directory puts the video somewhere Android deletes on uninstall, and
   * announcing it with `ACTION_MEDIA_SCANNER_SCAN_FILE` uses a broadcast that has been a no-op
   * since API 29. What this does instead is a MediaStore insert on Android and a
   * `PHAssetCreationRequest` on iOS, which are the two things the platforms actually index.
   *
   * Customise it through [SaveToGalleryOptions]: which of the two media folders, which album
   * inside it, and what the video is called once it is there. A host that wants none of that can
   * still do its own thing - the editor never calls this, only an app does.
   *
   * Asks for the photo library on iOS, and for storage on Android below API 29; from API 29 the
   * insert is scoped and needs no permission at all. Rejects with a [SaveToGalleryFailureCode].
   */
  saveToGallery(options: SaveToGalleryOptions): Promise<SaveToGalleryResult>;

  /**
   * Asks to read the device's videos when the person has not been asked yet, and answers with what
   * the host may now see. Never rejects for a refusal - `denied` is an answer, and a host's way
   * round it, the system picker, needs no permission at all. `unsupported` in a browser.
   *
   * The four gallery calls exist for a host that draws its OWN gallery. The system picker answers
   * with a set, so the order somebody tapped their clips in - the order they want on the timeline -
   * is lost on the way back; an app that numbers its picks has to list the library itself.
   *
   * THE HOST DECLARES THE PERMISSION, not the kit: `READ_MEDIA_VIDEO` (and `READ_EXTERNAL_STORAGE`
   * capped at API 32) in the Android manifest, `NSPhotoLibraryUsageDescription` in the iOS
   * `Info.plist`. Google Play reviews a media read permission app by app, so the kit does not put
   * one on every host that only renders.
   */
  requestGalleryAccess(options?: GalleryAccessOptions): Promise<GalleryAccessResult>;

  /**
   * One page of the device's videos, newest first - and its pictures among them, with `images`.
   * Rejects `permission_denied` without access and `unsupported` in a browser. Paged by position,
   * so a video recorded between two pages moves the rest down one: a host should skip an id it has
   * already listed. [galleryThumbnail] and [resolveGalleryVideo] take a picture's id as they take a
   * video's.
   */
  listGalleryVideos(options?: ListGalleryVideosOptions): Promise<ListGalleryVideosResult>;

  /**
   * A poster frame for one listed video, from the platform's own thumbnailer - which keeps one for
   * most of a library already - and cached on disk. Rejects `unreadable_input` for a video with no
   * frame to give; a grid shows a plain tile for it.
   */
  galleryThumbnail(options: GalleryThumbnailOptions): Promise<GalleryThumbnailResult>;

  /**
   * A URI the rest of the plugin can read, for one listed video.
   *
   * Call it for every pick before handing the video on. On Android it is instant and copies
   * nothing: the MediaStore URI is already readable, and stays so for as long as the host holds
   * the grant. On iOS a library asset has no path at all, so this copies its video - from iCloud
   * first, if that is where it lives - into the app's own storage, and can take a while for a long
   * one. Rejects `unreadable_input` for a video that has gone from the library since it was listed.
   */
  resolveGalleryVideo(options: ResolveGalleryVideoOptions): Promise<ResolveGalleryVideoResult>;

  /**
   * Makes a file a native picker handed over still openable in a LATER launch, and answers with the
   * name to store for it.
   *
   * For a host that keeps picks past the launch that made them - a draft naming its clips - and
   * called once per pick, before anything is written down. Nothing is refused over it: every way
   * this can fail answers with the URI as it came and `durable: false`, because that URI still opens
   * for the rest of the launch, and refusing it would break the pick today over a problem that only
   * shows up tomorrow. It rejects, with `invalid_spec`, only when there is no `uri` at all.
   *
   * iOS MOVES the picker's copy. A `file://` URI or a bare path under `Library/Caches` or `tmp` -
   * where a picker leaves what it copied out, and the two folders iOS may empty while the app is closed -
   * is moved to `Library/Application Support/videokit-picked/<uuid>.<ext>`: a rename on the same
   * volume rather than a second copy of the bytes, left out of the backup because the video is
   * already in the customer's own library, and dated now, which is what [sweepMedia]'s `before`
   * compares. The extension stays, because AVFoundation takes a file's type from its name and only
   * the render looks at the bytes instead. A UUID rather than the picker's own name, because two
   * picks of `IMG_0001.MOV` from two albums are two clips. The `Caches/<UUID>/` folder a picker made
   * for the file goes too, once empty, when it sits directly in Caches or tmp. A file anywhere else
   * in the app's container - a [resolveGalleryVideo] copy, say - is already somewhere iOS never
   * empties and answers itself, durable; a file that has gone, one outside the container and a URI
   * that is not a file answer themselves, not durable.
   *
   * Android copies nothing: a second hundred megabytes of a video that is already in the customer's
   * library would be the wrong place for it. It takes a PERSISTABLE read grant where the URI allows
   * one - a document picker's does - and otherwise, from Android 12, swaps a photo-picker URI, whose
   * grant never persists, for the MediaStore URI behind it. That one stays readable only while the
   * app holds the media permission, which is what [requestMediaAccess] is for. A device that can do
   * neither answers the URI as it came, not durable. So does a name that already lasts, where iOS
   * says durable: a MediaStore URI, [resolveGalleryVideo]'s among them, or a file in the app's own
   * storage, which neither route applies to and which needs no retaining.
   *
   * The web answers every URI as it came, `durable: false`, because a page's pick is a `blob:` URL
   * that dies with the document: a host keeps the bytes there, not the name.
   */
  retainMedia(options: RetainMediaOptions): Promise<RetainMediaResult>;

  /**
   * Whether a stored name still opens, and the name to open it by in this install. The question to
   * ask before telling somebody their clip has gone.
   *
   * It asks the file, not a record of it. Android opens a read descriptor through the content
   * resolver, because a MediaStore row outlives a file another app deleted and a lapsed grant fails
   * to open a file that is very much still there, and neither is the question: it is whether these
   * bytes can be read. iOS asks whether the file is readable, after looking for a path into an old
   * container in the current one (see [CheckMediaResult.uri]); a file in the app's own container
   * either reads or is gone. Every way either fails is the same `exists: false`, never a rejection.
   *
   * The web answers `exists: true`: the bytes behind a page's URL are the host's to keep - in
   * IndexedDB, for a draft - and only the host knows whether they are still there.
   *
   * [currentMediaUri] is the way to ask it for the name alone, and makes the call only where a name
   * can have moved.
   */
  checkMedia(options: CheckMediaOptions): Promise<CheckMediaResult>;

  /**
   * Asks for the right to go on reading retained media in a later launch, and answers whether it
   * was given. Never rejects for a refusal: somebody who says no still edits what they picked, and a
   * draft made from it reports the clip missing after a restart, which is a worse app rather than a
   * broken one.
   *
   * Android needs it because of what [retainMedia] answers there: a MediaStore URI is readable only
   * while the app may read the device's media at all, so without the grant the name survives and
   * opens nothing. It is `READ_MEDIA_VIDEO` - with `READ_MEDIA_IMAGES` beside it for `images`, from
   * Android 13 - or `READ_EXTERNAL_STORAGE` up to Android 12, asked for in one prompt: the same
   * permissions [requestGalleryAccess] asks for, and like those, THE HOST DECLARES THEM.
   *
   * iOS answers `granted` without a prompt, and so does the web. PHPicker and the document picker
   * run outside the app and hand over a copy, and a copy in the app's own container needs no
   * permission to open again, so asking for the photo library here would put up a prompt that
   * changes nothing.
   */
  requestMediaAccess(options?: MediaAccessOptions): Promise<MediaAccessResult>;

  /**
   * Deletes the kit's own copies among `uris`, except any `keep` also names, and ignores every other
   * URI.
   *
   * On iOS those are the files [retainMedia] moved into `Application Support/videokit-picked/` and
   * [resolveGalleryVideo] copied into `Application Support/videokit-gallery/`, which nothing else
   * ever deletes. Both lists are read to a copy by where each name points below the app's container,
   * so a name stored in an earlier install still finds its file. `uris` is read as a file name only,
   * a `file://` URI or a bare path, and `keep` in every form [SweepMediaOptions.keep] lists, so a copy
   * the two lists spell differently is still one copy, and stays: a name misread in `uris` costs some
   * space until the next sweep, and one misread in `keep` would cost the clip. For a copy nothing else
   * names: a host deleting one draft of several hands over what that draft named in `uris` and what
   * the drafts it keeps name in `keep`, because two drafts can share one pick.
   *
   * It deletes a copy this launch handed out, which [sweepMedia] never does, because this is the host
   * saying it is done with that copy, and a sweep is only the host saying what it still uses.
   *
   * Android and the web keep no copies, and do nothing. Every platform refuses an absent `uris`, and
   * a `keep` that is neither absent, `null` nor an array, with `invalid_spec`, as iOS must, so a
   * host's mistake is not passed on the two where it costs nothing; a `null` one names nothing and is
   * read as absent, and an empty `uris` is legal and deletes nothing.
   */
  releaseMedia(options: ReleaseMediaOptions): Promise<void>;

  /**
   * Deletes every copy of the kit's own that no URI in `keep` names and that was made before
   * `before`, then the folders that left empty, and answers how many files went.
   *
   * There has to be a sweep because most copies stop mattering without anybody saying so: a clip
   * deleted from the edit, a Replace, a video Extract from video only read the sound out of, an edit
   * left without a draft, a draft whose app was killed before it saved. [releaseMedia] needs a host
   * to know when each of those happens, and a host usually does not. What its saved state names is
   * the whole of what a copy can still be for, so a host with drafts runs this once as it starts,
   * with every media URI its drafts use in `keep`, and whatever else is in the two folders is a copy
   * nothing will ask for again.
   *
   * On iOS it covers `videokit-picked/` and `videokit-gallery/` under Application Support. A name in
   * `keep` is read to the copy it means by where it points below the app's container, in any of the
   * forms [SweepMediaOptions.keep] lists: a `file://` URI encoded or not, a bare path, either one
   * into an earlier install's container, the local server's URL for the copy, a path relative to
   * Application Support, with or without a query or a fragment. Two kinds of copy stay whatever
   * `keep` says and however old they are:
   *  - one this process has handed a host, moved in by [retainMedia] or answered by
   *    [resolveGalleryVideo] since the app started - a web view reload does not restart it - so a
   *    clip picked while the host gathers `keep`, or earlier in this launch and not saved yet, is
   *    safe. `before` alone could not say that: a gallery copy made in an earlier launch is dated
   *    then, however recently it was picked again.
   *  - an input of a render still running, or of one whose outcome JS has not collected yet. A host
   *    runs its sweep as its page starts, so it runs again when the web view reloads, which can
   *    happen mid render, and the edit being rendered may be in no draft.
   *
   * Android and the web keep no copies, and answer 0.
   *
   * Both options are required on every platform, and an absent one - or a `before` that is not a
   * finite number - is refused with `invalid_spec` rather than given a default: `keep` read as empty
   * would delete every copy a draft still uses, and `before` read as now would take a clip being
   * picked at that moment. An empty `keep` is legal, and means exactly what it says.
   */
  sweepMedia(options: SweepMediaOptions): Promise<SweepMediaResult>;

  /**
   * One sound from the Files app, through iOS's own document picker, as a copy the page can read.
   *
   * WHY THE KIT HAS A PICKER OF ITS OWN FOR THIS. Everywhere else a sound comes in through a page's
   * `<input type="file">`, and a WKWebView cannot be trusted with one. It answers the input with a
   * menu - Photo Library, Take Video, Choose File - in front of the Files picker, and copies the
   * chosen file into a `tmp/WKFileUploadPanel-*` folder of its own before the page is told. That
   * copy fails without a word when the same file is picked again about a minute after the first
   * time: the folder stays empty, and the page is handed a `File` of 0 bytes, which reads as a good
   * song the app cannot use. Measured on an iOS 26.5 simulator, where a second pick 61 s after the
   * first failed every time and picks 22 to 34 s or 70 to 79 s apart did not - which is Replace on a
   * track somebody has just set up. The input's `accept` is a second trap: `audio/*` alone greys out
   * every song, because WebKit has no type identifier for that wildcard and makes one up that no file
   * has (`AUDIO_FORMATS` in the editor's defaults).
   *
   * So this presents `UIDocumentPickerViewController` for any audio type, one file at a time, from
   * the bridge's view controller, and copies the choice to `tmp/videokit-audio/<uuid>.<ext>`,
   * keeping its extension. It answers that copy's `file://` name, the name the file had and its MIME
   * type; a cancel is `{ cancelled: true }`, never a rejection. The editor's default `pickAudio` is
   * the caller on iOS, whenever the app's native build lists this call among the plugin's methods:
   * it reads the copy through Capacitor's local server into a `blob:` URL and has no use for the
   * file after that.
   *
   * The picker opens the song where it is (`asCopy: false`), and the kit's copy is the only one
   * made. Asked for a copy of its own, the picker writes one into `tmp/<bundle id>-Inbox/` before it
   * answers, and that one fails as the web view's does: with the same song picked again 57 to 63 s
   * after the first time, on the same simulator, iOS's own picker code deletes its fresh copy before
   * the kit is told, and a good song reads as one the app cannot use. So the kit copies from the
   * person's own file, which nothing but the person deletes, inside the file's security scope -
   * without it a file outside the app cannot be read at all - and through a coordinated read
   * (`NSFileCoordinator`), as Apple asks of every file a document picker opens, so iCloud or the
   * file's provider has downloaded it, or finished writing it, before a byte is copied
   * (`AudioFilePicker.keep`).
   *
   * What that gives up is the picker's own download. Asked for a copy, the picker fetches a song
   * still in iCloud, or at another app's file provider, inside its sheet, with a progress bar and a
   * cancel. Opened in place, the song downloads after the sheet has closed, during that coordinated
   * read, with no progress anybody can show, no cancel and no deadline - one short enough to matter
   * would also fail a long song on a slow network, which is the one case the wait is for - and this
   * call answers only once the song is down and copied. The editor stays busy until then, its
   * pickers and Next greyed, and asks for no second pick; one a host asks for meanwhile has its copy
   * made after the first. A download that fails, offline say, rejects `unknown`, which reads as a
   * song the app cannot use though the song is good. Losing the song on every Replace made about a
   * minute after the first pick is worse than all of that.
   *
   * The copy is for reading once, straight away, and is not the kit's to keep, so nothing has to be
   * called once it is read. The next pick deletes it, whatever its age, before it copies its own song
   * into the folder, and the plugin's next load deletes whatever is left. Capacitor iOS loads a
   * plugin when it builds the bridge (`CapacitorBridge.loadPlugin`), in practice once a launch, and a
   * web view reload only resets that bridge, so the load is the app's next launch. By either time the
   * page it was answered to has read it, because somebody has been through the picker again or the
   * app has started over. So one song at most is on disk there, and iOS may empty `tmp` while the
   * app is not running besides. A host that wants the sound for good keeps the bytes or hands
   * them to its sound library, never this name.
   *
   * Rejects `already_picking` while the picker an earlier call asked for is still open - on screen,
   * or on its way up, which is where a double tap lands - rather than stacking a second over it and
   * leaving the first to answer nobody; Capacitor's `UNAVAILABLE` with no screen to present on, which
   * is checked before anything is presented; and `no_space` or `unknown` for a song that was picked
   * but would not copy.
   *
   * iOS only. Android's WebView answers the same input with a documents browser that works, and a
   * browser has its own, so both reject with `UNIMPLEMENTED`, the code Capacitor gives a call a
   * platform does not have: a host asks on iOS and uses a file input elsewhere, as the default does.
   */
  pickAudioFile(): Promise<PickAudioFileResult>;

  /**
   * Writes a chunk of a render input the page holds into a file of the kit's own, and answers the
   * file's `file://` name: a NEW file when `uri` is absent, or the one `uri` names with the bytes
   * appended.
   *
   * For a `blob:` URL, which no native engine can open (see **Render inputs a page holds** in
   * `definitions.ts`), and meant to be driven by `withNativeRenderInputs`, which stages every blob a
   * spec names and releases them once the render is over. The files live in
   * `tmp/videokit-render-inputs/` on iOS and `cacheDir/videokit-render-inputs/` on Android, named
   * `<uuid>` and `extension` after a dot when one is given.
   *
   * Rejects `invalid_spec` for a call the page got wrong - no `data`, data that is not base64, an
   * `extension` that is not one, a `uri` that is not a staged file still there - `no_space` for a
   * disk that would not take the chunk, and `unknown` for any other failed write, in the system's
   * words. Calls are written one at a time in the order they came, so a page may send the next chunk
   * before the last has answered. The web rejects with `UNIMPLEMENTED`: its engine reads a blob.
   */
  stageRenderInput(options: StageRenderInputOptions): Promise<StageRenderInputResult>;

  /**
   * Deletes files [stageRenderInput] wrote, once the render that read them is over - finished,
   * failed or cancelled. Only inside the render-input folder, and silent about everything else in
   * `uris`: a name from anywhere else, or one already gone. Rejects `invalid_spec` only for an
   * absent `uris`, and the web rejects with `UNIMPLEMENTED`, as it does for [stageRenderInput].
   */
  releaseRenderInputs(options: ReleaseRenderInputsOptions): Promise<void>;

  /** Asks for the microphone permission when needed. Rejects `already_recording` / `permission_denied`. */
  startVoiceRecording(options?: StartVoiceRecordingOptions): Promise<void>;

  /** Rejects `not_recording`, or `recording_failed` when the take captured nothing. */
  stopVoiceRecording(): Promise<VoiceRecordingResult>;

  capabilities(): Promise<CapabilitiesResult>;

  /**
   * Which of these frames this platform can actually encode, asked all at once.
   *
   * It exists because a resolution ladder is a promise an editor cannot keep on its own: a phone
   * from four years ago has no 4K encoder, a browser without WebCodecs has whatever `MediaRecorder`
   * will take, and the honest answer differs per device rather than per platform. An editor asks
   * before it offers, so a customer is never given a choice that fails at the last step - after the
   * editing, which is the worst moment to find out.
   *
   * One call for the whole ladder rather than one per rung: every implementation probes the same
   * encoder for all of them, and the answers are cached for the life of the process because they
   * cannot change while the app is running.
   *
   * Never rejects for an unsupported frame. A frame nothing can encode is a `supported: false` row
   * with a reason on it, which is an answer; a rejection would be the plugin saying it could not
   * find out, and there is no such case.
   */
  encodeSupport(options: { frames: EncodeFrame[] }): Promise<{ frames: EncodeSupport[] }>;

  /**
   * How much of the WebView the system bars cover, for a full-screen editor laying tools along the
   * bottom edge. Measured, so it is 0 wherever the WebView already sits clear of the bars.
   */
  systemInsets(): Promise<SystemInsetsResult>;

  /**
   * Moves (when the file is ours) or copies (when it is not) every input into the job folder, so
   * nothing the render or the upload depends on can be revoked or garbage-collected under it.
   *
   * Rejects `invalid_spec` before anything is written when `batchId` is missing, `.` or `..`
   * ([PrepareJobOptions.batchId]), and when `inputs` is missing or an input has no key or no uri.
   */
  prepareJob(options: PrepareJobOptions): Promise<PrepareJobResult>;

  /**
   * Deletes the job folder and forgets its jobs. Idempotent: a folder that is already gone is not
   * an error. Rejects `invalid_spec`, deleting nothing, when `batchId` is missing, `.` or `..`
   * ([CleanupOptions.batchId]).
   */
  cleanup(options: CleanupOptions): Promise<void>;

  addListener(eventName: 'progress', listener: (event: ComposeProgressEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'completed', listener: (event: ComposeCompletedEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'failed', listener: (event: ComposeFailedEvent) => void): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}
