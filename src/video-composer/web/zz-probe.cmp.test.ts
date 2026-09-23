import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import { it } from 'vitest';
import type { ComposeSpec } from '../definitions';
import { renderSpec } from './render';

async function make(noise: boolean): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 160; canvas.height = 120;
  const ctx = canvas.getContext('2d')!;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'avc', quality: new Quality({ bitrate: 1_000_000 }) });
  output.addVideoTrack(source);
  await output.start();
  for (let i = 0; i < 12; i++) {
    if (noise) {
      const image = ctx.createImageData(160, 120);
      for (let p = 0; p < image.data.length; p++) image.data[p] = (p % 4 === 3) ? 255 : Math.floor(Math.random() * 256);
      ctx.putImageData(image, 0, 0);
    } else { ctx.fillStyle = '#0a0'; ctx.fillRect(0, 0, 160, 120); }
    await source.add(i / 12, 1 / 12);
  }
  await output.finalize();
  return new Blob([(output.target as BufferTarget).buffer!], { type: 'video/mp4' });
}

function spec(uri: string, over: Partial<ComposeSpec> = {}): ComposeSpec {
  return {
    jobId: 'p', batchId: 'p',
    clips: [{ key: 'c1', uri, inMs: 0, outMs: 1000, speed: 1, volume: 1, muted: false, fit: 'contain' }],
    output: { width: 160, height: 284, fps: 10, videoBitrate: 800_000, audioBitrate: 128_000 },
    filter: [], overlays: [], audio: { originalMuted: true, originalVolume: 1, music: null, voiceover: [] }, posterAtMs: 100, ...over,
  };
}

it('probe', async () => {
  for (const noise of [false, true]) {
    const src = URL.createObjectURL(await make(noise));
    const out = await renderSpec(spec(src), { signal: new AbortController().signal, onProgress: () => undefined });
    console.log('noise', noise, 'blob', out.blob.size);
    for (const max of [2000, 8000, 20000]) {
      const seen: number[] = [];
      const r = await renderSpec(spec(src, { output: { ...spec(src).output, maxBytes: max } }), { signal: new AbortController().signal, onProgress: p => seen.push(p) }).then(o => 'ok ' + o.blob.size, (e: Error) => e.message);
      console.log('noise', noise, 'max', max, r, 'last progress', seen[seen.length - 1]);
    }
    URL.revokeObjectURL(src);
  }
}, 120000);
