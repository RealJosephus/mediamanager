import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import createCodec from './jpeg-codec.mjs';

parentPort.once('message', async ({ bytes, numerator }) => {
  let codec, source, image;
  try {
    codec = await createCodec({ wasmBinary: await readFile(new URL('./jpeg-codec.wasm', import.meta.url)) });
    source = codec._malloc(bytes.length);
    if (!source) throw new Error('JPEG input allocation failed.');
    codec.HEAPU8.set(bytes, source);
    image = codec._mm_jpeg_decode(source, bytes.length, numerator);
    if (!image || !codec._mm_jpeg_succeeded(image))
      throw new Error(image ? codec.UTF8ToString(codec._mm_jpeg_error(image)) : 'JPEG decoder allocation failed.');
    const width = codec._mm_jpeg_width(image), height = codec._mm_jpeg_height(image), start = codec._mm_jpeg_pixels(image);
    const pixels = new Uint8Array(codec.HEAPU8.subarray(start, start + width * height * 4));
    parentPort.postMessage({ pixels, width, height }, [pixels.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: { message: error.message } });
  } finally {
    if (image) codec._mm_jpeg_free(image);
    if (source) codec._free(source);
    parentPort.close();
  }
});
