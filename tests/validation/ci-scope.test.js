import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { applyInputIdentity, ciExecutionArguments, ciProfile, classify, provisionedServicesFor, restrictToRequested, skipGuards } from '../../tools/ci/scope.js';
import { captureInputIdentity, executionManifestContract, executionManifestReferences, inputsUnchanged } from '../../tools/validation/inputs.js';
import { designatedJellyfinRepository, verifyDesignatedJellyfinSourcePackage } from '../../tools/validation/designated-jellyfin-source.js';
import { repositoryRoot, validationPath } from '../../tools/validation/paths.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';

const ownPath = 'tests/validation/ci-scope.test.js';
const otherPath = 'tests/core/password.test.js';
const unrelatedPath = 'tests/core/composite-format.test.js';
const entry = (filename, overrides = {}) => ({ path: filename, test: true, imports: [], importedFiles: [],
  services: [], tools: [], declaredReferences: [], fixtureReferences: [], conditionalRegistration: false,
  unresolvedImports: [], unresolvedExecutables: [], ...overrides });
const relative = filename => path.relative(repositoryRoot, filename).replaceAll('\\', '/');
const description = filename => ({ filename, available: true, kind: 'file' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function extractOrdinaryZip(archiveFilename, prefix, destination) {
  const archive = await readFile(archiveFilename), end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  const entries = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const method = archive.readUInt16LE(cursor + 10), compressed = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28), extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32), local = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.ok(name.startsWith(prefix));
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const data = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const packed = archive.subarray(data, data + compressed);
    assert.ok(method === 0 || method === 8);
    const bytes = method === 8 ? inflateRawSync(packed) : packed;
    const relative = name.slice(prefix.length), filename = path.join(destination, ...relative.split('/'));
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, end);
}

test('CI full forwards the strict full profile and refuses every form of selection narrowing', () => {
  assert.equal(ciProfile({}), 'available');
  assert.equal(ciProfile({ MEDIAMANAGER_CI_PROFILE: 'full', MEDIAMANAGER_CI_TEST_FILES: ' ,\r\n ' }), 'full');
  assert.throws(() => ciProfile({ MEDIAMANAGER_CI_PROFILE: 'unknown' }), /CI profile/u);
  assert.throws(() => ciProfile({ MEDIAMANAGER_CI_PROFILE: 'full', MEDIAMANAGER_CI_TEST_FILES: ownPath }), /explicit test subset/u);
  const scope = { schemaVersion: 1, profile: 'full', selected: [ownPath, otherPath], discovered: [ownPath, otherPath], requested: [], excluded: [] };
  assert.deepEqual(ciExecutionArguments(scope, 'output'), ['--output', 'output', '--concurrency', '1', '--profile', 'full']);
  for (const narrowed of [
    { selected: [ownPath] }, { requested: [ownPath] }, { excluded: [{ path: otherPath }] },
    { selected: [ownPath, ownPath], discovered: [ownPath, ownPath] }
  ]) assert.throws(() => ciExecutionArguments({ ...scope, ...narrowed }, 'output'), /every discovered test/u);
  assert.deepEqual(ciExecutionArguments({ ...scope, profile: 'ci-available', selected: [ownPath] }, 'output'),
    ['--output', 'output', '--concurrency', '1', '--', ownPath]);
});

test('reviewed consumer records bind original source bytes and native runtime inputs without promoting ordinary DTO paths', () => {
  const consumer = executionManifestContract('tests/metadata/playlist-items.test.js');
  assert.equal(consumer.argument, 'playlist-layouts');
  assert.equal(executionManifestContract('tests/playback/http-native.test.js'), null, 'playback records its current reader oracle instead of executing the historical recording');
  assert.equal(executionManifestContract('tests/metadata/playlist-items.test.js').argument, 'playlist-layouts');
  assert.equal(executionManifestContract('tests/consumer-contracts/date-roundtrip.test.js').argument, 'date-roundtrip');
  assert.equal(executionManifestContract(ownPath), null, 'ordinary fixtures do not acquire an execution contract');
  const filename = path.join(repositoryRoot, consumer.manifest), sha256 = digest('sealed bytes');
  const source = 'D:/mediamanager-validation/consumer/input.json', record = 'D:/mediamanager-validation/consumer/record.json';
  const references = executionManifestReferences(consumer, {
    files: [{ filename: 'input.json', source, sha256 }], references: [{ filename: record, sha256 }],
    unusedHistory: { filename: 'D:/unread-history.json', sha256 }, Path: 'Z:\\Media\\movie.mkv',
  }, filename);
  assert.deepEqual(references, [{ filename: path.join(path.dirname(filename), 'input.json'), sha256 },
    { filename: source, sha256 }, { filename: record, sha256, nested: 'consumer-record' }]);
  const sourceFile = { filename: 'D:/jellyfin/Reader.cs', sha256 }, dotnet = { filename: 'D:/tools/dotnet.exe', sha256 };
  const jellyfinDll = { filename: 'D:/native/jellyfin.dll', sha256 }, oracleAssembly = { filename: 'D:/oracle/Oracle.dll', sha256 };
  const recordReferences = executionManifestReferences({ kind: 'consumer-record' }, {
    sourceFiles: [sourceFile], dotnet, jellyfinDll, oracleAssembly,
  }, record);
  assert.deepEqual(recordReferences, [{ ...sourceFile, sourceArchiveFallback: true }, dotnet, jellyfinDll, oracleAssembly]);
  assert.deepEqual(executionManifestReferences({ kind: 'consumer-native' }, { assemblies: [jellyfinDll, { name: 'no location' }] }, record), [jellyfinDll]);
});

test('shared reader manifests require only the called layout and retain ownership at the actual consumer', async () => {
  const consumer = 'tests/metadata/nfo-episode-blocks.test.js', sibling = 'tests/metadata/local-xml-provider.test.js';
  const contract = executionManifestContract(consumer), siblingContract = executionManifestContract(sibling);
  assert.equal(executionManifestContract('tests/metadata/local-xml-provider.test.js').argument, 'local-xml-provider');
  assert.equal(contract.manifest, siblingContract.manifest);
  const sha256 = digest('reader record'), filename = path.join(repositoryRoot, contract.manifest);
  const record = { kind: contract.argument, filename: 'D:\\recordings\\episode\\record.json', sha256 };
  const unrelated = { kind: siblingContract.argument, filename: 'D:\\recordings\\scalar\\record.json', sha256 };
  const files = [contract.argument, siblingContract.argument].flatMap(kind => ['input', 'native', 'comparison']
    .map(suffix => ({ filename: `${kind}-${suffix}.json`, sha256 })));
  const references = executionManifestReferences(contract, { records: [record, unrelated], files }, filename);
  assert.equal(references.length, 4);
  assert.deepEqual(references[0], { ...record, nested: 'reader-record' });
  assert.ok(references.slice(1).every(reference => path.basename(reference.filename).startsWith(contract.argument + '-')));
  assert.ok(!references.some(reference => reference.filename === unrelated.filename));
  const dependencies = { entries: [entry(consumer, { imports: [contract.loader] }), entry(sibling, { imports: [contract.loader] }),
    entry(contract.loader, { test: false })] };
  const classification = await classify({ dependencies, tracked: new Set(dependencies.entries.map(value => value.path)), environment: {} });
  const reason = `${consumer}:execution-manifest:${record.filename}`;
  assert.deepEqual(applyInputIdentity(classification, { entries: [{ filename: path.resolve(repositoryRoot, record.filename),
    required: true, available: false, reasons: [reason], requiredReasons: [reason] }] }, new Set()), []);
  assert.deepEqual(classification.records.map(value => [value.path, value.selected]), [[consumer, false], [sibling, true]],
    'sharing the loader must not promote an uncalled kind to required');
});

