import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getNewItemId } from '../../src/core/identity.js';
import { idKey } from '../../src/library/records.js';
import { tableDefinition } from '../../src/database/model.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { currentUserViewScenario, userViewEvidenceJson as json } from '../helpers/current-user-view-scenario.js';
import { recordItemFilterCandidate, validateFixture } from './item-filter-http-scenario.js';
import { projectSingleSourceName } from '../helpers/single-source-name-projection.js';
import { projectItemBody } from '../helpers/http-body-projection.js';
import { createFixtureIdentityProjector, projectItemDataIdentities } from '../helpers/fixture-identity-projection.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE) });
const bytes = await readFile(new URL('./fixtures/suggestions-http/input.json', import.meta.url));
const fixture = JSON.parse(bytes);
validateFixture(fixture);

test('Suggestions HTTP match Native membership, permissions, complete DTOs, counts and random windows without changing persisted state', {
  skip: !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE || !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 300000,
}, nativeCallback(async t => {
  const { http, stages, root, nativeServerId } = await currentUserViewScenario('suggestions-http', bytes, { signal: t.signal });
  assert.equal(http.records.length, 45);
  assert.deepEqual(stages.before, stages.afterReads); assert.deepEqual(stages.afterReads, stages.afterShutdown);
  const nodeToFixture = new Map(), fixtureToNode = new Map();
  const nativeRows = stages.before.database.baseItems;
  const sourceNames = [], sourceItems = nativeRows.map(row => ({ id: row.Id, path: row.Path }));
  const nativeResponse = (name, endpoint = 'items') => http.records.find(record => record.name === name && record.endpoint === endpoint).response;
  const nativeAll = nativeResponse('global regular all').bodyJson.Items;
  const fixtureItem = key => fixture.items.find(item => item.key === key);
  const nativePath = key => nativeAll.find(item => idKey(item.Id) === idKey(fixtureItem(key).id)).Path;
  const nativeDataRoot = path.dirname(nativePath('aggregate')), nativeLibraryRoot = path.dirname(nativePath('physicalA'));
  let nodeDataRoot;
  const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture,
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName: 'suggestions-http',
    captureResponseBodies: true, captureErrorText: true, captureCaseRuntimeErrors: true,
    trackUserData: true, trackFilesystem: true, captureShutdownState: true,
    configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
    prepareScenario: async ({ database, programDataPath, user, users }) => {
      nodeDataRoot = programDataPath;
      // The Native recorder retains a control administrator before demoting
      // the selected user. Preserve that real last-admin precondition here.
      const control = await users.createUser({ Name: 'SuggestionsControlAdmin' });
      const current = await users.getUser(control.Id);
      await users.updatePolicy(control.Id, { ...current.Policy, IsAdministrator: true });
      for (const row of nativeRows) {
        if (row.Type !== 'MediaBrowser.Controller.Entities.UserView') continue;
        const data = JSON.parse(row.Data ?? '{}');
        if (!data.UserId) continue;
        assert.equal(idKey(data.UserId), idKey(fixture.userId));
        const id = getNewItemId(`38_namedview_${idKey(user.Id)}${data.ViewType}`,
          'MediaBrowser.Controller.Entities.UserView', { programDataPath: 'Z:\\OracleUserViews' });
        fixtureToNode.set(idKey(row.Id), id);
        nodeToFixture.set(idKey(id), row.Id);
      }
      const identities = new Map([[idKey(fixture.userId), user.Id], ...fixtureToNode]);
      const projection = createFixtureIdentityProjector({ identities, viewRows: nativeRows });
      const roots = { aggregate: path.join(programDataPath, 'root'), userRoot: path.join(programDataPath, 'root/default') };
      for (const letter of ['A', 'B', 'T', 'K', 'M']) {
        roots['physical' + letter] = path.join(programDataPath, 'library-content', letter);
        roots['library' + letter] = path.join(programDataPath, 'root/default', 'Library ' + letter);
      }
      const itemPath = item => item.pathKind === 'noPath' ? null : roots[item.pathKind] ?? path.join(
        itemPath(fixture.items.find(parent => idKey(parent.id) === idKey(item.parentId))),
        item.key + (item.type === 'Movie' ? '.mkv' : ''));
      const physicalPaths = new Map(fixture.items.filter(item => item.pathKind).flatMap(item => {
        const original = nativeRows.find(row => idKey(row.Id) === idKey(item.id))?.Path;
        const target = itemPath(item);
        return typeof original === 'string' && typeof target === 'string' ? [[original, target]] : [];
      }));
      const convert = (table, row) => Object.fromEntries(tableDefinition(table).columns
        .filter(column => !column.generated || Object.hasOwn(row, column.name)).map(column => {
          const value = row[column.name], type = column.clrType.replace('?', '');
          return [column.name, value == null ? null : type === 'Guid' ? value
            : type === 'bool' ? Boolean(value) : type === 'long' || type === 'uint' ? BigInt(value) : value];
        }));
      // Global userless suggestions include the real seed's system/media rows.
      // Copy the complete observed input, rather than silently narrowing the
      // production query to fixture ids.
      for (const row of nativeRows) {
        const values = convert('BaseItems', projection.row('BaseItems', row)), item = fixture.items.find(item => idKey(item.id) === idKey(row.Id));
        values.Data = projectItemDataIdentities(values.Data, row.Type, new Map(), { paths: physicalPaths });
        if (item) {
          values.Path = itemPath(item);
          if (item.isFolder !== false && values.Path) await mkdir(values.Path, { recursive: true });
          if (item.type === 'CollectionFolder' && item.data.CollectionType) {
            await writeFile(path.join(values.Path, item.data.CollectionType + '.collection'), '');
          }
        }
        await database.upsert('BaseItems', values);
      }
      const relations = { AncestorIds: 'ancestorIds', LinkedChildren: 'linkedChildren', ItemValues: 'itemValues',
        ItemValuesMap: 'itemValueLinks', MediaStreamInfos: 'mediaStreamInfos', Peoples: 'peoples',
        PeopleBaseItemMap: 'peopleBaseItemMap', BaseItemImageInfos: 'baseItemImageInfos',
        BaseItemProviders: 'baseItemProviders', BaseItemMetadataFields: 'baseItemMetadataFields', UserData: 'userData' };
      for (const [table, name] of Object.entries(relations)) for (const row of stages.before.database[name]) {
        await database.upsert(table, convert(table, projection.row(table, row)));
      }
    },
  });
  await writeFile(path.join(root, 'postgres.json'), json(actual), { flag: 'wx' });
  const paths = prefix => [[prefix === nativeDataRoot ? nativeLibraryRoot : path.join(prefix, 'library-content'), '$library'], [prefix, '$instance']];
  const nodeIdentityProjection = createFixtureIdentityProjector({ identities: nodeToFixture, viewRows: actual.beforeReads.BaseItems });
  const normalize = (value, prefix, identities = new Map(), status = 200) => projectItemBody(identities.size ? nodeIdentityProjection.body(value) : value, {
    status,
    serverId: prefix === nativeDataRoot ? nativeServerId : actual.serverId,
    item: value => projectSingleSourceName(value, sourceItems, prefix === nativeDataRoot, sourceNames, 'Suggestions single stored file'),
    path: value => {
      for (const [source, target] of paths(prefix)) if (value.startsWith(source + path.sep) || value === source) return target + value.slice(source.length);
      return value;
    },
  });
  const sortItems = items => [...items].sort((left, right) => left.Id.localeCompare(right.Id));
  const nodeResponse = (name, endpoint = 'items') => actual.cases.find(item => item.name === name).endpoints.find(item => item.endpoint === endpoint).response;
  const difference = [];
  for (const testCase of fixture.cases) for (const endpoint of testCase.endpoints) {
    try {
      const expected = nativeResponse(testCase.name, endpoint), observed = nodeResponse(testCase.name, endpoint);
      assert.equal(observed.status, expected.status); assert.equal(observed.contentType, expected.contentType);
      if (!Object.hasOwn(expected, 'bodyJson')) { assert.equal(observed.bodyText, expected.bodyText); continue; }
      const native = normalize(expected.bodyJson, nativeDataRoot, new Map(), expected.status),
        node = normalize(observed.body, nodeDataRoot, nodeToFixture, observed.status);
      if (observed.status !== 200) { assert.deepEqual(node, native); continue; }
      assert.equal(node.StartIndex, native.StartIndex); assert.equal(node.TotalRecordCount, native.TotalRecordCount);
      assert.equal(node.Items.length, native.Items.length);
      for (const items of [native.Items, node.Items]) assert.equal(new Set(items.map(item => item.Id)).size, items.length);
      if (!testCase.window) { assert.deepEqual(sortItems(node.Items), sortItems(native.Items)); continue; }
      const baselineEndpoint = endpoint === 'legacy' && testCase.baseline === 'explicit movies' ? 'legacy' : 'items';
      const nativeBaseline = normalize(nativeResponse(testCase.baseline, baselineEndpoint).bodyJson, nativeDataRoot);
      const nodeBaseline = normalize(nodeResponse(testCase.baseline, baselineEndpoint).body, nodeDataRoot, nodeToFixture);
      assert.deepEqual(sortItems(nodeBaseline.Items), sortItems(nativeBaseline.Items));
      for (const page of [native, node]) for (const item of page.Items) {
        assert.deepEqual(item, nativeBaseline.Items.find(candidate => candidate.Id === item.Id));
      }
    } catch (error) { difference.push({ name: testCase.name, endpoint, message: error.message }); }
  }
  const returnedIds = name => nativeResponse(name).bodyJson.Items.map(item => item.Id);
  const movies = returnedIds('global movies'), scoped = returnedIds('explicit movies');
  for (const key of ['movie-a', 'movie-duplicate', 'movie-b', 'movie-orphan', 'movie-extra']) assert.ok(movies.includes(idKey(fixtureItem(key).id)));
  for (const key of ['movie-virtual', 'movie-alternate', 'movie-owned']) assert.ok(!movies.includes(idKey(fixtureItem(key).id)));
  assert.ok(scoped.includes(idKey(fixtureItem('movie-a').id)));
  for (const key of ['movie-duplicate', 'movie-b', 'movie-orphan']) assert.ok(!scoped.includes(idKey(fixtureItem(key).id)));
  const full = nativeResponse('explicit movies').bodyJson.Items.find(item => item.Id === idKey(fixtureItem('movie-a').id));
  assert.equal(full.Overview, fixtureItem('movie-a').overview); assert.equal(full.UserData.IsFavorite, true);
  assert.equal(full.UserData.PlayCount, 4); assert.equal(full.RunTimeTicks, 900000001);
  assert.ok(Object.hasOwn(full, 'Path')); assert.ok(Object.hasOwn(full, 'Etag')); assert.ok(Object.hasOwn(full, 'MediaSources'));
  for (const name of ['global API all', 'zero regular all', 'missing user API all']) assert.deepEqual(
    sortItems(normalize(nativeResponse(name).bodyJson.Items, nativeDataRoot)), sortItems(normalize(nativeAll, nativeDataRoot)));
  assert.deepEqual(actual.beforeReads, actual.afterReads); assert.deepEqual(actual.afterReads, actual.afterShutdown);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterReads); assert.deepEqual(actual.filesystemBeforeReads, actual.filesystemAfterReads);
  assert.deepEqual(actual.filesystemAfterReads, actual.filesystemAfterShutdown);
  assert.ok(Object.values(actual.cleanup).every(Boolean));
  await writeFile(path.join(root, 'postgres-comparison.json'), json({ passed: difference.length === 0,
    phaseAcceptance: false, releaseAcceptance: false, responses: 45, differences: difference, sourceNames,
    boundary: 'Fresh designated Native and PG production HTTP; full unbounded DTO sets, meaningful random window membership/counts and independent state stability. Random order and sampled member equality are not asserted between implementations. User/root/view identities, isolated filesystem prefixes, ServerId and opaque traceId are bound projections. Single-source display labels are independently bound to the same persistent file before projecting host path spelling; multiple-source labels and source identity/state remain compared. Cold UserView creation and complete-instance acceptance remain separate.' }), { flag: 'wx' });
  assert.deepEqual(difference, []);
}));
