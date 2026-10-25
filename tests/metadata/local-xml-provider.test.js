import { testFileSystem } from '../storage/plugin-files.js';
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { decodeNativeText } from '../../src/core/native-text.js';
import { newNativeItemEntity, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { createLocalXmlPlugin, localXmlSavePath } from '../../src/metadata/local-xml.js';
import { fetchLocalXml } from '../../src/metadata/local-xml-parser.js';
import { mergeMetadata } from '../../src/metadata/merge.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { createStateRelations } from '../library/deletion-fixture.js';
import { currentXmlReaderFixture, functionalXmlReader } from './xml-reader-current-fixture.js';
import { assertProjectedEqual } from '../comparison-observations.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const fixture = await currentXmlReaderFixture(new URL('./fixtures/local-xml-provider/current-profile.json', import.meta.url));
const { input, baseInput, layoutInput } = fixture;
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
const errorObservation = error => ({ name: error.name, nativeException: error.nativeException, message: error.message });
test('current local XML consumers bind all parser, provider, merge and layout inputs', async () => {
  const { native, report } = await fixture.capture();
  assert.equal(report.nativeExecutionRecorded, true);
  assert.equal(baseInput.parserCases.length, 46); assert.equal(layoutInput.parserCases.length, 135);
  assert.equal(native.parserResults.length, 362);
  assert.equal(native.providerResults.length, 10); assert.equal(native.mergeResults.length, 6);
  assert.equal(native.pipelineResults.length, 5);
  await fixture.compareLayouts();
});
for (const [index, sample] of input.parserCases.entries()) for (const type of ['BoxSet', 'Playlist']) test(`current native local XML parser: ${type}/${sample.name}`, async t => {
  const { native } = await fixture.capture();
  const expected = native.parserResults.find(value => value.name === sample.name && value.type === type);
  let bytes, missingFileError;
  try { bytes = await fixture.readNativeInput(expected.file); }
  catch (failure) {
    if (expected.file.exists || failure.code !== 'ENOENT') throw failure;
    missingFileError = failure;
  }
  const result = await seeded(type, sample.seed);
  let error = null;
  try {
    await linkedChildren.withSession(session => fetchLocalXml(async () => {
      if (missingFileError) throw missingFileError;
      return decodeNativeText(bytes);
    }, { type, result, externalIdInfos: sample.externalIds,
      signal: sample.cancelled ? AbortSignal.abort() : undefined, linkedChildren, session }));
  } catch (failure) { error = errorObservation(failure); }
  const actual = { error, result: await projectLocalXmlResult(result) };
  await fixture.recordCandidate(`parser-${index}-${type}`, { name: sample.name, type, file: expected.file, ...actual });
  assertProjectedEqual(t, sample.name + '/' + type, actual, expected, functionalXmlReader);
});

for (const [index, sample] of input.providerCases.entries()) test(`current native local XML provider: ${sample.name}`, async t => {
  const { native } = await fixture.capture();
  const expected = native.providerResults[index];
  const bytes = expected.file.exists ? await fixture.readNativeInput(expected.file) : null;
  const value = item(sample.type); value.Path = `Z:\\Fixture\\${sample.path}`;
  const context = { accessPath: `/fixture/${sample.path}`, signal: sample.cancelled ? AbortSignal.abort() : undefined };
  const target = `/fixture/${expected.path}`;
  const missing = () => { throw Object.assign(new Error('Missing'), { code: 'not-found' }); };
  const vfs = {
    async stat(filename) {
      if (filename === context.accessPath && sample.kind !== 'absent') return { kind: sample.kind };
      if (filename === target && sample.xmlDirectory) return { kind: 'directory' };
      if (filename === target && sample.xml) return { kind: 'file', modified: expected.modified };
      return missing();
    },
    async openRead(filename) {
      assert.equal(filename, target);
      return { stream: (async function* () { yield bytes; })(), async close() {} };
    }
  };
  const offsets = { '-1': '2026-10-10T02:03:03.9999999Z', '1': '2026-10-10T02:03:04.0000001Z' };
  value.DateLastSaved = sample.xml ? offsets[sample.savedOffsetTicks] ?? '2026-10-10T02:03:04Z' : '0001-01-01 00:00:00';
  const provider = createLocalXmlPlugin({fileSystem: testFileSystem,  vfs, linkedChildren, spoolRoot }).providers.find(entry => entry.id === `${sample.type}XmlProvider`);
  let actual = null, error = null;
  const changed = await provider.hasChanged(value, context);
  try { const result = await provider.getMetadata(value, context); track(result.Item); actual = { HasMetadata: result.HasMetadata,
    item: result.Item ? await projectLocalXmlResult(result) : null, Name: provider.name, Order: provider.order }; }
  catch (failure) { error = errorObservation(failure); }
  await fixture.recordCandidate(`provider-${index}`, { name: sample.name, file: expected.file, changed, error, result: actual });
  assert.equal(changed, expected.changed);
  assertProjectedEqual(t, sample.name, { error, result: actual }, expected, functionalXmlReader);
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
  const { native } = await fixture.capture();
  const links = entries => entries.map(entry => ({ Type: 'Manual', ItemId: entry.id ?? null, Path: entry.path ?? null, LibraryItemId: null }));
  const source = item('BoxSet'); await assignLinks(source, links(sample.source));
  const target = item('BoxSet'); target.Path = sample.managed ? 'Z:\\State\\data\\Set' : 'Z:\\External\\Set';
  await assignLinks(target, links(sample.target));
  const result = { Item: target, People: null };
  const before = await projectLocalXmlResult(result);
  await mergeMetadata({ Item: source, People: null }, result, { replaceData: sample.replaceData,
    mergeMetadataSettings: sample.mergeSettings, dataPath: 'Z:\\State\\data', linkedChildren });
  const after = await projectLocalXmlResult(result);
  await fixture.recordCandidate(`merge-${index}`, { name: sample.name, before, after });
  assert.deepEqual(before, native.mergeResults[index].before);
  assert.deepEqual(after, native.mergeResults[index].after);
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
  await assert.rejects(provider.getMetadata(value, { accessPath: '/fixture/Set' }), { code: 'permission-denied' });
});

test('unknown XML names do not access inherited JavaScript mapping properties', async () => {
  const result = await linkedChildren.withSession(session => fetchLocalXml(async () => '<Item><constructor>Ignored</constructor>'
    + '<toString>Ignored</toString><__proto__>Ignored</__proto__></Item>', { type: 'Playlist', linkedChildren, session }));
  track(result.Item);
  assert.equal(result.HasMetadata, true);
  const empty = await linkedChildren.withSession(session => fetchLocalXml(async () => '<Item />', { type: 'Playlist', linkedChildren, session }));
  track(empty.Item);
  assert.deepEqual(await projectLocalXmlResult(result), await projectLocalXmlResult(empty));
});

for (const [index, sample] of input.pipelineCases.entries()) test(`native local XML merge pipeline: ${sample.name}`, async () => {
  const { native } = await fixture.capture();
  const links = entries => entries.map(entry => ({ Type: 'Manual', ItemId: entry.id ?? null, Path: entry.path ?? null, LibraryItemId: null }));
  const source = { Item: item(sample.type), People: null };
  const target = { Item: item(sample.type), People: null };
  const temp = { Item: item(sample.type), People: null };
  await assignLinks(source.Item, links(sample.source));
  await assignLinks(target.Item, links(sample.target));
  target.Item.Path = temp.Item.Path = 'Z:\\External\\LogicalPlaylist';
  const expected = native.pipelineResults[index];
  await mergeMetadata(source, temp, { mergeMetadataSettings: true, dataPath: 'Z:\\State\\data', linkedChildren });
  const afterLocal = await linksFor(temp.Item);
  await mergeMetadata(target, temp, { linkedChildren });
  const afterExisting = await linksFor(temp.Item);
  await mergeMetadata(temp, target, { replaceData: sample.replaceData, mergeMetadataSettings: true, dataPath: 'Z:\\State\\data', linkedChildren });
  const afterFinal = await linksFor(target.Item);
  await fixture.recordCandidate(`pipeline-${index}`, { name: sample.name, afterLocal, afterExisting, afterFinal });
  assert.deepEqual(afterLocal, expected.afterLocal);
  assert.deepEqual(afterExisting, expected.afterExisting);
  assert.deepEqual(afterFinal, expected.afterFinal);
});
