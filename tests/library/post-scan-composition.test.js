import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../src/runtime.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { dateText, idKey } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const inputFile = new URL('./fixtures/post-scan-composition/input.json', import.meta.url);
const inputBytes = await readFile(inputFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const itemColumns = tableDefinition('BaseItems').columns;
const byNameTypes = ['Genre', 'Studio'].map(name => 'MediaBrowser.Controller.Entities.' + name);
const nativeTasks = ['SplashscreenPostScanTask', 'ArtistsPostScanTask', 'CollectionPosterVerifyPostScanTask',
  'CollectionPostScanTask', 'GenresPostScanTask', 'MusicGenresPostScanTask', 'StudiosPostScanTask', 'CleanDatabaseScheduledTask'];

function rewrite(value, root) {
  if (Array.isArray(value)) return value.map(entry => rewrite(entry, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry, root)]));
  if (typeof value === 'bigint') { assert.ok(Number.isSafeInteger(Number(value))); return Number(value); }
  if (typeof value !== 'string') return value;
  value = value.replaceAll(root, '$PROGRAM').replaceAll(root.replaceAll('\\', '/'), '$PROGRAM');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) return idKey(value);
  return value.replaceAll('\\', '/');
}

function rowsForComparison(rows, { root, initialIds, start, end, expandPath = value => value }) {
  return rows.filter(row => initialIds.has(idKey(row.Id)) || byNameTypes.includes(row.Type)).map(row => {
    const created = !initialIds.has(idKey(row.Id));
    return Object.fromEntries(itemColumns.map(column => {
      let value = row[column.name];
      if (value == null) return [column.name, null];
      if (column.name === 'Data') {
        value = parseLosslessJson(value);
        if (created && value.DateLastSaved != null && row.DateLastSaved != null) {
          assert.equal(dateText(value.DateLastSaved), dateText(row.DateLastSaved));
          value.DateLastSaved = '$SAVE_CLOCK';
        }
      } else if (column.clrType.includes('DateTime')) {
        value = dateText(value);
        if (created && ['DateCreated', 'DateModified', 'DateLastSaved', 'DateLastRefreshed'].includes(column.name)) {
          const instant = Date.parse(value);
          assert.ok(instant >= start - 1000 && instant <= end + 1000, `${column.name} must belong to this actual operation: ${value}`);
          value = '$' + column.name.toUpperCase() + '_CLOCK';
        }
      } else if (column.name === 'Path') value = expandPath(value);
      else if (column.clrType.replace('?', '') === 'bool') value = Boolean(value);
      return [column.name, rewrite(value, root)];
    }));
  }).sort((left, right) => left.Id.localeCompare(right.Id));
}

async function stateFiles(root) {
  const result = [];
  const visit = async directory => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, 'The isolated fixture must not introduce symbolic links.');
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) {
        const bytes = await readFile(filename);
        result.push({ path: path.relative(root, filename).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes), content: bytes.toString('base64') });
      }
    }
  };
  await visit(path.join(root, 'metadata')); await visit(path.join(root, 'data'));
  return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

