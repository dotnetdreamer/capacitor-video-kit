// Scores the kit's MEDIAPIPE scene table against results.json: per scene, how often the photos chosen
// for it come out with it on top (top-1), in the top two (top-2), its mean score there, and how often
// it is wrongly on top for another scene's photos (false tops). `node scripts/label-bench/eval.mjs [--misses]`.
import { readFileSync } from 'node:fs';

const { scenesFromLabels, MEDIA_SCENES } = await import(new URL('../../src/video-composer/scenes.ts', import.meta.url).href);
const results = JSON.parse(readFileSync(new URL('./.work/results.json', import.meta.url), 'utf8'));
const MIN = 0.02;
const showMisses = process.argv.includes('--misses');

const stats = new Map(MEDIA_SCENES.map((s) => [s, { n: 0, top1: 0, top2: 0, score: 0, falseTop: 0, none: 0 }]));
const misses = [];
for (const r of results) {
  const labels = r.labels.filter(([, c]) => c >= MIN).map(([label, confidence]) => ({ label, confidence }));
  const ranked = scenesFromLabels([{ timeMs: 0, labels }], 'mediapipe');
  const truth = new Set([r.scene, r.also].filter(Boolean));
  const s = stats.get(r.scene);
  s.n++;
  const top = ranked[0]?.scene;
  if (!top) s.none++;
  if (truth.has(top)) s.top1++;
  else if (top) stats.get(top).falseTop++;
  if (ranked.slice(0, 2).some((x) => truth.has(x.scene))) s.top2++;
  s.score += ranked.find((x) => x.scene === r.scene)?.score ?? 0;
  if (!truth.has(top)) misses.push(`${r.scene.padEnd(8)} ${r.file.padEnd(34)} -> ${ranked.slice(0, 3).map((x) => `${x.scene} ${x.score}`).join(', ') || '(none)'} | ${r.labels.slice(0, 4).map(([l, c]) => `${l} ${c}`).join(', ')}`);
}

let n = 0, top1 = 0, top2 = 0;
console.log('scene     n  top1  top2  score  none  falseTop');
for (const [scene, s] of stats) {
  if (!s.n) continue;
  console.log(`${scene.padEnd(8)} ${String(s.n).padStart(3)}  ${pct(s.top1, s.n)}  ${pct(s.top2, s.n)}  ${(s.score / s.n).toFixed(2)}  ${String(s.none).padStart(4)}  ${String(s.falseTop).padStart(4)}`);
  if (!['sunset', 'people', 'night'].includes(scene)) { n += s.n; top1 += s.top1; top2 += s.top2; }
}
console.log(`\nscenes it can see: top1 ${pct(top1, n)}, top2 ${pct(top2, n)} of ${n}`);
if (showMisses) console.log('\n' + misses.join('\n'));

function pct(a, b) {
  return `${Math.round((100 * a) / b)}%`.padStart(4);
}
