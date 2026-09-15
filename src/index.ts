/**
 * `choisy-video-kit` - native video composition and native background publishing.
 *
 * One package, two Capacitor plugins. They ship together because they are always used together and
 * two installs for one feature is a worse wart than an unused dependency; they stay two plugin
 * classes because they share nothing at runtime but a file path - the composer writes the video,
 * the publisher uploads whatever path it is handed.
 */
export { VideoComposer } from './video-composer';
export { PostPublisher } from './post-publisher';

export * from './video-composer/definitions';
export * from './post-publisher/definitions';
