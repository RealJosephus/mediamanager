import test from 'node:test';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dateText, dateTicks, idKey } from '../../src/library/records.js';
import { tableDefinition } from '../../src/database/model.js';
import { recordItemFilterCandidate, validateFixture } from './item-filter-http-scenario.js';
import { currentUserViewScenario, userViewEvidenceJson as json } from '../helpers/current-user-view-scenario.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE) });

const bytes = await readFile(new URL('./fixtures/named-item-lifecycle-http/input.json', import.meta.url));
const fixture = JSON.parse(bytes);
validateFixture(fixture);

test('named detail HTTP creation and complete persistence match current native lifecycles', {
  skip: !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE || !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 300000,
}, nativeCallback(async t => {
  const { http, stages, caseStages, root } = await currentUserViewScenario('named-item-lifecycle-http', bytes, { signal: t.signal });
  assert.equal(http.records.length, 26); assert.equal(caseStages.length, 26);
  const body = name => http.records.find(record => record.name === name)?.response.bodyJson;
  const originals = new Set(stages.before.database.baseItems.map(row => idKey(row.Id)));
  const created = stages.afterReads.database.baseItems.filter(row => !originals.has(idKey(row.Id)));
  assert.equal(created.length, 6);
  for (const kind of ['Genre', 'MusicGenre', 'MusicArtist', 'Studio']) {
    const initial = body('create ' + kind), repeat = body('repeat ' + kind), alias = body('case alias ' + kind);
    assert.equal(initial.Type, kind); assert.ok(!/^0{32}$/u.test(initial.Id));
    assert.equal(initial.Id, repeat.Id); assert.equal(initial.Id, alias.Id);
    assert.equal(initial.Name, repeat.Name); assert.equal(initial.Name, alias.Name);
    const row = created.find(row => idKey(row.Id) === initial.Id);
    assert.ok(row); assert.equal(row.Name, initial.Name);
    const metadata = stages.afterReads.filesystem.metadata.entries;
    assert.ok(metadata.some(entry => entry.type === 'directory' && entry.path.endsWith('/' + initial.Name)));
  }
  assert.equal(body('create sanitized studio').Id, body('same path studio').Id);
  assert.equal(body('same path studio').Name, 'Studio: Collision');
  assert.equal(body('missing Genre slug').Id, '0'.repeat(32));
  assert.equal(body('BOM is not CLR whitespace').Name, '\ufeff');
  assert.deepEqual(stages.afterReads, stages.afterShutdown);
  const times = new Map();
  const columns = tableDefinition('BaseItems').columns;
  const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture,
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName: 'named-item-lifecycle-http',
    captureResponseBodies: true, captureErrorText: true, captureCaseRuntimeErrors: true,
    trackUserData: true, trackFilesystem: true, captureShutdownState: true, captureEndpointStages: true,
    configuration: { EnableNormalizedItemByNameIds: true, EnableCaseSensitiveItemIds: true,
      EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
    prepareScenario: async ({ database, programDataPath }) => {
      const locations = { aggregate: path.join(programDataPath, 'root'), userRoot: path.join(programDataPath, 'root/default') };
      for (const letter of ['A', 'B', 'T', 'K', 'M']) {
        locations['physical' + letter] = path.join(programDataPath, 'library-content', letter);
        locations['library' + letter] = path.join(programDataPath, 'root/default', 'Library ' + letter);
      }
      for (const item of fixture.items) {
        const row = stages.before.database.baseItems.find(row => idKey(row.Id) === idKey(item.id));
        assert.ok(row, item.key);
        const values = Object.fromEntries(columns.filter(column => column.name !== 'Id').map(column => [column.name,
          column.clrType.replace('?', '') === 'long' && row[column.name] != null ? BigInt(row[column.name]) : row[column.name]]));
        const data = JSON.parse(row.Data ?? '{}');
        if (item.type === 'CollectionFolder') data.PhysicalLocationsList = data.PhysicalFolderIds.map(id =>
          locations[fixture.items.find(item => idKey(item.id) === idKey(id)).pathKind]);
        await mkdir(locations[item.pathKind], { recursive: true });
        if (item.type === 'CollectionFolder' && item.data.CollectionType) await writeFile(path.join(locations[item.pathKind], item.data.CollectionType + '.collection'), '');
        await database.update('BaseItems', { Id: item.id.toUpperCase() }, { ...values, Path: locations[item.pathKind], Data: JSON.stringify(data) });
      }
    },
    afterEndpoint: async ({ runtime, database }) => {
      for (const row of await database.rows('BaseItems')) if (created.some(item => idKey(item.Id) === idKey(row.Id))) {
        const identity = runtime.library.options.expandPath(row.Path);
        const metadata = path.join(runtime.library.options.programDataPath, 'metadata');
        assert.ok(identity.startsWith(metadata + path.sep));
        const info = await stat(identity, { bigint: true });
        times.set(idKey(row.Id), { birthtimeNs: String(info.birthtimeNs), mtimeNs: String(info.mtimeNs) });
      }
    },
  });
  await writeFile(path.join(root, 'postgres.json'), json(actual), { flag: 'wx' });
  const originalNode = new Set(actual.beforeReads.BaseItems.map(row => idKey(row.Id)));
  const nodeCreated = actual.afterReads.BaseItems.filter(row => !originalNode.has(idKey(row.Id)));
  const fileTicks = value => BigInt(value) / 100n + 621355968000000000n;
  for (const [rows, readTime] of [[created, row => stages.afterReads.filesystem.metadata.entries.find(entry => entry.path
    === row.Path.slice('%MetadataPath%'.length).replaceAll('\\', '/').replace(/^\//u, ''))],
    [nodeCreated, row => times.get(idKey(row.Id))]]) for (const row of rows) {
    const info = readTime(row); assert.ok(info, row.Name);
    assert.equal(dateTicks(row.DateCreated), fileTicks(info.birthtimeNs), row.Name + ' creation');
    assert.equal(dateTicks(row.DateModified), fileTicks(info.mtimeNs), row.Name + ' modification');
  }
  const rowProjection = row => Object.fromEntries(columns.map(column => {
    const value = row[column.name], type = column.clrType.replace('?', '');
    return [column.name, ['DateCreated', 'DateModified'].includes(column.name) ? '$directory-time'
      : value == null ? null : type === 'Guid' ? idKey(value) : type === 'bool' ? Boolean(value)
        : type === 'long' ? String(value) : type === 'DateTime' ? dateText(value) : value];
  }));
  const sortRows = rows => rows.map(rowProjection).sort((a, b) => a.Id.localeCompare(b.Id));
  assert.deepEqual(sortRows(nodeCreated), sortRows(created));
  for (const stage of actual.caseStages) {
    const reference = caseStages.find(value => value.name === stage.name && value.endpoint === stage.endpoint);
    assert.ok(reference, stage.name);
    for (const phase of ['before', 'after']) {
      const nativeRows = reference[phase].database.baseItems.filter(row => !originals.has(idKey(row.Id)));
      const nodeRows = stage[phase].database.BaseItems.filter(row => !originalNode.has(idKey(row.Id)));
      assert.deepEqual(sortRows(nodeRows), sortRows(nativeRows), stage.name + ':' + phase);
      for (const [rows, final] of [[nativeRows, created], [nodeRows, nodeCreated]]) for (const row of rows) {
        const saved = final.find(value => idKey(value.Id) === idKey(row.Id));
        for (const column of ['DateCreated', 'DateModified']) assert.equal(dateTicks(row[column]), dateTicks(saved[column]));
      }
    }
  }
  const normalize = (value, rows, prefix) => {
    if (Array.isArray(value)) return value.map(item => normalize(item, rows, prefix));
    if (!value || typeof value !== 'object') return typeof value === 'string' && value.startsWith(prefix)
      ? '$metadata' + value.slice(prefix.length) : value;
    const row = rows.find(row => idKey(row.Id) === value.Id);
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId').map(([key, entry]) => {
      if (key === 'ServerId') return [key, '$server'];
      if (key === 'DateCreated' && row) {
        assert.equal(dateTicks(entry), dateTicks(row.DateCreated)); return [key, '$directory-time'];
      }
      if (['DateCreated', 'DateLastSaved', 'DateLastMediaAdded'].includes(key) && typeof entry === 'string') return [key, dateText(entry)];
      return [key, normalize(entry, rows, prefix)];
    }));
  };
  const nativeRow = created.find(row => row.Name === 'Fresh Genre');
  const nativeRelative = nativeRow.Path.slice('%MetadataPath%'.length);
  const nativePrefix = body('create Genre').Path.slice(0, -nativeRelative.length);
  const nodePrefix = path.join(actual.programDataDirectory, 'metadata');
  const differences = [];
  for (const item of actual.cases) for (const endpoint of item.endpoints) {
    const reference = http.records.find(record => record.name === item.name && record.endpoint === endpoint.endpoint);
    try {
      assert.equal(endpoint.response.status, reference.response.status);
      assert.equal(endpoint.response.contentType, reference.response.contentType);
      assert.deepEqual(normalize(endpoint.response.body, nodeCreated, nodePrefix), normalize(reference.response.bodyJson, created, nativePrefix));
      assert.deepEqual(endpoint.runtimeErrors, []);
    } catch (error) { differences.push({ name: item.name, message: error.message }); }
  }
  await writeFile(path.join(root, 'postgres-comparison.json'), json({ passed: differences.length === 0, phaseAcceptance: false,
    responses: 26, createdIds: created.map(row => row.Id), nodeDirectoryTimes: [...times], differences,
    boundary: 'Complete HTTP and all created-row columns. Directory timestamps are independently bound to each runtime filesystem before projection; isolated metadata roots, ServerId and traceId only otherwise.' }), { flag: 'wx' });
  assert.deepEqual(actual.beforeReads.BaseItems, actual.afterReads.BaseItems.filter(row => originalNode.has(idKey(row.Id))));
  for (const [name, rows] of Object.entries(actual.beforeReads)) if (name !== 'BaseItems') assert.deepEqual(actual.afterReads[name], rows, name);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterReads);
  assert.deepEqual(actual.afterReads, actual.afterShutdown);
  assert.deepEqual(actual.filesystemAfterReads, actual.filesystemAfterShutdown);
  assert.deepEqual(actual.runtimeErrors, []); assert.ok(Object.values(actual.cleanup).every(Boolean));
  assert.deepEqual(differences, []);
}));
