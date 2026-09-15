import { WebPlugin } from '@capacitor/core';

import type {
  CapabilitiesResult,
  CleanupOptions,
  JobIdOptions,
  JobState,
  PrepareJobOptions,
  PrepareJobResult,
  ProbeOptions,
  ProbeResult,
  SystemInsetsResult,
  ThumbnailsOptions,
  ThumbnailsResult,
  VideoComposerPlugin,
  VoiceRecordingResult,
} from './definitions';

/**
 * Deliberately empty. The whole point of this plugin is that composition happens natively, so the
 * browser gets an honest "not here" rather than a second, subtly different renderer to keep in
 * sync. `capabilities()` is the one call that answers instead of throwing, so a host can ask
 * before it offers editing at all.
 */
export class VideoComposerWeb extends WebPlugin implements VideoComposerPlugin {
  async compose(): Promise<{ jobId: string }> {
    throw this.unavailable('Video composition is only available on a device.');
  }

  async cancel(_options: JobIdOptions): Promise<void> {
    throw this.unavailable('Video composition is only available on a device.');
  }

  async getState(_options: JobIdOptions): Promise<JobState> {
    throw this.unavailable('Video composition is only available on a device.');
  }

  async probe(_options: ProbeOptions): Promise<ProbeResult> {
    throw this.unavailable('Video composition is only available on a device.');
  }

  async thumbnails(_options: ThumbnailsOptions): Promise<ThumbnailsResult> {
    throw this.unavailable('Video composition is only available on a device.');
  }

  async startVoiceRecording(): Promise<void> {
    throw this.unavailable('Voice recording is only available on a device.');
  }

  async stopVoiceRecording(): Promise<VoiceRecordingResult> {
    throw this.unavailable('Voice recording is only available on a device.');
  }

  async capabilities(): Promise<CapabilitiesResult> {
    return { supported: false, reason: 'Not implemented on web.' };
  }

  /** A browser's own `env(safe-area-inset-*)` is already right. */
  async systemInsets(): Promise<SystemInsetsResult> {
    return { top: 0, bottom: 0 };
  }

  async prepareJob(_options: PrepareJobOptions): Promise<PrepareJobResult> {
    throw this.unavailable('Video composition is only available on a device.');
  }

  async cleanup(_options: CleanupOptions): Promise<void> {
    throw this.unavailable('Video composition is only available on a device.');
  }
}
