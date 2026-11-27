import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createMetadataHttpFixture } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres'];
const xml = name => '<tv><channel id="c1"><display-name>' + name + '</display-name></channel></tv>';
const save = (request, feed) => request('/LiveTv/ListingProviders', { method: 'POST', body: { Type: 'xmltv', Path: feed } });
const list = (request, id) => request('/LiveTv/ListingProviders/Lineups?id=' + encodeURIComponent(id));

test('a mapped XMLTV provider accepts both Windows share path spellings', async t => {
  const { filename, request } = await createMetadataHttpFixture(t);
  const root = path.dirname(filename), guideName = 'dual.xml', win = String.raw`\\nas\Listings`;
  await writeFile(path.join(root, guideName), xml('Mapped station'));
  const config = await request('/Storage/Configuration');
  config.body.mounts.push({ path: '/guide-share', instanceId: 'fixture-media', capabilities: {} });
  config.body.prefixes.push({ identityRoot: win, accessRoot: '/guide-share', style: 'windows', purpose: 'metadata',
    caseSensitive: false, returnAccess: 'Isolated listings share' });
  const changed = await request('/Storage/Configuration', { method: 'POST', body: config.body });
  assert.ok(changed.status >= 200 && changed.status < 300, changed.bytes.toString());
  for (const identity of [win + '\\' + guideName, '//nas/Listings/' + guideName]) {
    const response = await save(request, identity);
    assert.equal(response.status, 200, response.bytes.toString());
    assert.equal(response.body.Path, identity);
    const channels = await list(request, response.body.Id);
    assert.equal(channels.status, 200);
    assert.deepEqual(channels.body.map(entry => entry.Name), ['Mapped station']);
  }
});

test('the XMLTV clear-cache HTTP action invalidates the cached channel list', async t => {
  const { filename, request, programDataPath } = await createMetadataHttpFixture(t);
  const feed = path.join(path.dirname(filename), 'clear.xml');
  await writeFile(feed, xml('Original station'));
  const saved = await save(request, feed);
  assert.equal(saved.status, 200, saved.bytes.toString());
  const id = saved.body.Id, channels = async () => {
    const result = await list(request, id);
    assert.equal(result.status, 200, result.bytes.toString());
    return result.body.map(entry => entry.Name);
  };
  assert.deepEqual(await channels(), ['Original station']);
  await writeFile(feed, xml('Replacement station'));
  assert.deepEqual(await channels(), ['Original station']);
  const cache = path.join(programDataPath, 'cache', 'xmltv', id + '.xml');
  const unrelated = path.join(path.dirname(cache), 'unrelated.xml');
  await writeFile(unrelated, 'another owner');
  assert.equal(await readFile(cache, 'utf8'), xml('Original station'));
  const cleared = await request('/Plugins/xmltv/Cache', { method: 'DELETE' });
  assert.equal(cleared.status, 200, cleared.bytes.toString());
  assert.equal(await readFile(unrelated, 'utf8'), 'another owner');
  assert.deepEqual(await channels(), ['Replacement station']);
  assert.equal(await readFile(cache, 'utf8'), xml('Replacement station'));
  const enable = enabled => request('/Plugins/xmltv/Enabled', { method: 'POST', body: { enabled } });
  assert.equal((await enable(false)).status, 200);
  await writeFile(cache + '.tmp', 'interrupted download');
  await writeFile(feed, xml('Current station'));
  assert.equal((await request('/Plugins/xmltv/Cache', { method: 'DELETE' })).status, 200);
  for (const filename of [cache, cache + '.tmp']) await assert.rejects(readFile(filename), { code: 'ENOENT' });
  assert.equal(await readFile(unrelated, 'utf8'), 'another owner');
  assert.equal((await enable(true)).status, 200);
  assert.deepEqual(await channels(), ['Current station']);
});
