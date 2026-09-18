import { DEFAULT_OUTPUT, type EditOutput, type RasterContext } from '../editor';

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
/**
 * `output` is the frame the bitmaps are drawn FOR, and it is a parameter because the frame is a
 * choice now: a layer is rasterised at a fraction of the output's width, so the same sticker is a
 * different number of pixels on a 720 post and a 4K one. Left out, it is the default frame, which
 * is what every caller meant before the choice existed.
 */
export function createEditorRasterContext(host: ResolvedEditorHost, output: EditOutput = DEFAULT_OUTPUT): RasterContext {
  return {
    output,
    textStyle: textStyleById,
    stickerUrl,
    fileUrl: host.platform.fileUrl,
  };
}