test('input capture binds the real consumer manifest without including unread history or DTO paths', async t => {
  const consumer = 'tests/metadata/playlist-items.test.js', contract = executionManifestContract(consumer);
  const output = path.join(repositoryRoot, '.test-output'); await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'ci-execution-inputs-'));
  t.after(async () => { assert.equal(path.dirname(root), output); await rm(root, { recursive: true, force: true }); });
  const history = path.join(root, 'unread-history.bin'), dtoPath = path.join(root, 'movie.mkv');
  const ordinary = path.join(root, 'ordinary.json');
  await writeFile(ordinary, JSON.stringify({ historical: { filename: history, sha256: digest('unread bytes') }, Path: dtoPath }));
  const dependencies = { entries: [entry(consumer, { imports: [contract.loader] }),
    entry(contract.loader, { test: false, fixtureReferences: [description(ordinary)] })] };
  const identity = await captureInputIdentity({ selected: [consumer], dependencies, environment: {},
    preflight: { ready: true, services: [], tools: [] } });
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, contract.manifest), 'utf8'));
  for (const file of manifest.files) {
    const original = identity.entries.find(input => input.filename === path.resolve(repositoryRoot, file.source));
    assert.ok(original?.required, 'the real loader directly reads each historical source');
    assert.ok(original.requiredReasons.length > 0 && original.requiredReasons.every(reason => reason.startsWith(consumer + ':')));
    assert.deepEqual(original.expectedDigests, [file.sha256]);
  }
  assert.ok(!identity.entries.some(input => input.filename === history), 'unread history is outside current release inputs');
  assert.ok(!identity.entries.some(input => input.filename === dtoPath));
  assert.ok(!identity.entries.some(input => input.required && input.filename.includes('20261012-r23-date-roundtrip')),
    'an uncalled kind in the shared loader stays outside required execution inputs');
});

test('by-name execution inputs distinguish full selected recordings from the files actually read in other kinds', () => {
  const contract = { kind: 'byname', manifest: 'tests/library/fixtures/native-byname-filter-inputs/binding.json' };
  const filename = path.join(repositoryRoot, contract.manifest), sha256 = digest('native file');
  const root = path.join(repositoryRoot, '.test-output', 'byname-recording');
  const recordings = ['genre', 'studio', 'album'].map(kind => ({ kind,
    repetitions: [1, 2].map(index => ({ filename: path.join(root, kind + index), entriesSha256: sha256 })),
    artifacts: ['reference-runtime-manifest.json', 'source-config-manifest.json', 'prepared-config-manifest.json', 'unused-http.json']
      .map(name => ({ path: name, sha256 })),
    configuration: { finalEntries: [{ path: 'nested', type: 'directory' }, { path: 'nested/config.xml', type: 'file', sha256 }] },
  }));
  const audit = { filename: path.join(root, 'audit.json'), sha256 };
  const references = executionManifestReferences(contract, { independentNativeAudit: audit, recordings }, filename);
  assert.deepEqual(references.filter(reference => reference.entriesSha256).map(reference => reference.filename),
    recordings.slice(0, 2).flatMap(recording => recording.repetitions.map(reference => reference.filename)));
  const albumRoot = recordings[2].repetitions[0].filename;
  assert.deepEqual(references.filter(reference => reference.filename.startsWith(albumRoot + path.sep)).map(reference => path.relative(albumRoot, reference.filename)),
    ['provenance.json', 'reference-runtime-manifest.json', 'source-config-manifest.json', 'prepared-config-manifest.json', path.join('reference/config', 'nested/config.xml')]);
  assert.ok(!references.some(reference => reference.filename.includes('album2') || reference.filename.endsWith('unused-http.json')));
  const sourceDatabase = { filename: 'D:/native/initial.db', sha256 }, runtimeDirectory = { filename: 'D:/native/runtime', entriesSha256: sha256 };
  assert.deepEqual(executionManifestReferences({ kind: 'identity' }, { reference: { sourceDatabase },
    preparationInputFiles: [audit], independentNativeAudits: [audit], runtimeDirectory, sdkDirectory: runtimeDirectory }, filename),
  [sourceDatabase, audit, audit, runtimeDirectory, runtimeDirectory]);
});

test('CI statically resolves platform and provisioned-service guards without executing unknown probes', () => {
  const source = `
    const postgres = process.env.MEDIAMANAGER_TEST_POSTGRES;
    const windowsOnly = { skip: process.platform !== 'win32' };
    const service = { skip: !postgres };
    const unknownProbe = { skip: probeAvailability() };
    const knownConjunction = { skip: unknownCondition && !postgres };
  `;
  for (const platform of ['win32', 'linux', 'darwin']) {
    const guards = skipGuards(source, { MEDIAMANAGER_TEST_POSTGRES: '<provisioned>' }, platform);
    assert.deepEqual(guards.map(guard => guard.status), [platform === 'win32' ? 'runs' : 'skips',
      'runs', 'runtime-check', 'runs']);
  }
});

test('CI selection retains provisioned dependencies when the current environment has no executable or service', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath, {
    services: ['postgres', 'dotnet'], tools: ['dotnet', 'ffmpeg', 'ffprobe', 'git'],
  })] }, tracked: new Set([ownPath]), environment: {} });
  assert.equal(classification.records[0].selected, true);
  const errors = applyInputIdentity(classification, { entries: [{ filename: path.join(repositoryRoot, 'node_modules'),
    required: true, available: false, reasons: ['runtime:node-modules'], requiredReasons: ['runtime:node-modules'] }] }, new Set());
  assert.deepEqual(errors.map(error => error.code), ['input-unavailable']);
  assert.equal(classification.records[0].selected, true, 'a provisioning failure must fail the attempt without narrowing its selection');
});

test('CI excludes only consumers of an explicitly unprovisioned service', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath, { services: ['jellyfinDll'] }), entry(otherPath)] },
    tracked: new Set([ownPath, otherPath]), environment: {} });
  assert.deepEqual(classification.records.map(record => [record.path, record.selected]), [[ownPath, false], [otherPath, true]]);
  assert.equal(classification.records[0].reasons[0].code, 'service-not-provisioned');
});

