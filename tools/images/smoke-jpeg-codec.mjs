import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('JPEG build checks run only in GitHub Actions.');
const runtime = path.resolve(process.argv[2]);
const { default: createCodec } = await import(pathToFileURL(path.join(runtime, 'jpeg-codec.mjs')).href);
const codec = await createCodec({ wasmBinary: await readFile(path.join(runtime, 'jpeg-codec.wasm')) });
const input = Buffer.from('This is not a JPEG image.');
const pointer = codec._malloc(input.length);
assert.ok(pointer);
let image;
try {
  codec.HEAPU8.set(input, pointer);
  image = codec._mm_jpeg_decode(pointer, input.length, 8);
  assert.ok(image);
  assert.equal(codec._mm_jpeg_succeeded(image), 0);
  assert.ok(codec.UTF8ToString(codec._mm_jpeg_error(image)).length > 0);
  assert.equal(codec._mm_jpeg_pixels(image), 0);
} finally {
  if (image) codec._mm_jpeg_free(image);
  codec._free(pointer);
}
const root = new URL('../../tests/images/fixtures/blurhash-resampling/inputs/', import.meta.url);
const decoded = [];
for (const name of ['large.jpg', 'wide.jpg']) {
  const bytes = await readFile(new URL(name, root)), source = codec._malloc(bytes.length);
  assert.ok(source);
  let result;
  try {
    codec.HEAPU8.set(bytes, source);
    result = codec._mm_jpeg_decode(source, bytes.length, 1);
    assert.ok(result);
    assert.equal(codec._mm_jpeg_succeeded(result), 1, codec.UTF8ToString(codec._mm_jpeg_error(result)));
    const width = codec._mm_jpeg_width(result), height = codec._mm_jpeg_height(result), pixels = codec._mm_jpeg_pixels(result);
    assert.ok(width > 0 && height > 0 && pixels);
    const data = Buffer.from(codec.HEAPU8.subarray(pixels, pixels + width * height * 4));
    decoded.push({ name, width, height, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  } finally {
    if (result) codec._mm_jpeg_free(result);
    codec._free(source);
  }
}
await writeFile(path.join(runtime, 'build-smoke.json'), JSON.stringify({ actualWasmExecution: true, nativeParityValidated: false,
  invalidInputRejected: true, decoded }, null, 2) + '\n', { flag: 'wx' });
