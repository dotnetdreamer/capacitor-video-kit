/**
 * Slow motion that moves, in the live preview: the frame a slowed `<video>` showed BEFORE the one it
 * shows now, and how far the element's clock has come from one to the other.
 *
 * The preview plays a clip slowed below 1x by playing its element at that rate, so a 30 fps clip at
 * 0.3x presents a new picture about nine times a second, and the compositor - drawing sixty times a
 * second - drew each of them six or seven times over. The export no longer does that (see
 * `video-composer/web/slow-motion.ts`): every output frame of a slowed clip is made from the two
 * recorded frames either side of it. This is the preview's half of the same idea, and it hands the
 * painter the same thing the export does - frame A, frame B, and a weight - so the same one step in
 * `frame-interpolation.ts` mixes them.
 *
 * WHY IT LOOKS BACK rather than ahead. The export seeks, so it can fetch the frame after any instant.
 * The preview's element is PLAYING, and the frame after the one on screen does not exist anywhere
 * until the element presents it; fetching it early would take a second decoder per slowed layer,
 * which is the one thing a phone has too few of, or seeking the playing element, which stalls it. So
 * the pair is the frame the element showed last (copied as it was presented) and the frame it shows
 * now, and the weight runs from 0 to 1 across the time the element spends on the one it shows now:
 * the motion is the export's, drawn one source frame late - at 0.3x on 30 fps footage, a ninth of a
 * second. That is the whole cost, it is only paid while a slowed clip is playing, and it was judged
 * worth it: a picture a ninth of a second behind its own sound is hard to notice in slow motion, and
 * a picture that jumps every ninth of a second is impossible not to. Paused, seeking or scrubbing,
 * nothing here applies and the element's own frame is drawn, exactly as before.
 *
 * WHAT IT COSTS, per slowed layer while it plays: one `createImageBitmap` of each frame the element
 * presents (nine a second in the example above), each uploaded to the GPU once, and one more texture
 * read per pixel of that layer. Against that, the element itself is no longer uploaded on every
 * frame the compositor draws - sixty a second, for a picture that changed nine times - so a slowed
 * layer moves fewer pixels to the GPU than it did when it stepped. Nothing for a clip at 1x or
 * faster, nothing while paused.
 *
 * WHAT IT NEEDS: `requestVideoFrameCallback`, which is what says a new frame has been presented and
 * at which media time. A WebView without it (old Android System WebViews) draws slowed clips the way
 * it always did, and nothing here ever waits on anything - it only ever answers with what it already
 * holds, so it cannot stall a frame of playback.
 */

/**
 * Two presented frames further apart than this, in the element's own media seconds, are not a frame
 * and the one after it but a jump - a seek, a clip change on the same element - and nothing is
 * blended across it. A quarter of a second is a 4 fps source, below anything a phone records.
 */
const MAX_FRAME_GAP_S = 0.25;

/**
 * An element nobody has asked about for this long is no longer being drawn as a slowed clip: it is
 * no longer followed, and the frames held for it are let go of. The compositor asks on every frame it
 * draws, so this is a dozen missed frames, not a pause.
 */
const IDLE_MS = 200;

/** One frame copied out of the element as it was presented, or still being copied. */
interface HeldFrame {
  mediaTime: number;
  bitmap: ImageBitmap | null;
}

/** What is known about one element's recent frames. */
interface Track {
  /** A frame callback is registered and has not yet run. */
  armed: boolean;
  /** The source the frames below came from; a new one is a clip change and starts again. */
  src: string;
  /** When the compositor last asked; see [IDLE_MS]. */
  askedAt: number;
  /** The frame on screen, as the element last reported it: its media time and the frame it was presented on. */
  current: { mediaTime: number; atMs: number } | null;
  /** The copy of the frame on screen now. It becomes [previous] when the next one is presented. */
  latest: HeldFrame | null;
  /** The copy of the frame before the one on screen: frame A. */
  previous: HeldFrame | null;
}

/**
 * What a slowed element is drawn as: frame A, frame B and how far from one to the other - or, with a
 * weight of 0, frame A alone.
 *
 * Every frame here is a COPY, made as its frame was presented, never the element itself where a copy
 * can be had, because the element is not the frame its callbacks last named for one rendering step
 * in every source frame: its picture moves on to the next frame one step BEFORE the callback that
 * reports it runs - measured in Chromium. Drawing the element there would blend A with the frame
 * after B, or show B while the pair still said A, and then jump back a frame when the callback
 * caught up. Two copies are two neighbours, always.
 */
export interface PresentedTween {
  /** Frame A: the one the element presented before the one it shows now. */
  from: ImageBitmap;
  /**
   * Frame B, the one it shows now, as copied when it was presented - or null while that copy is
   * still being made, when the element itself is the best there is of it.
   */
  to: ImageBitmap | null;
  /** 0..1 from A towards B; 0 is A alone. */
  weight: number;
}

/**
 * How far from the previous frame towards the current one the picture is, `elapsedMs` of wall time
 * after the current frame was presented: the media time the element has played since, as a fraction
 * of the media time between the two frames. Held at 1 - the current frame alone - for as long as the
 * next frame is late, and 0 for anything that is not a real interval.
 */
export function tweenWeight(elapsedMs: number, playbackRate: number, intervalSeconds: number): number {
  if (!(intervalSeconds > 0) || !(playbackRate > 0) || !(elapsedMs > 0)) return 0;
  return Math.min(1, ((elapsedMs / 1000) * playbackRate) / intervalSeconds);
}

function sameSize(bitmap: ImageBitmap, video: HTMLVideoElement): boolean {
  return bitmap.width === video.videoWidth && bitmap.height === video.videoHeight;
}

