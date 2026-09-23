import { PICTURE_SOURCE_MS } from '../../editor';
import { debugWarn } from '../../host/debug';
import type { LayerSource } from '../../video-composer/web/painter';
import { decodePicture } from '../../web-runtime/picture';

/**
 * What one layer of the preview plays a clip on: its `<video>` element for a video, or a picture held
 * on a clock for a picture.
 *
 * WHY ONE OBJECT FOR BOTH. Everything in the preview is built on the `<video>` element. The base
 * track's two elements take turns being the CLOCK - the thing the playhead is read off - and the
 * SPARE, parked on the next clip so a cut costs no load; a transition's outgoing side is the spare
 * playing its tail; every extra layer has an element of its own that follows the clock; and the
 * compositor draws whatever those elements are showing. A picture on the timeline has to take part
 * in every one of those - be the clock through its own segment, sit on the spare ahead of its cut,
 * be the tail of a transition out of it - and teaching each of them a second kind of thing would be
 * teaching the whole player twice.
 *
 * So a picture is made to BE a clip on the same terms: [StillPicture] has a `currentTime` that runs
 * off the wall clock while it plays and stands still while it is paused, fires `seeked` after a seek
 * and `loadedmetadata` once it has decoded, and reports the picture's size as `videoWidth` and
 * `videoHeight`. The player seeks it, starts it, swaps it and reads the time off it exactly as it
 * does a video, and the schedule of cuts and transitions carries on as written.
 *
 * This object is the slot both of them live in. It answers with whichever is LIVE and forwards only
 * the live one's events, so the player and the compositor hold one thing per layer and never see the
 * switch. [showPicture] is the switch, and it is thrown by whoever points the slot at a new source,
 * immediately before the `src` - the one moment it is known which kind is coming.
 *
 * Only the members the preview reads are here. It is not an `HTMLVideoElement` and does not pretend
 * to be one to anything else.
 */

/**
 * The events that are forwarded, which is every one the preview listens for. An event outside this
 * list is not an event anything here waits on, and forwarding it would only cost a dispatch.
 */
const FORWARDED = [
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'canplaythrough',
  'play',
  'playing',
  'pause',
  'seeking',
  'seeked',
  'ended',
  'timeupdate',
  'error',
  'resize',
  'ratechange',
] as const;

/** `readyState` values, spelled as the media element spells them. */
const HAVE_NOTHING = 0;
const HAVE_ENOUGH_DATA = 4;

/**
 * The long side a picture is decoded at for the preview. The compositor draws into a canvas at most
 * twice the size of the box on screen, so a phone's preview never needs more than this - and the
 * crop tool, which shows the whole of a source on a stage the size of the preview, needs no more
 * either.
 */
const PREVIEW_MAX_EDGE = 2048;

/** How often a running picture says `timeupdate`, which is what a `<video>` does about as often. */
const TIMEUPDATE_MS = 250;

/**
 * A picture that plays like a clip: a still frame and a clock.
 *
 * The clock is the whole of it. `currentTime` is an anchor - where it was put - plus the wall time
 * since it was started, at the rate it was asked for; pausing folds the elapsed time into the anchor.
 * Its duration is the picture's whole source, [PICTURE_SOURCE_MS], so it never runs out under a
 * segment that is trimmed out of the middle of it (see `EditClip.image`).
 */
export class StillPicture extends EventTarget {
  /** The picture, once decoded: upright, and no bigger than the preview can show. */
  bitmap: ImageBitmap | HTMLCanvasElement | null = null;
  videoWidth = 0;
  videoHeight = 0;
  readyState = HAVE_NOTHING;
  error: { code: number; message: string } | null = null;
  seeking = false;
  paused = true;
  /** Written by the player like a video's, and meaningless here: a picture has no sound. */
  muted = false;
  volume = 1;
  preservesPitch = true;
  readonly duration = PICTURE_SOURCE_MS / 1000;

  private url = '';
  private rate = 1;
  private anchorSeconds = 0;
  private anchorWallMs = 0;
  /** Bumped by every load and every seek, so one that is superseded says nothing when it lands. */
  private loadToken = 0;
  private seekToken = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;

  get src(): string {
    return this.url;
  }

  set src(url: string) {
    this.url = url;
  }