test('CI selects a configured WebDAV executable and leaves missing provisioned bytes as an infrastructure failure', async () => {
  const dependencies = { entries: [entry(ownPath, { services: ['webdav'] }), entry(otherPath)] };
  const tracked = new Set([ownPath, otherPath]);
  for (const value of [undefined, '', 'rclone']) {
    const environment = value === undefined ? {} : { MEDIAMANAGER_WEBDAV_EXECUTABLE: value };
    const classification = await classify({ dependencies, tracked, environment });
    assert.equal(classification.records[0].selected, false);
    assert.equal(classification.records[1].selected, true);
    assert.ok(!provisionedServicesFor(environment).includes('webdav'));
  }
  const filename = path.join(repositoryRoot, '.test-output', 'missing-rclone');
  const environment = { MEDIAMANAGER_WEBDAV_EXECUTABLE: filename };
  const classification = await classify({ dependencies, tracked, environment });
  assert.deepEqual(provisionedServicesFor(environment), ['postgres', 'dotnet', 'webdav']);
  assert.ok(classification.records.every(record => record.selected));
  const errors = applyInputIdentity(classification, { entries: [{ filename, required: true, available: false,
    reasons: ['service:webdav'], requiredReasons: ['service:webdav'] }] }, tracked);
  assert.deepEqual(errors.map(error => error.code), ['input-unavailable']);
  assert.ok(classification.records.every(record => record.selected), 'failed provisioning must not silently remove the WebDAV consumer');
});

test('CI native reference provisioning is an explicit promise independent of runtime file availability', async () => {
  const dependencies = { entries: [entry(ownPath, { services: ['jellyfinDll'] }), entry(otherPath)] };
  const tracked = new Set([ownPath, otherPath]);
  const disabled = await classify({ dependencies, tracked, environment: { MEDIAMANAGER_JELLYFIN_DLL: '/unverified/jellyfin.dll' } });
  assert.equal(disabled.records[0].selected, false, 'a DLL path alone must not enable the native service');
  assert.deepEqual(provisionedServicesFor({ MEDIAMANAGER_CI_NATIVE_REFERENCE: 'false' }), ['postgres', 'dotnet']);
  const environment = { MEDIAMANAGER_CI_NATIVE_REFERENCE: 'true' };
  const promised = await classify({ dependencies, tracked, environment });
  assert.ok(promised.records.every(record => record.selected), 'missing provisioning must not narrow selection');
  assert.deepEqual(provisionedServicesFor(environment), ['postgres', 'dotnet', 'jellyfinDll']);
  await assert.rejects(captureInputIdentity({ dependencies, selected: [ownPath], environment,
    preflight: { ready: true, services: [], tools: [] } }), /requires its build root, Jellyfin DLL and isolated \.NET root/u);
  assert.equal(promised.records[0].selected, true);
});

test('CI AList provisioning requires an explicit API-host promise and cannot narrow a failed exact request', async () => {
  const dependencies = { entries: [entry(ownPath, { services: ['alist'] }), entry(otherPath)] };
  const tracked = new Set([ownPath, otherPath]);
  const filename = path.join(repositoryRoot, '.test-output', 'missing-alist');
  const disabled = await classify({ dependencies, tracked, environment: { MEDIAMANAGER_ALIST_EXECUTABLE: filename } });
  assert.equal(disabled.records[0].selected, false, 'an arbitrary executable is not a designated source build');
  const environment = { MEDIAMANAGER_CI_ALIST_REFERENCE: 'true' };
  const promised = await classify({ dependencies, tracked, environment });
  assert.deepEqual(provisionedServicesFor(environment), ['postgres', 'dotnet', 'alist']);
  assert.ok(promised.records.every(record => record.selected));
  const errors = applyInputIdentity(promised, { entries: [{ filename, required: true, available: false,
    reasons: ['service:alist'], requiredReasons: ['service:alist'] }] }, tracked);
  assert.deepEqual(errors.map(error => error.code), ['input-unavailable']);
  assert.equal(promised.records[0].selected, true, 'failed AList supply stays an infrastructure error');
  await assert.rejects(captureInputIdentity({ dependencies, selected: [ownPath], environment,
    preflight: { ready: true, services: [], tools: [] } }), /requires its build root and executable path/u);
});

test('CI native instance supply is explicit, depends on the build and never supplies the historical SQLite fixture', async () => {
  const dependencies = { entries: [entry(ownPath, { services: ['nativeInstance'] }), entry(otherPath, { services: ['nativeSqlite'] })] };
  const tracked = new Set([ownPath, otherPath]);
  const disabled = await classify({ dependencies, tracked, environment: { MEDIAMANAGER_TEST_NATIVE_INSTANCE: '/arbitrary/instance' } });
  assert.ok(disabled.records.every(record => !record.selected));
  assert.throws(() => provisionedServicesFor({ MEDIAMANAGER_CI_NATIVE_INSTANCE: 'true' }), /requires native reference/u);
  const environment = { MEDIAMANAGER_CI_NATIVE_REFERENCE: 'true', MEDIAMANAGER_CI_NATIVE_INSTANCE: 'true' };
  assert.deepEqual(provisionedServicesFor(environment), ['postgres', 'dotnet', 'jellyfinDll', 'nativeInstance']);
  const promised = await classify({ dependencies, tracked, environment });
  assert.equal(promised.records[0].selected, true, 'an unavailable promised instance must fail provisioning instead of shrinking selection');
  assert.equal(promised.records[1].selected, false, 'fresh generated instances cannot replace historical query SQLite pins');
  await assert.rejects(captureInputIdentity({ dependencies, selected: [ownPath], environment,
    preflight: { ready: true, services: [], tools: [] } }), /requires its build root, Jellyfin DLL and isolated \.NET root/u);
  assert.equal(promised.records[0].selected, true);
});

test('CI current SQLite supply requires an instance and leaves historical SQLite unavailable', async () => {
  const dependencies = { entries: [entry(ownPath, { services: ['currentNativeSqlite'] }), entry(otherPath, { services: ['nativeSqlite'] })] };
  const tracked = new Set([ownPath, otherPath]);
  assert.throws(() => provisionedServicesFor({ MEDIAMANAGER_CI_NATIVE_SQLITE: 'true' }), /requires native instance/u);
  assert.throws(() => provisionedServicesFor({ MEDIAMANAGER_CI_NATIVE_SQLITE: 'true', MEDIAMANAGER_CI_NATIVE_INSTANCE: 'true' }), /requires native reference/u);
  const disabled = await classify({ dependencies, tracked, environment: { MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE: '/arbitrary/input.db' } });
  assert.ok(disabled.records.every(record => !record.selected));
  const environment = { MEDIAMANAGER_CI_NATIVE_REFERENCE: 'true', MEDIAMANAGER_CI_NATIVE_INSTANCE: 'true', MEDIAMANAGER_CI_NATIVE_SQLITE: 'true' };
  assert.equal(validationPath('.agent-docs/evidence/core-flow-20260926/initial.db', repositoryRoot,
    { ...environment, MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE: '/current/input.db' }),
  path.resolve(repositoryRoot, '.agent-docs/evidence/core-flow-20260926/initial.db'), 'the current input must not remap a historical recording path');
  const promised = await classify({ dependencies, tracked, environment });
  assert.equal(promised.records[0].selected, true);
  assert.equal(promised.records[1].selected, false, 'a new input cannot stand in for a historical database binding');
  assert.deepEqual(provisionedServicesFor(environment), ['postgres', 'dotnet', 'jellyfinDll', 'nativeInstance', 'currentNativeSqlite']);
  const filename = path.join(repositoryRoot, '.test-output', 'missing-current-native.db');
  const errors = applyInputIdentity(promised, { entries: [{ filename, required: true, available: false,
    reasons: ['service:currentNativeSqlite'], requiredReasons: ['service:currentNativeSqlite'] }] }, tracked);
  assert.equal(errors[0].code, 'input-unavailable');
  assert.equal(promised.records[0].selected, true, 'failed promised supply remains an infrastructure error');
  await assert.rejects(captureInputIdentity({ dependencies, selected: [ownPath], environment,
    preflight: { ready: true, services: [], tools: [] } }), /requires its build root, Jellyfin DLL and isolated \.NET root/u);
});

