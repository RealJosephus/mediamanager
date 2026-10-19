import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalXmlPlugin, serializeLocalXml } from '../../src/metadata/local-xml.js';
import { saveMetadata, ItemUpdateType } from '../../src/metadata/save-manager.js';
import { setNativePlaylistFileState } from '../../src/library/native-path.js';

const fixture = new URL('./fixtures/local-xml-save-prefix/', import.meta.url);
const [nativeBytes, proofBytes] = await Promise.all(['native.json', 'provenance.json'].map(name => fs.readFile(new URL(name, fixture))));
const native = JSON.parse(nativeBytes), proof = JSON.parse(proofBytes);
const sha = value => createHash('sha256').update(value).digest('hex');
const base = extra => ({ Type: 'BoxSet', Name: 'New common title', Overview: 'New overview', OfficialRating: 'PG',
  DateCreated: '2026-10-13T00:00:00Z', DisplayOrder: 'PremiereDate', SupportsLocalMetadata: true, ...extra });
const snapshot = (count, paths = ['Z:\\NeutralMedia\\member.mkv']) => ({ manualCount: BigInt(count),
  async *pages({ limit }) { assert.equal(limit, 128); for (let start = 0; start < count; start += limit)
    yield Array.from({ length: Math.min(count - start, limit) }, (_, offset) => ({ Path: paths[(start + offset) % paths.length] })); },
  async close() {} });
