/**
 * Serves this example over http, because a module script and an import map both need an origin and
 * neither works from `file://`.
 *
 * Three roots, which is the whole of what a host application has to arrange as well:
 *
 *   /                      this directory, the page itself
 *   /node_modules/         the app's `node_modules`, so `@capacitor-video-kit/core/...` in the import map
 *                          resolves to the real files the way a bundler would resolve it
 *   /video-editor/assets/  a copy of the package's `dist/components/assets`, which is what
 *                          `setEditorAssetPath('/video-editor/')` in example.js points at
 *
 * Nothing is copied and nothing is built. The package is installed here as a self link, so
 * `node_modules/@capacitor-video-kit/core` is a symlink back to this repository and what the page loads is
 * whatever the last `npm run build:package` left in `dist/`.
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

const PORT = Number(process.env.PORT ?? 5173);

const ROOTS = [
  { prefix: '/node_modules/', dir: join(repo, 'node_modules') },
  { prefix: '/video-editor/assets/', dir: join(repo, 'dist', 'components', 'assets') },
  { prefix: '/', dir: here },
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

/* The one thing worth failing loudly about: the page loads the built package, not the sources. */
const editorBuild = join(repo, 'dist', 'components', 've-editor.js');
if (!exists(editorBuild)) {
  console.error(`${editorBuild} is not there.\nRun "npm run build:package" in ${repo} first.`);
  process.exit(1);
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);
  const file = locate(path);
  if (!file) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`404 ${path}`);
    return;
  }
  response.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    /* The example is looked at while the package is rebuilt underneath it. */
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(response);
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});

/**
 * The path a request means, or null.
 *
 * `resolve` collapses `..` before the prefix is checked, so a request for
 * `/node_modules/../../etc/passwd` lands outside the root and is refused. The symlink at
 * `node_modules/@capacitor-video-kit/core` is followed on purpose and the real path is not what is checked,
 * because following it is the point.
 */
function locate(path) {
  for (const { prefix, dir } of ROOTS) {
    if (!path.startsWith(prefix)) continue;
    const full = resolve(dir, `.${path.slice(prefix.length - 1)}`);
    if (full !== dir && !full.startsWith(`${dir}/`)) return null;
    if (exists(full)) return full;
    const index = join(full, 'index.html');
    if (exists(index)) return index;
  }
  return null;
}

function exists(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