test('CI Web consumers require explicit browser and client supply without hiding missing inputs', async () => {
  const dependencies = { entries: [entry(ownPath, { services: ['jellyfinWeb', 'browser'] }), entry(otherPath)] };
  const tracked = new Set([ownPath, otherPath]);
  assert.throws(() => provisionedServicesFor({ MEDIAMANAGER_CI_WEB_CLIENTS: 'true' }), /requires current native SQLite/u);
  const disabled = await classify({ dependencies, tracked, environment: {
    MEDIAMANAGER_JELLYFIN_WEB_ROOT: '/arbitrary/web', MEDIAMANAGER_BROWSER_EXECUTABLE: '/arbitrary/chromium',
  } });
  assert.equal(disabled.records[0].selected, false);
  const environment = { MEDIAMANAGER_CI_NATIVE_REFERENCE: 'true', MEDIAMANAGER_CI_NATIVE_INSTANCE: 'true',
    MEDIAMANAGER_CI_NATIVE_SQLITE: 'true', MEDIAMANAGER_CI_WEB_CLIENTS: 'true' };
  const promised = await classify({ dependencies, tracked, environment });
  assert.ok(promised.records.every(record => record.selected));
  const filename = path.join(repositoryRoot, '.test-output', 'missing-browser');
  const errors = applyInputIdentity(promised, { entries: [{ filename, required: true, available: false,
    reasons: ['service:browser'], requiredReasons: ['service:browser'] }] }, tracked);
  assert.equal(errors[0].code, 'input-unavailable');
  assert.equal(promised.records[0].selected, true);
  await assert.rejects(captureInputIdentity({ dependencies, selected: [ownPath], environment,
    preflight: { ready: true, services: [], tools: [] } }), /requires an explicit same-run build root and runtime/u);
});

test('CI hosted Emby supply selects its own consumer and retains missing-input failures', async () => {
  const dependencies = { entries: [entry(ownPath, { services: ['embyWeb', 'browser'] }),
    entry(otherPath, { services: ['jellyfinWeb', 'browser'] })] };
  const tracked = new Set([ownPath, otherPath]);
  assert.throws(() => provisionedServicesFor({ MEDIAMANAGER_CI_EMBY_WEB: 'true' }), /requires current native SQLite/u);
  const environment = { MEDIAMANAGER_CI_NATIVE_REFERENCE: 'true', MEDIAMANAGER_CI_NATIVE_INSTANCE: 'true',
    MEDIAMANAGER_CI_NATIVE_SQLITE: 'true', MEDIAMANAGER_CI_EMBY_WEB: 'true' };
  const promised = await classify({ dependencies, tracked, environment });
  assert.equal(promised.records.find(record => record.path === ownPath).selected, true);
  assert.equal(promised.records.find(record => record.path === otherPath).selected, false);
  const filename = path.join(repositoryRoot, '.test-output', 'missing-emby-web');
  const errors = applyInputIdentity(promised, { entries: [{ filename, required: true, available: false,
    reasons: ['service:embyWeb'], requiredReasons: ['service:embyWeb'] }] }, tracked);
  assert.equal(errors[0].code, 'input-unavailable');
  assert.equal(promised.records.find(record => record.path === ownPath).selected, true);
  await assert.rejects(captureInputIdentity({ dependencies, selected: [ownPath], environment,
    preflight: { ready: true, services: [], tools: [] } }), /Emby Web requires its same-run input root/u);
});

