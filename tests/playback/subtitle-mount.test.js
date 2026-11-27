import assert from 'node:assert/strict';
import { mkdir, readFile, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { idKey } from '../../src/library/records.js';
import { createMetadataHttpFixture, metadataMovieId } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres'];

test('external SAMI subtitle text follows the selected Local volume', async t => {
  const { database, filename, programDataPath, request, runtime } = await createMetadataHttpFixture(t);
  const oldRoot = path.dirname(filename), newRoot = path.join(programDataPath, 'second-volume');
  await mkdir(newRoot);
  const file = 'movie.en.sami', stamp = new Date('2025-01-02T03:04:05Z');
  for (const [root, line] of [[oldRoot, 'First cut'], [newRoot, 'Other cut']]) {
    const sami = '<SAMI><HEAD><TITLE>Captions</TITLE></HEAD><BODY>\n'
      + '<SYNC Start=1000><P Class=ENCC>' + line + '\n<SYNC Start=3000><P Class=ENCC>&nbsp;\n</BODY></SAMI>';
    await writeFile(path.join(root, file), sami);
    await utimes(path.join(root, file), stamp, stamp);
  }
  const row = probeStreamRow(metadataMovieId, { Type: 'Subtitle', Index: 0, Codec: 'sami', Language: 'eng',
    IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true, Path: path.join(oldRoot, file) });
  await database.insert('MediaStreamInfos', row);
  const id = idKey(metadataMovieId), route = '/Videos/' + id + '/' + id + '/Subtitles/0/Stream.srt';
  async function subtitle() {
    const reply = await request(route + '?startPositionTicks=0&endPositionTicks=0&copyTimestamps=true');
    assert.equal(reply.status, 200, reply.bytes.toString());
    return reply.bytes.toString();
  }
  const before = await subtitle();
  assert.match(before, /First cut/);
  const storage = await request('/Storage/Configuration');
  assert.equal(storage.status, 200);
  storage.body.instances.find(value => value.id === 'fixture-media').config.root = newRoot;
  const changed = await request('/Storage/Configuration', { method: 'POST', body: storage.body });
  assert.ok(changed.status >= 200 && changed.status < 300, changed.bytes.toString());
  const active = await runtime.storage.mediaFileSystem.readFile(path.join(oldRoot, file));
  assert.deepEqual(active, await readFile(path.join(newRoot, file)));
  assert.match(active.toString(), /Other cut/);
  const afterRemount = await subtitle();
  assert.match(afterRemount, /Other cut/);
  assert.doesNotMatch(afterRemount, /First cut/);
  storage.body.instances.find(value => value.id === 'fixture-media').config.root = oldRoot;
  const returned = await request('/Storage/Configuration', { method: 'POST', body: storage.body });
  assert.ok(returned.status >= 200 && returned.status < 300, returned.bytes.toString());
  assert.equal(await subtitle(), before);
  // Simulate a native v2 pair which has never been read on the new mount.
  const paths = runtime.extraction.subtitleCache.paths(id, 0);
  await unlink(paths.metadata + '.storage');
  storage.body.instances.find(value => value.id === 'fixture-media').config.root = newRoot;
  assert.equal((await request('/Storage/Configuration', { method: 'POST', body: storage.body })).status, changed.status);
  assert.match(await subtitle(), /Other cut/);
});
