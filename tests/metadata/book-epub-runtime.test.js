import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createBookEpubPlugin } from '../../src/metadata/book-epub-provider.js';
import { BookArchiveService } from '../../src/storage/archive-reader.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { dateTicks } from '../../src/library/records.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const inputFile = new URL('./fixtures/book-epub-runtime/input.json', import.meta.url);
const inputBytes = await readFile(inputFile), input = JSON.parse(inputBytes);
assert.equal(input.timeZone, 'Asia/Taipei');
assert.equal(input.timeZoneOffsetMinutes, 480);
// This test file runs in its own Node test process. The parent strict runner's
// environment and the other files' clocks remain separate inputs.
process.env.TZ = input.timeZone;
const timeZoneControl = { requested: input.timeZone, effective: Intl.DateTimeFormat().resolvedOptions().timeZone,
  instant: input.timeZoneInstant, offsetMinutes: 0 - new Date(input.timeZoneInstant).getTimezoneOffset() };
assert.equal(timeZoneControl.offsetMinutes, input.timeZoneOffsetMinutes);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const root = new URL('.', inputFile);
const identity = filename => 'Z:\\Books\\' + filename.replaceAll('/', '\\');
const book = filename => Object.assign(newNativeItemEntity('MediaBrowser.Controller.Entities.Book'), { Path: identity(filename) });
const errorDetails = error => ({ name: error.name, message: error.message, code: error.code, status: error.status, stack: error.stack });
const outcome = ({ error, coverError, metadataLogs, imageLogs, ...value }) => ({ ...value,
  failed: error != null, coverFailed: coverError != null });
