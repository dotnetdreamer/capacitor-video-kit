import { getAssetPath } from '@stencil/core';

/**
 * Where the package's own files are served from, kept in the one place every copy of this code can
 * see.
 *
 * A consumer ends up with more than one copy of the editor's JavaScript and there is no arranging
 * that away. The wrappers render the standalone build in `dist/components`, a script tag renders
 * the lazy build in `dist/capacitor-video-kit`, and each carries its own inlined Stencil runtime
 * with its own module scoped resources URL. Stencil's `setAssetPath` writes the runtime it was
 * imported from, so a call made through one entry point is invisible to the other, and the failure
 * is silent in the worst way: stickers 404 and the caption burned into the customer's posted video
 * comes out in the fallback face.
 *
 * So the base lives on a `Symbol.for` key on `globalThis`, which is the same slot in every copy in
 * the realm, and every copy resolves against it. One call to `setEditorAssetPath` is seen by all of
 * them.
 */
const ASSET_BASE = Symbol.for('capacitor-video-kit.assetBase');

/** `globalThis` is not typed with our key, and a symbol index signature is how that is spelled. */
type AssetBaseHolder = Record<symbol, string | undefined>;

/**
 * Says where the 34 sticker SVGs and the 32 font files are served from.
 *
 * It has to be settable at runtime rather than fixed at build time, because a manifest stores only
 * a sticker's permanent `assetId` and a saved draft has to keep resolving under whatever layout the
 * host happens to serve.
 *
 * Stencil's own `setAssetPath` is deliberately not called from here, and adding it back would
 * reintroduce a crash. In the `dist-custom-elements` build Rollup sees the entry point already
 * re-exporting `setAssetPath` from the runtime chunk and drops the local import binding, so the
 * call compiles to a bare `setAssetPath(path)` against an identifier that is not in scope and
 * throws `ReferenceError` the first time a wrapper consumer calls it. `getAssetPath` below is
 * bound correctly in both builds, which is why reading still goes through Stencil when no base has
 * been set.
 */
export function setEditorAssetPath(path: string): void {
  (globalThis as unknown as AssetBaseHolder)[ASSET_BASE] = directory(path);
}

/** The call every message here points at, spelled once so the two cannot drift. */
const CALL = "setEditorAssetPath('/video-editor/')";

/**
 * Turns what a host wrote into the base the rest of this file can resolve against, and refuses the
 * two spellings that would otherwise be wrong in silence.
 *
 * `new URL(relative, base)` needs an absolute base, so `/video-editor/`, which is the first thing
 * anyone writes, would throw on the first sticker. Resolving against the document's base URL once,
 * here, lets a host say where the files are the way it would in an `href`. An absolute URL passes
 * through unchanged.
 */
function directory(path: string): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error(
      `setEditorAssetPath() was called with ${JSON.stringify(path)}. It wants the URL of the directory ` +
        `that holds this package's "assets" directory, such as ${CALL} when /video-editor/assets/stickers/ ` +
        `is what the server answers.`,
    );
  }

  /*
   * A base is a directory here, always. `new URL('assets/x', 'https://h/a/b')` resolves against
   * `https://h/a/`, so a base written without its trailing slash quietly loses its last segment and
   * every sticker and every font is looked for one directory too high. Adding the slash is the only
   * reading of `/video-editor` that can have been meant.
   */
  const trimmed = path.trim();
  const asDirectory = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  const base = typeof document === 'undefined' ? asDirectory : new URL(asDirectory, document.baseURI).href;

  /*
   * Everything this package asks for lives under `assets/` beneath the base: `stickerUrl` asks for
   * `assets/stickers/<id>.svg` and `installEditorFonts` for `assets/fonts/<face>.woff2`. So a base
   * that is itself the assets directory resolves to `assets/assets/...` and 404s everything. It is
   * the one wrong base that can be caught without a network round trip, and it is the one people
   * write, because the directory they copied was named `assets`.
   */
  if (/(^|\/)assets\/$/.test(base)) {
    throw new Error(
      `setEditorAssetPath() was called with ${JSON.stringify(path)}, which ends in "assets". It wants the ` +
        `directory that contains "assets" rather than the assets directory itself, because this package asks ` +
        `for assets/stickers/<id>.svg and assets/fonts/<face>.woff2 beneath the base: as given, a sticker ` +
        `would be fetched from ${base}assets/stickers/. Pass the parent directory instead.`,
    );
  }

  return base;
}

/**
 * The URL to one of the package's own files, relative to the package root, such as
 * `assets/stickers/crown.svg`.
 *
 * Nothing in this package calls Stencil's `getAssetPath` directly, and nothing new should: a
 * component that did would read the base of whichever runtime it was bundled with rather than the
 * one the host set.
 *
 * With no base set this falls through to Stencil, which works out its own from the script a
 * component loaded from. That succeeds in the lazy build and throws in the standalone build, whose
 * resources URL starts empty, so a wrapper consumer who never calls `setEditorAssetPath` is told
 * so rather than being handed a broken URL.
 */
export function editorAssetUrl(relativePath: string): string {
  const base = (globalThis as unknown as AssetBaseHolder)[ASSET_BASE];
  if (base === undefined) return stencilAssetUrl(relativePath);

  // The same two lines as Stencil's own `getAssetPath`, so a base set through here and a base
  // Stencil worked out for itself produce one spelling of a URL rather than two.
  const url = new URL(relativePath, base);
  return typeof window !== 'undefined' && url.origin === window.location.origin ? url.pathname : url.href;
}

/**
 * The fallback, and the place a forgotten `setEditorAssetPath` is finally noticed.
 *
 * Stencil's `getAssetPath` builds `new URL(path, resourcesUrl)`, and in the standalone build the
 * wrappers render that resources URL starts empty, so it throws `TypeError: Failed to construct
 * URL: Invalid base URL`. That message names neither this package nor the call that was missed, and
 * it is what a React, Vue or Angular consumer sees on their first sticker. Rewriting it is the only
 * thing this wrapper does; the original is kept as `cause`.
 */
function stencilAssetUrl(relativePath: string): string {
  try {
    return getAssetPath(relativePath);
  } catch (cause) {
    throw new Error(
      `@capacitor-video-kit/core cannot work out where its own files are served from, so "${relativePath}" ` +
        `cannot be resolved. Nothing has called setEditorAssetPath() and this build carries no base of its ` +
        `own, which is what the standalone build behind the React, Vue and Angular wrappers always looks ` +
        `like. Serve a copy of node_modules/@capacitor-video-kit/core/dist/components/assets and call ${CALL} ` +
        `once, before the editor renders.`,
      { cause },
    );
  }
}
