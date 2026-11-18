import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { idKey } from '../../src/library/records.js';
import { readItemImageRows } from '../../src/library/image-order.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createMetadataHttpFixture, metadataMovieId, existingTmdbId, posterFiles } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres'];

test('remote image HTTP browses and downloads artwork supplied by the configured TMDB plugin', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 90000,
}, async t => {
  const { database, upstream, request, reader, errors } = await createMetadataHttpFixture(t);
  const endpoint = `/Items/${idKey(metadataMovieId)}/RemoteImages`, observations = {};
  t.after(() => writeFile(path.join(validationOutputRoot(), 'remote-images-' + randomUUID() + '.json'),
    JSON.stringify({ observations, requests: upstream.requests }, null, 2)));
  const record = async (name, route, options) => {
    const result = await request(route, options);
    observations[name] = { status: result.status, body: result.body, contentType: result.contentType };
    return result;
  };
  assert.equal((await record('anonymous list', endpoint, { token: null })).status, 401);
  const providers = await record('providers', endpoint + '/Providers', { token: reader });
  assert.equal(providers.status, 200);
  assert.deepEqual(providers.body, [{ Name: 'TheMovieDb', SupportedImages: ['Primary', 'Backdrop', 'Logo', 'Thumb'] }]);
  const preferred = await record('preferred', endpoint + '?type=primary&startIndex=1&limit=2&providerName=themoviedb', { token: reader });
  assert.equal(preferred.status, 200);
  assert.deepEqual(preferred.body.Providers, ['TheMovieDb']);
  assert.equal(preferred.body.TotalRecordCount, 3);
  const filenames = images => images.map(image => new URL(image.Url).pathname.split('/').at(-1));
  assert.deepEqual(filenames(preferred.body.Images), posterFiles.slice(1, 3));
  assert.deepEqual(preferred.body.Images.map(image => image.Language), ['en', '']);
  assert.ok(preferred.body.Images.every(image => image.Type === 'Primary' && image.RatingType === 'Score'));
  const all = await record('all languages', endpoint + '?type=Primary&startIndex=-4&includeAllLanguages=true');
  assert.equal(all.status, 200);
  assert.equal(all.body.TotalRecordCount, 4);
  assert.deepEqual(filenames(all.body.Images), posterFiles);
  const none = await record('negative limit', endpoint + '?limit=-1');
  assert.equal(none.body.TotalRecordCount, 3);
  assert.deepEqual(none.body.Images, []);
  const unknown = await record('unknown provider', endpoint + '?providerName=unconfigured');
  assert.deepEqual(unknown.body, { TotalRecordCount: 0, Providers: ['TheMovieDb'], Images: [] });
  const unsupported = await record('unsupported type', endpoint + '?type=Box');
  assert.deepEqual(unsupported.body, { TotalRecordCount: 0, Providers: [], Images: [] });
  const imageUrl = all.body.Images[0].Url;
  const download = endpoint + '/Download?type=Primary&imageUrl=' + encodeURIComponent(imageUrl) + '&providerName=TheMovieDb';
  assert.equal((await record('ordinary download', download, { method: 'POST', token: reader })).status, 403);
  assert.equal((await record('download selected poster', download, { method: 'POST' })).status, 204);
  const read = await record('read saved poster', `/Items/${idKey(metadataMovieId)}/Images/Primary?format=Png`, { accept: 'image/png' });
  assert.equal(read.status, 200);
  assert.deepEqual(read.bytes, upstream.poster);
  const rows = await readItemImageRows(database, metadataMovieId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ImageType, 0);
  assert.deepEqual(await readFile(rows[0].Path), upstream.poster);
  assert.ok(upstream.requests.some(entry => entry.path === '/3/movie/' + existingTmdbId));
  assert.equal(upstream.requests.filter(entry => entry.path.startsWith('/images/')).length, 1);
  assert.deepEqual(errors, []);
});