async function root(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-xml-stream-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function smallFrame(item, context) {
  const prepared = await serializeLocalXml(item, {fileSystem:testFileSystem,...context}), chunks = [];
  try { for await (const chunk of prepared.stream()) chunks.push(chunk); return Buffer.concat(chunks); }
  finally { await prepared.close(); }
}

test('local XML prefix fixture binds actual saver, source and loaded assembly evidence', async () => {
  assert.equal(sha(nativeBytes), proof.nativeSha256);
  assert.equal(sha(await fs.readFile(proof.rawRecording)), proof.nativeSha256);
  assert.equal(native.actualBaseXmlSaver, true); assert.equal(native.actualBoxSetXmlSaver, true);
  assert.equal(native.results.length, 5); assert.equal(proof.phaseAcceptance, false);
  for (const source of proof.oracleSources) assert.equal(sha(await fs.readFile(new URL(source.name, fixture))), source.sha256);
  for (const source of proof.sources) for (const filename of [source.designated, source.isolated]) assert.equal(sha(await fs.readFile(filename)), source.sha256);
  for (const assembly of proof.loadedAssemblies) assert.equal(sha(await fs.readFile(assembly.filename)), assembly.sha256);
});

for (const expected of native.results) test('local XML persists the actual native frame after ' + expected.name, async t => {
  const directory = await root(t), target = path.join(directory, 'collection.xml');
  if (expected.existing) await fs.writeFile(target, 'Previous complete document');
  let opened = 0, closed = 0;
  const fileSystem = { ...fs, async open(...args) { opened++; assert.equal(args[1], 'w'); const handle = await fs.open(...args);
    return { write: (...values) => handle.write(...values), async close() { closed++; await handle.close(); } }; } };
  const saver = createLocalXmlPlugin({ fileSystem }).providers.find(value => value.id === 'BoxSetXmlSaver');
  const item = base({ Path: directory, Overview: expected.fault === 'xml' ? 'Before \0 after' : 'New overview' });
  const context = { localRoot: directory, localPath: directory,
    async getPeople() { assert.equal((await fs.stat(target)).size, 0); if (expected.fault === 'people') throw new Error('people lookup failed'); return []; },
    async prepareLinkedXmlItems() { assert.equal((await fs.stat(target)).size, 0); if (expected.fault === 'links') throw new Error('links lookup failed'); return snapshot(1); } };
  if (expected.fault === 'none') await saver.save(item, context);
  else await assert.rejects(saver.save(item, context));
  const bytes = await fs.readFile(target);
  assert.equal(bytes.length, expected.finalLength); assert.equal(sha(bytes), expected.finalSha256);
  assert.equal(opened, 1); assert.equal(closed, 1);
});

test('prepared XML keeps duplicate path order and directory/file Playlist nodes', async t => {
  const spoolRoot = await root(t), paths = ['Z:\\Media\\A & <B>.mkv', null, 'Z:\\Media\\A & <B>.mkv'];
  const box = (await smallFrame(base(), { spoolRoot, prepareLinkedXmlItems: () => snapshot(3, paths) })).toString('utf8');
  assert.equal((box.match(/<CollectionItem>/gu) ?? []).length, 2);
  assert.equal((box.match(/A &amp; &lt;B&gt;/gu) ?? []).length, 2);
  const item = { ...base(), Type: 'Playlist', Path: 'Z:\\Playlists\\Road.m3u', OwnerUserId: '91000000-0000-0000-0000-000000000001',
    Shares: [{ UserId: '91000000-0000-0000-0000-000000000002', CanEdit: true }], PlaylistMediaType: 'Video' };
  setNativePlaylistFileState(item, false);
  const directory = (await smallFrame(item, { spoolRoot, prepareLinkedXmlItems: () => snapshot(1) })).toString('utf8');
  assert.match(directory, /<OwnerUserId>91000000000000000000000000000001<\/OwnerUserId>/u);
  assert.match(directory, /<PlaylistItems>/u); assert.match(directory, /<Shares>/u);
  setNativePlaylistFileState(item, true);
  const file = (await smallFrame(item, { spoolRoot, prepareLinkedXmlItems() { throw new Error('file playlist cannot resolve links'); } })).toString('utf8');
  assert.doesNotMatch(file, /OwnerUserId|PlaylistItems/u); assert.match(file, /<PlaylistMediaType>Video<\/PlaylistMediaType>/u);
  assert.deepEqual(await fs.readdir(spoolRoot), []);
});

test('prepared XML bounds member pages and output chunks and releases abandoned readers', async t => {
  const spoolRoot = await root(t);
  let released = 0, pages = 0;
  const members = snapshot(4097);
  const prepared = await serializeLocalXml(base(), {fileSystem: testFileSystem,  spoolRoot, prepareLinkedXmlItems: () => ({ ...members,
    async *pages(options) { for await (const page of members.pages(options)) { pages++; yield page; } }, close: async () => { released++; } }) });
  assert.equal(released, 1); assert.equal(pages, 33); assert.equal(typeof prepared.size, 'bigint');
  let length = 0n;
  for await (const bytes of prepared.stream()) { assert.ok(bytes.length <= 8192); length += BigInt(bytes.length); }
  assert.equal(length, prepared.size);
  const abandoned = prepared.stream(); await abandoned.next(); await prepared.close(); await abandoned.return();
  assert.deepEqual(await fs.readdir(spoolRoot), []);
  await assert.rejects(prepared.stream().next(), /released/u);
});

test('remote XML commits a failed preparation frame once and preserves explicit storage conditions', async t => {
  const spoolRoot = await root(t), expected = native.results.find(value => value.fault === 'links');
  const failure = new Error('links lookup failed'), calls = [];
  const vfs = { capabilities: () => ({ create: true, replace: true, conditionalWrite: true, atomicReplace: true }),
    async write(destination, stream, options) { const chunks = []; for await (const chunk of stream) chunks.push(chunk);
      calls.push({ destination, options, bytes: Buffer.concat(chunks) }); } };
  const saver = createLocalXmlPlugin({fileSystem: testFileSystem,  vfs, spoolRoot }).providers.find(value => value.id === 'BoxSetXmlSaver');
  await assert.rejects(saver.save(base(), { accessPath: '/box', vfsWriteOptions: { ifMatch: 'explicit-version', atomic: true },
    prepareLinkedXmlItems() { throw failure; } }), error => error === failure);
  assert.equal(calls.length, 1); assert.equal(sha(calls[0].bytes), expected.finalSha256);
  assert.equal(calls[0].options.size, BigInt(expected.finalLength));
  assert.equal(calls[0].options.ifMatch, 'explicit-version'); assert.equal(calls[0].options.atomic, true);
  assert.deepEqual(await fs.readdir(spoolRoot), []);
});

test('save manager completes monitor and continues another saver after local XML failure', async t => {
  const directory = await root(t), actions = [];
  const saver = createLocalXmlPlugin({fileSystem:testFileSystem}).providers.find(value => value.id === 'BoxSetXmlSaver');
  const item = base({ Path: directory });
  const result = await saveMetadata(item, ItemUpdateType.MetadataEdit, [saver, { id: 'Other', name: 'Other',
    isEnabledFor: () => true, save: async () => actions.push('other') }], {
    libraryOptions: { MetadataSavers: ['Emby Xml', 'Other'] },
    logger: { error: () => actions.push('logger') }, monitor: { begin: () => actions.push('begin'), complete: () => actions.push('complete') },
    context: { localRoot: directory, localPath: directory, prepareLinkedXmlItems() { throw new Error('lookup failure'); } } });
  assert.deepEqual(actions, ['begin', 'logger', 'complete', 'other']);
  assert.equal(result.length, 2); assert.ok(result[0].error); assert.equal(result[1].error, undefined);
});