test('CI binds same-run native receipts, source offer and runtime only for selected native consumers', async t => {
  const output = path.join(repositoryRoot, '.test-output'); await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'ci-native-inputs-'));
  t.after(async () => { assert.ok(root.startsWith(output + path.sep)); await rm(root, { recursive: true, force: true }); });
  for (const directory of ['runtime', 'receipts', 'source-offer', 'source', 'sdk', 'nuget-packages']) await mkdir(path.join(root, directory));
  const write = async (directory, filename, bytes) => {
    const target = path.join(root, directory, filename);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return { path: filename, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) };
  };
  const designated = await verifyDesignatedJellyfinSourcePackage();
  const sourceRoot = path.join(root, 'source');
  await extractOrdinaryZip(designated.attachments.archive.filename, designated.package.prefix, sourceRoot);
  const runtimeFiles = [await write('runtime', 'jellyfin.dll', 'new same-run assembly'),
    await write('runtime', 'MediaBrowser.Providers.dll', 'new same-run dependency')];
  const runtimeManifestText = files => JSON.stringify({ files });
  const runtimeManifest = await write('receipts', 'runtime-manifest.json', runtimeManifestText(runtimeFiles));
  const snapshot = JSON.stringify({ files: designated.manifest.files.map(file => ({ path: file.path, bytes: file.size,
    sha256: file.sha256, matches: true })), allMatched: true });
  const sourceBefore = await write('receipts', 'source-before.json', snapshot);
  const sourceAfter = await write('receipts', 'source-after.json', snapshot);
  const runnerOs = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[process.platform];
  const matrixOs = { win32: 'windows-2025', linux: 'ubuntu-24.04', darwin: 'macos-15' }[process.platform];
  const architecture = process.arch === 'arm64' ? 'ARM64' : 'X64';
  const dotnetName = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
  const sdkFiles = [await write('sdk', dotnetName, 'controlled dotnet executable'),
    await write('sdk', 'LICENSE.txt', 'controlled SDK license')].sort((left, right) => left.path.localeCompare(right.path));
  const nugetFiles = [await write('nuget-packages', 'controlled-package.1.0.0.nupkg', 'controlled NuGet package'),
    await write('nuget-packages', 'controlled-package.1.0.0.nupkg.sha512', 'controlled NuGet digest')]
    .sort((left, right) => left.path.localeCompare(right.path));
  const tree = (directory, kind, files) => JSON.stringify({ schemaVersion: 1, root: path.join(root, directory), kind,
    scope: 'same-run-byte-identity-only', files });
  const sdkTree = tree('sdk', 'dotnet-sdk', sdkFiles), nugetTree = tree('nuget-packages', 'nuget-packages', nugetFiles);
  const sdkBefore = await write('receipts', 'sdk-before.json', sdkTree);
  const sdkAfter = await write('receipts', 'sdk-after.json', sdkTree);
  const nugetBeforeBuild = await write('receipts', 'nuget-before-build.json', nugetTree);
  const nugetAfterBuild = await write('receipts', 'nuget-after-build.json', nugetTree);
  const nugetRoot = path.join(root, 'nuget-packages');
  const nugetConfig = path.join(sourceRoot, 'nuget.config');
  const configSource = designated.manifest.files.find(file => file.path === 'nuget.config');
  assert.ok(configSource);
  const sourceOffer = [];
  for (const descriptor of designated.sourceOffer) {
    const attachment = Object.values(designated.attachments).find(value => value.descriptor.path === descriptor.path);
    const copied = await write('source-offer', descriptor.path, await readFile(attachment.filename));
    assert.deepEqual(copied, descriptor);
  }
  sourceOffer.push(...designated.sourceOffer);
  const dotnet = path.join(root, 'sdk', dotnetName);
  const commandOutput = {
    versionOut: await write('receipts', 'sdk-version.stdout.txt', '10.0.401\n'),
    versionError: await write('receipts', 'sdk-version.stderr.txt', ''),
    infoOut: await write('receipts', 'sdk-info.stdout.txt', '.NET SDK 10.0.401'),
    infoError: await write('receipts', 'sdk-info.stderr.txt', ''),
    restoreOut: await write('receipts', 'restore.stdout.txt', 'successful restore log'),
    restoreError: await write('receipts', 'restore.stderr.txt', ''),
    buildOut: await write('receipts', 'build.stdout.txt', 'successful build log'),
    buildError: await write('receipts', 'build.stderr.txt', ''),
  };
  const command = (arguments_, stdout, stderr, start, finish) => ({ executable: dotnet, arguments: arguments_,
    cwd: path.join(root, 'source'), started: `2026-10-23T00:00:0${start}.000Z`, finished: `2026-10-23T00:00:0${finish}.000Z`,
    exitCode: 0, stdout, stderr });
  const commands = [command(['--version'], commandOutput.versionOut, commandOutput.versionError, 1, 2),
    command(['--info'], commandOutput.infoOut, commandOutput.infoError, 2, 3),
    command(['restore', 'Jellyfin.Server/Jellyfin.Server.csproj', '--packages', nugetRoot,
      '--configfile', nugetConfig, '-p:RestoreFallbackFolders=', '-p:RestoreAdditionalProjectFallbackFolders=',
      '--nologo', '--verbosity', 'minimal'],
      commandOutput.restoreOut, commandOutput.restoreError, 3, 4),
    command(['build', 'Jellyfin.Server/Jellyfin.Server.csproj', '--configuration', 'Release', '--framework', 'net10.0',
      '--no-restore', '--output', path.join(root, 'runtime'), '--nologo', '--verbosity', 'minimal'],
      commandOutput.buildOut, commandOutput.buildError, 4, 5)];
  const receipt = { schemaVersion: 2, status: 'succeeded', repository: designatedJellyfinRepository,
    commit: 'a'.repeat(40), runId: '123', runAttempt: '1', started: '2026-10-23T00:00:00.000Z',
    finished: '2026-10-23T00:00:06.000Z', sdkExpected: '10.0.401', sdkActual: '10.0.401',
    producer: { eventName: 'workflow_dispatch', workflow: 'Cross-platform validation',
      workflowRef: `${designatedJellyfinRepository}/.github/workflows/ci.yml@refs/heads/main`,
      workflowSha: 'b'.repeat(40), job: 'validate', ref: 'refs/heads/main' },
    runner: { os: runnerOs, architecture, matrixOs, shard: '1', shards: '1' },
    checkout: { head: 'a'.repeat(40), tree: 'c'.repeat(40) },
    testsExecuted: false, oracleRecordingsProduced: false, historicalBinaryReplacement: false,
    evidenceScope: { sameRunByteVerification: true, offlineReplaySelfContained: false,
      omittedOfflinePayloads: ['dotnet-sdk-tree', 'nuget-packages-tree'],
      statement: 'SDK and NuGet manifests are verified against live same-run roots; manifests without those omitted byte trees are not an offline replay supply.' },
    source: { archive: designated.attachments.archive.descriptor, manifest: designated.attachments.sourceManifest.descriptor,
      head: designated.package.head, contentDigest: designated.package.sourceContentDigest, files: designated.package.sourceFiles },
    restoreIsolation: { packagesRoot: nugetRoot,
      config: { path: 'nuget.config', bytes: configSource.size, sha256: configSource.sha256 },
      fallbackEnvironmentAbsent: true, restoreFallbackFolders: '', restoreAdditionalProjectFallbackFolders: '' },
    sourceUnchanged: true, sdkUnchanged: true, nugetUnchangedDuringBuild: true, sourceBefore, sourceAfter,
    sdkBefore, sdkAfter, nugetBeforeBuild, nugetAfterBuild, runtimeManifest, sourceOffer, commands };
  await write('receipts', 'build-receipt.json', JSON.stringify(receipt));
  const environment = { MEDIAMANAGER_CI_NATIVE_REFERENCE: 'true', MEDIAMANAGER_NATIVE_BUILD_ROOT: root,
    MEDIAMANAGER_JELLYFIN_DLL: path.join(root, 'runtime/jellyfin.dll'), MEDIAMANAGER_DOTNET: dotnet,
    MEDIAMANAGER_CI_DOTNET_ROOT: path.join(root, 'sdk'), MEDIAMANAGER_CI_MATRIX_OS: matrixOs,
    MEDIAMANAGER_CI_SHARD: '1', MEDIAMANAGER_CI_SHARDS: '1', MEDIAMANAGER_CHECKOUT_HEAD: receipt.checkout.head,
    MEDIAMANAGER_CHECKOUT_TREE: receipt.checkout.tree, RUNNER_OS: runnerOs, RUNNER_ARCH: architecture,
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: designatedJellyfinRepository, GITHUB_SHA: receipt.commit,
    GITHUB_RUN_ID: receipt.runId, GITHUB_RUN_ATTEMPT: receipt.runAttempt, GITHUB_EVENT_NAME: receipt.producer.eventName,
    GITHUB_WORKFLOW: receipt.producer.workflow, GITHUB_WORKFLOW_REF: receipt.producer.workflowRef,
    GITHUB_WORKFLOW_SHA: receipt.producer.workflowSha, GITHUB_JOB: receipt.producer.job, GITHUB_REF: receipt.producer.ref };
  const dependencies = { entries: [entry(ownPath, { services: ['jellyfinDll'] }), entry(otherPath)] };
  const capture = (selected, overrides = {}) => captureInputIdentity({ dependencies, selected, environment: { ...environment, ...overrides },
    preflight: { ready: true, services: [], tools: [] } });
  const nativeInputs = identity => identity.entries.filter(input => input.requiredReasons.some(reason => reason.startsWith('runtime:native-reference')));
  assert.equal(nativeInputs(await capture([otherPath])).length, 0, 'unselected native consumers do not require native artifacts');
  const classification = await classify({ dependencies, tracked: new Set([ownPath, otherPath]), environment });
  const before = await capture([ownPath]), bound = nativeInputs(before);
  assert.match((await verifyNativeBuild(environment)).identitySha256, /^[a-f0-9]{64}$/u);
  const sourceMember = designated.manifest.files[0], sourceFilename = path.join(sourceRoot, ...sourceMember.path.split('/'));
  const sourceBytes = await readFile(sourceFilename); await writeFile(sourceFilename, 'changed sealed source bytes');
  await assert.rejects(verifyNativeBuild(environment), /source live byte tree differs/u);
  await writeFile(sourceFilename, sourceBytes);
  await write('sdk', 'LICENSE.txt', 'changed SDK bytes');
  await assert.rejects(verifyNativeBuild(environment), /SDK live byte tree differs/u);
  await write('sdk', 'LICENSE.txt', 'controlled SDK license');
  await write('nuget-packages', 'controlled-package.1.0.0.nupkg', 'changed NuGet bytes');
  await assert.rejects(verifyNativeBuild(environment), /NuGet live byte tree differs/u);
  await write('nuget-packages', 'controlled-package.1.0.0.nupkg', 'controlled NuGet package');
  await write('runtime', 'unlisted.dll', 'an unlisted runtime member');
  await assert.rejects(verifyNativeBuild(environment), /membership differs/u);
  await rm(path.join(root, 'runtime/unlisted.dll'));
  await assert.rejects(verifyNativeBuild({ ...environment, NUGET_FALLBACK_PACKAGES: path.join(root, 'fallback') }),
    /restore isolation/u);
  assert.ok(bound.every(input => input.required && input.available && input.expectedDigestMatched !== false));
  for (const directory of ['runtime', 'receipts', 'source-offer', 'sdk', 'nuget-packages']) {
    assert.ok(bound.some(input => input.filename === path.join(root, directory) && input.kind === 'directory'));
  }
  assert.deepEqual(applyInputIdentity(classification, { entries: bound }, new Set()), [], 'same-run build inputs need no Git tracked-file exemption');
  await write('receipts', 'build-receipt.json', JSON.stringify({ ...receipt,
    source: { ...receipt.source, head: '0'.repeat(40) } }));
  await assert.rejects(capture([ownPath]), /does not identify the designated Jellyfin source/u);
  await write('receipts', 'build-receipt.json', JSON.stringify({ ...receipt,
    sourceOffer: [...receipt.sourceOffer.slice(0, 3), receipt.sourceOffer[0]] }));
  await assert.rejects(capture([ownPath]), /source offer is incomplete/u);
  await write('receipts', 'build-receipt.json', JSON.stringify({ ...receipt,
    restoreIsolation: { ...receipt.restoreIsolation, config: { ...receipt.restoreIsolation.config, sha256: '0'.repeat(64) } } }));
  await assert.rejects(capture([ownPath]), /restore isolation/u);
  await write('receipts', 'build-receipt.json', JSON.stringify({ ...receipt,
    commands: receipt.commands.map((value, index) => index === 2 ? { ...value, exitCode: 1 } : value) }));
  await assert.rejects(capture([ownPath]), /command evidence differs/u);
  await write('receipts', 'build-receipt.json', JSON.stringify({ ...receipt,
    commands: receipt.commands.map((value, index) => index === 3
      ? { ...value, arguments: value.arguments.filter(argument => argument !== '--no-restore') } : value) }));
  await assert.rejects(capture([ownPath]), /command evidence differs/u);
  await write('receipts', 'build-receipt.json', JSON.stringify({ ...receipt,
    evidenceScope: { ...receipt.evidenceScope, offlineReplaySelfContained: true } }));
  await assert.rejects(capture([ownPath]), /complete same-run byte closure/u);
  await write('receipts', 'build-receipt.json', JSON.stringify(receipt));
  await assert.rejects(capture([ownPath], { GITHUB_REPOSITORY: 'other/example' }), /workflow run: repository/u);
  await assert.rejects(capture([ownPath], { GITHUB_RUN_ID: 'different-run' }), /workflow run: runId/u);
  await assert.rejects(capture([ownPath], { GITHUB_JOB: 'build' }), /producer workflow/u);
  await assert.rejects(capture([ownPath], { GITHUB_WORKFLOW: 'Different workflow' }), /producer workflow/u);
  await assert.rejects(capture([ownPath], { MEDIAMANAGER_CHECKOUT_TREE: 'd'.repeat(40) }), /checkout HEAD and tree/u);
  await assert.rejects(capture([ownPath], { MEDIAMANAGER_CI_MATRIX_OS: matrixOs === 'windows-2025' ? 'ubuntu-24.04' : 'windows-2025' }), /runner platform/u);
  const mismatchedSnapshot = JSON.stringify({ ...JSON.parse(snapshot), files: designated.manifest.files.map((file, index) => ({
    path: file.path, bytes: file.size, sha256: index === 0 ? '0'.repeat(64) : file.sha256, matches: true,
  })) });
  const mismatchedBefore = await write('receipts', 'source-before.json', mismatchedSnapshot);
  const mismatchedAfter = await write('receipts', 'source-after.json', mismatchedSnapshot);
  await write('receipts', 'build-receipt.json', JSON.stringify({ ...receipt, sourceBefore: mismatchedBefore, sourceAfter: mismatchedAfter }));
  await assert.rejects(capture([ownPath]), /snapshot does not match/u);
  await write('receipts', 'source-before.json', snapshot); await write('receipts', 'source-after.json', snapshot);
  await write('receipts', 'build-receipt.json', JSON.stringify(receipt));
  await write('runtime', 'MediaBrowser.Providers.dll', 'changed runtime dependency');
  await write('receipts', 'build.stdout.txt', 'changed build log');
  await write('source-offer', designated.attachments.archive.descriptor.path, 'changed source offer');
  const changed = await capture([ownPath]);
  await assert.rejects(verifyNativeBuild(environment), /input is missing or changed/u);
  assert.equal(inputsUnchanged(before, changed), false);
  for (const directory of ['runtime', 'receipts', 'source-offer']) {
    const filename = path.join(root, directory);
    assert.notEqual(changed.entries.find(input => input.filename === filename).entriesSha256,
      before.entries.find(input => input.filename === filename).entriesSha256);
  }
  assert.ok(applyInputIdentity(classification, { entries: nativeInputs(changed) }, new Set()).some(error => error.code === 'input-digest-mismatch'));
  assert.equal(classification.records[0].selected, true, 'corrupt build inputs fail the attempt without removing their consumer');
  await rm(path.join(root, 'receipts/build-receipt.json'));
  const missing = await capture([ownPath]);
  assert.ok(applyInputIdentity(classification, { entries: nativeInputs(missing) }, new Set()).some(error => error.code === 'input-unavailable'));
  assert.equal(classification.records[0].selected, true);
  await write('receipts', 'build-receipt.json', JSON.stringify({ ...receipt, sourceUnchanged: false }));
  await assert.rejects(capture([ownPath]), /complete same-run byte closure/u);
  await assert.rejects(capture([ownPath], { MEDIAMANAGER_JELLYFIN_DLL: path.join(root, 'unverified.dll') }), /same-run runtime/u);
});

