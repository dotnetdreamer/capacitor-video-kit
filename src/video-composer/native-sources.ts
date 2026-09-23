import { Capacitor } from '@capacitor/core';

import type { EditorSource } from '../host/host.types';

import type { GalleryVideo } from './definitions';
import { VideoComposer } from './index';

/*
 * The per-file glue between a native pick and the editor's `EditorSource`, which every host with
 * drafts was writing for itself around the same two calls, and getting wrong the same ways: storing
 * the picker's name rather than the retained one, playing a moved file from the place it left, a
 * picture opened as a video.
 *
 * `EditorSource` is the editor's type, from `host/host.types`, imported as a type alone: nothing of
 * the editor runs here, and this file stays the plugin's.
 */

/** What a file picker hands over for one file: the two names every Capacitor picker plugin answers. */
export interface PickedFileNames {
  /** The file itself: a `file://` URI or a bare path on iOS, a `content://` URI on Android. */
  path?: string;
  /** The same file as a URL the WebView can play right now. */
  webPath?: string;
}

/** A picked file's two names as a source carries them, and whether the first will outlive this launch. */
export interface RetainedPick {
  /** What a draft stores for the file, and what the render and the probes read. */
  sourcePath?: string;
  /** What the WebView plays now. */
  playbackUrl?: string;
  /** [RetainMediaResult.durable]: false when a draft that keeps `sourcePath` will find the clip missing later. */
  durable: boolean;
}

/**
 * Makes one picked file last past this launch where the platform can, and answers the two names
 * an `EditorSource` needs for it.
 *
 * `retainMedia` is asked when there is a `path`, and its answer is the `sourcePath` a draft stores.
 * It never throws: a picker that worked must not be undone by the step that was only ever about
 * tomorrow, so a call that fails answers the path as it came, `durable: false`, which still opens
 * for the rest of the launch. No `path` at all is the same answer with no `sourcePath`.
 *
 * `playbackUrl` is usually the picker's own `webPath`, but not after iOS MOVED the file: the picker's
 * copy sits in Caches, which the system empties when it likes, so `retainMedia` moves it into
 * Application Support, and the picker's `webPath` still points where it was. A `file://` name that
 * changed is that case, and the new name through `Capacitor.convertFileSrc` is what plays. A
 * `content://` name that changed is Android's, which moves nothing: it is another name for the same
 * bytes, and the picker's URL still plays them.
 */
export async function retainPickedFile({ path, webPath }: PickedFileNames): Promise<RetainedPick> {
  const playing = webPath ? { playbackUrl: webPath } : {};
  if (!path) return { ...playing, durable: false };

  let sourcePath = path;
  let durable = false;
  try {
    ({ uri: sourcePath, durable } = await VideoComposer.retainMedia({ uri: path }));
  } catch {
    // The path as it came, which opens today and is reported missing tomorrow rather than failing now.
  }
  const moved = sourcePath !== path && sourcePath.startsWith('file://');
  return { sourcePath, ...(moved ? { playbackUrl: Capacitor.convertFileSrc(sourcePath) } : playing), durable };
}

/**
 * One item a host listed with `listGalleryVideos`, as a source the editor opens, under the `key` the
 * host gives it.
 *
 * The item's `id` is the library's handle and not a file, so it is resolved first: at once on
 * Android, where the answer is the MediaStore URI and already a name a draft can keep, and on iOS
 * by a copy out of the photo library, from iCloud first when it lives there, which for a long clip
 * takes a moment a page shows as busy. Rejects as `resolveGalleryVideo` does, `unreadable_input` for
 * an item gone from the library since it was listed.
 *
 * `sourcePath` is that answer, and `playbackUrl` the same file through Capacitor's local server,
 * which is the form a system picker's `webPath` takes too. The name is the one the resolve found,
 * or the one the listing had where the resolve found none. A picture says so with `kind: 'image'`,
 * or the editor opens it as a video and reports it missing; a video carries no `kind`, as every
 * source did before pictures could go on the timeline.
 *
 * The key is the host's, and has to be new for every pick: the same item picked twice is two clips,
 * and a manifest that gave them one key could not tell them apart.
 */
export async function gallerySource(video: GalleryVideo, key: string): Promise<EditorSource> {
  const { uri, fileName } = await VideoComposer.resolveGalleryVideo({ id: video.id });
  return {
    key,
    fileName: fileName || video.fileName,
    sourcePath: uri,
    playbackUrl: Capacitor.convertFileSrc(uri),
    ...(video.kind === 'image' ? { kind: 'image' as const } : {}),
  };
}
