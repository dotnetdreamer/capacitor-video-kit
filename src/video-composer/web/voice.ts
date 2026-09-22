import { describe, putFile } from '../../web-runtime/files';
import type { VoiceRecordingResult } from '../definitions';

import { canRecordVoice } from './capabilities';

/**
 * Voiceover takes, through `getUserMedia` and `MediaRecorder`.
 *
 * The permission is not asked for separately, because on the web there is no separate asking:
 * `getUserMedia` IS the prompt, and a customer who says no rejects the call. That is the same
 * outcome the native plugins produce - `permission_denied` - reached the way a browser reaches it.
 *
 * The length is measured on the clock rather than read back off the file. A `MediaRecorder` blob
 * carries no duration in its header in most browsers (WebM written as a live stream reports an
 * unknown duration, and an `<audio>` element loading one answers `Infinity`), and the editor needs a
 * real number to lay the take out on the timeline. Wall time between start and stop is that number,
 * to within the few milliseconds the recorder spends flushing.
 */

/** Containers to ask for, best first. Opus in WebM is what every browser but Safari gives. */
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];

interface Session {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  startedAt: number;
  batchId: string;
  mimeType: string;
}

let session: Session | null = null;

export class VoiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VoiceError';
  }
}

/** Asks for the microphone and starts recording. Rejects `already_recording` / `permission_denied`. */
export async function startVoiceRecording(batchId?: string): Promise<void> {
  if (session) throw new VoiceError('already_recording', 'a take is already being recorded');
  if (!canRecordVoice()) {
    throw new VoiceError('recording_failed', 'this browser cannot record from the microphone');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // The three the platform will honour where it can. A voiceover recorded next to a playing
      // preview is exactly the case echo cancellation exists for.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new VoiceError('permission_denied', 'microphone permission denied');
    }
    throw new VoiceError('recording_failed', describe(error));
  }

  const mimeType = MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type)) ?? '';
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (error) {
    stopStream(stream);
    throw new VoiceError('recording_failed', describe(error));
  }

  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', event => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  // One second, so a take that ends badly still has most of itself rather than nothing: without a
  // timeslice the whole recording arrives in a single blob at `stop`, and a tab closed mid-take
  // takes it with it.
  recorder.start(1000);

  session = {
    recorder,
    stream,
    chunks,
    startedAt: Date.now(),
    batchId: batchId && batchId.length > 0 ? batchId : 'voice-cache',
    mimeType: recorder.mimeType || mimeType || 'audio/webm',
  };
}

/** Rejects `not_recording`, or `recording_failed` when the take captured nothing. */
export async function stopVoiceRecording(): Promise<VoiceRecordingResult> {
  const current = session;
  if (!current) throw new VoiceError('not_recording', 'nothing is being recorded');
  session = null;

  const durationMs = Math.max(0, Date.now() - current.startedAt);
  await new Promise<void>(resolve => {
    if (current.recorder.state === 'inactive') {
      resolve();
      return;
    }
    current.recorder.addEventListener('stop', () => resolve(), { once: true });
    try {
      current.recorder.stop();
    } catch {
      resolve();
    }
  });
  // The microphone light goes out here and not a moment later. A stream left running is a red dot
  // in the tab strip for the rest of the session.
  stopStream(current.stream);

  const blob = new Blob(current.chunks, { type: current.mimeType });
  if (blob.size === 0) throw new VoiceError('recording_failed', 'the take captured nothing');

  const name = `vo-${current.startedAt.toString(36)}.${extensionFor(current.mimeType)}`;
  const stored = await putFile(current.batchId, name, blob);
  // The durable name, not the `blob:` URL: this goes into a manifest, and `prepareJob` may move it
  // into a job folder before anything renders it.
  return { uri: stored.uri, durationMs };
}

/** Whether a take is being recorded right now, for a host that lost track of its own sheet. */
export function isRecording(): boolean {
  return session !== null;
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* Already stopped. */
    }
  }
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}
