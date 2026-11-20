import { withNativeFloats } from '../core/json.js';

const lower = value => value?.toLowerCase();

export function matchesTranscodeJob(job, deviceId, playSessionId) {
  return playSessionId?.trim() ? lower(job.options.PlaySessionId) === lower(playSessionId)
    : Boolean(deviceId?.trim()) && lower(job.options.DeviceId) === lower(deviceId);
}

export function transcodingInfo(plan, options, progress, hardwareAccelerationType, fallbackBitrate) {
  const video = plan.videoOutput;
  const audio = plan.audioOutput;
  const reasons = new Set(options.TranscodeReasons?.split(',').filter(Boolean) ?? []);
  if (audio?.copyRefusedByCodec && video) reasons.add('AudioCodecNotSupported');
  return withNativeFloats({
    AudioCodec: audio?.codec, VideoCodec: video?.codec, Container: plan.container,
    IsVideoDirect: video?.encoder === 'copy', IsAudioDirect: audio?.encoder === 'copy',
    Bitrate: progress?.Bitrate ?? fallbackBitrate ?? audio?.bitrate ?? 0,
    ...(progress?.Framerate != null ? { Framerate: progress.Framerate } : {}),
    ...(progress?.CompletionPercentage != null ? { CompletionPercentage: progress.CompletionPercentage } : {}),
    Width: video?.width, Height: video?.height, AudioChannels: audio?.channels,
    HardwareAccelerationType: hardwareAccelerationType ?? 'none', TranscodeReasons: [...reasons],
  }, ['Framerate']);
}

export class TranscodeJobs {
  #sequence = 0;
  #entries = new Map();

  register(job, { describe, stop, ping }) {
    this.#entries.set(job, { describe, stop, ping });
  }

  activate(job) { job.sequence = ++this.#sequence; }

  unregister(job) { this.#entries.delete(job); }

  hasJob(playSessionId) {
    if (!playSessionId?.trim()) return false;
    return [...this.#entries.keys()].some(job => this.#active(job) && matchesTranscodeJob(job, undefined, playSessionId));
  }

  getTranscodingInfo(deviceId) {
    if (!deviceId?.trim()) return;
    let newest;
    for (const job of this.#entries.keys()) {
      if (this.#active(job) && matchesTranscodeJob(job, deviceId) && (!newest || job.sequence > newest.sequence)) newest = job;
    }
    if (newest) return this.#entries.get(newest).describe();
  }

  #active(job) { return job.active && !job.controller?.signal.aborted; }

  ping(playSessionId, isPaused) {
    if (!playSessionId?.trim()) return;
    for (const [job, entry] of this.#entries) {
      if (matchesTranscodeJob(job, undefined, playSessionId)) entry.ping?.(isPaused);
    }
  }

  async stop(deviceId, playSessionId) {
    const entries = [...this.#entries].filter(([job]) => matchesTranscodeJob(job, deviceId, playSessionId));
    const results = await Promise.allSettled(entries.map(async ([, entry]) => entry.stop()));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Transcoding jobs could not be stopped.');
  }
}
