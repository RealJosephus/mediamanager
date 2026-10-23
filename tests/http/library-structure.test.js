import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApplication } from '../../src/http/application.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { LibraryConfigurationService } from '../../src/library/library-configuration-service.js';
import { LibraryOptionsStore } from '../../src/library/library-options-store.js';
import { LibraryScanHost } from '../../src/library/library-scan-host.js';
import { deserializeLibraryOptions } from '../../src/library/options.js';
import { decodeNativeText } from '../../src/core/native-text.js';
import { parseCollectionTypeOption } from '../../src/library/collection-type-options.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { currentLibraryStructure, structureInput } from './library-structure-current.js';
import { projectStructureObservation } from './fixtures/library-structure-current/observations.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const id = 'ca200000000000000000000000000009';

test('library structure executes two current Native MVC, permission, rename and CollectionFolder consumers', async () => {
  const captured = await currentLibraryStructure();
  assert.equal(captured.native.results.length, structureInput.cases.length);
  assert.equal(captured.repeat.results.length, structureInput.cases.length);
});

test('public collection type parsing preserves current Native marker values and excludes internal query types', async () => {
  const { native } = await currentLibraryStructure();
  for (const row of native.markerTypes) assert.equal(parseCollectionTypeOption(row.text), row.value, row.text);
});

