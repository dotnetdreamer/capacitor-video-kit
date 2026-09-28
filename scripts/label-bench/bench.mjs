// Runs MediaPipe's image classifier (EfficientNet-Lite0 int8, CPU) over every test photo in a real,
// visible Chromium and writes results.json: [{ file, scene, labels: [[name, score], ...] }].
// Photos are read from .work/ (fetch_photos.py, plus optional .work/photos-lab/<scene>/* and
// .work/photos-game/*); results go to .work/results.json. Run from the kit folder: node scripts/label-bench/bench.mjs
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';


const W = join(import.meta.dirname, '.work');
const KIT = join(import.meta.dirname, '../..');
const { chromium } = createRequire(join(KIT, 'package.json'))('playwright');
const MP = join(KIT, 'node_modules/@mediapipe/tasks-vision');
const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.tflite': 'application/octet-stream', '.html': 'text/html' };

const PAGE = `<!doctype html><title>label bench</title><script type="module">
import { FilesetResolver, ImageClassifier } from '/vision_bundle.mjs';
window.ready = (async () => {
  const files = await FilesetResolver.forVisionTasks('/wasm');
  window.clf = await ImageClassifier.createFromOptions(files, {
    baseOptions: { modelAssetPath: '/model.tflite', delegate: 'CPU' },
    maxResults: 25, scoreThreshold: 0.005, runningMode: 'IMAGE',
  });
})();
window.classify = async (url) => {
  await window.ready;
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const t = performance.now();
  const result = window.clf.classify(bitmap);
  const ms = performance.now() - t;
  bitmap.close();
  return { ms, labels: result.classifications[0].categories.map((c) => [c.categoryName, Math.round(c.score * 1e4) / 1e4]) };
};
</script>`;

function route(url) {
  const path = decodeURIComponent(url.split('?')[0]);
  if (path === '/' || path === '/bench.html') return { body: PAGE, type: 'text/html' };
  if (path === '/vision_bundle.mjs') return { file: join(MP, 'vision_bundle.mjs') };
  if (path.startsWith('/wasm/')) return { file: join(MP, path) };
  if (path === '/model.tflite') return { file: join(KIT, 'web-assets/labeling/efficientnet_lite0.tflite') };
  if (path.startsWith('/img/')) return { file: join(W, path.slice(5)) };
  return null;
}

const server = createServer((req, res) => {
  const found = route(req.url);
  if (!found || (found.file && !existsSync(found.file))) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': found.type ?? TYPES[extname(found.file)] ?? 'application/octet-stream' });
  res.end(found.body ?? readFileSync(found.file));
}).listen(0);
const port = server.address().port;

// Every photo, with the scene it was chosen for.
const items = [];
for (const entry of JSON.parse(readFileSync(join(W, 'photos/index.json'), 'utf8'))) items.push({ file: entry.file, scene: entry.scene, set: 'openverse' });
for (const scene of existsSync(join(W, 'photos-lab')) ? readdirSync(join(W, 'photos-lab')) : []) {
  for (const f of readdirSync(join(W, 'photos-lab', scene))) items.push({ file: `photos-lab/${scene}/${f}`, scene, set: 'lab' });
}
for (const f of existsSync(join(W, 'photos-game')) ? readdirSync(join(W, 'photos-game')) : []) {
  if (statSync(join(W, 'photos-game', f)).size > 0) items.push({ file: `photos-game/${f}`, scene: 'game', also: 'screen', set: 'game' });
}

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/bench.html`);
const results = [];
let totalMs = 0;
for (const item of items) {
  const { ms, labels } = await page.evaluate((url) => window.classify(url), `/img/${item.file}`);
  totalMs += ms;
  results.push({ ...item, labels });
}
await browser.close();
server.close();
writeFileSync(join(W, 'results.json'), JSON.stringify(results, null, 1));
console.log(`${results.length} photos, ${(totalMs / results.length).toFixed(1)} ms each on average`);
