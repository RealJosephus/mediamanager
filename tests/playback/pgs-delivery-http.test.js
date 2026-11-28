import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { idKey } from '../../src/library/records.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import { createMetadataHttpFixture, metadataMovieId } from '../helpers/metadata-http-fixture.js';
import reference from './fixtures/graphical-subtitle-reference.json' with { type: 'json' };

export const requiredValidationServices = ['postgres'];

test('formatted PGS routes stream the selected SUP byte range and retain embedded PGS delivery', async t => {
  const { runtime, database, request, filename } = await createMetadataHttpFixture(t);
  const media = path.join(path.dirname(filename), 'captions.mkv'), sidecar = path.join(path.dirname(filename), 'captions.sup');
  const sample = reference.sources.find(entry => entry.name === 'pgs.mks');
  await writeFile(media, Buffer.from(sample.media, 'base64'));
  execFileSync(validationExecutable('ffmpeg'), ['-nostdin', '-v', 'error', '-i', media, '-map', '0:s:0', '-c', 'copy', '-f', 'sup', sidecar], { windowsHide: true });
  const expected = await readFile(sidecar);
  const native = reference.outputs.find(entry => entry.source === sample.name).native;
  assert.equal(expected.length, native.byteLength);
  assert.equal(createHash('sha256').update(expected).digest('hex'), native.sha256);
  await database.update('BaseItems', { Id: metadataMovieId }, { Path: media });
  for (const stream of [{ Index: 0, IsExternal: false }, { Index: 1, IsExternal: true, Path: sidecar }]) {
    await database.insert('MediaStreamInfos', probeStreamRow(metadataMovieId, {
      Type: 'Subtitle', Codec: 'PGSSUB', IsTextSubtitleStream: false, SupportsExternalStream: true, ...stream,
    }));
  }

  const files = runtime.storage.mediaFileSystem, accessPath = files.accessPath(sidecar), vfs = files.vfs;
  const openResponse = vfs.openResponse.bind(vfs), readers = [];
  t.mock.method(vfs, 'openResponse', async (location, options) => {
    const handle = await openResponse(location, options);
    if (location !== accessPath) return handle;
    const reader = { length: Number(handle.contentLength), closed: false };
    readers.push(reader);
    return { ...handle, close: async () => { await handle.close(); reader.closed = true; } };
  });

  const id = idKey(metadataMovieId), route = `/Videos/${id}/${id}/Subtitles/`;
  for (const format of ['pgssub', 'sup']) {
    const external = route + '1/Stream.' + format;
    const full = await request(external);
    assert.equal(full.status, 200);
    assert.equal(full.contentType, 'application/octet-stream');
    assert.deepEqual(full.bytes, expected);
    const partial = await request(external, { headers: { Range: 'bytes=8-31' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.contentType, full.contentType);
    assert.equal(partial.headers.get('content-range'), `bytes 8-31/${expected.length}`);
    assert.equal(partial.headers.get('content-length'), '24');
    assert.deepEqual(partial.bytes, expected.subarray(8, 32));
    const embedded = await request(route + '0/Stream.' + format);
    assert.equal(embedded.status, 200);
    assert.equal(embedded.contentType, full.contentType);
    assert.deepEqual(embedded.bytes, expected);
    t.diagnostic(JSON.stringify({ format, full: full.bytes.length, range: partial.headers.get('content-range'),
      rangeSha256: createHash('sha256').update(partial.bytes).digest('hex'), embedded: embedded.bytes.length }));
  }
  await runtime.drainRequests();
  assert.deepEqual(readers, [expected.length, 24, expected.length, 24].map(length => ({ length, closed: true })));
});
