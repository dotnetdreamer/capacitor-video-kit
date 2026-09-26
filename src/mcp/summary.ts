/**
 * A manifest written out as something to read.
 *
 * Every tool here answers with the manifest itself as structured content, so this is not how an
 * agent gets the data - it is how an agent gets its bearings. A manifest with four clips, three
 * layers and a music track is around 200 lines of JSON in which nothing is more prominent than
 * anything else, and an agent that has to re-read all of it to answer "how long is this post now"
 * spends its context on punctuation.
 *
 * So the summary states the things an edit is usually about: how long the post runs, what is on
 * each row and when, what was done to the sound, and what the render will actually apply. The ids
 * are in it because an id is what the next op will name, and a summary that made an agent go back
 * to the JSON for one would have saved nothing.
 *
 * Milliseconds are printed beside the clock, never instead of it. Milliseconds are what the ops
 * take and the clock is how long the post feels, and an agent asked to "cut the first three
 * seconds" needs both in front of it.
 */
import {
  FILTER_PRESETS,
  aspectOf,
  clipsDurationMs,
  qualityOf,
  resolveFilterOps,
  totalDurationMs,
  type EditAdjust,
  type EditClip,
  type EditManifest,
  type EditOverlay,
  type EditZoom,
} from '../editor/edit-manifest';
import { clipDurationMs, overlayEndMs, timelineSlots } from '../editor/edit-ops';
import type { FilterOp } from '../video-composer/definitions';

export function summariseManifest(manifest: EditManifest): string {
  const totalMs = totalDurationMs(manifest);
  const lines: string[] = [];

  const { width, height, fps } = manifest.output;
  lines.push(
    `Post: ${time(totalMs)}, ${width}x${height} at ${fps}fps ` + `(${aspectOf(manifest.output)}, ${qualityOf(manifest.output).label}), manifest version ${manifest.version}`,
  );

  /* ---- the base track ---- */

  lines.push('');
  if (manifest.clips.length === 0) {
    lines.push('Base track: empty. A post with no base clip renders nothing.');
  } else {
    lines.push(`Base track: ${count(manifest.clips.length, 'clip')}`);
    // Slots rather than the clips themselves: a clip carries its own trim, and where it lands on
    // the output timeline is the sum of every clip before it at its own speed. That sum is what an
    // op naming a time on the timeline is measured against, so it is what belongs here.
    for (const [index, slot] of timelineSlots(manifest).entries()) {
      const into = slot.clip.transitionIn
        ? slot.transitionInMs > 0
          ? `, coming in with ${slot.clip.transitionIn.kind} over ${time(slot.transitionInMs)}`
          : `, ${slot.clip.transitionIn.kind} asked for but the clips either side are too short, so a cut`
        : '';
      lines.push(`  ${index}. ${describeClip(slot.clip)} at ${time(slot.startMs)}${into}`);
    }
  }

  if (manifest.durationMs > 0) {
    const baseMs = clipsDurationMs(manifest.clips);
    if (manifest.durationMs > baseMs) {
      lines.push(`  The post is held open to ${time(manifest.durationMs)}; past ${time(baseMs)} the picture is black.`);
    }
  }

  /* ---- layers of video over it ---- */

  if (manifest.videoTracks.length > 0) {
    lines.push('');
    lines.push(`Video tracks over the base: ${count(manifest.videoTracks.length, 'track')} (bottom to top by z)`);
    for (const track of [...manifest.videoTracks].sort((a, b) => a.z - b.z)) {
      const opacity = track.opacity < 1 ? `, ${percent(track.opacity)} opacity` : '';
      lines.push(`  "${track.id}" z=${track.z}, starts ${time(track.startMs)}${opacity}`);
      for (const clip of track.clips) lines.push(`      ${describeClip(clip)}`);
    }
  }

  /* ---- layers drawn over the picture ---- */

  lines.push('');
  if (manifest.overlays.length === 0) {
    lines.push('Layers: none');
  } else {
    lines.push(`Layers: ${count(manifest.overlays.length, 'layer')} (first is drawn first, last is on top)`);
    for (const [index, overlay] of manifest.overlays.entries()) {
      lines.push(`  ${index}. ${describeOverlay(overlay, totalMs)}`);
    }
  }

  /* ---- sound ---- */

  lines.push('');
  const sound: string[] = [];
  sound.push(manifest.originalMuted ? 'Original sound: muted' : 'Original sound: on');
  if (manifest.music) {
    const music = manifest.music;
    const section = music.outMs > 0 ? `${time(music.inMs)}..${time(music.outMs)}` : `from ${time(music.inMs)}`;
    const loop = music.loop ? ', looped' : '';
    const fade = music.fadeOutMs > 0 ? `, fades out over ${time(music.fadeOutMs)}` : '';
    sound.push(`Music: ${music.fileName || music.uri}, ${section}, at ${time(music.startMs)} on the post, ` + `${percent(music.volume)}${loop}${fade}`);
  } else {
    sound.push('Music: none');
  }
  if (manifest.voiceovers.length === 0) {
    sound.push('Voiceover: none');
  } else {
    sound.push(`Voiceover: ${count(manifest.voiceovers.length, 'take')}`);
    for (const take of manifest.voiceovers) {
      sound.push(`  "${take.id}" ${time(take.startMs)}..${time(take.startMs + take.durationMs)}, ${percent(take.volume)}`);
    }
  }
  lines.push(...sound);

  /* ---- zooms ---- */

  lines.push('');
  if (manifest.zooms.length === 0) {
    lines.push('Zooms: none');
  } else {
    lines.push(`Zooms: ${count(manifest.zooms.length, 'zoom')}`);
    for (const zoom of manifest.zooms) {
      lines.push(
        `  "${zoom.id}" ${time(zoom.startMs)}..${time(zoom.endMs)}, ${zoom.scale}x on (${zoom.cx}, ${zoom.cy}), ` +
          `${describeZoomRamps(zoom)}${CHAIN_NOTES[String(zoom.chain)] ?? ''}`,
      );
    }
  }

  /* ---- the look ---- */

  lines.push('');
  const filter = FILTER_PRESETS.find(preset => preset.id === manifest.filterId);
  const filterName = filter ? filter.label : `${manifest.filterId} (not a preset this build knows)`;
  lines.push(`Look: fit ${manifest.fit}, filter ${filterName} at ${percent(manifest.filterIntensity)}`);
  const adjusted = describeAdjust(manifest.adjust);
  lines.push(adjusted ? `  Adjust: ${adjusted}` : '  Adjust: untouched');
  // What the render will actually do, which is not the same list as the preset's: the intensity and
  // the Adjust are folded into it, and a preset at 0% resolves to nothing at all.
  const ops = resolveFilterOps(manifest);
  lines.push(ops.length === 0 ? '  Resolved colour ops: none, so the picture goes through untouched' : `  Resolved colour ops: ${ops.map(describeFilterOp).join(', ')}`);

  return lines.join('\n');
}

