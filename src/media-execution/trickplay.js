import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { operationFailure } from '../core/operation-failure.js';
import { encoderVersionAtLeast } from '../playback/media-encoder.js';
import { StorageError } from '../storage/errors.js';
import { captureMediaProcess } from './process.js';
import { trickplayVideoPlan } from './video.js';

export async function extractTrickplayFrames(mediaEncoder, url, source, video, width, options, { signal } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/u.test(url)) throw new TypeError('Trickplay requires a private VFS input.');
  if (!mediaEncoder.ready) throw new StorageError('unavailable', 'The trickplay encoder is unavailable.');
  const root = path.resolve(tmpdir());
  const plan = trickplayVideoPlan(video, source, width, options.Interval, options, mediaEncoder.getEncodingOptions(), mediaEncoder.capabilities, mediaEncoder.version);
  const fresh = async keyframes => {
    const directory = await mkdtemp(path.join(root, 'mediamanager-trickplay-'));
    const release = () => {
      if (path.dirname(directory) !== root || !path.basename(directory).startsWith('mediamanager-trickplay-')) throw new Error('Invalid trickplay extraction directory.');
      return rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    };
    try {
      const args = ['-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'http,tcp'];
      if (keyframes) args.push('-skip_frame', 'nokey');
      const threads = String(options.ProcessThreads ?? mediaEncoder.probeThreads);
      if (!plan.accelerated) args.push('-threads', threads);
      args.push(...plan.inputArgs, '-i', url);
      if (plan.decoder.args.length) args.push('-noautoscale');
      args.push('-map', `0:${video.Index}`, '-an', '-sn', '-vf', plan.filters.join(','), '-threads', threads, '-c:v', plan.encoder);
      const quality = Math.min(31, Math.max(1, options.Qscale ?? 4));
      if (/_(?:vaapi|qsv)$/u.test(plan.encoder)) args.push('-global_quality:v', String(100 - (quality - 1) * 3));
      else if (plan.encoder.endsWith('_rkmpp')) args.push('-qp_init:v', String(99 - (quality - 1) * 3));
      else if (plan.encoder.endsWith('_videotoolbox')) args.push('-qscale:v', String(118 - (quality - 1) * 3), '-allow_sw', '1');
      else args.push('-qscale:v', String(quality));
      if (encoderVersionAtLeast(mediaEncoder.version, 5, 1)) args.push('-fps_mode', 'passthrough');
      else args.push('-vsync', '0');
      args.push('-f', 'image2', path.join(directory, '%08d.jpg'));
      const environment = plan.environment ? { ...(mediaEncoder.environment ?? process.env), ...plan.environment } : mediaEncoder.environment;
      const { exitCode } = await captureMediaProcess(mediaEncoder.encoderPath, args, { signal, environment,
        timeoutMs: 21600000, maxOutputBytes: 1024 * 1024 });
      const frames = (await readdir(directory)).filter(name => /^\d{8}\.jpg$/u.test(name)).sort().map(name => path.join(directory, name));
      if (exitCode !== 0 || !frames.length) throw new StorageError('invalid-response', 'FFmpeg could not extract trickplay frames.');
      return { frameCount: frames.length, readFrame: index => readFile(frames[index], { signal }), release };
    } catch (error) {
      try { await release(); }
      catch (failure) { throw operationFailure([error, failure], 'Trickplay extraction failed.'); }
      throw error;
    }
  };
  if (plan.keyframes) {
    try { return await fresh(true); }
    catch (error) { if (signal?.aborted || error.code !== 'invalid-response') throw error; }
  }
  return fresh(false);
}
