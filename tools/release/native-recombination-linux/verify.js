import assert from 'node:assert/strict';
import path from 'node:path';

export const imageCases = [
  { name: 'rgb', format: 'png', channels: 3, rgba: [17, 31, 47, 255] },
  { name: 'rgba-saturated', format: 'png', channels: 4, rgba: [252, 61, 79, 255] },
  { name: 'jpeg', format: 'jpeg', channels: 3, rgba: [17, 31, 47, 255] },
  { name: 'webp', format: 'webp', channels: 3, rgba: [17, 31, 47, 255] },
];

const differentDirectory = (left, right) => {
  const value = path.relative(left, right);
  return value && (value === '..' || value.startsWith('..' + path.sep) || path.isAbsolute(value));
};
export function uniformPixels(values, pixel, count, description) {
  assert.deepEqual(values, Array.from({ length: count }, () => pixel).flat(), description);
}

export function verifyConsumerPair(stock, modified, { original, replacement, libraryPath, redBias }) {
  assert.equal(stock.mode, 'stock'); assert.equal(modified.mode, 'modified');
  assert.ok(Number.isInteger(stock.pid) && Number.isInteger(modified.pid) && stock.pid !== modified.pid, 'Consumers must be fresh independent Node processes.');
  assert.ok(differentDirectory(stock.dataRoot, modified.dataRoot) && differentDirectory(modified.dataRoot, stock.dataRoot), 'Consumer assets and caches must not overlap.');
  assert.notEqual(original.sha256, replacement.sha256, 'The modified aggregate must differ from the vendor library.');
  assert.deepEqual(stock.loadedLibrary, { path: libraryPath, ...original });
  assert.deepEqual(modified.loadedLibrary, { path: libraryPath, ...replacement });
  assert.deepEqual(stock.inputs, modified.inputs, 'Both consumers must read exactly the same source image bytes.');
  assert.deepEqual(stock.candidate, modified.candidate);
  assert.deepEqual(stock.bindings, modified.bindings, 'The experiment replaces the aggregate while retaining the actual Sharp binding.');
  assert.deepEqual(stock.sourceFiles, modified.sourceFiles, 'The private library replacement cannot change application consumers.');
  for (const [receipt, delta] of [[stock, 0], [modified, redBias]]) {
    assert.equal(receipt.closed, true, 'The actual application and local storage owners must close.');
    assert.deepEqual(receipt.cases.map(value => value.name), imageCases.map(value => value.name));
    for (const [index, value] of receipt.cases.entries()) {
      const fixture = imageCases[index];
      assert.deepEqual(value.size, { Width: 5, Height: 4 });
      assert.deepEqual(value.sharp.info, { width: 5, height: 4, channels: 4 });
      assert.equal(value.application.original, false);
      assert.equal(value.application.mimeType, 'image/png');
      assert.deepEqual(value.application.size, { width: 3, height: 2 });
      assert.equal(value.sharp.pixels.length, 80);
      assert.equal(value.application.pixels.length, 24);
      assert.equal(value.application.cacheReadEqual, true);
      assert.ok(value.application.path.startsWith(receipt.dataRoot + path.sep), 'Application cache escaped its own local storage root.');
      if (fixture.format !== 'jpeg') {
        const pixel = [...fixture.rgba];
        if (fixture.format === 'png') pixel[0] = Math.min(255, pixel[0] + delta);
        uniformPixels(value.sharp.pixels, pixel, 20, 'Sharp must consume the actual PNG/WebP pixels.');
        uniformPixels(value.application.pixels, pixel, 6, 'The independently decoded application output must contain the actual pixels.');
      } else {
        // JPEG decoder versions can round lossy values differently. Require a
        // real complete opaque image with the selected uniform colour nearby.
        for (const pixels of [value.sharp.pixels, value.application.pixels]) {
          assert.equal(pixels.length % 4, 0); assert.ok(pixels.length > 0);
          for (let offset = 0; offset < pixels.length; offset += 4) {
            assert.equal(pixels[offset + 3], 255);
            for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(pixels[offset + channel] - fixture.rgba[channel]) <= 3, 'Lossy JPEG colour exceeds the chosen fixture encoding bound.');
          }
        }
      }
    }
  }
}
