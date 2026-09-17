/**
 * The editor's bundled sticker pack: the "Stickers" tab of the Stickers sheet.
 *
 * Each sticker is a standalone SVG under `src/assets/stickers/<id>.svg`. The files are
 * drawn from plain paths - no `<text>`, no web fonts, no filters, no external references - because
 * the rasteriser loads them into an `<img>` and draws that onto a canvas, and an SVG used as an
 * image can neither fetch a font nor be trusted to render a filter the same way on every WebView.
 * Every file also declares an intrinsic `width`/`height` next to its `viewBox`: without one, some
 * WebViews decode an SVG image at 300x150 or 0x0 and the layer comes out squashed or blank. The
 * lettering is a hand-drawn round-pen alphabet stroked with an ink outline, a white die-cut edge
 * and a soft offset shadow, all baked into the file.
 *
 * A manifest stores only the sticker id (`StickerOverlay.assetId`), so ids are permanent: renaming
 * or deleting a file would make saved drafts lose that layer. Labels, keywords and the order below
 * can change freely.
 */
import { editorAssetUrl } from '../host/asset-path';

export type StickerCategory = 'reactions' | 'food' | 'badges' | 'shapes';

/** The sheet's bottom category bar, in display order. */
export const STICKER_CATEGORIES: { id: StickerCategory; label: string; icon: string }[] = [
  { id: 'reactions', label: 'Reactions', icon: '🤩' },
  { id: 'food', label: 'Food', icon: '🍕' },
  { id: 'badges', label: 'Badges', icon: '🏅' },
  { id: 'shapes', label: 'Shapes', icon: '✨' },
];

export interface StickerAsset {
  /** Kebab-case, equal to the SVG's file name. Permanent - see the note at the top of this file. */
  id: string;
  label: string;
  category: StickerCategory;
  /** Lowercase search terms beyond the label, so "delicious" finds "Yum!". */
  keywords: string[];
}

