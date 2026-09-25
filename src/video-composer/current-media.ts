import { Capacitor } from '@capacitor/core';

import { VideoComposer } from './index';

/**
 * The folder iOS keeps one install's files in, as it appears inside every path to one of them:
 * `.../Containers/Data/Application/<UUID>/...` on a phone and on a simulator alike. The same four
 * components `JobFolders.rebased` looks for on the Swift side, which is what answers for a path
 * that has them.
 */
const APP_CONTAINER = /\/Containers\/Data\/Application\/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\//i;

/**
 * What `Capacitor.convertFileSrc` puts in front of a path to serve it through Capacitor's local
 * server: `capacitor://localhost/_capacitor_file_` on iOS, under whatever scheme and host name the
 * app configured. The path after it is the file's own, spelled as the `file://` URI it was made from
 * spelled it.
 */
const LOCAL_SERVER_FILE = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\/_capacitor_file_(?=\/)/i;

/**
 * A stored media name, as THIS install has to open it.
 *
 * For a name read back from storage - a draft's clips, its music, a poster - because storage is the
 * one place a name into an old app container can come from. The container is the install's rather
 * than the app's, iOS gives an app a new one on an update or a restore and carries every file
 * across, so the file a draft named is still there, under a path the draft does not have.
 * [CheckMediaResult.uri] has the whole of it, and `checkMedia` is what finds the new path.
 *
 * The bridge is asked only on iOS and only for a name that has a container in it. Every other name
 * comes back as it went in, which is every name on Android and in a browser, so neither ever pays
 * for the question.
 *
 * A URL the local server plays a file by names the container too, and a host that stored one - a
 * poster as a WebView shows it, say - gets it back moved the same way, still that URL. `checkMedia`
 * reads only a file name (`JobFolders.fileURL`), so it is asked about the file the URL serves, and
 * the URL's own front goes back on the `file://` name it answers. The file name is still the better
 * thing to store and convert on the way out: `releaseMedia` reads nothing else, and the URL's front
 * is the app's configuration, which a later version is free to change.
 *
 * Never rejects. A call that fails answers the name as it came, which is what `checkMedia` answers
 * for a file it cannot find as well: whatever then opens the name reports as missing the one the
 * host stored, rather than a draft failing to open over a question about one of its files.
 */
export async function currentMediaUri(uri: string): Promise<string> {
  if (Capacitor.getPlatform() !== 'ios' || !APP_CONTAINER.test(uri)) return uri;
  const served = LOCAL_SERVER_FILE.exec(uri)?.[0];
  try {
    if (!served) return (await VideoComposer.checkMedia({ uri })).uri;
    // `convertFileSrc` made the URL by putting its front where `file://` was, so this undoes it, and
    // a `file://` name comes back from `checkMedia` a `file://` name (`JobFolders.rebasedURI`).
    const answer = (await VideoComposer.checkMedia({ uri: 'file://' + uri.slice(served.length) })).uri;
    return served + answer.slice('file://'.length);
  } catch {
    return uri;
  }
}
