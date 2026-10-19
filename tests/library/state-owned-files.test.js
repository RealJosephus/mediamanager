import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { stateOwnedFiles, stateIgnoreFileAccess } from '../../src/library/state-owned-files.js';
import { DotIgnoreRule } from '../../src/library/dot-ignore-rule.js';
import { nativeDateFromUnixNanoseconds } from '../../src/users/native.js';
import { dateText } from '../../src/library/records.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'state-owned-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'instance');
  await mkdir(state);
  return { root, state, assets: new MetadataImageAssets({fileSystem: testFileSystem,  stateRoots: [state] }) };
}

test('state directory observations retain filesystem date precision and expose no media reader', async t => {
  const { state, assets } = await fixture(t), filename = path.join(state, 'trailer.mkv');
  await writeFile(filename, 'local identity control');
  const files = stateOwnedFiles(assets), info = await stat(filename, { bigint: true });
  const listing = await files.list(state);
  assert.equal(listing.deletionSafe, true); assert.equal(listing.entries.length, 1);
  assert.deepEqual(await files.stat({ identityPath: filename }), { kind: 'file', size: info.size,
    modified: dateText(nativeDateFromUnixNanoseconds(info.mtimeNs)), created: dateText(nativeDateFromUnixNanoseconds(info.birthtimeNs)) });
  assert.deepEqual(Object.keys(files).sort(), ['list', 'stat']);
});

test('state observations reject a media asset resolver before invoking its list or stat', async () => {
  let mediaCalls = 0;
  const files = stateOwnedFiles({ resolve: async () => ({ accessPath: '/media/item' }),
    list() { mediaCalls++; }, stat() { mediaCalls++; } });
  await assert.rejects(files.list('Z:\\Media'), TypeError);
  await assert.rejects(files.stat({ identityPath: 'Z:\\Media\\item' }), TypeError);
  assert.equal(mediaCalls, 0);
});

test('state .ignore never reads arbitrary host ancestors and only delegates .ignore', async t => {
  const { root, state, assets } = await fixture(t);
  await writeFile(path.join(root, '.ignore'), '*');
  const access = stateIgnoreFileAccess(assets);
  assert.deepEqual(await access.info(path.join(root, '.ignore')), { mapped: false, entry: null });
  assert.deepEqual(await access.info(path.join(state, '.ignore')), { mapped: true, entry: null, stateIdentity: path.join(state, '.ignore') });
  await assert.rejects(access.info(path.join(state, 'trailer.mkv')), TypeError);
  const rule = new DotIgnoreRule({ fileAccess: access });
  await assert.rejects(rule.shouldIgnore(path.join(state, 'item.mkv')), { code: 'ignore-search-unmapped' });
});

test('explicit ancestor .ignore access is retained without broadening instance permissions', async t => {
  const { root, assets } = await fixture(t), filename = path.join(root, '.ignore');
  let reads = 0;
  const fallback = { info: async value => ({ mapped: true, entry: { kind: 'file', modified: '2025-01-03T04:05:06.0000000Z' }, accessPath: value }),
    openRead: async info => { reads++; return { stream: [Buffer.from('*.mkv')], close: async () => {} }; } };
  const access = stateIgnoreFileAccess(assets, fallback);
  const info = await access.info(filename);
  assert.equal(info.accessPath, filename); assert.equal(info.stateIdentity, undefined);
  const handle = await access.openRead(info); await handle.close(); assert.equal(reads, 1);
});

test('state .ignore BOM decoding and cloned preview caches remain isolated', async t => {
  const { state, assets } = await fixture(t);
  const fallback = { info: async () => ({ mapped: true, entry: null }) };
  const access = stateIgnoreFileAccess(assets, fallback), rule = new DotIgnoreRule({ fileAccess: access });
  const candidate = path.join(state, 'item.mkv');
  assert.equal(await rule.clone().shouldIgnore(candidate), false);
  await writeFile(path.join(state, '.ignore'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('*.mkv', 'utf16le')]));
  assert.equal(await rule.shouldIgnore(candidate), true);
});

test('state directory and ignore symlinks cannot escape the authorized instance root', async t => {
  const { root, state, assets } = await fixture(t), outside = path.join(root, 'outside'), alias = path.join(state, 'alias');
  await mkdir(outside); await writeFile(path.join(outside, '.ignore'), '*.mkv');
  await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  let fallbacks = 0;
  const access = stateIgnoreFileAccess(assets, { info: async () => { fallbacks++; return { mapped: true, entry: null }; } });
  await assert.rejects(stateOwnedFiles(assets).list(alias), { code: 'permission-denied' });
  await assert.rejects(stateOwnedFiles(assets).stat({ identityPath: path.join(alias, '.ignore') }), { code: 'permission-denied' });
  await assert.rejects(access.info(path.join(alias, '.ignore')), { code: 'permission-denied' });
  assert.equal(fallbacks, 0);
});

test('incomplete local enumeration and post-list authorization failure cannot authorize cleanup', async () => {
  const error = Object.assign(new Error('Controlled enumeration failure'), { code: 'permission-denied' });
  await assert.rejects(stateOwnedFiles({ resolve: async () => ({ localPath: '/state' }), list: async () => { throw error; } }).list('/state'),
    value => value === error);
  let resolutions = 0;
  await assert.rejects(stateOwnedFiles({ resolve: async () => { if (resolutions++) throw error; return { localPath: '/state' }; },
    list: async () => [] }).list('/state'), value => value === error);
});