export const STICKERS: StickerAsset[] = [
  // Reactions
  { id: 'yes', label: 'YES!', category: 'reactions', keywords: ['yes', 'agree', 'excited', 'hype'] },
  { id: 'wow', label: 'WOW', category: 'reactions', keywords: ['wow', 'amazing', 'surprised', 'impressed'] },
  { id: 'omg', label: 'OMG', category: 'reactions', keywords: ['omg', 'shocked', 'surprised', 'no way'] },
  { id: 'ten-out-of-ten', label: '10/10', category: 'reactions', keywords: ['10', 'ten', 'score', 'rating', 'perfect'] },
  { id: 'lol', label: 'LOL', category: 'reactions', keywords: ['lol', 'funny', 'laugh', 'haha'] },
  { id: 'thumbs-up', label: 'Thumbs up', category: 'reactions', keywords: ['like', 'good', 'approve', 'ok', 'hand'] },
  { id: 'fire', label: 'Fire', category: 'reactions', keywords: ['fire', 'hot', 'lit', 'trending', 'flame'] },
  { id: 'heart-eyes', label: 'Heart eyes', category: 'reactions', keywords: ['love', 'face', 'smile', 'crush', 'adore'] },
  { id: 'mind-blown', label: 'Mind blown', category: 'reactions', keywords: ['mind blown', 'wow', 'boom', 'shocked', 'amazing'] },

  // Food
  { id: 'must-try', label: 'Must try', category: 'food', keywords: ['must try', 'recommend', 'try this', 'favourite'] },
  { id: 'yum', label: 'Yum!', category: 'food', keywords: ['yum', 'delicious', 'tasty', 'yummy'] },
  { id: 'tasty', label: 'Tasty', category: 'food', keywords: ['tasty', 'delicious', 'good food', 'flavour'] },
  { id: 'chefs-kiss', label: "Chef's kiss", category: 'food', keywords: ['chef', 'kiss', 'perfect', 'delicious', 'hat'] },
  { id: 'pizza', label: 'Pizza', category: 'food', keywords: ['pizza', 'slice', 'italian', 'pepperoni'] },
  { id: 'burger', label: 'Burger', category: 'food', keywords: ['burger', 'hamburger', 'fast food', 'cheeseburger'] },
  { id: 'coffee', label: 'Coffee', category: 'food', keywords: ['coffee', 'cafe', 'latte', 'takeaway', 'drink'] },
  { id: 'ramen', label: 'Ramen', category: 'food', keywords: ['ramen', 'noodles', 'bowl', 'soup', 'japanese'] },
  { id: 'donut', label: 'Donut', category: 'food', keywords: ['donut', 'doughnut', 'dessert', 'sweet', 'bakery'] },

  // Badges
  { id: 'hidden-gem', label: 'Hidden gem', category: 'badges', keywords: ['hidden gem', 'diamond', 'secret', 'discovery'] },
  { id: 'top-pick', label: 'Top pick', category: 'badges', keywords: ['top pick', 'best', 'award', 'winner', 'rosette'] },
  { id: 'new', label: 'New!', category: 'badges', keywords: ['new', 'just opened', 'fresh', 'launch'] },
  { id: 'best-value', label: 'Best value', category: 'badges', keywords: ['best value', 'cheap', 'deal', 'affordable', 'budget'] },
  { id: 'local-fave', label: 'Local fave', category: 'badges', keywords: ['local', 'favourite', 'favorite', 'pin', 'location', 'neighbourhood'] },
  { id: 'price-tag', label: 'Price tag', category: 'badges', keywords: ['price', 'tag', 'money', 'dollar', 'cost'] },
  { id: 'five-stars', label: '5 stars', category: 'badges', keywords: ['5', 'five', 'stars', 'rating', 'review'] },
  { id: 'open-now', label: 'Open now', category: 'badges', keywords: ['open', 'now', 'sign', 'hours'] },
  { id: 'choisy-approved', label: 'Choisy approved', category: 'badges', keywords: ['choisy', 'approved', 'verified', 'check', 'stamp'] },

  // Shapes
  { id: 'arrow-curve', label: 'Arrow', category: 'shapes', keywords: ['arrow', 'point', 'look', 'this'] },
  { id: 'circle-scribble', label: 'Circle', category: 'shapes', keywords: ['circle', 'scribble', 'highlight', 'ring', 'marker'] },
  { id: 'sparkles', label: 'Sparkles', category: 'shapes', keywords: ['sparkles', 'shine', 'stars', 'magic', 'glitter'] },
  { id: 'speech-bubble', label: 'Speech bubble', category: 'shapes', keywords: ['speech', 'bubble', 'chat', 'talk', 'comment'] },
  { id: 'star-burst', label: 'Star burst', category: 'shapes', keywords: ['burst', 'boom', 'pow', 'explosion', 'star'] },
  { id: 'crown', label: 'Crown', category: 'shapes', keywords: ['crown', 'king', 'queen', 'best', 'royal'] },
  { id: 'heart', label: 'Heart', category: 'shapes', keywords: ['heart', 'love', 'like', 'red'] },
];

const STICKER_BY_ID = new Map(STICKERS.map((s) => [s.id, s]));

/**
 * The URL the WebView loads a sticker from.
 *
 * It goes through the editor's asset base rather than a literal string because a manifest stores
 * only the `assetId`: the base has to be a runtime value, or a draft saved under one host's asset
 * layout would stop resolving under another's. `setEditorAssetPath()` is how a host says where the
 * files are.
 */
export function stickerUrl(assetId: string): string {
  return editorAssetUrl(`assets/stickers/${assetId}.svg`);
}

/** Null for an id this build does not ship (a draft from a newer build, or a removed sticker). */
export function stickerById(id: string): StickerAsset | null {
  return STICKER_BY_ID.get(id) ?? null;
}