/* -------------------------------------------------------------------------------------------- */

/**
 * One resolved colour operation.
 *
 * `FilterOp` is a union and only five of its seven members carry an `amount`: a hue rotation is in
 * degrees and a tint is a colour with a weight. Switching over it rather than printing `op.amount`
 * is also what makes a new member a compile error here rather than an `undefined` in a report.
 */
function describeFilterOp(op: FilterOp): string {
  switch (op.op) {
    case 'hueRotate':
      return `hueRotate ${round(op.degrees)} degrees`;
    case 'tint':
      return `tint rgb(${op.rgb.map(round).join(' ')}) at ${percent(op.alpha)}`;
    default:
      return `${op.op} ${round(op.amount)}`;
  }
}

function describeClip(clip: EditClip): string {
  const parts = [`"${clip.id}" (${clip.clipKey}) ${time(clip.inMs)}..${time(clip.outMs)} = ${time(clipDurationMs(clip))}`];
  if (clip.speed !== 1) parts.push(`${round(clip.speed)}x`);
  if (clip.muted) parts.push('muted');
  else if (clip.volume !== 1) parts.push(`${percent(clip.volume)} volume`);
  if (clip.fit) parts.push(`fit ${clip.fit}`);
  if (clip.crop) parts.push(`cropped to ${rect(clip.crop)}`);
  if (clip.rect) {
    const turn = clip.rect.rotationDeg ? ` turned ${round(clip.rect.rotationDeg)} degrees` : '';
    parts.push(`placed at ${rect(clip.rect)}${turn}`);
  }
  return parts.join(', ');
}