async function snapshot(views) {
  const files = [];
  for (const entry of await fs.readdir(views, { recursive: true, withFileTypes: true })) {
    const filename = path.join(entry.parentPath, entry.name), directory = entry.isDirectory();
    const file = { path: path.relative(views, filename).split(path.sep).join('/'), kind: directory ? 'directory' : 'file',
      bytesBase64: directory ? null : (await fs.readFile(filename)).toString('base64'), options: null };
    if (!directory && entry.name === 'options.xml') {
      try { file.options = { accepted: true, value: deserializeLibraryOptions(decodeNativeText(Buffer.from(file.bytesBase64, 'base64'))), error: null }; }
      catch (error) { file.options = { accepted: false, value: null, error: { name: error.name, message: error.message } }; }
    }
    files.push(file);
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function coldOptions(root, directory) {
  const store = new LibraryOptionsStore({ fileSystem: testFileSystem, programDataPath: root });
  try { return structuredClone(await store.get(directory)); }
  finally { await store.close(); }
}

for (const sample of structureInput.cases) test('LibraryStructure current Native HTTP differential: ' + sample.name, async t => {
  const captured = await currentLibraryStructure();
  const root = path.join(captured.candidateRoot, sample.name, 'program'), views = path.join(root, 'root', 'default');
  await fs.mkdir(views, { recursive: true });
  for (const file of structureInput.files) {
    const filename = path.join(views, ...file.path.split('/'));
    await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, Buffer.from(file.bytesBase64, 'base64'), { flag: 'wx' });
  }
  const beforeFiles = await snapshot(views), calls = [], events = [], moveAttempts = [], identity = sample.identity ?? 'admin';
  let savedOptions = null, injectedFailure = null;
  const user = { Id: id, Policy: { IsAdministrator: identity === 'admin', EnableRemoteAccess: sample.remoteDenied !== true }, AccessSchedules: [] };
  const auth = { IsAuthenticated: identity !== 'anonymous', IsApiKey: identity === 'apiKey', IsAdministrator: ['admin', 'apiKey'].includes(identity),
    UserId: ['apiKey', 'empty'].includes(identity) ? '00000000000000000000000000000000' : id,
    User: ['apiKey', 'empty'].includes(identity) ? null : user };
  const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'structure-differential', isLocalNetwork: () => sample.remote !== true });
  authentication.authenticate = async () => auth;
  const trace = (action, value = null) => calls.push({ action, value });
  const fail = action => { if (sample.fail === action) { injectedFailure = action; throw new Error('Controlled ' + action + ' failure.'); } };
  const types = ['movies', 'tvshows', 'music', 'musicvideos', 'homevideos', 'boxsets', 'books', 'mixed'];
  const optionsStore = new LibraryOptionsStore({ fileSystem: testFileSystem, programDataPath: root });
  optionsStore.on('updated', event => {
    savedOptions = structuredClone(event.LibraryOptions); events.push({ libraryPath: event.LibraryPath, options: savedOptions });
    trace('options-updated', savedOptions);
  });
  t.after(() => optionsStore.close());
  const service = {
    getVirtualFolders: async refresh => { trace('get', refresh); return []; },
    addVirtualFolder: async (name, type, options, refresh) => { trace('create', { name, collectionType: typeof type === 'string' ? types.indexOf(type) : type, options, refresh }); fail('create'); },
    removeVirtualFolder: async (name, refresh) => { trace('delete', { name, refresh }); fail('delete'); },
    addMediaPathFromRequest: async request => {
      fail('stop');
      const info = request.PathInfo ?? (request.Path == null ? null : { Path: request.Path });
      if (!info) throw Object.assign(new Error('Missing media path.'), { status: 400 });
      trace('add-path', { name: request.Name, info }); fail('add-path');
    },
    updateMediaPath: async (name, info) => trace('update-path', { name, info }),
    removeMediaPathAndRefresh: async (name, mediaPath) => { fail('stop'); trace('remove-path', { name, path: mediaPath }); fail('remove-path'); },
    updateLibraryOptions: async (key, options) => {
      trace('item', key);
      if (sample.missingItem) return false;
      const directory = path.join(views, 'Library'), current = await optionsStore.bind(key, directory);
      for (const info of options.PathInfos) {
        if (current.PathInfos.some(existing => existing.Path === info.Path)) continue;
        trace('shortcut', { directory, info }); fail('shortcut');
      }
      await optionsStore.save(directory, options); return true;
    },
  };
  if (sample.name.startsWith('rename')) {
    const physicalHost = new LibraryScanHost({ store: {}, library: { validateChildren: async (item, options) => trace('validate-physical', {
      id: item.Id, recursive: options.recursive, refreshChildMetadata: options.refreshChildMetadata, allowRemoveRoot: options.allowRemoveRoot, tokenCanCancel: !!options.signal }) },
      itemCreation: { withItem: async (key, operation) => { trace('item', key); return operation({ Id: key, IsFolder: key.endsWith('12') }); } },
      metadataScanner: { refreshLiveItem: async (item, options) => trace('refresh-physical', { id: item.Id, metadata: options.MetadataRefreshMode,
        image: options.ImageRefreshMode, automated: options.IsAutomated, force: options.ForceSave, tokenCanCancel: !!options.signal }) }, topLevelValidation: { supports: () => false } });
    let moves = 0;
    const configuration = new LibraryConfigurationService({ programDataPath: root, optionsStore, mediaAssets: {},
      host: { getUserRootFolder: async () => { trace('user-root'); return {}; }, withCachedChildren: async (_root, operation) => operation({ firstByPath: async () => sample.physicalRoot
        ? { Type: 'CollectionFolder', PhysicalFolderIds: [12, 13, 12].map(index => 'ca2000000000000000000' + String(index).padStart(11, '0')) } : null }),
        refreshPhysicalFolders: value => physicalHost.refreshPhysicalFolders(value), clearIgnoreRuleCache: async () => trace('clear-ignore') },
      lifecycle: { validateTopLibraryFolders: async options => trace('validate-top', options.removeRoot) },
      monitor: { stop: async () => { trace('stop'); fail('stop'); }, start: async () => trace('start') },
      queueLibraryScan: async () => trace('queue'), sleep: async milliseconds => trace('delay', milliseconds),
      fileSystem: { ...fs, rename: async (from, to) => {
        trace('move', { from, to }); let succeeded = false, error = null;
        try { fail('move'); if (++moves === 2) fail('move-second'); await fs.rename(from, to); succeeded = true; }
        catch (failure) { error = { name: failure.name, message: failure.message }; throw failure; }
        finally { moveAttempts.push({ from, to, succeeded, error, files: await snapshot(views) }); }
      } } });
    service.renameVirtualFolder = (...args) => configuration.renameVirtualFolder(...args);
    service.close = () => configuration.close(); t.after(() => configuration.close());
  }
  const application = await createApplication({ configuration: { IsStartupWizardCompleted: !sample.wizard }, authentication, libraryConfiguration: service });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => application.server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${application.server.address().port}${sample.path}`, {
    method: sample.method, headers: { Accept: sample.accept ?? 'application/json', ...(sample.body !== undefined && { 'Content-Type': sample.contentType ?? 'application/json' }) }, body: sample.body,
  });
  const body = await response.text(); let hasJson = false, jsonBody = null;
  try { jsonBody = JSON.parse(body); hasJson = true; } catch { }
  await service.close?.(); await optionsStore.close();
  const optionsRead = sample.path.startsWith('/Library/VirtualFolders/LibraryOptions')
    ? await coldOptions(root, path.join(views, 'Library')) : null;
  const actual = { name: sample.name, views, beforeFiles, status: response.status, contentType: response.headers.get('content-type'),
    allow: response.headers.get('allow') ?? '', body, hasJson, jsonBody, calls, events, savedOptions, optionsRead,
    injectedFailure, moveAttempts, files: await snapshot(views) };
  await captured.recordCandidate(actual);
  const expected = captured.projections[structureInput.cases.indexOf(sample)];
  assert.deepEqual(projectStructureObservation(actual, sample), expected);
});

test('library options XML is read by current Native and Node, continued by Native and reopened by Node', async () => {
  const captured = await currentLibraryStructure(), consumers = [], evidence = [];
  for (const native of captured.native.results) {
    const file = native.files.find(entry => entry.path === 'Library/options.xml');
    if (!file) continue;
    assert.equal(file.options.accepted, true, native.name);
    const nativeDirectory = path.join(native.views, 'Library');
    const nativeBytes = await fs.readFile(path.join(nativeDirectory, 'options.xml'));
    assert.equal(nativeBytes.toString('base64'), file.bytesBase64, native.name);
    const nodeReadsNative = await coldOptions(path.dirname(path.dirname(native.views)), nativeDirectory);
    assert.deepEqual(nodeReadsNative, file.options.value, native.name + ' Native XML to Node');
    assert.deepEqual(nodeReadsNative, native.optionsRead, native.name + ' Native public cold read');
    const candidate = captured.candidates.get(native.name); assert.ok(candidate, native.name);
    const candidateFile = candidate.files.find(entry => entry.path === 'Library/options.xml'); assert.ok(candidateFile, native.name);
    assert.equal(candidateFile.options.accepted, true, native.name);
    const directory = path.join(candidate.views, 'Library');
    assert.equal((await fs.readFile(path.join(directory, 'options.xml'))).toString('base64'), candidateFile.bytesBase64, native.name);
    consumers.push({ name: native.name, directory });
    evidence.push({ name: native.name, nodeReadsNative, nodeWritten: candidateFile.options.value, beforeBytes: candidateFile.bytesBase64 });
  }
  assert.ok(consumers.length > 0, 'Successful options HTTP requests produced real XML.');
  const returned = await captured.continueOptions(consumers);
  for (const row of returned.results) {
    const prior = evidence.find(entry => entry.name === row.name), candidate = captured.candidates.get(row.name);
    assert.equal(row.beforeBytes, prior.beforeBytes, row.name + ' current Native consumed exact Node-written file');
    assert.equal(row.read.accepted, true, row.name);
    assert.deepEqual(row.read.value, prior.nodeWritten, row.name + ' Native XML reader');
    assert.deepEqual(row.before, prior.nodeWritten, row.name + ' Native CollectionFolder reader');
    const expectedAfter = { ...prior.nodeWritten, ...structureInput.optionsContinuation };
    assert.deepEqual(row.after, expectedAfter, row.name + ' complete Native continuation');
    assert.deepEqual(row.events, [{ libraryPath: row.directory, options: expectedAfter }], row.name + ' public options event');
    const afterBytes = await fs.readFile(path.join(row.directory, 'options.xml'));
    assert.equal(afterBytes.toString('base64'), row.afterBytes, row.name);
    const reopened = await coldOptions(path.dirname(path.dirname(candidate.views)), row.directory);
    assert.deepEqual(reopened, row.after, row.name + ' fresh Node reads Native continuation');
    Object.assign(prior, { nativeBefore: row.before, nativeAfter: row.after, reopened, afterBytes: row.afterBytes });
  }
  await fs.writeFile(path.join(captured.output, 'options-exchange.json'), JSON.stringify({ actualNativeInstance: false, evidence }, null, 2) + '\n', { flag: 'wx' });
});
