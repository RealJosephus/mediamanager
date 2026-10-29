import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { dateText, dateTicks, idKey } from '../../src/library/records.js';
import { tableDefinition } from '../../src/database/model.js';
import { recordItemFilterCandidate, validateFixture } from './item-filter-http-scenario.js';
import { currentUserViewScenario, userViewEvidenceJson as json } from '../helpers/current-user-view-scenario.js';
import { projectItemBody } from '../helpers/http-body-projection.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE) });
const bytes = await readFile(new URL('./fixtures/year-detail-http/input.json', import.meta.url));
const fixture = JSON.parse(bytes);
validateFixture(fixture);

test('Year detail HTTP, by-name persistence and user DTOs match the designated Native lifecycle', {
  skip: !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE || !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 300000,
}, nativeCallback(async t => {
  const { http, stages, caseStages, root, nativeServerId } = await currentUserViewScenario('year-detail-http', bytes, { signal: t.signal });
  assert.equal(http.records.length, 21); assert.equal(caseStages.length, 21);
  const response = name => http.records.find(record => record.name === name).response;
  const originalNative = new Set(stages.before.database.baseItems.map(row => idKey(row.Id)));
  const nativeCreated = stages.afterReads.database.baseItems.filter(row => !originalNative.has(idKey(row.Id)));
  assert.deepEqual(nativeCreated.map(row => row.Name).sort(), ['1', '2026', '2147483647']);
  for (const row of nativeCreated) assert.equal(row.Type, 'MediaBrowser.Controller.Entities.Year');
  for (const name of ['repeat Year', 'leading zero Year', 'signed Year', 'padded Year']) {
    assert.equal(response(name).bodyJson.Id, response('create Year').bodyJson.Id);
    assert.equal(response(name).bodyJson.Name, '2026');
  }
  assert.equal(response('create Year').bodyJson.CanDelete, false);
  assert.equal(response('create Year').bodyJson.MovieCount, 1);
  assert.equal(response('create Year').bodyJson.SongCount, 1);
  assert.equal(response('authenticated user Year').bodyJson.UserData.Key, 'Year-2026');
  assert.deepEqual(stages.afterReads, stages.afterShutdown);

  const nodeTimes = new Map(), columns = tableDefinition('BaseItems').columns;
  const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture,
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName: 'year-detail-http',
    captureResponseBodies: true, captureErrorText: true, captureCaseRuntimeErrors: true,
    trackUserData: true, trackFilesystem: true, captureShutdownState: true, captureEndpointStages: true,
    configuration: { EnableNormalizedItemByNameIds: true, EnableCaseSensitiveItemIds: true,
      EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
    prepareScenario: async ({ database, programDataPath, users }) => {
      // The Native recorder retains a separate administrator while this reader
      // is demoted. Preserve that same prerequisite for the ordinary-user case.
      const control = await users.createUser({ Name: 'Year fixture control', Password: 'isolated year fixture control' });
      const administrator = await users.getUser(control.Id);
      await users.updatePolicy(control.Id, { ...administrator.Policy, IsAdministrator: true });
      const locations = { aggregate: path.join(programDataPath, 'root'), userRoot: path.join(programDataPath, 'root/default') };
      for (const letter of ['A', 'B', 'T', 'K', 'M']) {
        locations['physical' + letter] = path.join(programDataPath, 'library-content', letter);
        locations['library' + letter] = path.join(programDataPath, 'root/default', 'Library ' + letter);
      }
      const itemPath = item => locations[item.pathKind] ?? path.join(itemPath(fixture.items.find(parent => idKey(parent.id) === idKey(item.parentId))),
        item.key + (item.type === 'Movie' ? '.mkv' : ''));
      for (const item of fixture.items) {
        const row = stages.before.database.baseItems.find(row => idKey(row.Id) === idKey(item.id));
        assert.ok(row, item.key);
        const values = Object.fromEntries(columns.filter(column => column.name !== 'Id').map(column => [column.name,
          column.clrType.replace('?', '') === 'long' && row[column.name] != null ? BigInt(row[column.name]) : row[column.name]]));
        const data = JSON.parse(row.Data ?? '{}');
        if (item.type === 'CollectionFolder') data.PhysicalLocationsList = data.PhysicalFolderIds.map(id =>
          itemPath(fixture.items.find(physical => idKey(physical.id) === idKey(id))));
        if (item.isFolder !== false && ['AggregateFolder', 'UserRootFolder', 'CollectionFolder', 'Folder'].includes(item.type)) {
          await mkdir(itemPath(item), { recursive: true });
        }
        if (item.type === 'CollectionFolder' && item.data.CollectionType) {
          await writeFile(path.join(itemPath(item), item.data.CollectionType + '.collection'), '');
        }
        await database.update('BaseItems', { Id: item.id.toUpperCase() }, { ...values, Path: itemPath(item), Data: JSON.stringify(data) });
      }
    },
    afterEndpoint: async ({ runtime, database }) => {
      for (const expected of nativeCreated) {
        const row = (await database.rows('BaseItems', { where: { Id: expected.Id.toUpperCase() } }))[0];
        if (!row) continue;
        const identity = runtime.library.options.expandPath(row.Path);
        const metadata = path.join(runtime.library.options.programDataPath, 'metadata');
        assert.ok(identity.startsWith(metadata + path.sep));
        const info = await stat(identity, { bigint: true });
        nodeTimes.set(idKey(row.Id), { birthtimeNs: String(info.birthtimeNs), mtimeNs: String(info.mtimeNs) });
      }
    },
  });
  await writeFile(path.join(root, 'postgres.json'), json(actual), { flag: 'wx' });
  const originalNode = new Set(actual.beforeReads.BaseItems.map(row => idKey(row.Id)));
  const nodeCreated = actual.afterReads.BaseItems.filter(row => !originalNode.has(idKey(row.Id)));
  const fileTicks = value => BigInt(value) / 100n + 621355968000000000n;
  for (const [rows, readTime] of [[nativeCreated, row => stages.afterReads.filesystem.metadata.entries.find(entry => entry.path
    === row.Path.slice('%MetadataPath%'.length).replaceAll('\\', '/').replace(/^\//u, ''))],
  [nodeCreated, row => nodeTimes.get(idKey(row.Id))]]) for (const row of rows) {
    const info = readTime(row); assert.ok(info, row.Name);
    assert.equal(dateTicks(row.DateCreated), fileTicks(info.birthtimeNs));
    assert.equal(dateTicks(row.DateModified), fileTicks(info.mtimeNs));
  }
  const rowProjection = row => Object.fromEntries(columns.map(column => {
    const value = row[column.name], type = column.clrType.replace('?', '');
    return [column.name, ['DateCreated', 'DateModified'].includes(column.name) ? '$directory-time'
      : value == null ? null : type === 'Guid' ? idKey(value) : type === 'bool' ? Boolean(value)
        : type === 'long' ? String(value) : type === 'DateTime' ? dateText(value) : value];
  }));
  const sortRows = rows => rows.map(rowProjection).sort((left, right) => left.Id.localeCompare(right.Id));
  assert.deepEqual(sortRows(nodeCreated), sortRows(nativeCreated));
  for (const stage of actual.caseStages) {
    const reference = caseStages.find(value => value.name === stage.name && value.endpoint === stage.endpoint);
    assert.ok(reference, stage.name);
    for (const phase of ['before', 'after']) {
      const nativeRows = reference[phase].database.baseItems.filter(row => !originalNative.has(idKey(row.Id)));
      const nodeRows = stage[phase].database.BaseItems.filter(row => !originalNode.has(idKey(row.Id)));
      assert.deepEqual(sortRows(nodeRows), sortRows(nativeRows), stage.name + ':' + phase);
      for (const [rows, final] of [[nativeRows, nativeCreated], [nodeRows, nodeCreated]]) for (const row of rows) {
        const saved = final.find(value => idKey(value.Id) === idKey(row.Id));
        for (const column of ['DateCreated', 'DateModified']) assert.equal(dateTicks(row[column]), dateTicks(saved[column]));
      }
    }
  }
  const nativeRow = nativeCreated.find(row => row.Name === '2026');
  const relative = nativeRow.Path.slice('%MetadataPath%'.length);
  const nativePrefix = response('create Year').bodyJson.Path.slice(0, -relative.length);
  const nodePrefix = path.join(actual.programDataDirectory, 'metadata');
  const normalize = (value, rows, prefix, serverId, status) => projectItemBody(value, { serverId, status,
    path: entry => entry === prefix || entry.startsWith(prefix + path.sep) ? '$metadata' + entry.slice(prefix.length) : entry,
    date: (entry, { field, owner }) => {
      const row = rows.find(row => idKey(row.Id) === idKey(owner.Id));
      if (field === 'DateCreated' && row) {
        assert.equal(dateTicks(entry), dateTicks(row.DateCreated)); return '$directory-time';
      }
      return dateText(entry);
    },
  });
  const responseProjection = (response, rows, prefix, serverId, status) => {
    const value = normalize(response, rows, prefix, serverId, status);
    if (value?.status !== 400 || value.title !== 'One or more validation errors occurred.'
      || value.type !== 'https://tools.ietf.org/html/rfc9110#section-15.5.1' || !value.errors || Array.isArray(value.errors)) return value;
    // These two framework validation templates describe the same rejected
    // value. Keep the field, attempted value, number of errors and full raw
    // response; English wording alone does not change the request outcome.
    return { ...value, errors: Object.fromEntries(Object.entries(value.errors).map(([field, errors]) => [field,
      Array.isArray(errors) ? errors.map(message => typeof message === 'string'
        ? message.replace(/^The value ('[\s\S]*') is (?:not valid|invalid)\.$/u, 'The value $1 is not valid.')
        : message) : errors,
    ])) };
  };
  const differences = [];
  for (const item of actual.cases) for (const endpoint of item.endpoints) {
    const reference = http.records.find(record => record.name === item.name && record.endpoint === endpoint.endpoint);
    try {
      assert.equal(endpoint.response.status, reference.response.status);
      assert.equal(endpoint.response.contentType, reference.response.contentType);
      if (Object.hasOwn(reference.response, 'bodyJson')) {
        assert.deepEqual(responseProjection(endpoint.response.body, nodeCreated, nodePrefix, actual.serverId, endpoint.response.status),
          responseProjection(reference.response.bodyJson, nativeCreated, nativePrefix, nativeServerId, reference.response.status));
      } else assert.equal(endpoint.response.bodyText, reference.response.bodyText);
    } catch (error) { differences.push({ name: item.name, message: error.message }); }
  }
  await writeFile(path.join(root, 'postgres-comparison.json'), json({ passed: differences.length === 0,
    phaseAcceptance: false, releaseAcceptance: false, responses: 21, createdIds: nativeCreated.map(row => row.Id),
    nodeDirectoryTimes: [...nodeTimes], differences,
    boundary: 'Complete Year detail HTTP and created-row columns with per-request transitions and independently bound directory timestamps. Isolated metadata roots, ServerId, opaque traceId and the equivalent English ModelState invalid/not-valid templates are projected. ModelState field, attempted value, error count, HTTP status and original response are preserved. The Years list, exchange continuation and full-instance acceptance are separate.' }), { flag: 'wx' });
  assert.deepEqual(actual.beforeReads.BaseItems, actual.afterReads.BaseItems.filter(row => originalNode.has(idKey(row.Id))));
  for (const [name, rows] of Object.entries(actual.beforeReads)) if (name !== 'BaseItems') assert.deepEqual(actual.afterReads[name], rows, name);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterReads);
  assert.deepEqual(actual.afterReads, actual.afterShutdown);
  assert.deepEqual(actual.filesystemAfterReads, actual.filesystemAfterShutdown);
  assert.ok(Object.values(actual.cleanup).every(Boolean));
  assert.deepEqual(differences, []);
}));