  get currentTime(): number {
    if (this.paused) return this.anchorSeconds;
    const elapsed = ((performance.now() - this.anchorWallMs) / 1000) * this.rate;
    return Math.min(this.duration, this.anchorSeconds + elapsed);
  }

  /**
   * A seek is instant - there is nothing to decode - but it is still ANSWERED like one, with
   * `seeked` a task later: the player arms its seek before it writes the time and waits for the
   * event, exactly as it does for a video, and an answer that arrived inside the write would land
   * before the player had finished asking.
   */
  set currentTime(seconds: number) {
    this.anchorSeconds = Math.min(this.duration, Math.max(0, Number.isFinite(seconds) ? seconds : 0));
    this.anchorWallMs = performance.now();
    this.seeking = true;
    const token = ++this.seekToken;
    this.fire('seeking');
    setTimeout(() => {
      if (token !== this.seekToken) return;
      this.seeking = false;
      this.fire('seeked');
      this.fire('timeupdate');
    }, 0);
  }

  get playbackRate(): number {
    return this.rate;
  }

  set playbackRate(rate: number) {
    if (!(rate > 0) || rate === this.rate) return;
    // The time run so far is folded in at the OLD rate before the new one applies.
    this.anchorSeconds = this.currentTime;
    this.anchorWallMs = performance.now();
    this.rate = rate;
    this.fire('ratechange');
  }

  get ended(): boolean {
    return this.currentTime >= this.duration;
  }

  /** Decodes [src]; `loadedmetadata` and the rest follow once it has, or `error` if it cannot be. */
  load(): void {
    const token = ++this.loadToken;
    this.releaseBitmap();
    this.readyState = HAVE_NOTHING;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.error = null;
    const url = this.url;
    if (!url) return;
    decodePicture(url, PREVIEW_MAX_EDGE).then(
      (picture) => {
        if (token !== this.loadToken) {
          if ('close' in picture.bitmap) picture.bitmap.close();
          return;
        }
        this.bitmap = picture.bitmap;
        this.videoWidth = picture.width;
        this.videoHeight = picture.height;
        this.readyState = HAVE_ENOUGH_DATA;
        this.fire('loadedmetadata');
        this.fire('resize');
        this.fire('loadeddata');
        this.fire('canplay');
        this.fire('canplaythrough');
        if (!this.paused) this.fire('playing');
      },
      (error: unknown) => {
        if (token !== this.loadToken) return;
        debugWarn('[ve-preview] picture could not be decoded', url, error);
        this.error = { code: 4, message: error instanceof Error ? error.message : String(error) };
        this.fire('error');
      },
    );
  }

  play(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    this.anchorWallMs = performance.now();
    this.paused = false;
    this.fire('play');
    if (this.readyState >= HAVE_ENOUGH_DATA) this.fire('playing');
    this.ticker = setInterval(() => this.tick(), TIMEUPDATE_MS);
    return Promise.resolve();
  }

  pause(): void {
    if (this.paused) return;
    this.anchorSeconds = this.currentTime;
    this.paused = true;
    this.stopTicker();
    this.fire('pause');
  }

  /** `poster` and the rest mean nothing to a picture; `src` is the one attribute that does. */
  setAttribute(): void {
    /* Nothing to set. */
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.url = '';
  }

  /** Let go of everything: stopped, no picture, nothing pending. Nothing is announced for it. */
  clear(): void {
    this.loadToken += 1;
    this.seekToken += 1;
    this.stopTicker();
    this.paused = true;
    this.seeking = false;
    this.anchorSeconds = 0;
    this.url = '';
    this.readyState = HAVE_NOTHING;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.error = null;
    this.releaseBitmap();
  }

