import { editorAssetUrl } from './asset-path';

/**
 * Google's own subsets, in Google's own ranges, so a caption in plain English downloads one small
 * file and a Turkish one (ğ ş İ) pulls in the second. The browser fetches a face only when a string
 * needs a character in its range, which is why every family ships as two.
 */
const LATIN_EXT_RANGE =
  'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, ' +
  'U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, ' +
  'U+A720-A7FF';
const LATIN_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, ' +
  'U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

interface EditorFont {
  /** Matches the `family` of a text style in `data/text-styles.ts`. Both sides must stay in step. */
  family: string;
  weight: string;
  style: 'normal' | 'italic';
  /** The file name without its subset suffix; each face ships as `-latin` and `-latin-ext`. */
  file: string;
}

const EDITOR_FONTS: readonly EditorFont[] = [
  { family: 'VE Inter', weight: '700', style: 'normal', file: 'inter-700' },
  { family: 'VE Playfair Display', weight: '700', style: 'italic', file: 'playfair-display-700-italic' },
  { family: 'VE Poppins', weight: '600', style: 'normal', file: 'poppins-600' },
  { family: 'VE Shrikhand', weight: '400', style: 'italic', file: 'shrikhand-400' },
  { family: 'VE Comic Relief', weight: '700', style: 'normal', file: 'comic-relief-700' },
  { family: 'VE Bebas Neue', weight: '400', style: 'normal', file: 'bebas-neue-400' },
  { family: 'VE DM Serif Display', weight: '400', style: 'normal', file: 'dm-serif-display-400' },
  { family: 'VE Baloo 2', weight: '800', style: 'normal', file: 'baloo-2-800' },
  { family: 'VE Great Vibes', weight: '400', style: 'normal', file: 'great-vibes-400' },
  { family: 'VE Sedgwick Ave', weight: '400', style: 'normal', file: 'sedgwick-ave-400' },
  { family: 'VE Caveat', weight: '700', style: 'normal', file: 'caveat-700' },
  { family: 'VE Pacifico', weight: '400', style: 'normal', file: 'pacifico-400' },
  { family: 'VE Special Elite', weight: '400', style: 'normal', file: 'special-elite-400' },
  { family: 'VE Bungee', weight: '400', style: 'normal', file: 'bungee-400' },
  { family: 'VE Anton', weight: '400', style: 'normal', file: 'anton-400' },
  { family: 'VE Bangers', weight: '400', style: 'normal', file: 'bangers-400' },
];

/** The family of the `classic` text style, which is what every new text layer is drawn in. */
const PROBE_FAMILY = 'VE Inter';

/** One call installs them all; a second call is the same promise and fetches nothing again. */
let installed: Promise<void> | null = null;

/**
 * Puts the editor's text faces into the document, which is the one thing the package cannot do
 * from inside its own components.
 *
 * It is load bearing for correctness rather than for looks. The overlay rasteriser draws a text
 * layer onto a canvas whose bitmap is burned into the posted video, and a canvas never waits for a
 * face to arrive - it paints the fallback and moves on. So the preview and the render only agree
 * while both draw with the same bundled file, and if these faces are missing the failure is not a
 * missing font, it is a posted video whose text does not match what the customer approved.
 *
 * `@font-face` declared inside a shadow root does not apply, so a shadow DOM component cannot ship
 * these in its own styles. `document.fonts` is a document level registry instead, which is also
 * where the rasteriser's own `document.fonts.load(font, text)` preload looks for them.
 *
 * Call it once, before the editor renders, and let a rejection surface. Swallowing it would trade
 * a loud failure at startup for a quiet one in the customer's finished video.
 */
export function installEditorFonts(): Promise<void> {
  installed ??= install();
  return installed;
}

async function install(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) {
    throw new Error('installEditorFonts needs a document with a FontFaceSet');
  }

  /* The URL travels with the face because it is what the failure below has to name. */
  const faces: { face: FontFace; url: string }[] = [];
  let probe: { face: FontFace; url: string } | undefined;

  for (const font of EDITOR_FONTS) {
    for (const [suffix, unicodeRange] of [
      ['latin', LATIN_RANGE],
      ['latin-ext', LATIN_EXT_RANGE],
    ] as const) {
      const url = editorAssetUrl(`assets/fonts/${font.file}-${suffix}.woff2`);
      const entry = {
        url,
        face: new FontFace(font.family, `url(${url}) format('woff2')`, {
          weight: font.weight,
          style: font.style,
          display: 'swap',
          unicodeRange,
        }),
      };
      faces.push(entry);

      /*
       * The probe is picked here, from the list above, rather than searched for afterwards by
       * reading `FontFace.family` back. A browser returns a family name containing a space in
       * quotes, so `face.family === 'VE Inter'` is false in Chromium and a search found nothing at
       * all. `latin` is the subset an English caption needs and so the one worth proving.
       */
      if (font.family === PROBE_FAMILY && suffix === 'latin') probe = entry;
    }
  }

  for (const { face } of faces) document.fonts.add(face);

  // Registering is not fetching: a face added to the set downloads when something first draws with
  // it, which is what keeps an edit with no text from paying for 828 KB of fonts, and what lets
  // the rasteriser's own `document.fonts.load(font, text)` pull just the subset a caption needs.
  //
  // So the promise waits on exactly one face, the one a new text layer is drawn in. What that
  // proves is the thing that actually goes wrong: the asset base resolving somewhere the files are
  // not served. A 404 on the rest would otherwise show up as a posted video in Roboto.
  if (!probe) {
    throw new Error(
      `installEditorFonts has no ${PROBE_FAMILY} face to probe with. PROBE_FAMILY and EDITOR_FONTS have ` +
        `drifted apart, and without a probe a wrong asset base passes startup and shows up in a posted video.`,
    );
  }

  try {
    await probe.face.load();
  } catch (cause) {
    throw new Error(
      `installEditorFonts could not load ${PROBE_FAMILY} from ${probe.url}. That is where the editor's asset ` +
        `base points, so either setEditorAssetPath() names the wrong directory or this package's assets ` +
        `directory is not served there. Leaving it would burn the fallback face into the finished video.`,
      { cause },
    );
  }
}
