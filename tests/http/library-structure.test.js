import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createApplication } from '../../src/http/application.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { LibraryConfigurationService } from '../../src/library/library-configuration-service.js';
import { LibraryScanHost } from '../../src/library/library-scan-host.js';
import { parseCollectionTypeOption } from '../../src/library/collection-type-options.js';
import { recordedInputPath } from '../../tools/validation/paths.js';

void JSON.parse(await fs.readFile(new URL('./fixtures/library-structure/required-inputs.json', import.meta.url)));
const fixture = new URL('./fixtures/library-structure/', import.meta.url);
const [inputBytes, nativeBytes, proofBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(name => fs.readFile(new URL(name, fixture))));
const input = JSON.parse(inputBytes), native = JSON.parse(nativeBytes), proof = JSON.parse(proofBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = 'ca200000000000000000000000000009';
const noTrace = value => Array.isArray(value) ? value.map(noTrace) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId').map(([key, value]) => [key, noTrace(value)])) : value;

test('library structure native recording binds actual MVC, policy, rename files and CollectionFolder options', async () => {
  assert.equal(hash(inputBytes), proof.inputSha256); assert.equal(hash(nativeBytes), proof.nativeSha256);
  assert.equal(hash(await fs.readFile(recordedInputPath(proof.rawRecording, [proof.nativeSha256]))), proof.nativeSha256);
  assert.equal(native.inputSha256, proof.inputSha256); assert.equal(proof.sourcesStable, true);
  for (const key of ['actualController','actualBinding','actualPermissionHandlers','actualRenameFiles','actualCollectionFolderOptions','principalControlled','managerControlled']) assert.equal(native[key], true);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0); assert.equal(proof.phaseAcceptance, false);
  for (const source of proof.sources) {
    assert.equal(hash(await fs.readFile(recordedInputPath(path.join('D:/jellyfin', source.filename), [source.sha256]))), source.sha256, source.filename);
    assert.equal(hash(await fs.readFile(recordedInputPath(path.join(proof.jellyfin.buildSource, source.filename), [source.sha256]))), source.sha256, source.filename);
  }
  for (const source of proof.oracleSources) assert.equal(hash(await fs.readFile(source.filename === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.filename, fixture))), source.sha256, source.filename);
  for (const assembly of proof.assemblies) assert.equal(hash(await fs.readFile(recordedInputPath(assembly.filename, [assembly.sha256]))), assembly.sha256, assembly.name);
  assert.deepEqual(native.results.map(row => row.name), input.cases.map(row => row.name));
});

test('public collection type parsing preserves native marker numeric values and excludes internal query types', () => {
  for (const row of native.markerTypes) assert.equal(parseCollectionTypeOption(row.text), row.value, row.text);
});

function normalize(value, views) {
  if (typeof value === 'string') {
    if (!value.includes('{views}') && (!views || !value.includes(views))) return value;
    const result = views ? value.replaceAll(views, '{views}') : value;
    return result.replace(/\{views\}[\\/][a-f0-9]{32}(?=$|[\\/])/gu, '{views}/temporary').replaceAll('\\', '/');
  }
  if (Array.isArray(value)) return value.map(entry => normalize(entry, views));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, views)]));
  return value;
}

