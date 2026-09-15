import { WebPlugin } from '@capacitor/core';

import type {
  PendingPostIdOptions,
  PostPublisherPlugin,
  PublishState,
  RetryOptions,
} from './definitions';

/**
 * Deliberately empty. The point of this plugin is that the upload survives the app being
 * backgrounded or killed, which a browser cannot offer - so rather than a second transport that
 * quietly behaves differently, the web build says so.
 *
 * `getState` answers `null` instead of throwing, because that is the honest answer ("nothing is in
 * flight") and it lets a caller's reconcile pass run unchanged in a browser.
 */
export class PostPublisherWeb extends WebPlugin implements PostPublisherPlugin {
  async publish(): Promise<void> {
    throw this.unavailable('Background publishing is only available on a device.');
  }

  async getState(_options: PendingPostIdOptions): Promise<{ state: PublishState | null }> {
    return { state: null };
  }

  async cancel(_options: PendingPostIdOptions): Promise<void> {
    throw this.unavailable('Background publishing is only available on a device.');
  }

  async retry(_options: RetryOptions): Promise<void> {
    throw this.unavailable('Background publishing is only available on a device.');
  }

  async clear(_options: PendingPostIdOptions): Promise<void> {
    throw this.unavailable('Background publishing is only available on a device.');
  }
}