test('both native producers immediately verify the dependency-free restore and no-restore byte closure', async () => {
  const [ci, dedicated, producer, verifier] = await Promise.all([
    readFile(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/native-build.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'tools/ci/build-native.ps1'), 'utf8'),
    readFile(path.join(repositoryRoot, 'tools/validation/native-build-inputs.js'), 'utf8'),
  ]);
  for (const workflow of [ci, dedicated]) {
    const build = workflow.indexOf('./tools/ci/build-native.ps1');
    const verify = workflow.indexOf('await verifyNativeBuild();', build);
    const nextStep = workflow.indexOf('\n      - name:', build + 1);
    assert.ok(build >= 0 && verify > build && (nextStep < 0 || verify < nextStep),
      'receipt verification must run in the native build step before another action can consume its output');
    assert.match(workflow, /MEDIAMANAGER_CHECKOUT_HEAD/u);
    assert.match(workflow, /MEDIAMANAGER_CHECKOUT_TREE/u);
  }
  const sdkBefore = producer.indexOf("Write-Record 'sdk-before.json'");
  const restore = producer.indexOf("Invoke-Dotnet 'restore'");
  const nugetBefore = producer.indexOf("Write-Record 'nuget-before-build.json'");
  const build = producer.indexOf("Invoke-Dotnet 'build'");
  const nugetAfter = producer.indexOf("Write-Record 'nuget-after-build.json'");
  const sdkAfter = producer.indexOf("Write-Record 'sdk-after.json'");
  assert.ok(sdkBefore >= 0 && sdkBefore < restore && restore < nugetBefore && nugetBefore < build
    && build < nugetAfter && nugetAfter < sdkAfter);
  assert.match(producer, /Remove-Item Env:NUGET_FALLBACK_PACKAGES/u);
  assert.match(producer, /'--configfile', \$nugetConfig/u);
  assert.match(producer, /'-p:RestoreFallbackFolders='/u);
  assert.match(producer, /'--no-restore'/u);
  assert.match(producer, /'--output', \$runtime/u);
  assert.match(producer, /offlineReplaySelfContained = \$false/u);
  assert.doesNotMatch(verifier, /from ['"]\.\/inventory\.js['"]/u,
    'the pre-install verifier must not load inventory.js or its acorn development dependency');
});

