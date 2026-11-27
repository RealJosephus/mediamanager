import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { MIN_DATE } from '../../src/library/records.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { createMetadataHttpFixture } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres'];

test('refresh publishes the embedded title and primary cover of a standard EPUB to a reader', async t => {
  const { runtime, request, database, filename, reader } = await createMetadataHttpFixture(t);
  const assets = new URL('../library/fixtures/book-photo-global-runtime/assets/', import.meta.url);
  const book = path.join(path.dirname(filename), 'Novel.epub');
  await copyFile(new URL('epub-standard-slashes.epub', assets), book);
  const id = 'bc200000-0000-0000-0000-000000000001';
  await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: id, Type: 'MediaBrowser.Controller.Entities.Book', Name: 'Novel', Path: book,
    CleanName: 'novel', SortName: 'novel', IsFolder: false, Data: '{}',
    ChannelId: '00000000-0000-0000-0000-000000000000', MediaType: 'Book', PresentationUniqueKey: id.replaceAll('-', ''),
    DateCreated: MIN_DATE, DateModified: MIN_DATE, DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE,
  }));
  const result = await runtime.metadata.refresh(id, {
    MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'FullRefresh', ReplaceAllMetadata: true, signal: t.signal,
  });
  assert.equal(result.Failures, 0);
  const [item] = await database.rows('BaseItems', { where: { Id: id } });
  assert.equal(item.Name, 'Embedded title');
  assert.equal((await database.rows('BaseItemImageInfos', { where: { ItemId: id } })).length, 1);
  const dto = await request('/Items/' + id, { token: reader });
  assert.equal(dto.status, 200);
  assert.equal(dto.body.Name, 'Embedded title');
  assert.ok(dto.body.ImageTags.Primary);
  const cover = await request('/Items/' + id + '/Images/Primary', { token: reader, accept: 'image/png' });
  assert.equal(cover.status, 200);
  assert.equal(cover.contentType, 'image/png');
  assert.equal(createHash('sha256').update(cover.bytes).digest('hex'), '95cfaeba3dde34423ea3e89d30ee8fb41d9331d5aef6c520b8cbd4521c91cd1d');
});