test('postgres: current native eight-task global scan creates and cleans nonempty by-name state', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 300000,
}, async t => {
  assert.ok(process.env.MEDIAMANAGER_JELLYFIN_DLL, 'The actual composition requires the current native Jellyfin assembly directory.');
  await access(process.env.MEDIAMANAGER_JELLYFIN_DLL);
  const output = path.join(validationOutputRoot(), 'post-scan-composition-' + randomUUID());
  const recording = await recordOracle({ project: 'tests/library/fixtures/post-scan-composition/Oracle.csproj', output,
    args: [fileURLToPath(inputFile), '{output}/native.json', '{output}/cases'] });
  assert.equal(recording.passed, true);
  const nativeBytes = await readFile(path.join(output, 'native.json'));
  const native = parseLosslessJson(nativeBytes.toString('utf8'));
  assert.equal(native.inputSha256, hash(inputBytes));
  assert.equal(native.results.length, 1);
  const recordedOutput = recording.outputs.find(file => path.basename(file.filename) === 'native.json');
  assert.equal(recordedOutput.sha256, hash(nativeBytes));
  assert.ok(native.assemblies.some(assembly => assembly.name === 'jellyfin' && assembly.sha256 === recording.jellyfinDll.sha256),
    'The helper actually loads the Jellyfin assembly supplied by this CI build.');

  const sample = native.results[0], before = sample.before.sql.result, expected = sample.observation.Sql.result;
  assert.deepEqual(sample.discovered, sample.instantiated);
  assert.deepEqual(sample.instantiated.map(name => name.split('.').at(-1)), nativeTasks);
  assert.equal(sample.observation.Exception, null, sample.observation.ExceptionMessage);
  assert.equal(sample.observation.ScanRunning, false);
  const logs = sample.observation.Trace.filter(event => event.action === 'log').map(event => event.detail);
  assert.deepEqual(logs.filter(event => event.level === 'Error' || event.level === 'Critical'), [], 'An internally swallowed native task failure is still a test failure.');
  assert.deepEqual(logs.map(event => /^Post-scan task (\w+) completed after /u.exec(event.message)?.[1]).filter(Boolean), nativeTasks);
  assert.deepEqual(sample.observation.Trace.filter(event => event.action === 'metadata-completed' && byNameTypes.includes(event.detail.item.type))
    .map(event => event.detail.item.type).sort(), [...byNameTypes].sort(), 'Both native by-name items complete their real metadata service.');
  assert.ok(sample.before.files.length >= 6, 'Native cleanup starts with real source, internal and extracted marker files.');
  assert.deepEqual(sample.files, [], 'The native operation deletes every seeded cleanup marker.');
  assert.deepEqual(sample.createdDirectories.map(entry => entry.exists), [true, true]);
  assert.equal(expected.ItemValues.some(row => idKey(row.ItemValueId) === idKey(sample.orphanValueId)), false);
  assert.deepEqual(expected.BaseItems.filter(row => byNameTypes.includes(row.Type)).map(row => row.Name).sort(), [sample.seed.Genre, sample.seed.Studio].sort());

  const programRoot = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-post-scan-'));
  let database, runtime;
  t.after(async () => {
    const errors = [];
    for (const close of [() => runtime?.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(path.resolve(programRoot)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(programRoot).startsWith('mediamanager-post-scan-'));
      await rm(programRoot, { recursive: true, force: true });
    }]) try { await close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Post-scan composition cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'post_scan', { max: 1 });
  const errors = [], events = [], completed = [], metadata = [];
  runtime = await createRuntime({ database, programDataPath: programRoot,
    configurationDirectoryPath: path.join(programRoot, 'config'), serverId: 'post-scan-composition',
    configuration: { UICulture: 'en-US', MetadataCountryCode: 'US', IsStartupWizardCompleted: true,
      EnableCaseSensitiveItemIds: true, EnableNormalizedItemByNameIds: true, LibraryScanFanoutConcurrency: 1 },
    onError: error => errors.push(String(error?.stack ?? error)) });
  const initialIds = new Set(sample.fixtureIds.map(idKey));
  for (const row of [...before.BaseItems, ...expected.BaseItems]) assert.deepEqual(Object.keys(row).sort(), itemColumns.map(column => column.name).sort());
  const rebase = value => typeof value === 'string' ? value.replaceAll(sample.programRoot, programRoot)
    .replaceAll(JSON.stringify(sample.programRoot).slice(1, -1), JSON.stringify(programRoot).slice(1, -1)) : value;
  await runtime.store.transaction(async db => {
    for (const row of before.BaseItems.filter(row => initialIds.has(idKey(row.Id)))) {
      await db.insert('BaseItems', Object.fromEntries(itemColumns.map(column => {
        let value = rebase(row[column.name]);
        if (value != null && column.clrType.includes('Guid')) value = nativeGuid(value);
        return [column.name, value];
      })));
    }
    for (const name of ['ItemValues', 'ItemValuesMap']) for (const row of before[name]) {
      await db.insert(name, Object.fromEntries(tableDefinition(name).columns.map(column => {
        const value = row[column.name];
        return [column.name, value != null && column.clrType.includes('Guid') ? nativeGuid(value) : value];
      })));
    }
  });
  for (const file of sample.before.files) {
    const filename = path.resolve(programRoot, file.path), relative = path.relative(programRoot, filename);
    assert.ok(relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    assert.ok(file.path.startsWith('metadata/') || file.path.startsWith('data/'));
    const bytes = Buffer.from(file.content, 'base64'); assert.equal(hash(bytes), file.sha256);
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes, { flag: 'wx' });
  }
  assert.deepEqual(await stateFiles(programRoot), rewrite(sample.before.files, sample.programRoot));
  for (const [name, action] of [['ItemAdded', 'added'], ['ItemRemoved', 'removed']]) runtime.library.on(name, ({ Item }) => {
    if (initialIds.has(idKey(Item.Id)) || byNameTypes.includes(Item.NativeType)) events.push({ action, id: idKey(Item.Id), name: Item.Name });
  });
  const tasks = runtime.libraryScanLifecycle.postScanTasks;
  assert.deepEqual(tasks.map(task => task.constructor.name), nativeTasks.map(name => name === 'CleanDatabaseScheduledTask' ? 'CleanDatabasePostScanTask' : name));
  for (const task of tasks) {
    const run = task.run.bind(task);
    task.run = async options => { const result = await run(options); completed.push(task.constructor.name); return result; };
  }
  const refresh = runtime.metadataScanner.refreshItem.bind(runtime.metadataScanner);
  runtime.metadataScanner.refreshItem = async (reference, options) => {
    const result = await refresh(reference, options); metadata.push(idKey(typeof reference === 'string' ? reference : reference.Id)); return result;
  };
  errors.length = 0;
  const start = Date.now();
  let failure;
  try { await runtime.libraryScanLifecycle.run(); } catch (error) { failure = error; }
  const end = Date.now();
  const rows = await database.rows('BaseItems'), values = await database.rows('ItemValues'), maps = await database.rows('ItemValuesMap');
  const files = await stateFiles(programRoot);
  await writeFile(path.join(output, 'candidate.json'), JSON.stringify({ startedAt: new Date(start).toISOString(), completedAt: new Date(end).toISOString(),
    programRoot, completed, events, errors, failure: failure?.stack ?? null, sql: { BaseItems: rows, ItemValues: values, ItemValuesMap: maps },
    files, nativeSha256: hash(nativeBytes), record: path.join(output, 'record.json') },
  (_, value) => typeof value === 'bigint' ? JSON.rawJSON(String(value)) : value, 2) + '\n', { flag: 'wx' });
  assert.equal(failure, undefined, failure?.stack);
  assert.deepEqual(errors, [], 'Internally logged candidate failures must not pass the composition check.');
  assert.deepEqual(completed, tasks.map(task => task.constructor.name));
  assert.equal(runtime.libraryScanLifecycle.isScanRunning, false);
  const actual = rowsForComparison(rows, { root: programRoot, initialIds, start, end, expandPath: runtime.library.options.expandPath });
  const wanted = rowsForComparison(expected.BaseItems, { root: sample.programRoot, initialIds,
    start: Date.parse(sample.startedAt), end: Date.parse(sample.completedAt) });
  assert.deepEqual(actual, wanted, 'All persistent columns of the source and by-name entities match the current native operation.');
  const order = rows => rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  for (const name of ['ItemValues', 'ItemValuesMap']) {
    const normalize = rows => order(rows.map(row => Object.fromEntries(tableDefinition(name).columns.map(column =>
      [column.name, rewrite(row[column.name], programRoot)]))));
    assert.deepEqual(normalize(name === 'ItemValues' ? values : maps), normalize(expected[name]), name);
  }
  const nativeEvents = sample.observation.Trace.filter(event => ['added', 'removed'].includes(event.action)
    && (initialIds.has(idKey(event.detail.item.id)) || byNameTypes.includes(event.detail.item.type)))
    .map(event => ({ action: event.action, id: idKey(event.detail.item.id), name: event.detail.item.Name }));
  assert.deepEqual(events, nativeEvents);
  for (const row of rows.filter(row => byNameTypes.includes(row.Type))) assert.ok(metadata.includes(idKey(row.Id)), 'Each newly created by-name item traverses the actual metadata scanner.');
  assert.deepEqual(files, rewrite(sample.files, sample.programRoot));
  for (const entry of sample.createdDirectories) assert.equal((await stat(path.join(programRoot, entry.path))).isDirectory(), entry.exists);
  assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, false, 'This narrow nonempty scenario does not admit all media families or release capabilities.');
  await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ passed: true, scope: sample.Name,
    rows: actual, nativeSha256: hash(nativeBytes), candidate: 'candidate.json' }, null, 2) + '\n', { flag: 'wx' });
});