test('CI attributes a recursive required input to every required consumer while preserving an optional consumer of that same file', async t => {
  const output = path.join(repositoryRoot, '.test-output');
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'ci-scope-'));
  t.after(async () => {
    assert.ok(root.startsWith(output + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const child = path.join(root, 'shared'), sibling = path.join(root, 'unrelated');
  await mkdir(child); await mkdir(sibling);
  const missing = path.join(root, 'unavailable-native.dll');
  const recursive = path.join(child, 'recursive.json');
  const recursiveBytes = JSON.stringify({ dependency: { filename: missing, sha256: '0'.repeat(64), required: true } });
  await writeFile(recursive, recursiveBytes);
  const manifest = path.join(root, 'provenance.json');
  await writeFile(manifest, JSON.stringify({ dependency: { filename: recursive, sha256: digest(recursiveBytes), required: true } }));
  const independent = path.join(sibling, 'native.json');
  await writeFile(independent, JSON.stringify({ dependency: { filename: missing, sha256: '0'.repeat(64), required: false } }));
  const dependencies = { entries: [entry(ownPath, { fixtureReferences: [description(manifest)] }),
    entry(otherPath, { fixtureReferences: [description(recursive)] }),
    entry(unrelatedPath, { fixtureReferences: [description(independent)] })] };
  const selected = dependencies.entries.map(value => value.path);
  const tracked = new Set([...selected, ...[manifest, recursive, independent].map(relative)]);
  const classification = await classify({ dependencies, tracked, environment: {} });
  assert.ok(classification.records.every(record => record.selected));
  const identity = await captureInputIdentity({ dependencies, selected, environment: {},
    preflight: { ready: true, services: [], tools: [] } });
  assert.equal(identity.schemaVersion, 3);
  const absent = identity.entries.find(input => input.filename === missing);
  assert.ok(absent?.required);
  for (const consumer of [ownPath, otherPath]) {
    assert.ok(absent.requiredReasons.some(reason => reason.startsWith(consumer + ':')), `recursive required ownership retained for ${consumer}`);
  }
  assert.ok(!absent.reasons.some(reason => reason.startsWith(unrelatedPath + ':')), 'optional history is outside current release inputs');
  assert.ok(!absent.requiredReasons.some(reason => reason.startsWith(unrelatedPath + ':')), 'an unrelated requirement must not promote optional ownership');
  assert.deepEqual(applyInputIdentity(classification, { entries: [absent] }, tracked), []);
  assert.deepEqual(classification.records.map(record => record.selected), [false, false, true]);
});

test('CI binds direct source JSON reads without inheriting unrelated sibling provenance', async () => {
  const resources = path.join(repositoryRoot, 'src', 'http', 'resources');
  const schema = path.join(resources, 'item-update-schema.json');
  const mimeManifest = path.join(resources, 'mime-types-provenance.json');
  const capture = filename => captureInputIdentity({ selected: [ownPath],
    dependencies: { entries: [entry(ownPath, { fixtureReferences: [description(filename)] })] },
    preflight: { ready: true, services: [], tools: [] }, environment: {} });
  const resource = await capture(schema);
  assert.ok(resource.entries.some(value => value.filename === schema && value.required));
  assert.equal(resource.entries.some(value => value.filename === mimeManifest), false);
  assert.equal(resource.entries.some(value => value.requiredReasons?.some(reason => reason.includes(':manifest-reference:'))), false);
  const explicit = await capture(mimeManifest);
  assert.ok(explicit.entries.some(value => value.filename === mimeManifest && value.required));
  assert.ok(explicit.entries.some(value => value.requiredReasons?.some(reason => reason.includes(':manifest-reference:'))),
    'explicitly reading a source manifest must still bind its required source and executable descriptors');
});

test('CI refuses a required digest mismatch without removing the failing consumer from the frozen scope', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath), entry(otherPath)] },
    tracked: new Set([ownPath, otherPath]), environment: {} });
  const filename = path.join(repositoryRoot, 'tests', 'fixtures', 'recording.json');
  const errors = applyInputIdentity(classification, { entries: [{ filename, kind: 'file', available: true,
    required: true, expectedDigestMatched: false, reasons: [ownPath + ':manifest-reference:recording'],
    requiredReasons: [ownPath + ':manifest-reference:recording'] }] },
  new Set(['tests/fixtures/recording.json']));
  assert.deepEqual(errors.map(error => error.code), ['input-digest-mismatch']);
  assert.ok(classification.records.every(record => record.selected));
  const malformed = applyInputIdentity(classification, { entries: [{ filename, available: false,
    required: true, invalidExpectedDigest: true, reasons: [ownPath + ':manifest-reference:recording'],
    requiredReasons: [ownPath + ':manifest-reference:recording'] }] }, new Set());
  assert.deepEqual(malformed.map(error => error.code), ['input-digest-mismatch'], 'a malformed required pin cannot become an unavailable-input exclusion');
  assert.ok(classification.records.every(record => record.selected));
});