export class PresentedFrames {
  private readonly tracks = new Map<HTMLVideoElement, Track>();

  /**
   * @param onDrop hears about every copied frame as it is let go of, before it is closed, so the
   *   painter can give back the texture it was uploaded into.
   */
  constructor(private readonly onDrop: (bitmap: ImageBitmap) => void = () => undefined) {}

  /**
   * For an element playing a SLOWED clip: frame A - the frame it presented before the one it shows
   * now - frame B, and the weight between them; or null where there is nothing to draw but the
   * element as it is. `now` is the animation frame's timestamp, the clock the element's frame
   * callbacks are stamped with.
   *
   * Asking is also what starts the element being followed, so a slowed clip is drawn plain until its
   * first frame has been reported, then holds that frame until the second is, and moves smoothly
   * from there on: one frame held a little longer as slow motion starts, and never a step back.
   */
  tween(video: HTMLVideoElement, now: number = performance.now()): PresentedTween | null {
    if (typeof video.requestVideoFrameCallback !== 'function' || typeof createImageBitmap !== 'function') return null;
    let track = this.tracks.get(video);
    if (!track) {
      track = { armed: false, src: '', askedAt: now, current: null, latest: null, previous: null };
      this.tracks.set(video, track);
    }
    track.askedAt = now;
    this.follow(video, track);
    // Stopped, the element's own frame is the exact one the playhead is on, which is what a paused
    // preview has always shown and what a scrub needs.
    if (video.paused || video.seeking || video.ended) return null;
    const current = track.current;
    if (!current || track.src !== video.currentSrc) return null;
    // A frame of another size is not a frame of this picture: sampled at A's coordinates it would be
    // stretched.
    const latest = track.latest?.bitmap;
    const to = latest && sameSize(latest, video) ? latest : null;
    const previous = track.previous;
    if (!previous?.bitmap || !sameSize(previous.bitmap, video)) {
      // The first pair is still being gathered. The last frame reported is held rather than the
      // element drawn, because the pictures that follow run one frame behind the element: drawing
      // the element now and the pair next would step the picture BACK a frame as the blending began.
      // Holding it costs the same frame drawn a little longer, once, as a slowed clip starts.
      return to ? { from: to, to: null, weight: 0 } : null;
    }
    const interval = current.mediaTime - previous.mediaTime;
    const elapsedMs = now - current.atMs;
    // B's copy not made yet: the element stands in for it, but only while it is sure still to be
    // showing B - the first half of B's expected time on screen. Its picture moves on to the frame
    // after B one step before that frame is reported, so late in the interval it may already be
    // there, and mixing A with it would step the picture back a frame when the report came. Past
    // that, A is held alone: a copy that slow costs one frame held a little longer, never a step back.
    if (!to && !(elapsedMs < ((interval / video.playbackRate) * 1000) / 2)) return { from: previous.bitmap, to: null, weight: 0 };
    return { from: previous.bitmap, to, weight: tweenWeight(elapsedMs, video.playbackRate, interval) };
  }

  /** Stops following every element and lets every held frame go. */
  destroy(): void {
    for (const track of this.tracks.values()) this.release(track);
    this.tracks.clear();
  }

  /* ------------------------------------------------------------------------------------------ */

  private follow(video: HTMLVideoElement, track: Track): void {
    if (track.armed) return;
    track.armed = true;
    video.requestVideoFrameCallback((now, metadata) => this.onPresented(video, track, now, metadata.mediaTime));
  }

  /**
   * A new frame is on screen. The copy of the last one becomes frame A - if the new one really is
   * the frame after it - and a copy of the new one is started, to be frame A in its turn.
   *
   * The copy is taken HERE, in the callback, because it is the one moment the element is known to be
   * showing exactly this frame; `createImageBitmap` takes its snapshot as it is called and only the
   * copying is asynchronous. It is never waited for: a copy that has not landed by the time it is
   * wanted is a frame drawn plain.
   */
  private onPresented(video: HTMLVideoElement, track: Track, now: number, mediaTime: number): void {
    track.armed = false;
    // Destroyed, or given up on, since the callback was registered.
    if (this.tracks.get(video) !== track) return;
    if (now - track.askedAt > IDLE_MS) {
      this.release(track);
      this.tracks.delete(video);
      return;
    }
    const src = video.currentSrc;
    const latest = track.latest;
    const sameSource = track.src === src;
    // The very frame already held, presented again: nothing has moved.
    if (sameSource && latest && mediaTime === latest.mediaTime) {
      this.follow(video, track);
      return;
    }
    const follows = sameSource && latest !== null && mediaTime > latest.mediaTime && mediaTime - latest.mediaTime <= MAX_FRAME_GAP_S;
    this.drop(track.previous);
    track.previous = follows ? latest : null;
    if (!follows) this.drop(latest);

    track.src = src;
    track.current = { mediaTime, atMs: now };
    const held: HeldFrame = { mediaTime, bitmap: null };
    track.latest = held;
    createImageBitmap(video).then(
      bitmap => {
        // Kept only while it is still one of the two frames this track holds; a copy that lands after
        // its frame has already been passed over is let go of at once.
        if (track.latest === held || track.previous === held) held.bitmap = bitmap;
        else bitmap.close();
      },
      () => undefined,
    );
    this.follow(video, track);
  }

  private release(track: Track): void {
    this.drop(track.previous);
    this.drop(track.latest);
    track.previous = null;
    track.latest = null;
    track.current = null;
  }

  private drop(frame: HeldFrame | null): void {
    const bitmap = frame?.bitmap;
    if (!frame || !bitmap) return;
    frame.bitmap = null;
    this.onDrop(bitmap);
    bitmap.close();
  }
}
