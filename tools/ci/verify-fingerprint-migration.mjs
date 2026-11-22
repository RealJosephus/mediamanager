import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readCreditFrames, readFingerprint } from '../../src/media-execution/segment-analysis.js';
import { recurringInterval } from '../../plugins/skip-segments/detection.js';
import { rollingCredits } from '../../plugins/skip-segments/rolling-credits.js';
import { music } from './migration-audio-fixture.mjs';

// Two independent episodes contain the same theme at different offsets and volumes.
// A third has different music. Exercise the actual packaged FFmpeg and its muxer.
const length = 66;
const token = 'f'.repeat(64);
async function sampleStream(media, contentType, seconds, read) {
  const service = createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = m ? Number(m[1]) : 0,
      end = m?.[2] ? Math.min(Number(m[2]), media.length - 1) : media.length - 1;
    if (start > end) {
      res.writeHead(416);
      res.end();
      return;
    }
    res.writeHead(m ? 206 : 200, {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(m ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + media.length } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : media.subarray(start, end + 1));
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  try {
    const url = 'http://127.0.0.1:' + service.address().port + '/' + token;
    return await read(
      {
        mediaEncoder: { encoderPath: process.env.MEDIAMANAGER_FFMPEG },
        vfs: { stat: async () => ({ version: '1' }) },
        bridge: { lease: async () => ({ url, release: async () => {} }) },
      },
      'sample',
      0,
      seconds,
      AbortSignal.timeout(60000),
    );
  } finally {
    service.closeAllConnections();
    await new Promise((resolve) => service.close(resolve));
  }
}
const clips = [];
for (const audio of [music(13, 10), music(41, 21, 0.85), music(83, 1000)])
  clips.push({ start: 0, hashes: await sampleStream(audio, 'audio/wav', length, readFingerprint) });
const found = recurringInterval(clips[0], [clips[1]], 5);
assert.ok(found, 'common theme was not detected in real audio');
assert.ok(
  Math.abs(Number(found.StartTicks) / 1e7 - 10) < 3.5 && Math.abs(Number(found.EndTicks) / 1e7 - 38) < 4,
  'detected interval in seconds: ' + Number(found.StartTicks) / 1e7 + '..' + Number(found.EndTicks) / 1e7,
);
assert.equal(recurringInterval(clips[0], [clips[2]], 5), null, 'unrelated audio produced an intro');
console.log('A shifted intro was identified from real audio. The unrelated episode produced no interval.');

// Y4M video of small names rolling between an opening scene and a stinger.
// The controls contain the same cards held still, scrolling down, or all black.
const glyphs = {
  A: [2, 5, 7, 5, 5],
  C: [7, 4, 4, 4, 7],
  D: [6, 5, 5, 5, 6],
  E: [7, 4, 6, 4, 7],
  I: [7, 2, 2, 2, 7],
  L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5],
  N: [5, 7, 7, 7, 5],
  O: [7, 5, 5, 5, 7],
  R: [6, 5, 6, 5, 5],
  S: [7, 4, 7, 1, 7],
  T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7],
  V: [5, 5, 5, 5, 2],
  X: [5, 5, 2, 5, 5],
};
const lines = [
  'CAST',
  'LENA ROSS',
  'SOUND MIX',
  'MIRA VALE',
  'MUSIC',
  'ALEX ROSS',
  'EDITOR',
  'NOEL RIOS',
  'VISUALS',
  'LUNA DALE',
];
function creditsVideo(kind, seconds) {
  const parts = [Buffer.from('YUV4MPEG2 W128 H72 F2:1 Ip A1:1 Cmono\n')];
  for (let i = 0; i < seconds * 2; i++) {
    const pixels = Buffer.alloc(128 * 72, 16),
      t = i / 2;
    if (t >= 8 && t < 44) {
      const offset = kind === 'roll' ? i * 2 : kind === 'down' ? -i * 2 : 0;
      for (let y = 0; y < 72 && kind !== 'black'; y++) {
        const at = (y + offset + 900) % 90,
          row = at % 9;
        if (row >= 5) continue;
        const line = lines[Math.floor(at / 9)];
        let x = (128 - line.length * 4) / 2;
        for (const char of line) {
          const dots = glyphs[char]?.[row] ?? 0;
          for (let col = 0; col < 3; col++) if (dots & (4 >> col)) pixels[y * 128 + x + col] = 235;
          x += 4;
        }
      }
    } else if (kind !== 'black') pixels.fill(160);
    parts.push(Buffer.from('FRAME\n'), pixels);
  }
  return Buffer.concat(parts);
}
for (const [kind, seconds] of [
  ['roll', 54],
  ['roll', 40],
  ['still', 54],
  ['down', 54],
  ['black', 54],
]) {
  const frames = await sampleStream(
    creditsVideo(kind, seconds),
    'video/x-yuv4mpeg',
    seconds,
    readCreditFrames,
  );
  const result = rollingCredits(frames, 0, BigInt(seconds) * 10000000n);
  if (kind !== 'roll') {
    assert.deepEqual(result, [], kind);
    continue;
  }
  assert.equal(result.length, 1);
  assert.equal(result[0].StartTicks, 80000000n);
  assert.equal(result[0].EndTicks, seconds === 40 ? 400000000n : 435000000n);
}
console.log(
  'Decoded rolling credits retained the stinger and exact EOF. Static cards, downward motion and black frames did not produce credits.',
);
