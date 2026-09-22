import { registerPlugin } from '@capacitor/core';

import type { BackgroundPublisherPlugin } from './definitions';

export const BackgroundPublisher = registerPlugin<BackgroundPublisherPlugin>('BackgroundPublisher', {
  web: () => import('./web').then((m) => new m.BackgroundPublisherWeb()),
});

export * from './definitions';
