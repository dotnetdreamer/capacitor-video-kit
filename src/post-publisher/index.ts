import { registerPlugin } from '@capacitor/core';

import type { PostPublisherPlugin } from './definitions';

export const PostPublisher = registerPlugin<PostPublisherPlugin>('PostPublisher', {
  web: () => import('./web').then((m) => new m.PostPublisherWeb()),
});

export * from './definitions';
