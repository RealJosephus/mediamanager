import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { nativeModel } from '../../src/database/model.js';
import { databaseDigest } from '../../src/migration/database-transfer.js';
import { idKey } from '../../src/library/records.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { readTestLinks } from '../library/collection-test-consumers.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { parseLosslessJson } from '../../src/core/json.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const fixture = new URL('./fixtures/collections/', import.meta.url);
const inputFile = new URL('current/input.json', fixture);
const inputBytes = await fs.readFile(inputFile);
export const input = JSON.parse(inputBytes);
export const id = index => `ca1000000000000000000${String(index).padStart(11, '0')}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
export const semantic = value => JSON.parse(json(value));
export const projectCollectionHttpBody = (value, status) => projectProblemTrace(value, status);
export const collectionBindingObservation = calls => Object.fromEntries(['create', 'add', 'remove'].map(operation => [operation,
  calls.filter(call => call.phase === operation).map(({ phase: _phase, ...value }) => value)]));
const observable = row => ({ name: row.name, status: row.status, contentType: row.contentType, allow: row.allow,
  body: row.jsonBody == null ? row.body : null, jsonBody: projectCollectionHttpBody(row.jsonBody, row.status),
  bindings: row.managerState ? undefined : collectionBindingObservation(row.calls),
  managerState: row.managerState && Object.fromEntries(Object.entries(row.managerState).filter(([key]) => key !== 'diagnosticPhases')) });

let pending;
export const currentCollections = () => pending ??= capture();
async function capture() {
  const profile = JSON.parse(await fs.readFile(new URL('current-profile.json', fixture), 'utf8'));
  const output = path.join(validationOutputRoot(), 'collections-current-' + randomUUID());
  assertValidationOutputChild(output); await fs.mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputSha256: sha(inputBytes), inputs: [], sourceBindings: [],
    nativeExecutionRecorded: false, independentRepeatMatched: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, fixture)));
      assert.equal(actual.available, true, expected.filename); assert.equal(actual.bytes, expected.bytes, expected.filename);
      assert.equal(actual.sha256, expected.sha256, expected.filename); report.inputs.push({ role: expected.role, ...actual });
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await fs.readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relativePath of profile.sourcePaths) {
      const expected = manifest.files.find(entry => entry.path === relativePath); assert.ok(expected, relativePath);
      const source = await describeFile(path.join(build.root, 'source', relativePath));
      assert.equal(source.sha256, expected.sha256, relativePath); report.sourceBindings.push({ relativePath, source });
    }
    const captures = [];
    report.captures = [];
    for (const label of ['first', 'repeat']) {
      const nativeRoot = path.join(output, label);
      const record = await recordOracle({ project: fileURLToPath(new URL('current/Oracle.csproj', fixture)), output: nativeRoot,
        args: [fileURLToPath(inputFile), '{output}/native.json'] });
      const filename = path.join(nativeRoot, 'native.json'), bytes = await fs.readFile(filename), native = parseLosslessJson(bytes.toString('utf8'));
      const receipt = { label, record, observation: await describeFile(filename), assemblies: [] };
      report.captures.push(receipt);
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, sha(bytes));
      assert.equal(native.actualExecution, true); assert.equal(native.httpServerStopped, true);
      assert.equal(native.inputSha256, sha(inputBytes));
      for (const assembly of native.assemblies.filter(entry => /^(?:Emby\.|Jellyfin\.|MediaBrowser\.|jellyfin$)/u.test(entry.name))) {
        const supplied = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
        assert.equal(supplied.available, true, assembly.name); assert.equal(supplied.sha256, assembly.sha256, assembly.name);
        receipt.assemblies.push({ loaded: assembly, supplied });
      }
      assert.ok(receipt.assemblies.length > 0);
      assert.deepEqual(native.results.map(entry => entry.name), input.cases.map(entry => entry.name));
      captures.push(native);
    }
    assert.deepEqual(captures[1].results.map(observable), captures[0].results.map(observable));
    report.nativeExecutionRecorded = true; report.independentRepeatMatched = true;
    await fs.mkdir(path.join(output, 'candidate'));
    return { native: captures[0], output, report };
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await fs.writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}

export async function recordCandidate(name, observation) {
  assert.match(name, /^[a-zA-Z0-9_.-]+$/u);
  const { output } = await currentCollections();
  await fs.writeFile(path.join(output, 'candidate', name + '.json'), json(observation), { flag: 'wx' });
}

async function fileTree(root, { includeBytes = false } = {}) {
  const directories = [], files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true, recursive: true })) {
    const filename = path.join(entry.parentPath, entry.name), relative = path.relative(root, filename).split(path.sep).join('/');
    if (entry.isDirectory()) directories.push(relative);
    else if (entry.isFile()) {
      const bytes = await fs.readFile(filename); files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes),
        ...(includeBytes ? { base64: bytes.toString('base64') } : {}) });
    } else assert.fail('The isolated fixture must not create links or special files: ' + relative);
  }
  return { directories: directories.sort(), files: files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) };
}

async function allTables(database) {
  const tables = [];
  for (const table of nativeModel.tables) tables.push({ name: table.name,
    rows: semantic(await database.rows(table.name, { orderBy: table.primaryKey.map(column => ({ column, direction: 'ASC' })) })) });
  return { digest: await databaseDigest(database), tables };
}

export async function actualManagerCase(t, sample) {
  const { output } = await currentCollections();
  const root = path.join(output, 'candidate-states', sample.name);
  assertValidationOutputChild(root); await fs.mkdir(root, { recursive: true });
  const programDataPath = path.join(root, 'program'), dataPath = path.join(programDataPath, 'data');
  const configurationDirectoryPath = path.join(root, 'config'), mediaPath = path.join(programDataPath, 'media', 'Member.mkv');
  let database, runtime, existing;
  const errors = [], events = [], queued = [], added = [], monitor = [];
  const report = { sample: sample.name, cleanup: { runtimeClosed: false, postgresDropped: false, stateRemoved: false } };
  t.after(async () => {
    const failures = [];
    try { await runtime?.close(); report.cleanup.runtimeClosed = true; } catch (error) { failures.push(error); }
    try { await dropPostgresTestDatabase(database); report.cleanup.postgresDropped = true; } catch (error) { failures.push(error); }
    try {
      assert.equal(path.dirname(root), path.join(output, 'candidate-states'));
      await fs.rm(root, { recursive: true, force: true }); report.cleanup.stateRemoved = true;
    } catch (error) { failures.push(error); }
    if (failures.length) report.cleanup.errors = failures.map(error => ({ name: error.name, message: error.message }));
    await recordCandidate(sample.name, report);
    if (failures.length) throw new AggregateError(failures, 'Current collections manager cleanup failed.');
  });
  await fs.mkdir(configurationDirectoryPath, { recursive: true });
  await fs.mkdir(path.dirname(mediaPath), { recursive: true });
  await fs.writeFile(mediaPath, 'unchanged source media\n');
  await fs.writeFile(path.join(configurationDirectoryPath, 'system.xml'), '<ServerConfiguration><ContentTypes/></ServerConfiguration>');
  database = await createPostgresTestDatabase(null, 'current_collect');
  await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: 'ca100000-0000-0000-0000-000000000002', Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Member',
    SortName: 'member', Path: mediaPath, MediaType: 'Video', IsMovie: true, Data: '{"UnknownCollectionInput":{"preserve":true}}',
    DateCreated: '2026-10-13 00:00:00.0000000', DateModified: '2026-10-13 00:00:00.0000000',
  }));
  runtime = await createTestRuntime({ database, programDataPath, dataPath, metadataPath: path.join(programDataPath, 'metadata'),
    configurationDirectoryPath, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, EnableCaseSensitiveItemIds: true },
    serverId: 'collections-current-http', autoDiscoveryOptions: { enabled: false }, onError: error => errors.push(error) });
  runtime.libraryConfiguration.sleep = async () => {};
  runtime.libraryConfiguration.queueLibraryScan = async () => {};
  runtime.metadata.queue = async (itemId, options, priority) => { queued.push({ id: idKey(itemId), options, priority }); };
  existing = await runtime.collections.create({ Name: 'Existing' });
  await fs.writeFile(path.join(existing.Path, 'preserve.bin'), 'unchanged collection sidecar\n');
  queued.length = 0;
  runtime.library.on('ItemAdded', value => { if (value.Item.Type === 'BoxSet') added.push(idKey(value.Item.Id)); });
  for (const [name, observed] of [['CollectionCreated', 'created-event'], ['ItemsAddedToCollection', 'added-event'], ['ItemsRemovedFromCollection', 'removed-event']]) {
    runtime.collections.on(name, () => events.push(observed));
  }
  const begin = runtime.collections.monitor.reportFileSystemChangeBeginning?.bind(runtime.collections.monitor);
  const complete = runtime.collections.monitor.reportFileSystemChangeComplete?.bind(runtime.collections.monitor);
  runtime.collections.monitor = { reportFileSystemChangeBeginning: async (...args) => { monitor.push('begin'); return begin?.(...args); },
    reportFileSystemChangeComplete: async (...args) => { monitor.push('complete'); return complete?.(...args); } };
  const user = { Id: id(9), Policy: { EnableCollectionManagement: true, EnableRemoteAccess: true }, AccessSchedules: [] };
  runtime.authentication.authenticate = async () => ({ IsAuthenticated: true, IsApiKey: false, IsAdministrator: false, UserId: user.Id, User: user });

  const collections = path.join(dataPath, 'collections');
  const project = async item => ({ name: item.Name, type: item.Type, isLocked: item.IsLocked,
    parentRole: idKey(item.ParentId) === idKey(existing.ParentId) ? 'collections' : idKey(item.ParentId),
    path: path.relative(collections, item.Path).split(path.sep).join('/'),
    links: (await readTestLinks(item)).map(link => ({ itemId: link.ItemId == null ? null : idKey(link.ItemId),
      path: link.Path ?? null, libraryItemId: link.LibraryItemId ?? null, type: link.Type })) });
  report.before = { database: await allTables(database), files: await fileTree(root, { includeBytes: true }) };
  const originalIds = new Set(report.before.database.tables.find(table => table.name === 'BaseItems').rows.map(row => idKey(row.Id)));
  const requestPath = sample.path.replaceAll(id(1), idKey(existing.Id));
  const response = await fetch(`http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}${requestPath}`, {
    method: sample.method, headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
  });
  report.response = { status: response.status, contentType: response.headers.get('content-type'), allow: response.headers.get('allow') ?? '', body: await response.text() };
  await runtime.collections.drainForItem();
  report.after = { database: await allTables(database), files: await fileTree(root, { includeBytes: true }) };
  const createdRows = report.after.database.tables.find(table => table.name === 'BaseItems').rows.filter(row => !originalIds.has(idKey(row.Id)));
  assert.ok(createdRows.length <= 1, 'a failed creation cannot produce unrequested items');
  const created = createdRows.length ? await runtime.itemCreation.getItemById(createdRows[0].Id) : null;
  const mediaBytes = await fs.readFile(mediaPath);
  report.managerState = { created: !!created, collection: created ? await project(created) : null, existing: await project(existing), events,
    ...await fileTree(collections), media: { bytes: mediaBytes.length, sha256: sha(mediaBytes) } };
  report.diagnostics = { queued, added, monitor, errors: errors.map(error => ({ name: error.name, message: error.message, status: error.status ?? error.statusCode })) };
  const createdId = created && idKey(created.Id);
  for (const before of report.before.database.tables) {
    const after = report.after.database.tables.find(table => table.name === before.name);
    const retained = after.rows.filter(row => !createdId || !(before.name === 'BaseItems' && idKey(row.Id) === createdId)
      && !(before.name === 'AncestorIds' && idKey(row.ItemId) === createdId));
    assert.deepEqual(retained, before.rows, sample.name + ': all existing rows and unrelated tables remain unchanged: ' + before.name);
  }
  if (created) {
    assert.equal(created.Type, 'BoxSet'); assert.equal(idKey(created.ParentId), idKey(existing.ParentId));
    assert.deepEqual(await readTestLinks(created), []);
    assert.ok(added.includes(createdId), 'the persisted creation prefix was published to the library');
  }
  assert.deepEqual(report.after.files.files, report.before.files.files, sample.name + ': all original file bytes remain unchanged');
  const newDirectories = report.after.files.directories.filter(value => !report.before.files.directories.includes(value));
  assert.deepEqual(newDirectories, created ? [path.relative(root, created.Path).split(path.sep).join('/')] : [],
    sample.name + ': failure retains only its actually created directory');
  return report;
}