function describeOverlay(overlay: EditOverlay, totalMs: number): string {
  const window = `${time(overlay.startMs)}..${time(overlayEndMs(overlay, totalMs))}`;
  const where = `at ${round(overlay.cx)},${round(overlay.cy)}`;
  const extras: string[] = [];
  if (overlay.scale !== 1) extras.push(`${round(overlay.scale)}x`);
  if (overlay.rotationDeg !== 0) extras.push(`turned ${round(overlay.rotationDeg)} degrees`);
  if (overlay.opacity !== 1) extras.push(`${percent(overlay.opacity)}`);
  const moves = describeAnimation(overlay);
  if (moves) extras.push(moves);
  const tail = extras.length > 0 ? `, ${extras.join(', ')}` : '';

  switch (overlay.kind) {
    case 'text':
      return (
        `text "${overlay.id}": ${JSON.stringify(overlay.text)} in ${overlay.styleId} ${overlay.color}, ` + `${overlay.align}, effect ${overlay.effect}, ${window} ${where}${tail}`
      );
    case 'sticker':
      return `sticker "${overlay.id}": ${overlay.emoji ? `emoji ${overlay.emoji}` : `asset ${overlay.assetId}`}, ` + `${window} ${where}${tail}`;
    case 'image':
      return `image "${overlay.id}": ${overlay.fileName || overlay.uri}, aspect ${round(overlay.aspect)}, ` + `${window} ${where}${tail}`;
    case 'effect':
      // An effect covers the frame, so its centre and angle are fixed and saying them would be
      // saying something that is true of every effect there has ever been.
      return `effect "${overlay.id}": ${overlay.effectId}, ${window}, strength ${percent(overlay.opacity)}${moves ? `, ${moves}` : ''}`;
  }
}

/** A layer's moves as asked for, `in pop 470ms, loop pulse every 1000ms, out fade 400ms`, or '' for none. */
function describeAnimation(overlay: EditOverlay): string {
  const animation = overlay.animation;
  if (!animation) return '';
  const parts: string[] = [];
  if (animation.in) parts.push(`in ${animation.in.id} ${animation.in.durationMs}ms`);
  if (animation.loop) parts.push(`loop ${animation.loop.id} every ${animation.loop.periodMs}ms`);
  if (animation.out) parts.push(`out ${animation.out.id} ${animation.out.durationMs}ms`);
  return parts.join(', ');
}

/** Only what was moved. A list of six zeroes is the same sentence as "untouched", spelled longer. */
function describeAdjust(adjust: EditAdjust): string {
  const moved = Object.entries(adjust)
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => `${key} ${value > 0 ? '+' : ''}${round(value)}`);
  return moved.join(', ');
}

function rect(value: { x: number; y: number; w: number; h: number }): string {
  return `${round(value.x)},${round(value.y)} ${round(value.w)}x${round(value.h)}`;
}

/**
 * `700ms (0:00.7) smooth ramps` for the zoom the editor makes, and both ramps named when a template
 * made them differ: `steady ramps, 3000ms (0:03.0) in and instant out` is a push-in held to the cut.
 */
/** What a zoom's [EditZoom.chain] keeps it from, by its stored value; absent pans both ways and says nothing. */
const CHAIN_NOTES: Readonly<Record<string, string>> = {
  false: ', never pans to a neighbour',
  in: ', pans from the zoom before and never on to the next',
  out: ', pans on to the next zoom and never from the one before',
};

function describeZoomRamps(zoom: EditZoom): string {
  const out = zoom.rampOutMs ?? zoom.rampMs;
  if (out === zoom.rampMs) return zoom.rampMs > 0 ? `${time(zoom.rampMs)} ${zoom.ease} ramps` : 'instant';
  const ramp = (ms: number): string => (ms > 0 ? time(ms) : 'instant');
  return `${zoom.ease} ramps, ${ramp(zoom.rampMs)} in and ${ramp(out)} out`;
}

/** `4500ms (0:04.5)`, and a plain `0ms` for the start, where a clock adds nothing. */
function time(ms: number): string {
  const rounded = Math.round(ms);
  if (rounded === 0) return '0ms';
  const totalSeconds = Math.floor(rounded / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const tenths = Math.floor((rounded % 1000) / 100);
  return `${rounded}ms (${minutes}:${String(seconds).padStart(2, '0')}.${tenths})`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Two decimals at most, and no trailing zeroes: `1.5`, not `1.50`, and `2`, not `2.00`. */
function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
