import type { LabelEngine, LabelMediaOptions, LabelMediaResult, MediaLabel } from './definitions';
import { VideoComposer } from './index';
import { scenesFromLabels, type SceneScore } from './scenes';

/** What [describeMedia] is asked: `labelMedia`'s options without the file, which is its own argument. */
export type DescribeMediaOptions = Omit<LabelMediaOptions, 'uri'>;

/** A picture or a clip, as the phone's own image recogniser saw it. */
export interface MediaDescription {
  /** Whose labels these are. See [LabelEngine]. */
  engine: LabelEngine;
  /** Whether the file was read as a picture or as a video. */
  kind: 'video' | 'image';
  /** What it shows, strongest first: [scenesFromLabels] of every frame looked at. */
  scenes: SceneScore[];
  /**
   * The engine's own labels, each the mean of its confidence over the frames looked at (0 in a frame
   * that did not show it), strongest first. In the engine's words, for a host that wants more than
   * the scenes say.
   */
  labels: MediaLabel[];
  /** How many frames were looked at: 1 for a picture. */
  frames: number;
}

/**
 * What a picture or a clip shows, on the device: [MediaScene]s strongest first, and the labels
 * behind them. `labelMedia`, read by [scenesFromLabels] - the one call a host needs to say "these
 * clips are food" whichever phone it runs on.
 *
 * Null where there is nothing to ask: in a browser, which has no image recogniser, in the iOS
 * simulator, where Vision's classifier does not run, and in an app whose native build predates
 * `labelMedia`, which the bridge answers `UNIMPLEMENTED`. A host reads
 * null as "no scenes here" and carries on - an app that picks a template by what the clips show
 * picks one by their number instead. A file that cannot be read still rejects, as `labelMedia`
 * does, because that is something to say about the file rather than about the platform.
 */
export async function describeMedia(uri: string, options: DescribeMediaOptions = {}): Promise<MediaDescription | null> {
  let result: LabelMediaResult;
  try {
    result = await VideoComposer.labelMedia({ ...options, uri });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'unsupported' || code === 'UNIMPLEMENTED') return null;
    throw error;
  }
  const frames = result.frames;
  return {
    engine: result.engine,
    kind: result.kind,
    scenes: scenesFromLabels(frames, result.engine),
    labels: meanLabels(frames.map((frame) => frame.labels)),
    frames: frames.length,
  };
}

/** Each label's mean confidence over the frames, strongest first; a frame without it counts as 0. */
function meanLabels(frames: readonly (readonly MediaLabel[])[]): MediaLabel[] {
  if (frames.length === 0) return [];
  const totals = new Map<string, number>();
  for (const labels of frames) {
    for (const { label, confidence } of labels) totals.set(label, (totals.get(label) ?? 0) + confidence);
  }
  return [...totals]
    .map(([label, total]) => ({ label, confidence: Math.round((total / frames.length) * 1000) / 1000 }))
    .sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label));
}
