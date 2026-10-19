import { testFileSystem } from '../storage/plugin-files.js';
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { decodeNativeText } from '../../src/core/native-text.js';
import { newNativeItemEntity, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { createLocalXmlPlugin, localXmlSavePath } from '../../src/metadata/local-xml.js';
import { fetchLocalXml } from '../../src/metadata/local-xml-parser.js';
import { mergeMetadata } from '../../src/metadata/merge.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { createStateRelations } from '../library/deletion-fixture.js';

const fixture = new URL('./fixtures/local-xml-provider/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', fixture)));
const native = JSON.parse(await readFile(new URL('native.json', fixture)));
const provenance = JSON.parse(await readFile(new URL('provenance.json', fixture)));
// One actual relation repository serves the complete neutral fixture, with
// every case relinquishing its entities before the next case starts.
let database, linkedChildren, stateRoot, spoolRoot;
const entities = new Set();
const track = value => { if (value) entities.add(value); return value; };
const item = type => track(newNativeItemEntity(type === 'Playlist' ? 'MediaBrowser.Controller.Playlists.Playlist' : 'MediaBrowser.Controller.Entities.Movies.BoxSet'));
before(async () => {
  stateRoot = await mkdtemp(path.join(os.tmpdir(), 'local-xml-provider-state-'));
  spoolRoot = path.join(stateRoot, 'metadata-spool');
  database = await createPostgresTestDatabase(null, 'xml_provider');
  linkedChildren = await createStateRelations(database, spoolRoot);
});
async function releaseEntities() {
  const errors = [];
  for (const value of entities) { try { releaseNativeItemLinks(value); } catch (error) { errors.push(error); } }
  entities.clear();
  try { await linkedChildren?.flushReleases(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'XML fixture entity cleanup failed.');
}
afterEach(releaseEntities);
after(async () => {
  const errors = [];
  for (const close of [releaseEntities, async () => {
    if (!linkedChildren) return;
    const counts = await linkedChildren.withSession(async session => (await session.client.query(
      'SELECT (SELECT count(*) FROM ' + linkedChildren.sets + ') AS sets,'
      + '(SELECT count(*) FROM ' + linkedChildren.rows + ') AS rows,'
      + '(SELECT count(*) FROM ' + linkedChildren.pins + ') AS pins,'
      + '(SELECT count(*) FROM "' + linkedChildren.schemaName + '".item_states) AS states,'
      + '(SELECT count(*) FROM "' + linkedChildren.schemaName + '".item_cohorts) AS cohorts')).rows[0]);
    for (const [name, value] of Object.entries(counts)) assert.equal(BigInt(value), 0n, name);
    assert.deepEqual(await readdir(spoolRoot), []);
  }, () => linkedChildren?.close(), () => dropPostgresTestDatabase(database), async () => {
    if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
  }]) { try { await close(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, 'XML fixture repository cleanup failed.');
});
async function linksFor(value) {
  const result = [];
  for await (const page of linkedChildren.pages(value.LinkedChildren)) {
    assert.ok(page.length <= 128);
    for (const entry of page) result.push({ Type: ['Manual', 'Shortcut', 'LocalAlternateVersion', 'LinkedAlternateVersion'][entry.Type] ?? entry.Type,
      ItemId: entry.ItemId ?? null, Path: entry.Path ?? null, LibraryItemId: entry.LibraryItemId ?? null });
  }
  return result;
}
async function assignLinks(value, entries) {
  await linkedChildren.withSession(async session => {
    const writer = await linkedChildren.createWriter({ session, parentId: value.Id });
    try { for (const entry of entries) await writer.append(entry); value.LinkedChildren = await writer.finish(); }
    finally { await writer.abort(); }
  });
  await linkedChildren.flushReleases();
}
const normalizedDate = value => value == null ? null : String(value).replace(' ', 'T').replace(/\.(\d+)(Z?)$/u,
  (_all, fraction, zone) => `.${fraction.padEnd(7, '0')}${zone}`).replace(/(\d\d:\d\d:\d\d)(Z?)$/u, '$1.0000000$2');
// Native fresh DateCreated is MinValue/Unspecified; the typed JS entity uses
// the already-verified UTC MinValue representation. No parsed dates are masked.
const createdDate = value => normalizedDate(value)?.replace(/^0001-01-01T00:00:00\.0000000Z$/u, '0001-01-01T00:00:00.0000000');
const number = value => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value ?? null;
async function projectLocalXmlResult(result) {
  const value = result.Item, playlist = value.Type === 'Playlist';
  return {
    type: value.Type, Name: value.Name ?? null, OriginalTitle: value.OriginalTitle ?? null,
    ForcedSortName: value.ForcedSortName ?? null, Overview: value.Overview ?? null,
    PreferredMetadataLanguage: value.PreferredMetadataLanguage ?? null, PreferredMetadataCountryCode: value.PreferredMetadataCountryCode ?? null,
    OfficialRating: value.OfficialRating ?? null, CustomRating: value.CustomRating ?? null,
    dateCreated: createdDate(value.DateCreated), premiereDate: normalizedDate(value.PremiereDate), endDate: normalizedDate(value.EndDate),
    ProductionYear: value.ProductionYear, CriticRating: number(value.CriticRating), CommunityRating: number(value.CommunityRating),
    IsLocked: value.IsLocked, LockedFields: value.LockedFields, runtime: value.RunTimeTicks?.toString() ?? null,
    Tagline: value.Tagline, displayOrder: value.DisplayOrder ?? null, Genres: value.Genres, Tags: value.Tags,
    Studios: value.Studios, ProductionLocations: value.ProductionLocations, ProviderIds: value.ProviderIds,
    trailers: value.RemoteTrailers.map(entry => entry.Url), people: result.People?.map(entry => ({
      Name: entry.Name, Role: entry.Role ?? null, Type: entry.Type, SortOrder: entry.SortOrder ?? null,
      ImageUrl: entry.ImageUrl ?? null, ProviderIds: entry.ProviderIds ?? {}
    })) ?? null,
    links: await linksFor(value),
    ownerUserId: playlist ? value.OwnerUserId : null, openAccess: playlist ? value.OpenAccess : null,
    shares: playlist ? value.Shares : null, playlistMediaType: playlist ? String(value.PlaylistMediaType) : null
  };
}
async function seeded(type, seed) {
  const value = item(type);
  if (seed) {
    Object.assign(value, { Name: 'Old Name', Tags: ['Old Tag'], Genres: ['Old Genre'], Studios: ['Old Studio'], LockedFields: ['Overview'] });
    await assignLinks(value, [{ Type: 'Manual', ItemId: '10000000-0000-0000-0000-000000000001' }]);
    if (type === 'Playlist') value.Shares = [{ UserId: '20000000-0000-0000-0000-000000000001', CanEdit: true }];
  }
  return { Item: value, People: [{ Name: 'Old Person' }] };
}
const errorType = error => error?.nativeException ?? (error?.name === 'XmlError' ? 'XmlException'
  : error?.name === 'AbortError' ? 'OperationCanceledException' : error?.name);
const layouts = await (await import('./reader-layout-fixture.js')).layoutFixture('local-xml-provider');
test('local XML oracle seals bind every input and recorded result', async () => {
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(provenance.jellyfin.commit, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  assert.equal(provenance.files.native.sha256, '3051ccd13e3ccb3af2252615290852f45829b39198edf0c72dfc1d4d99f68c7c');
  for (const name of ['input', 'native', 'oracle', 'project']) {
    const file = provenance.files[name];
    assert.equal(sha(await readFile(new URL(file.filename, fixture))), file.sha256);
  }
  assert.equal(native.candidateVerified, false);
  assert.equal(provenance.candidateVerified, false);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(provenance.counts, { parserCases: 46, parserResults: 92, providerCases: 10, mergeCases: 6, pipelineCases: 5 });
  assert.equal(input.parserCases.length, 46);
  assert.equal(native.parserResults.length, 92);
  for (const [inputs, results, count] of [[input.providerCases, native.providerResults, 10],
    [input.mergeCases, native.mergeResults, 6], [input.pipelineCases, native.pipelineResults, 5]]) {
    assert.equal(inputs.length, count); assert.equal(results.length, count);
    assert.deepEqual(inputs.map(value => value.name), results.map(value => value.name));
  }
  assert.equal(new Set(native.parserResults.map(value => `${value.type}/${value.name}`)).size, 92);
  assert.equal(provenance.repeat.rawSha256, provenance.files.rawRecording.sha256);
  assert.equal(provenance.repeat.projectionEqual, true); assert.equal(provenance.repeat.byteEqual, true);
});
for (const expected of [...native.parserResults, ...layouts.native.parserResults]) test(`native local XML parser: ${expected.type}/${expected.name}`, async () => {
  const sample = [...input.parserCases, ...layouts.input.parserCases].find(value => value.name === expected.name);
  const result = await seeded(expected.type, sample.seed);
  let error = null;
  try {
    await linkedChildren.withSession(session => fetchLocalXml(async () => {
      if (sample.xml == null) throw Object.assign(new Error('Missing neutral file.'), { nativeException: 'FileNotFoundException' });
      return sample.bytes ? decodeNativeText(Buffer.from(sample.bytes, 'base64')) : sample.xml;
    }, { type: expected.type, result, externalIdInfos: sample.externalIds,
      signal: sample.cancelled ? AbortSignal.abort() : undefined, linkedChildren, session }));
  } catch (failure) { error = errorType(failure); }
  assert.equal(error, expected.error);
  assert.deepEqual(await projectLocalXmlResult(result), expected.result);
});

for (const expected of native.providerResults) test(`native local XML provider: ${expected.name}`, async () => {
  const sample = input.providerCases.find(value => value.name === expected.name);
  const value = item(sample.type); value.Path = `Z:\\Fixture\\${sample.path}`;
  const context = { accessPath: `/fixture/${sample.path}`, signal: sample.cancelled ? AbortSignal.abort() : undefined };
  const target = `/fixture/${expected.path}`;
  const missing = () => { throw Object.assign(new Error('Missing'), { code: 'not-found' }); };
  const vfs = {
    async stat(filename) {
      if (filename === context.accessPath && sample.kind !== 'absent') return { kind: sample.kind };
      if (filename === target && sample.xmlDirectory) return { kind: 'directory' };
      if (filename === target && sample.xml) return { kind: 'file', modified: '2026-10-10T02:03:04.0000000Z' };
      return missing();
    },
    async openRead(filename) {
      assert.equal(filename, target);
      return { stream: (async function* () { yield Buffer.from(sample.xml); })(), async close() {} };
    }
  };
  const offsets = { '-1': '2026-10-10T02:03:03.9999999Z', '1': '2026-10-10T02:03:04.0000001Z' };
  value.DateLastSaved = sample.xml ? offsets[sample.savedOffsetTicks] ?? '2026-10-10T02:03:04Z' : '0001-01-01 00:00:00';
  const provider = createLocalXmlPlugin({fileSystem: testFileSystem,  vfs, linkedChildren, spoolRoot }).providers.find(entry => entry.id === `${sample.type}XmlProvider`);
  let actual = null, error = null;
  assert.equal(await provider.hasChanged(value, context), expected.changed);
  try { const result = await provider.getMetadata(value, context); track(result.Item); actual = { HasMetadata: result.HasMetadata,
    item: result.Item ? await projectLocalXmlResult(result) : null, Name: provider.name, Order: provider.order }; }
  catch (failure) { error = errorType(failure); }
  assert.equal(error, expected.error);
  assert.deepEqual(actual, expected.result);
});

test('local XML reader confines state-local files and does not use a media filesystem fallback', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-xml-reader-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'local-xml-reader-outside-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const value = item('BoxSet'); value.Path = path.join(root, 'Set');
  await mkdir(value.Path);
  await writeFile(localXmlSavePath(value), '<Item><LocalTitle>State local</LocalTitle></Item>');
  const provider = createLocalXmlPlugin({fileSystem: testFileSystem,  linkedChildren, spoolRoot }).providers.find(entry => entry.id === 'BoxSetXmlProvider');
  const result = await provider.getMetadata(value, { localPath: value.Path, localRoot: root }); track(result.Item);
  assert.equal(result.Item.Name, 'State local');
  const linked = path.join(root, 'Linked');
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(provider.getMetadata(value, { localPath: linked, localRoot: root }), error => error.code === 'permission-denied');
  await assert.rejects(provider.getMetadata(value, { localPath: outside, localRoot: root }), error => error.code === 'unmapped-path');
  const remote = createLocalXmlPlugin({fileSystem: testFileSystem,  linkedChildren, spoolRoot, vfs: { stat: async () => { throw Object.assign(new Error('Missing'), { code: 'not-found' }); } } })
    .providers.find(entry => entry.id === 'BoxSetXmlProvider');
  assert.equal((await remote.getMetadata(value, { accessPath: '/remote/Set' })).HasMetadata, false);
});

for (const [index, sample] of input.mergeCases.entries()) test(`native BoxSet XML merge: ${sample.name}`, async () => {
  const links = entries => entries.map(entry => ({ Type: 'Manual', ItemId: entry.id ?? null, Path: entry.path ?? null, LibraryItemId: null }));
  const source = item('BoxSet'); await assignLinks(source, links(sample.source));
  const target = item('BoxSet'); target.Path = sample.managed ? 'Z:\\State\\data\\Set' : 'Z:\\External\\Set';
  await assignLinks(target, links(sample.target));
  const result = { Item: target, People: null };
  assert.deepEqual(await projectLocalXmlResult(result), native.mergeResults[index].before);
  await mergeMetadata({ Item: source, People: null }, result, { replaceData: sample.replaceData,
    mergeMetadataSettings: sample.mergeSettings, dataPath: 'Z:\\State\\data', linkedChildren });
  assert.deepEqual(await projectLocalXmlResult(result), native.mergeResults[index].after);
});

test('XML provider retains its fresh item after post-stat I/O failure and propagates permission errors', async () => {
  const value = item('BoxSet'); value.Path = 'Z:\\Fixture\\Set';
  let failure = Object.assign(new Error('I/O'), { code: 'unavailable' });
  const provider = createLocalXmlPlugin({fileSystem: testFileSystem,  linkedChildren, spoolRoot, vfs: { stat: async () => ({ kind: 'file' }), openRead: async () => { throw failure; } } })
    .providers.find(entry => entry.id === 'BoxSetXmlProvider');
  const result = await provider.getMetadata(value, { accessPath: '/fixture/Set', signal: AbortSignal.abort() }); track(result.Item);
  assert.equal(result.HasMetadata, false);
  assert.equal(result.Item.Type, 'BoxSet'); assert.deepEqual(result.People, []);
  failure = Object.assign(new Error('Forbidden'), { code: 'permission-denied' });
  await assert.rejects(provider.getMetadata(value, { accessPath: '/fixture/Set' }), error => error === failure);
});

test('unknown XML names do not access inherited JavaScript mapping properties', async () => {
  const result = await linkedChildren.withSession(session => fetchLocalXml(async () => '<Item><constructor>Ignored</constructor>'
    + '<toString>Ignored</toString><__proto__>Ignored</__proto__></Item>', { type: 'Playlist', linkedChildren, session }));
  track(result.Item);
  assert.equal(result.HasMetadata, true);
  assert.deepEqual(Object.keys(result.Item).sort(), Object.keys(item('Playlist')).sort());
});

for (const [index, sample] of input.pipelineCases.entries()) test(`native local XML merge pipeline: ${sample.name}`, async () => {
  const links = entries => entries.map(entry => ({ Type: 'Manual', ItemId: entry.id ?? null, Path: entry.path ?? null, LibraryItemId: null }));
  const source = { Item: item(sample.type), People: null };
  const target = { Item: item(sample.type), People: null };
  const temp = { Item: item(sample.type), People: null };
  await assignLinks(source.Item, links(sample.source));
  await assignLinks(target.Item, links(sample.target));
  target.Item.Path = temp.Item.Path = 'Z:\\External\\LogicalPlaylist';
  const expected = native.pipelineResults[index];
  await mergeMetadata(source, temp, { mergeMetadataSettings: true, dataPath: 'Z:\\State\\data', linkedChildren });
  assert.deepEqual(await linksFor(temp.Item), expected.afterLocal);
  await mergeMetadata(target, temp, { linkedChildren });
  assert.deepEqual(await linksFor(temp.Item), expected.afterExisting);
  await mergeMetadata(temp, target, { replaceData: sample.replaceData, mergeMetadataSettings: true, dataPath: 'Z:\\State\\data', linkedChildren });
  assert.deepEqual(await linksFor(target.Item), expected.afterFinal);
});