const fields = ['Name', 'ForcedSortName', 'Overview', 'Studios', 'ProviderIds', 'Genres', 'IndexNumber', 'SeriesName', 'ProductionYear'];
const wireStrings = value => typeof value === 'string' ? value.toWellFormed() : Array.isArray(value) ? value.map(wireStrings)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, part]) => [key, wireStrings(part)])) : value;
function projection(result, candidate = false) {
  if (!result) return null;
  const item = candidate ? result.Item : result.item;
  return wireStrings({ HasMetadata: result.HasMetadata, ResultLanguage: result.ResultLanguage ?? null,
    item: item ? Object.fromEntries(fields.map(field => [field, item[field] ?? null])) : null,
    premiereTicks: item ? candidate ? item.PremiereDate ? dateTicks(item.PremiereDate).toString() : null : item.premiereTicks : null,
    rating: item ? candidate ? item.CommunityRating ?? null : item.communityRatingDouble : null,
    people: (candidate ? result.People : result.people)?.map(person => ({ Name: person.Name, type: candidate ? person.Type : person.type,
      Role: person.Role ?? null, ProviderIds: person.ProviderIds ?? {} })) ?? null });
}
let nativeRun;
function actualNativeRun() {
  return nativeRun ??= (async () => {
    const output = path.join(validationOutputRoot(), 'book-epub-runtime-' + randomUUID());
    await mkdir(output);
    const recording = await recordOracle({ project: 'tests/metadata/fixtures/book-epub-runtime/Oracle.csproj',
      output: path.join(output, 'native'), args: [fileURLToPath(inputFile), '{output}/assets', '{output}/native.json'] });
    const native = JSON.parse(await readFile(path.join(output, 'native/native.json')));
    assert.equal(recording.passed, true); assert.equal(native.actualExecution, true);
    assert.equal(native.inputSha256, digest(inputBytes));
    assert.equal(recording.timezone, input.timeZone);
    assert.equal(native.timeZoneControl.requested, input.timeZone);
    assert.equal(native.timeZoneControl.instant, timeZoneControl.instant);
    assert.equal(native.timeZoneControl.offsetMinutes, timeZoneControl.offsetMinutes);
    assert.equal(native.assemblies.find(value => value.FullName.startsWith('jellyfin,')).sha256, recording.jellyfinDll.sha256);
    assert.deepEqual(native.results.map(value => value.name), input.epubs.map(value => value.name));
    await writeFile(path.join(output, 'candidate-timezone.json'), JSON.stringify(timeZoneControl, null, 2) + '\n', { flag: 'wx' });
    return { native, output };
  })();
}

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'book-epub-runtime-'));
  const registry = new StorageRegistry();
  registry.registerType('memory', () => new MemoryStorageAdapter());
  let archives;
  t.after(async () => {
    try { await archives?.close(); }
    finally { try { await registry.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
  });
  const media = await registry.createInstance('media', 'memory', {}), metadata = await registry.createInstance('metadata', 'memory', {});
  const vfs = new VirtualFileSystem(registry), mediaMap = new IdentityAccessMap();
  vfs.mount({ path: '/media', instanceId: 'media', capabilities: {} });
  vfs.mount({ path: '/metadata', instanceId: 'metadata', capabilities: {} });
  mediaMap.addPrefix({ identityRoot: 'Z:\\Books', accessRoot: '/media', style: 'windows', returnAccess: 'Independent original EPUB media.' });
  archives = new BookArchiveService({ vfs, identityMap: mediaMap, spoolPath: directory });
  await media.mkdir('/epub'); await metadata.mkdir('/epub');
  for (const entry of input.assets) {
    const bytes = await readFile(new URL('assets/' + entry.path, root));
    assert.equal(bytes.length, entry.length); assert.equal(digest(bytes), entry.sha256);
    await media.write('/' + entry.path, bytes);
    await metadata.write('/' + entry.path, Buffer.from('Independent metadata backend decoy.'));
  }
  await media.mkdir('/epub/directory.epub');
  return { directory, archives, context: item => ({ fileSystemMetadata: async () => ({
    ...await vfs.stat(mediaMap.resolve({ identityPath: item.Path, style: 'windows' })), exists: true }) }) };
}

test('EPUB executes all original provider cases against the current same-platform native build', async () => {
  const { native } = await actualNativeRun();
  assert.equal(native.results.length, 38); assert.equal(input.assets.length, 37);
  const positive = native.results.find(value => value.name === (process.platform === 'win32' ? 'rich-with-cover' : 'standard-slashes'));
  assert.equal(positive.result.HasMetadata, true); assert.equal(positive.hasCover, true);
});

test('EPUB metadata, cover bytes, errors and archive release match actual same-platform providers', async t => {
  const { native, output } = await actualNativeRun(), fixture = await setup(t);
  for (const sample of input.epubs) await t.test(sample.name, async () => {
    const item = book(sample.path), signal = sample.cancelled ? AbortSignal.abort() : undefined;
    const metadataLogs = [], imageLogs = []; let logs = metadataLogs;
    const [provider, cover] = createBookEpubPlugin({ openArchive: fixture.archives.openArchive,
      logger: { error: cause => logs.push(errorDetails(cause)) } }).providers;
    let result = null, error = null, image = null, coverError = null;
    try { result = await provider.getMetadata(item, { ...fixture.context(item), signal }); } catch (cause) { error = errorDetails(cause); }
    logs = imageLogs;
    try { image = await cover.getImage(item, { type: 'Primary', signal }); } catch (cause) { coverError = errorDetails(cause); }
    const observed = { name: sample.name, result: projection(result, true), error, coverError, hasCover: coverError ? null : Boolean(image),
      coverSha: image ? digest(image.bytes) : null, coverMime: image?.mimeType ?? null, metadataLogs, imageLogs };
    await writeFile(path.join(output, 'candidate-' + sample.name + '.json'), JSON.stringify(observed, null, 2) + '\n', { flag: 'wx' });
    const expected = native.results.find(entry => entry.name === sample.name);
    assert.deepEqual(outcome(observed), outcome({ name: sample.name, result: projection(expected.result), error: expected.error,
      coverError: expected.coverError, hasCover: expected.hasCover, coverSha: expected.coverSha,
      coverMime: expected.coverFormat == null ? null : { Png: 'image/png', Jpg: 'image/jpeg', Gif: 'image/gif', Bmp: 'image/bmp' }[expected.coverFormat],
      metadataLogs: expected.metadataLogs, imageLogs: expected.imageLogs }));
    assert.deepEqual(await readdir(fixture.directory), [], 'every operation releases its owned archive spool');
  });
});

test('EPUB controlled cancellation and read failures retain the actual prefix and close archives', async t => {
  const container = Buffer.from('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfile full-path="OPS/package.opf"/></container>');
  const valid = Buffer.from('<package xmlns="http://www.idpf.org/2007/opf"><metadata/></package>');
  for (const mode of ['cancelled missing container', 'cancelled valid XML', 'cancelled invalid XML', 'ordinary read failure', 'cover cancelled before open']) await t.test(mode, async () => {
    let opened = 0, closed = 0, reads = 0;
    const entries = mode === 'cancelled missing container' ? [] : [{ key: path.join('META-INF', 'container.xml') }, { key: 'OPS/package.opf' }];
    const signal = mode.startsWith('cancelled') || mode === 'cover cancelled before open' ? AbortSignal.abort() : undefined;
    const openArchive = async (_item, options) => {
      opened++; assert.equal(options.signal, undefined); assert.equal(options.zipOnly, true);
      return { findEntry: name => entries.find(entry => entry.key === name) ?? null, async read(entry, options = {}) {
        reads++; assert.equal(options.signal, undefined);
        if (mode === 'ordinary read failure') throw new Error('Controlled archive read failure.');
        return entry === entries[0] ? container : mode === 'cancelled invalid XML' ? Buffer.from('<broken>') : valid;
      }, async close() { closed++; } };
    };
    const [provider, cover] = createBookEpubPlugin({ openArchive }).providers, item = book('controlled.epub');
    if (mode === 'cover cancelled before open') {
      await assert.rejects(cover.getImage(item, { signal }), error => error.name === 'AbortError'); assert.equal(opened, 0); return;
    }
    const work = provider.getMetadata(item, { signal, fileSystemMetadata: async () => ({ kind: 'file' }) });
    if (mode === 'cancelled missing container') assert.equal((await work).HasMetadata, false);
    else await assert.rejects(work, error => mode === 'cancelled valid XML' ? error.name === 'AbortError'
      : mode === 'cancelled invalid XML' ? error.code === 'invalid-book-xml' : error.message === 'Controlled archive read failure.');
    assert.equal(opened, 1); assert.equal(closed, 1);
    assert.equal(reads, mode === 'cancelled missing container' ? 0 : mode === 'ordinary read failure' ? 1 : 2);
  });
});