test('CI treats unprovided external historical paths as not shipped regardless of incidental runner bytes', async () => {
  const filename = path.resolve(repositoryRoot, '..', 'unprovided-historical-tools', 'node.exe');
  const owner = ownPath + ':manifest-reference:' + filename, optional = otherPath + ':manifest-reference:' + filename;
  for (const state of [
    { available: true, expectedDigestMatched: false },
    { available: false, expectedDigestMatched: false },
    { available: true, expectedDigestMatched: true },
  ]) {
    const classification = await classify({ dependencies: { entries: [entry(ownPath), entry(otherPath)] },
      tracked: new Set([ownPath, otherPath]), environment: {} });
    const input = { filename, kind: 'file', required: true, reasons: [owner, optional], requiredReasons: [owner], ...state };
    assert.deepEqual(applyInputIdentity(classification, { entries: [input] }, new Set()), []);
    assert.equal(classification.records[0].selected, false);
    assert.deepEqual(classification.records[0].reasons, [{ code: 'input-not-shipped', filename, reasons: [owner] }]);
    assert.equal(classification.records[1].selected, true, 'an optional historical observer does not own this requirement');
  }
});

test('CI keeps explicit external runtime, service and tool provisioning failures fatal', async () => {
  const filename = path.resolve(repositoryRoot, '..', 'supplied-runtime', 'runtime.bin');
  for (const supplied of ['runtime:node', 'runtime:native-reference', 'service:jellyfinDll', 'tool:ffmpeg']) {
    for (const state of [
      { available: true, expectedDigestMatched: false },
      { available: false },
    ]) {
      const classification = await classify({ dependencies: { entries: [entry(ownPath), entry(otherPath)] },
        tracked: new Set([ownPath, otherPath]), environment: {} });
      const reasons = [ownPath + ':manifest-reference:' + filename, supplied];
      const errors = applyInputIdentity(classification, { entries: [{ filename, kind: 'file', required: true,
        reasons, requiredReasons: reasons, ...state }] }, new Set());
      assert.deepEqual(errors, [{ code: state.available ? 'input-digest-mismatch' : 'input-unavailable', filename, reasons }]);
      assert.ok(classification.records.every(record => record.selected), 'explicit supplied input failures cannot shrink scope');
    }
  }
  const classification = await classify({ dependencies: { entries: [entry(ownPath)] }, tracked: new Set([ownPath]), environment: {} });
  const reasons = [ownPath + ':manifest-reference:' + filename];
  assert.deepEqual(applyInputIdentity(classification, { entries: [{ filename, required: true, available: false,
    invalidExpectedDigest: true, reasons, requiredReasons: reasons }] }, new Set()),
  [{ code: 'input-digest-mismatch', filename, reasons }], 'an invalid pin remains a declaration error even for unprovided history');
  assert.equal(classification.records[0].selected, true);
});

test('an exact request still fails when its only required historical input is not shipped', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath), entry(otherPath)] },
    tracked: new Set([ownPath, otherPath]), environment: {} });
  restrictToRequested(classification, ownPath);
  const filename = path.resolve(repositoryRoot, '..', 'unprovided-historical-tools', 'ffprobe.exe');
  const reasons = [ownPath + ':manifest-reference:' + filename];
  assert.deepEqual(applyInputIdentity(classification, { entries: [{ filename, kind: 'file', required: true, available: true,
    expectedDigestMatched: false, reasons, requiredReasons: reasons }] }, new Set()), []);
  const request = restrictToRequested(classification, ownPath);
  assert.deepEqual(request.infrastructureErrors.map(error => [error.code, error.filename]), [['requested-test-unavailable', ownPath]]);
  assert.equal(request.infrastructureErrors[0].reasons[0].code, 'input-not-shipped');
  assert.deepEqual(classification.records[1].reasons, [{ code: 'not-requested' }]);
});

test('CI retains optional historical provenance and fails an unattributed required input', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath)] }, tracked: new Set([ownPath]), environment: {} });
  const filename = path.join(repositoryRoot, 'unavailable-history.json');
  assert.deepEqual(applyInputIdentity(classification, { entries: [{ filename, available: false,
    required: false, reasons: [ownPath + ':historical-provenance'], requiredReasons: [] }] }, new Set()), []);
  const errors = applyInputIdentity(classification, { entries: [{ filename, available: false,
    required: true, reasons: ['unknown-consumer:manifest-reference'], requiredReasons: ['unknown-consumer:manifest-reference'] }] }, new Set());
  assert.deepEqual(errors.map(error => error.code), ['unattributed-input-failure']);
  assert.equal(classification.records[0].selected, true);
});

test('manual CI selection accepts exact comma and newline paths while an empty request preserves automatic scope', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath), entry(otherPath), entry(unrelatedPath)] },
    tracked: new Set([ownPath, otherPath, unrelatedPath]), environment: {} });
  const before = structuredClone(classification.records);
  assert.deepEqual(restrictToRequested(classification, ' \r\n, '), { requested: [], infrastructureErrors: [] });
  assert.deepEqual(classification.records, before);
  assert.deepEqual(restrictToRequested(classification, ` ${ownPath},\r\n ${otherPath} `), {
    requested: [ownPath, otherPath], infrastructureErrors: [],
  });
  assert.deepEqual(classification.records.map(record => record.selected), [true, true, false]);
  assert.deepEqual(classification.records[2].reasons, [{ code: 'not-requested' }]);
});

test('manual CI selection rejects duplicate, unknown and wildcard paths before changing scope', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath), entry(otherPath)] },
    tracked: new Set([ownPath, otherPath]), environment: {} });
  const before = structuredClone(classification.records);
  for (const raw of [`${ownPath}, ${ownPath}`, `${ownPath}\ntests/unknown.test.js`, 'tests/core/*.test.js', otherPath.replaceAll('/', '\\')]) {
    assert.throws(() => restrictToRequested(classification, raw), /(?:Duplicate|Unknown) requested test:/u);
    assert.deepEqual(classification.records, before);
  }
});

test('manual CI requests fail explicitly when declared or recursively discovered dependencies are unavailable', async () => {
  const classification = await classify({ dependencies: { entries: [entry(ownPath, { services: ['jellyfinDll'] }), entry(otherPath), entry(unrelatedPath)] },
    tracked: new Set([ownPath, otherPath, unrelatedPath]), environment: {} });
  const raw = `${ownPath}\n${otherPath}`;
  const initial = restrictToRequested(classification, raw);
  assert.deepEqual(initial.infrastructureErrors.map(error => [error.code, error.filename]), [['requested-test-unavailable', ownPath]]);
  assert.equal(initial.infrastructureErrors[0].reasons[0].code, 'service-not-provisioned');
  applyInputIdentity(classification, { entries: [{ filename: path.join(repositoryRoot, 'missing-native-input.json'),
    required: true, available: false, reasons: [otherPath + ':manifest-reference:native-input'],
    requiredReasons: [otherPath + ':manifest-reference:native-input'] }] }, new Set());
  const final = restrictToRequested(classification, raw);
  assert.deepEqual(final.requested, [ownPath, otherPath]);
  assert.deepEqual(final.infrastructureErrors.map(error => error.filename), [ownPath, otherPath]);
  assert.equal(final.infrastructureErrors[1].reasons[0].code, 'input-unavailable');
  assert.deepEqual(classification.records[2].reasons, [{ code: 'not-requested' }]);
});
