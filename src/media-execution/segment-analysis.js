import { captureMediaProcess } from './process.js';
import { withCleanup } from '../core/operation-failure.js';

// FFmpeg only receives an expiring local bridge URL for the VFS object.
async function readWindow(probe, path, start, duration, args, maxOutputBytes, signal) {
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 600)
    throw new RangeError('Invalid segment analysis window');
  const source = await probe.vfs.stat(path, { signal });
  const timeoutMs = 180000;
  const lease = await probe.bridge.lease(path, {
    signal,
    version: source.version,
    expiresInMs: timeoutMs + 5000,
  });
  return withCleanup(
    async () => {
      const { stdout, exitCode } = await captureMediaProcess(
        probe.mediaEncoder.encoderPath,
        [
          '-nostdin',
          '-v',
          'error',
          '-protocol_whitelist',
          'http,tcp',
          '-ss',
          String(start),
          '-i',
          lease.url,
          '-t',
          String(duration),
          ...args,
          'pipe:1',
        ],
        { signal, environment: probe.mediaEncoder.environment, timeoutMs, maxOutputBytes },
      );
      if (exitCode !== 0)
        throw new Error('FFmpeg could not decode the selected analysis stream (exit ' + exitCode + ')');
      return stdout;
    },
    [() => lease.release()],
    'Segment analysis and media lease cleanup failed.',
  );
}

export async function readFingerprint(probe, path, start, duration, signal) {
  const args = [
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-ac',
    '1',
    '-ar',
    '11025',
    '-f',
    'chromaprint',
    '-algorithm',
    '1',
    '-fp_format',
    'raw',
  ];
  const stdout = await readWindow(probe, path, start, duration, args, 256 * 1024, signal);
  if (stdout.length % 4) throw new Error('Unexpected Chromaprint output length');
  return Array.from({ length: stdout.length / 4 }, (_, i) => stdout.readUInt32LE(i * 4));
}

export async function readCreditFrames(probe, path, start, duration, signal) {
  const width = 128,
    height = 72,
    fps = 2;
  if (duration > 420) throw new RangeError('Credit samples exceed the analysis window');
  const count = Math.ceil(duration * fps);
  const args = [
    '-map',
    '0:V:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    'fps=2,scale=128:72:flags=area,format=gray',
    '-frames:v',
    String(count),
    '-threads:v',
    '1',
    '-pix_fmt',
    'gray',
    '-f',
    'rawvideo',
  ];
  const pixels = await readWindow(probe, path, start, duration, args, count * width * height, signal);
  if (pixels.length % (width * height)) throw new Error('Incomplete video frame in credit analysis');
  return { pixels, width, height, fps };
}
