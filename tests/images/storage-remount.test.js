import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { idKey } from '../../src/library/records.js';
import { createMetadataHttpFixture, metadataMovieId } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres'];

test('original and resized images follow a Local remount at the same media identity', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const { database, request, filename, programDataPath } = await createMetadataHttpFixture(t);
  const first = path.dirname(filename), second = path.join(programDataPath, 'replacement-volume');
  await mkdir(second);
  const colors = [[255, 0, 0], [0, 0, 255]], originals = [];
  const stamp = new Date('2024-01-01T00:00:00Z'), name = 'poster.png';
  for (const [index, directory] of [first, second].entries()) {
    const [r, g, b] = colors[index];
    const bytes = await sharp({ create: { width: 16, height: 12, channels: 3, background: { r, g, b } } })
      .png({ compressionLevel: 0 }).toBuffer();
    originals.push(bytes);
    await writeFile(path.join(directory, name), bytes);
    await utimes(path.join(directory, name), stamp, stamp);
  }
  assert.equal(originals[0].length, originals[1].length);
  await database.insert('BaseItemImageInfos', { Id: randomUUID().toUpperCase(), ItemId: metadataMovieId,
    Path: path.join(first, name), ImageType: 0, Width: 16, Height: 12, Blurhash: null, DateModified: '2024-01-01 00:00:00' });
  const route = '/Items/' + idKey(metadataMovieId) + '/Images/Primary';
  const check = async index => {
    const original = await request(route, { accept: 'image/png' });
    assert.equal(original.status, 200);
    assert.deepEqual(original.bytes, originals[index]);
    const thumbnail = await request(route + '?width=8&format=Png', { accept: 'image/png' });
    assert.equal(thumbnail.status, 200);
    const { data, info } = await sharp(thumbnail.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [8, 6]);
    assert.deepEqual(data, Buffer.alloc(8 * 6 * 3, Buffer.from(colors[index])));
  };
  await check(0);
  const configuration = await request('/Storage/Configuration');
  assert.equal(configuration.status, 200);
  const local = configuration.body.instances.find(entry => entry.id === 'fixture-media');
  assert.equal(local.config.root, first);
  local.config.root = second;
  const changed = await request('/Storage/Configuration', { method: 'POST', body: configuration.body });
  assert.ok(changed.status >= 200 && changed.status < 300, JSON.stringify(changed.body));
  await check(1);
});
