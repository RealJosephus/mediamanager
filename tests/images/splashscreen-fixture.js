import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { createCanvas, ImageData } from '@napi-rs/canvas';

export const fixture = new URL('./fixtures/splashscreen/', import.meta.url);
export const fixtureRoot = fileURLToPath(fixture);
export const [nativeBytes, inputBytes, proofBytes, manifestBytes] = await Promise.all(['native.json', 'input.json', 'provenance.json', 'files.json']
  .map(filename => readFile(new URL(filename, fixture))));
export const native = JSON.parse(nativeBytes), input = JSON.parse(inputBytes), proof = JSON.parse(proofBytes), manifest = JSON.parse(manifestBytes);
export const hash = value => createHash('sha256').update(value).digest('hex');
export function recordedFile(snapshot) {
  const entry = manifest.files.find(file => path.win32.resolve(file.original).toLowerCase() === path.win32.resolve(snapshot.path).toLowerCase());
  assert.ok(entry, snapshot.path); assert.equal(entry.sha256, snapshot.sha256);
  return new URL(entry.local, fixture);
}
export async function rgba(snapshot) {
  const bytes = await readFile(recordedFile(snapshot)); assert.equal(hash(bytes), snapshot.sha256);
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, snapshot.Width); assert.equal(decoded.info.height, snapshot.Height);
  const canvas = createCanvas(decoded.info.width, decoded.info.height);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(decoded.data), decoded.info.width, decoded.info.height), 0, 0);
  const pixels = canvas.data(); assert.equal(hash(pixels), snapshot.pixelHash); return pixels;
}
let coordinates;
let renderedCoordinates;
export function recordedCoordinates() {
  return coordinates ??= (async () => {
    const row = native.transforms.find(row => row.name === 'coordinates'), pixels = await rgba(row.output);
    const result = new Int32Array(pixels.length / 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      assert.equal(pixels[offset + 3], 255);
      const index = pixels[offset] | pixels[offset + 1] << 8 | pixels[offset + 2] << 16;
      result[offset / 4] = index === 0 ? -1 : index;
      assert.ok(result[offset / 4] < 5760 * 2160);
    }
    return result;
  })();
}

// Solve the two forward projection equations independently of the renderer's inverse.
const [a, b, c, d, e, f, g, h, i] = [0.324108899, -0.244337708, 42.0407715, 0.0377609022, 0.563934922, -198.104706,
  -9.08959337e-5, 6.85242048e-5, 0.988209724].map(Math.fround);
export function sourcePoint(x, y) {
  const tx = x + 0.5, ty = y + 0.5, aa = a - tx * g, bb = b - tx * h, dd = d - ty * g, ee = e - ty * h;
  const rx = tx * i - c, ry = ty * i - f, determinant = aa * ee - bb * dd;
  const sx = (rx * ee - bb * ry) / determinant, sy = (aa * ry - rx * dd) / determinant;
  const error = 16 * 2 ** -24 * Math.max(1, Math.abs(sx), Math.abs(sy));
  return { sx, sy, error };
}
export function admissibleCoordinate(index, x, y) {
  const { sx, sy, error } = sourcePoint(x, y);
  if (index === -1) return sx <= error || sx >= 5760 - error || sy <= error || sy >= 2160 - error;
  const ix = index % 5760, iy = Math.floor(index / 5760);
  return sx >= ix - error && sx <= ix + 1 + error && sy >= iy - error && sy <= iy + 1 + error;
}
export async function candidateCoordinates(transform) {
  return renderedCoordinates ??= decodeCandidateCoordinates(transform);
}
async function decodeCandidateCoordinates(transform) {
  const row = native.transforms.find(row => row.name === 'coordinates'), pixels = transform(await rgba(row.input));
  const actual = new Int32Array(pixels.length / 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const index = pixels[offset] | pixels[offset + 1] << 8 | pixels[offset + 2] << 16;
    actual[offset / 4] = index === 0 ? -1 : index;
  }
  return actual;
}
