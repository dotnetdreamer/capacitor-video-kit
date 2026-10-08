import { decodePicture, releasePicture, type DecodedPicture } from '../../web-runtime/picture';

/**
 * The long side a picture is decoded at for the preview. The compositor draws into a canvas at most
 * twice the size of the box on screen, so a phone's preview never needs more than this - and the
 * crop tool, which shows the whole of a source on a stage the size of the preview, needs no more
 * either.
 */
export const PREVIEW_MAX_EDGE = 2048;

/**
 * How many bytes of decoded pictures that no slot is showing are kept, for a slot that asks for one
 * again: about five full-HD photos. See [PreviewPictures].
 */
export const KEPT_PICTURE_BYTES = 48 * 1024 * 1024;

/** One slot's claim on a picture, from [PreviewPictures.hold]. */
export interface PictureHold {
  /** The picture, already decoded - by another slot, or kept from a moment ago - or null until it is. */
  readonly picture: DecodedPicture | null;
  /** Settles once the picture has decoded, or rejects when it will not. */
  readonly ready: Promise<DecodedPicture>;
  /** Gives the claim up. A second call does nothing. */
  release(): void;
}

type Decode = (url: string, maxEdge: number) => Promise<DecodedPicture>;

interface Entry {
  readonly ready: Promise<DecodedPicture>;
  picture: DecodedPicture | null;
  holders: number;
  /** When the last holder let go, which orders the kept ones for dropping: oldest first. */
  releasedAt: number;
}

/**
 * The preview's decoded pictures, one per file however many slots show it.
 *
 * A picture is on screen in more than one place more often than not. A template cuts back to the
 * same photo, and a split opens on photos the base track showed a moment before: one with two
 * splits and a grid put seven layers on four photos, every one of them shown full frame first.
 * Each slot used to decode its own copy, and a copy is a new picture to the painter, uploaded to
 * the GPU on the frame it first appears. So every split opened on its photos being decoded and
 * uploaded all over again on the very frame the halves began to slide: 220-380 ms of a frozen stage
 * on the iOS 26.5 simulator (2026-10-07), the slide's first half never seen. Shared, a photo is
 * decoded once and is the same picture wherever it is shown, which the painter has already
 * uploaded.
 *
 * A picture no slot is holding any more is not let go of at once: the most recently released ones
 * are kept, up to [KEPT_PICTURE_BYTES], because the slot that wants one next - the base track
 * cutting back, a layer opening on it - is usually a second or two away. Past that the oldest is
 * released: its bitmap closed or its canvas emptied, and the painter lets its texture go with it.
 *
 * Owned by one preview and destroyed with it, so nothing outlives the editor that showed it.
 */
export class PreviewPictures {
  private readonly entries = new Map<string, Entry>();
  private readonly decode: Decode;
  private readonly keptBytes: number;
  private clock = 0;
  private destroyed = false;

  constructor(
    private readonly maxEdge = PREVIEW_MAX_EDGE,
    options: { keptBytes?: number; decode?: Decode } = {},
  ) {
    this.keptBytes = Math.max(0, options.keptBytes ?? KEPT_PICTURE_BYTES);
    this.decode = options.decode ?? decodePicture;
  }

  /**
   * A claim on the picture at `url`, decoding it if nothing has yet. Every claim is given up with
   * its `release`; the picture stays for as long as one is not.
   */
  hold(url: string): PictureHold {
    const entry = this.entries.get(url) ?? this.start(url);
    entry.holders += 1;
    let released = false;
    return {
      get picture() {
        return released ? null : entry.picture;
      },
      ready: entry.ready,
      release: () => {
        if (released) return;
        released = true;
        this.letGo(url, entry);
      },
    };
  }

  /**
   * Decodes the picture at `url` before any slot asks for it, so the one that does finds it ready.
   * Kept like any picture nobody is holding, as the most recent, so it is the last to be dropped.
   */
  warm(url: string): void {
    if (!url || this.destroyed || this.entries.has(url)) return;
    this.hold(url).release();
  }

  /** Whether the picture at `url` has decoded and is here to be held. */
  has(url: string): boolean {
    return this.entries.get(url)?.picture != null;
  }

  /** Lets every picture go, held or not; a decode still running lets its picture go when it lands. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const entry of this.entries.values()) {
      if (entry.picture) releasePicture(entry.picture);
      entry.picture = null;
    }
    this.entries.clear();
  }

  private start(url: string): Entry {
    const entry: Entry = {
      ready: this.decode(url, this.maxEdge).then(
        picture => {
          if (this.destroyed || this.entries.get(url) !== entry) {
            releasePicture(picture);
            throw new Error('the picture was let go of before it decoded');
          }
          entry.picture = picture;
          // Warmed or let go of while decoding, it joins the kept ones now it has a size to count.
          if (entry.holders === 0) this.trim();
          return picture;
        },
        (error: unknown) => {
          // Forgotten, so the next slot to ask tries the file again rather than inheriting a failure.
          if (this.entries.get(url) === entry) this.entries.delete(url);
          throw error;
        },
      ),
      picture: null,
      holders: 0,
      releasedAt: 0,
    };
    // A failure is answered to whoever holds it; one nobody holds must not surface as unhandled.
    entry.ready.catch(() => undefined);
    if (!this.destroyed) this.entries.set(url, entry);
    return entry;
  }

  private letGo(url: string, entry: Entry): void {
    if (this.entries.get(url) !== entry) return;
    entry.holders -= 1;
    if (entry.holders > 0) return;
    entry.releasedAt = ++this.clock;
    this.trim();
  }

  /** Drops the longest-unheld pictures until those nobody holds fit [keptBytes] again. */
  private trim(): void {
    const idle = [...this.entries].filter(([, entry]) => entry.holders === 0 && entry.picture);
    let bytes = idle.reduce((sum, [, entry]) => sum + bytesOf(entry.picture!), 0);
    idle.sort((a, b) => a[1].releasedAt - b[1].releasedAt);
    for (const [url, entry] of idle) {
      if (bytes <= this.keptBytes) break;
      bytes -= bytesOf(entry.picture!);
      this.entries.delete(url);
      releasePicture(entry.picture!);
      entry.picture = null;
    }
  }
}

function bytesOf(picture: DecodedPicture): number {
  return picture.width * picture.height * 4;
}