for (const sample of input.cases) test('LibraryStructure native HTTP differential: ' + sample.name, async t => {
  const calls = [], identity = sample.identity ?? 'admin';
  const user = { Id: id, Policy: { IsAdministrator: identity === 'admin', EnableRemoteAccess: sample.remoteDenied !== true }, AccessSchedules: [] };
  const auth = { IsAuthenticated: identity !== 'anonymous', IsApiKey: identity === 'apiKey', IsAdministrator: ['admin','apiKey'].includes(identity),
    UserId: ['apiKey','empty'].includes(identity) ? '00000000000000000000000000000000' : id,
    User: ['apiKey','empty'].includes(identity) ? null : user };
  const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'structure-differential', isLocalNetwork: () => sample.remote !== true });
  authentication.authenticate = async () => auth;
  const trace = (action, value = null) => calls.push({ action, value });
  const fail = action => { if (sample.fail === action) throw new Error('Controlled ' + action + ' failure.'); };
  const types = ['movies','tvshows','music','musicvideos','homevideos','boxsets','books','mixed'];
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
      for (const info of options.PathInfos) { trace('shortcut', { directory: '{views}/Library', info }); fail('shortcut'); }
      if (options.PathInfos.includes(null)) throw new TypeError('Null media path.');
      trace('options-updated', options); return true;
    },
  };
  let views;
  if (sample.name.startsWith('rename')) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'structure-rename-')); views = path.join(root, 'root', 'default');
    for (const name of ['Library','Taken']) { await fs.mkdir(path.join(views, name), { recursive: true }); await fs.writeFile(path.join(views, name, 'movies.collection'), ''); }
    const physicalHost = new LibraryScanHost({ store: {}, library: { validateChildren: async (item, options) => trace('validate-physical', {
      id: item.Id, recursive: options.recursive, refreshChildMetadata: options.refreshChildMetadata, allowRemoveRoot: options.allowRemoveRoot, tokenCanCancel: !!options.signal }) },
      itemCreation: { withItem: async (key, operation) => { trace('item', key); return operation({ Id: key, IsFolder: key.endsWith('12') }); } },
      metadataScanner: { refreshLiveItem: async (item, options) => trace('refresh-physical', { id: item.Id, metadata: options.MetadataRefreshMode,
        image: options.ImageRefreshMode, automated: options.IsAutomated, force: options.ForceSave, tokenCanCancel: !!options.signal }) }, topLevelValidation: { supports: () => false } });
    let moves = 0;
    const configuration = new LibraryConfigurationService({ programDataPath: root, optionsStore: { clear: async () => {} }, mediaAssets: {},
      host: { getUserRootFolder: async () => { trace('user-root'); return {}; }, withCachedChildren: async (_root, operation) => operation({ firstByPath: async () => sample.physicalRoot
        ? { Type: 'CollectionFolder', PhysicalFolderIds: [12,13,12].map(index => 'ca2000000000000000000' + String(index).padStart(11, '0')) } : null }),
        refreshPhysicalFolders: value => physicalHost.refreshPhysicalFolders(value), clearIgnoreRuleCache: async () => trace('clear-ignore') },
      lifecycle: { validateTopLibraryFolders: async options => trace('validate-top', options.removeRoot) },
      monitor: { stop: async () => { trace('stop'); fail('stop'); }, start: async () => trace('start') },
      queueLibraryScan: async () => trace('queue'), sleep: async milliseconds => assert.equal(milliseconds, 1000),
      fileSystem: { ...fs, rename: async (from, to) => { trace('move', { from, to }); fail('move'); if (++moves === 2) fail('move-second'); await fs.rename(from, to); } } });
    service.renameVirtualFolder = (...args) => configuration.renameVirtualFolder(...args);
    service.close = () => configuration.close();
    t.after(async () => { await configuration.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('structure-rename-')); await fs.rm(root, { recursive: true, force: true }); });
  }
  const application = await createApplication({ configuration: { IsStartupWizardCompleted: !sample.wizard }, authentication, libraryConfiguration: service });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => application.server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${application.server.address().port}${sample.path}`, {
    method: sample.method, headers: { Accept: sample.accept ?? 'application/json', ...(sample.body !== undefined && { 'Content-Type': sample.contentType ?? 'application/json' }) }, body: sample.body,
  });
  const body = await response.text(), expected = native.results.find(row => row.name === sample.name);
  await service.close?.();
  assert.equal(response.status, expected.status); assert.equal(response.headers.get('content-type'), expected.contentType);
  assert.deepEqual((response.headers.get('allow') ?? '').split(',').map(value => value.trim()).sort(), expected.allow.split(',').map(value => value.trim()).sort());
  const nativeViews = path.join(path.dirname(proof.rawRecording), 'states', sample.name, 'root', 'default');
  const actualBody = expected.jsonBody != null ? noTrace(JSON.parse(body)) : body;
  const expectedBody = expected.jsonBody != null ? noTrace(expected.jsonBody) : expected.body;
  assert.deepEqual(normalize(actualBody, views ?? ''), normalize(expectedBody, nativeViews));
  const controlledPaths = sample.name.startsWith('path-');
  const expectedCalls = controlledPaths ? expected.calls.filter(row => !['stop','start','queue'].includes(row.action)) : expected.calls;
  assert.deepEqual(normalize(calls, views ?? ''), normalize(expectedCalls, nativeViews));
  if (views) {
    const moves = calls.filter(row => row.action === 'move');
    if (moves.length === 2) assert.equal(moves[1].value.from, moves[0].value.to);
    for (const move of calls.filter(row => row.action === 'move' && row.value.to !== path.join(views, 'Renamed') && row.value.to !== path.join(views, 'Library') && row.value.to !== path.join(views, 'library'))) {
      assert.equal(path.dirname(move.value.to), views); assert.match(path.basename(move.value.to), /^[a-f0-9]{32}$/u);
    }
    const files = (await fs.readdir(views, { recursive: true, withFileTypes: true })).filter(row => row.isFile()).map(row => path.relative(views, path.join(row.parentPath, row.name))).sort();
    assert.deepEqual(normalize(files.map(value => '{views}/' + value), views).sort(), normalize(expected.files.map(value => '{views}/' + value), nativeViews).sort());
  }
});
