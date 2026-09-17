import { DEFAULT_OUTPUT, type RasterContext } from '../editor';

import type { ResolvedEditorHost } from '../host/host.types';
import { stickerUrl } from '../data/stickers';
import { textStyleById } from '../data/text-styles';

/**
 * The editor's side of the rasteriser contract: this package's text styles, its bundled stickers,
 * and the way the host turns a file it handed over into something the WebView can load.
 *
 * The preview's bitmaps and the render's bitmaps must come out of the same context, or a layer
 * could be drawn in one font on screen and another in the posted video. Both call this, so there
 * is only one definition of each of those things.
 *
 * `fileUrl` is the host's because it is the only part that is not the editor's own: a browser gets
 * a blob URL that is already loadable, and Capacitor gets a device path that has to go through its
 * local server first.
 */
export function createEditorRasterContext(host: ResolvedEditorHost): RasterContext {
  return {
    output: DEFAULT_OUTPUT,
    textStyle: textStyleById,
    stickerUrl,
    fileUrl: host.platform.fileUrl,
  };
}
