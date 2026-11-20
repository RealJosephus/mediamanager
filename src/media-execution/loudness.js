import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { operationFailure } from '../core/operation-failure.js';
import { captureMediaProcess } from './process.js';

const ffmpegInput = /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/u;
const integratedLoudness = /^\s+I:\s+(-?(?:\d+\.?\d*|\.\d+))\s+LUFS/mu;
export const loudnessTimeoutMs = 6 * 60 * 60 * 1000;

export async function measureLoudness(mediaEncoder, urls, { album = false, signal } = {}) {
  if (!urls.length || urls.some(url => !ffmpegInput.test(url))) throw new TypeError('Loudness analysis requires private VFS inputs.');
  const args = ['-nostdin', '-hide_banner', '-nostats', '-protocol_whitelist', album ? 'file,http,tcp' : 'http,tcp'];
  const root = path.resolve(tmpdir());
  let directory, result, failure;
  try {
    if (album) {
      directory = await mkdtemp(path.join(root, 'mediamanager-loudness-'));
      const manifest = path.join(directory, 'album.concat');
      await writeFile(manifest, urls.map(url => `file '${url}'`).join('\n') + '\n', { flag: 'wx', signal });
      args.push('-f', 'concat', '-safe', '0', '-i', manifest);
    } else args.push('-i', urls[0]);
    args.push('-af', 'ebur128=framelog=verbose', '-f', 'null', '-');
    const { stderr } = await captureMediaProcess(mediaEncoder.encoderPath, args, {
      environment: mediaEncoder.environment, signal, timeoutMs: loudnessTimeoutMs, maxOutputBytes: 1024 * 1024,
    });
    const measured = integratedLoudness.exec(stderr.toString('utf8'));
    result = measured ? Math.fround(Number(measured[1])) : null;
  } catch (error) { failure = error; }
  if (directory) {
    try {
      if (path.dirname(directory) !== root || !path.basename(directory).startsWith('mediamanager-loudness-')) throw new Error('Invalid loudness staging directory.');
      await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    } catch (error) { throw operationFailure(failure ? [failure, error] : [error], 'Album loudness analysis failed to clean up.'); }
  }
  if (failure) throw failure;
  return result;
}
