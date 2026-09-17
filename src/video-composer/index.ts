import { registerPlugin } from '@capacitor/core';

import type { VideoComposerPlugin } from './plugin';

/**
 * The web implementation is loaded lazily and only ever used in a browser: on a device the bridge
 * resolves the native class instead, and this `import()` is never evaluated.
 */
export const VideoComposer = registerPlugin<VideoComposerPlugin>('VideoComposer', {
  web: () => import('./web').then((m) => new m.VideoComposerWeb()),
});

export * from './definitions';
export * from './plugin';