  private tick(): void {
    if (this.paused) return;
    this.fire('timeupdate');
    if (this.ended) {
      this.anchorSeconds = this.duration;
      this.paused = true;
      this.stopTicker();
      this.fire('pause');
      this.fire('ended');
    }
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private releaseBitmap(): void {
    const bitmap = this.bitmap;
    this.bitmap = null;
    if (bitmap && 'close' in bitmap) bitmap.close();
  }

  private fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

/** One layer's media: its `<video>` element, and the picture that takes its place for a picture. */
export class ClipMedia extends EventTarget {
  readonly still = new StillPicture();
  /** Which of the two is live: the picture, or the element. */
  private picture = false;
  private readonly unlisten: Array<() => void> = [];

  constructor(readonly element: HTMLVideoElement) {
    super();
    for (const type of FORWARDED) {
      this.forward(element, type, () => !this.picture);
      this.forward(this.still, type, () => this.picture);
    }
  }

  /** Whether the slot is showing a picture now rather than its video element. */
  get isPicture(): boolean {
    return this.picture;
  }

  /**
   * Makes the picture or the element the live one, from the next `src` on.
   *
   * The one going quiet gives up what it holds: an element pointed away from a video hands its
   * decoder back - which is the scarcest thing a phone has, and the whole reason the preview keeps
   * so few elements - and a picture that stops being one lets its bitmap go. Neither says anything
   * about it, because nothing is listening to the one that is not live.
   */
  showPicture(picture: boolean): void {
    if (picture === this.picture) return;
    this.picture = picture;
    if (picture) {
      this.element.pause();
      this.element.removeAttribute('src');
      this.element.load();
    } else {
      this.still.clear();
    }
  }

  /** What the compositor draws: the element itself, or the picture once it has decoded. */
  get drawable(): LayerSource | null {
    return this.picture ? this.still.bitmap : this.element;
  }

  get src(): string {
    return this.picture ? this.still.src : this.element.src;
  }

  set src(url: string) {
    if (this.picture) this.still.src = url;
    else this.element.src = url;
  }

  load(): void {
    if (this.picture) this.still.load();
    else this.element.load();
  }

  play(): Promise<void> {
    return this.picture ? this.still.play() : this.element.play();
  }

  pause(): void {
    if (this.picture) this.still.pause();
    else this.element.pause();
  }

  get currentTime(): number {
    return this.live.currentTime;
  }

  set currentTime(seconds: number) {
    this.live.currentTime = seconds;
  }

  get playbackRate(): number {
    return this.live.playbackRate;
  }

  set playbackRate(rate: number) {
    this.live.playbackRate = rate;
  }

  get muted(): boolean {
    return this.live.muted;
  }

  set muted(muted: boolean) {
    this.live.muted = muted;
  }

  get volume(): number {
    return this.live.volume;
  }

  set volume(volume: number) {
    this.live.volume = volume;
  }

  get preservesPitch(): boolean {
    return this.picture ? this.still.preservesPitch : ((this.element as PitchAware).preservesPitch ?? true);
  }

  set preservesPitch(keep: boolean) {
    if (this.picture) this.still.preservesPitch = keep;
    else (this.element as PitchAware).preservesPitch = keep;
  }

  get paused(): boolean {
    return this.live.paused;
  }

  get ended(): boolean {
    return this.live.ended;
  }

  get seeking(): boolean {
    return this.live.seeking;
  }

  get readyState(): number {
    return this.live.readyState;
  }

  get videoWidth(): number {
    return this.live.videoWidth;
  }

  get videoHeight(): number {
    return this.live.videoHeight;
  }

  get duration(): number {
    return this.live.duration;
  }

  get error(): { code: number; message: string } | MediaError | null {
    return this.live.error;
  }

  /** `poster` is the element's alone: it is what a paused `<video>` shows, and a picture shows itself. */
  setAttribute(name: string, value: string): void {
    this.element.setAttribute(name, value);
  }

  /** Removing `src` strips BOTH, which is how a slot is emptied on the way out. */
  removeAttribute(name: string): void {
    this.element.removeAttribute(name);
    this.still.removeAttribute(name);
  }

  /** Stops forwarding and lets the picture go. The element is the component's, and stays. */
  dispose(): void {
    for (const off of this.unlisten) off();
    this.unlisten.length = 0;
    this.still.clear();
  }

  private get live(): HTMLVideoElement | StillPicture {
    return this.picture ? this.still : this.element;
  }

  private forward(source: EventTarget, type: string, live: () => boolean): void {
    const handler = () => {
      if (live()) this.dispatchEvent(new Event(type));
    };
    source.addEventListener(type, handler);
    this.unlisten.push(() => source.removeEventListener(type, handler));
  }
}

interface PitchAware {
  preservesPitch?: boolean;
}
