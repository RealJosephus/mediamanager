import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { nativeContainsSubPath } from '../../src/library/native-path.js';
import { visibleItem } from '../../src/library/permissions.js';
import { idKey } from '../../src/library/records.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = await readFile(new URL('./fixtures/playlist-path/native.json', import.meta.url));
assert.equal(hash(bytes), '1aa9ab1f53ef294dc1e757863ed3e252fc68faa001e2f280c8985a09861f5080');
const native = JSON.parse(bytes);

test('Playlist contract pins actual Windows DLL getters, raw paths and separate CLR source/runtime bindings', async () => {
  assert.equal(native.frozenJellyfin, true); assert.equal(native.audit.actualWindowsRuntime, true);
  assert.equal(native.audit.processExit, 0); assert.equal(native.audit.caseCount, 23); assert.equal(native.audit.rootControlCount, 25);
  assert.equal(native.audit.processesReclaimed, true); assert.equal(native.audit.phaseAcceptance, false);
  assert.equal(native.sourceBindings.length, 16); assert.equal(native.nativeSourceBindings.length, 4); assert.equal(native.nativeAssemblyBindings.length, 23);
  assert.equal(native.raw.actualFrozenPlaylistGetter, true); assert.equal(native.raw.actualFrozenManagedFileSystem, true);
  assert.equal(native.raw.actualFrozenVisibility, true); assert.equal(native.raw.Windows, true);
  const source = await readFile(new URL('./fixtures/playlist-path/Oracle.cs', import.meta.url));
  assert.equal(hash(source), native.oracleSourceSha256);
  assert.equal(native.sourceBindings.find(row => row.path.endsWith('/playlist-path-native-v1/Program.cs')).sha256, hash(source));
  assert.equal(native.initial.sourceStable, true); assert.equal(native.initial.differences, 6); assert.equal(native.initial.containsDifferences, 3);
  assert.equal(native.initial.candidateSourceBindings.length, 239);
  assert.equal(native.raw.results.length, 16); assert.equal(native.raw.subpathControls.length, 7); assert.equal(native.supplementalRoots.results.length, 25);
  assert.equal(native.clrProvenance.sourceVersion, 'dotnet/runtime v10.0.0');
  assert.equal(native.clrProvenance.oracleRuntimeCommit, '95017c711e6afc1085133d440e42b4bd78155701');
  assert.deepEqual(JSON.parse(await readFile(new URL('../../src/core/resources/native-path-provenance.json', import.meta.url))), native.clrProvenance);
  for (const row of native.nativeAssemblyBindings) assert.equal(native.raw.assemblies.find(assembly => assembly.name === row.name).sha256, row.sha256);
});

test('raw ContainsSubPath matches 23 actual Windows DLL controls and separately observed root-trimming boundaries', () => {
  for (const row of native.raw.results) {
    assert.equal(!!row.path && nativeContainsSubPath(row.path, row.dataPath, { windows: true }), row.isSharedItem, row.name);
    if (row.containsError) assert.throws(() => nativeContainsSubPath(row.path, row.dataPath, { windows: true }), TypeError);
    else assert.equal(nativeContainsSubPath(row.path, row.dataPath, { windows: true }), row.contains, row.name);
  }
  for (const row of native.raw.subpathControls) assert.equal(nativeContainsSubPath(row.value, row.parent, { windows: true }), row.actual, row.name);
  for (const row of native.supplementalRoots.results) {
    // An untrimmed root equals its candidate and fails the strict length test;
    // a separately recorded trimmed final separator makes the original a subpath.
    assert.equal(nativeContainsSubPath(row.input, row.input, { windows: true }), row.trimmed !== row.input, row.input);
  }
});

test('private Playlist direct/standalone visibility matches all 16 actual Windows getter cases',
  { skip: process.platform !== 'win32' }, async () => {
    const observations = [], differences = [];
    for (const row of native.raw.results) {
      const item = { Id: row.Id, ParentId: row.ParentId, Type: 'Playlist', IsFolder: true, Path: row.path,
        OpenAccess: row.OpenAccess, OwnerUserId: row.OwnerUserId, Shares: row.shares, Tags: [] };
      const parent = { Id: row.ParentId, ParentId: null, Path: 'Q:\\external-library', Type: 'Folder', IsFolder: true, Tags: [] };
      const state = { items: [parent, item], byId: new Map([parent, item].map(item => [idKey(item.Id), item])), links: [], parents: [], ancestors: () => [] };
      const user = { Id: row.userId, Policy: { EnableAllFolders: true, BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] } };
      const options = { query: false, programDataPath: row.programDataPath };
      const actual = { isVisible: visibleItem(item, user, state, { ...options, checkStandaloneParents: false }),
        isVisibleStandalone: visibleItem(item, user, state, options) };
      const expected = { isVisible: row.isVisible, isVisibleStandalone: row.isVisibleStandalone };
      const observation = { name: row.name, path: row.path, dataPath: row.dataPath, actual, expected, matched: JSON.stringify(actual) === JSON.stringify(expected) };
      observations.push(observation); if (!observation.matched) differences.push(observation);
    }
    const output = process.env.MEDIAMANAGER_PLAYLIST_PATH_EVIDENCE;
    if (output) {
      await mkdir(path.resolve(output), { recursive: true });
      await writeFile(path.join(output, 'observations.json'), JSON.stringify({ passed: !differences.length, phaseAcceptance: false,
        nativeSha256: hash(bytes), testSha256: hash(await readFile(new URL(import.meta.url))),
        helperSha256: hash(await readFile(new URL('../../src/library/native-path.js', import.meta.url))),
        permissionsSha256: hash(await readFile(new URL('../../src/library/permissions.js', import.meta.url))),
        platform: process.platform, observations, differences, crossPlatformNativeExecuted: false,
        scope: native.scope, databaseOpened: false, hostOpened: false, portOpened: false }, null, 2) + '\n', { flag: 'wx' });
    }
    assert.equal(differences.length, 0, JSON.stringify(differences));
  });
