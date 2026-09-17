import type { ConfirmRequest } from '../../host/host.types';

/**
 * One button on a confirmation, which is one button of the request a host `confirm` would have been
 * handed.
 *
 * Derived from [ConfirmRequest] rather than written out again, because the whole point of the two
 * dialogs is that the same request goes to either one. `role` is the string that comes back as the
 * answer, and it is a plain string rather than a union because a host's own dialog decides what it
 * returns; the editor's four are `cancel`, `destructive`, `plain` and `retry`.
 *
 * It lives in a `.ts` beside the component rather than in `ve-alert.tsx` so that importing the type
 * never pulls the component in behind it.
 */
export type AlertButton = ConfirmRequest['buttons'][number];
