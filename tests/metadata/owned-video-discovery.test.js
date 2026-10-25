import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLosslessJson } from '../../src/core/json.js';
import { dateText, EMPTY_ID, MIN_DATE, guid, idKey, mapRecord } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { setupChildrenFixture } from './children-fixture.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { resolveOrdinaryVideoFile } from '../../src/library/video-file-resolver.js';
import { OwnedItemMetadataLifecycleHost } from '../../src/metadata/owned-item-lifecycle.js';
import { prepareOwnedItemRefresh } from '../../src/metadata/owned-item-refresh.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { readCachedFolderChildren, setFolderChildren } from '../../src/library/folder-cache.js';

import { projectItem, setup, project } from './owned-video-fixture.js';

const root = new URL('./fixtures/owned-video-discovery/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async name => parseLosslessJson(await readFile(new URL(name, root), 'utf8'))));
const ownerId = '98c00000-0000-0000-0000-000000000001', parentId = '98c00000-0000-0000-0000-000000000002';
const typeName = type => `MediaBrowser.Controller.Entities.${type === 'Movie' ? 'Movies.' : ''}${type}`;
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const integer = value => typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
const videoData = () => ({ AdditionalParts: [], LocalAlternateVersions: [], LinkedAlternateVersions: [], SubtitleFiles: [], AudioFiles: [],
  HasSubtitles: false, IsPlaceHolder: false, VideoType: 'VideoFile', IsHD: false, IsShortcut: false,
  Width: 0, Height: 0, DateLastSaved: MIN_DATE, RemoteTrailers: [] });
const folderData = () => ({ IsRoot: false, IsHD: false, IsShortcut: false, Width: 0, Height: 0, DateLastSaved: MIN_DATE, RemoteTrailers: [] });
const outcome = ({ exception, ...result }) => ({ ...result, failed: exception != null });

test('owned video recording binds actual independent create/delete and controlled provider scope', async () => {
  for (const file of provenance.fixtureFiles) {
    const source = file.path === 'tests/Directory.Build.props' ? new URL('../../../Directory.Build.props', root)
      : new URL(file.path.split('/').at(-1), root);
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), file.sha256, file.path);
  }
  assert.equal(native.actualFrozenOwnedVideoDiscovery, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(sample => sample.name), input.map(sample => sample.name));
  assert.deepEqual(native.results.map(sample => sample.exception != null), input.map(sample => Object.hasOwn(sample, 'expectException')));
  for (const sample of input) {
    const ownerRefresh = native.results.find(result => result.name === sample.name).calls
      .findLast(call => call.action === 'refresh' && call.item.id === ownerId);
    assert.ok(ownerRefresh, sample.name + ': the actual Native owner reaches its controlled provider');
    assert.equal(ownerRefresh.cancellationRequested, sample.cancelled === true);
  }
  assert.equal(native.results.length, 15);
});

async function verifySample(t, sample, { delayedLookup = false } = {}) {
  const value = await setup(t, 'postgres', sample), { fixture, loaded, calls } = value;
  if (delayedLookup) {
    const creator = fixture.library.itemCreation, withItem = creator.withItem.bind(creator);
    let lookups = 0;
    creator.withItem = async (...args) => {
      if (++lookups === 2) await delay(10);
      return withItem(...args);
    };
    t.after(() => { creator.withItem = withItem; });
  }
  const signal = sample.cancelled ? AbortSignal.abort() : new AbortController().signal;
  const options = { ForceSave: false, MetadataRefreshMode: 'None', ImageRefreshMode: 'None', SearchResult: { Name: 'Owner search' }, signal };
  const recordRefresh = (item, options) => {
    calls.push({ action: 'refresh', item: projectItem(item, fixture.stateRoot), forceSave: options.ForceSave === true,
      hasSearchResult: options.SearchResult != null, cancellationRequested: options.signal.aborted });
    options.signal.throwIfAborted();
  };
  const lifecycle = new OwnedItemMetadataLifecycleHost({ store: fixture.store, updates: fixture.host.updates, registry: fixture.registry, loadContext: fixture.loadContext,
    async refreshOwnedItem(_, child, options, inheritance) {
      // The controlled native provider receives the same cached entity. Its
      // inherited fields survive a repeated dispatch without a provider save.
      const item = await loaded.videoVersionDiscovery.lookup(loaded, child);
      recordRefresh(item, prepareOwnedItemRefresh(loaded.item, item, options, inheritance));
    } });
  let requiresSave = false, exception = null;
  try { requiresSave = await lifecycle.beforeRefresh(loaded, options); }
  catch (error) {
    if (!signal.aborted && !sample.newFailure) assert.ok(error.code === 'metadata-conflict', error.stack);
  }
  // The native wrapper logs owned failure and still dispatches its owner.
  // The single-item provider in this oracle intentionally performs no save.
  try { recordRefresh(loaded.item, { ...options, ForceSave: requiresSave }); }
  catch (error) { exception = error; }
  assert.equal(signal.aborted, sample.cancelled === true);
  if (sample.cancelled) {
    assert.equal(signal.reason.name, 'AbortError');
    assert.equal(exception?.name, 'AbortError');
  }
  assert.deepEqual(outcome(await project(value, sample, exception)), outcome(native.results.find(result => result.name === sample.name)));
}

for (const sample of input) test(`postgres: native owned video ${sample.name}`, t => verifySample(t, sample));

test('postgres: delayed owned-video lookup preserves inherited fields across duplicate part dispatches', async t => {
  const sample = input.find(sample => sample.name === 'duplicate-part-paths');
  for (let attempt = 0; attempt < 8; attempt++) await t.test('dispatch ' + attempt,
    child => verifySample(child, sample, { delayedLookup: true }));
});
