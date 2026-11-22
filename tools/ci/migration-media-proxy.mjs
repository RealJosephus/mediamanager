import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { startOwnedMediaProxy } from '../../tests/helpers/library-exchange-media-proxy.js';

const files = [];
for (const filename of process.argv.slice(2)) {
  const bytes = await readFile(filename);
  const contentType = filename.endsWith('.mka') ? 'audio/x-matroska' : 'video/x-matroska';
  files.push({ filename, contentType, expected: {
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  } });
}
const proxy = await startOwnedMediaProxy(files);
try {
  console.log('ready');
  process.stdin.resume();
  await once(process.stdin, 'end');
} finally {
  await proxy.close();
  console.log(JSON.stringify(proxy.report));
}
