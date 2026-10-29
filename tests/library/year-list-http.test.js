import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getNewItemId } from '../../src/core/identity.js';
import { tableDefinition } from '../../src/database/model.js';
import { dateText, dateTicks, idKey } from '../../src/library/records.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { currentUserViewScenario, userViewEvidenceJson as json } from '../helpers/current-user-view-scenario.js';
import { createFixtureIdentityProjector, projectItemDataIdentities } from '../helpers/fixture-identity-projection.js';
import { projectItemBody } from '../helpers/http-body-projection.js';
import { recordItemFilterCandidate, validateFixture } from './item-filter-http-scenario.js';

const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE);
const nativeCallback = declareNativeHttpTestFile({ enabled });
const bytes = await readFile(new URL('./fixtures/year-list-http/input.json', import.meta.url));
const fixture = JSON.parse(bytes);
validateFixture(fixture);
const yearType = 'MediaBrowser.Controller.Entities.Year';
const tables = { BaseItems: 'baseItems', AncestorIds: 'ancestorIds', LinkedChildren: 'linkedChildren', ItemValues: 'itemValues',
  ItemValuesMap: 'itemValueLinks', UserData: 'userData', MediaStreamInfos: 'mediaStreamInfos', Peoples: 'peoples',
  PeopleBaseItemMap: 'peopleBaseItemMap', BaseItemImageInfos: 'baseItemImageInfos', BaseItemProviders: 'baseItemProviders',
  BaseItemMetadataFields: 'baseItemMetadataFields' };
const sorted = rows => [...rows].sort((left, right) => json(left).localeCompare(json(right), 'en'));
const fileTicks = value => BigInt(value) / 100n + 621355968000000000n;
const years = database => database.baseItems.filter(row => row.Type === yearType);

test('Years and CollectionFolder Items HTTP match Native sources, full DTOs, windows and complete committed state', {
  skip: !enabled, timeout: 300000,
}, nativeCallback(async t => {
  const { http, stages, caseStages, root, nativeServerId } = await currentUserViewScenario('year-list-http', bytes, { signal: t.signal });
  const nativePolicy = JSON.parse(await readFile(path.join(root, 'provenance.json'), 'utf8')).preparation.initialPolicy;
  assert.equal(typeof nativePolicy.EnableContentDeletion, 'boolean');
  assert.ok(Array.isArray(nativePolicy.EnableContentDeletionFromFolders));
  assert.equal(http.records.length, 66); assert.equal(caseStages.length, 66);
  assert.ok(http.records.slice(0, 53).every(record => record.route.startsWith('/Years?')));
  const nativeResponse = (name, endpoint = 'items') => http.records.find(record => record.name === name && record.endpoint === endpoint).response;
  const nativeStage = (name, endpoint = 'items') => caseStages.find(stage => stage.name === name && stage.endpoint === endpoint);
  const initial = new Set(stages.before.database.baseItems.map(row => idKey(row.Id)));
  const nativeCreated = stages.afterReads.database.baseItems.filter(row => !initial.has(idKey(row.Id)));
  assert.ok(nativeCreated.every(row => row.Type === yearType));
  assert.deepEqual(nativeStage('user sort rejects before creating years').after.database.baseItems, stages.before.database.baseItems);
  const cold = nativeStage('cold zero limit creates every positive year');
  assert.deepEqual(nativeResponse('cold zero limit creates every positive year').bodyJson.Items, []);
  assert.equal(nativeResponse('cold zero limit creates every positive year').bodyJson.TotalRecordCount, 130);
  assert.deepEqual(years(cold.after.database).filter(row => !initial.has(idKey(row.Id))).map(row => row.Name).sort(),
    Array.from({ length: 130 }, (_, index) => String(1900 + index)));
  const all = nativeResponse('direct API movies all').bodyJson;
  assert.equal(all.TotalRecordCount, 130); assert.equal(all.Items.length, 130);
  assert.deepEqual(all.Items.map(item => item.Name), Array.from({ length: 130 }, (_, index) => String(1900 + index)));
  assert.deepEqual(nativeResponse('direct API movies page').bodyJson.Items, all.Items.slice(123, 130));
  assert.equal(nativeResponse('negative start keeps public offset').bodyJson.StartIndex, -2);
  assert.deepEqual(nativeResponse('negative start keeps public offset').bodyJson.Items, all.Items.slice(0, 3));
  for (const name of ['negative take remains empty', 'beyond last', 'leaf mismatched type']) assert.deepEqual(nativeResponse(name).bodyJson.Items, []);
  const recursive = nativeResponse('recursive regular movies count occurrences').bodyJson;
  assert.ok(recursive.TotalRecordCount > recursive.Items.length);
  const apiRecursive = nativeResponse('recursive API movies distinct count').bodyJson;
  assert.equal(apiRecursive.TotalRecordCount, apiRecursive.Items.length);
  assert.deepEqual(recursive.Items.map(item => item.Id).sort(), apiRecursive.Items.map(item => item.Id).sort());
  assert.deepEqual(nativeResponse('named Year link keeps its stored production year').bodyJson.Items.map(item => item.Name), ['2077']);
  const ordinary = nativeResponse('unknown view direct').bodyJson;
  assert.ok(!ordinary.Items.some(item => ['2181', '2200'].includes(item.Name)));
  assert.ok(nativeResponse('ordinary view source applies collection grouping').bodyJson.Items.some(item => item.Name === '2181'));
  assert.deepEqual(nativeResponse('ordinary view source restores ungrouped children').bodyJson, ordinary);
  assert.ok(!nativeCreated.some(row => row.Name === '2200'));
  const failedAfterRandom = nativeStage('user sort after random retains created prefix');
  assert.ok(!years(failedAfterRandom.before.database).some(row => row.Name === '2199'));
  assert.ok(years(failedAfterRandom.after.database).some(row => row.Name === '2199'));
  for (const item of nativeResponse('full DTO with item counts stays untagged').bodyJson.Items) {
    for (const field of ['ChildCount', 'MovieCount', 'SeriesCount', 'EpisodeCount', 'SongCount', 'AlbumCount', 'ArtistCount']) assert.ok(!Object.hasOwn(item, field), field);
    assert.equal(item.CanDelete, false);
  }
  for (const item of nativeResponse('no user data').bodyJson.Items) assert.ok(!Object.hasOwn(item, 'UserData'));
  assert.deepEqual(stages.afterReads, stages.afterShutdown);
  const fixtureId = key => idKey(fixture.items.find(item => item.key === key).id);
  for (const endpoint of ['items', 'legacy']) {
    for (const name of ['collection Items excludes logical parent rows', 'collection Items excludes physical folder links']) {
      assert.deepEqual(nativeResponse(name, endpoint).bodyJson, { Items: [], TotalRecordCount: 0, StartIndex: 0 });
    }
    const physical = nativeResponse('collection Items keeps its physical child', endpoint).bodyJson;
    assert.equal(physical.TotalRecordCount, 1); assert.deepEqual(physical.Items.map(item => item.Id), [fixtureId('bulk-000')]);
    assert.deepEqual(nativeResponse('collection zero limit returns the full physical source', endpoint).bodyJson, physical);
    const linked = nativeResponse('collection Items includes its own link', endpoint).bodyJson;
    assert.equal(linked.TotalRecordCount, 2);
    assert.deepEqual(linked.Items.map(item => item.Id).sort(), [fixtureId('bulk-114'), fixtureId('disabled-movie')].sort());
    const page = nativeResponse('collection Items sorts and pages the combined source', endpoint).bodyJson;
    assert.equal(page.TotalRecordCount, 4); assert.equal(page.StartIndex, 1);
    assert.deepEqual(page.Items.map(item => item.Id), [fixtureId('bulk-001'), fixtureId('bulk-114')]);
  }
  const userlessCollection = nativeResponse('userless collection Items does not consume its own link').bodyJson;
  assert.equal(userlessCollection.TotalRecordCount, 1);
  assert.deepEqual(userlessCollection.Items.map(item => item.Id), [fixtureId('bulk-114')]);

  const nativeRows = stages.before.database.baseItems;
  const nativeMetadataRoot = path.join(path.dirname(nativeRows.find(row => row.Type === 'MediaBrowser.Controller.Entities.AggregateFolder').Path), 'metadata');
  const fixtureToNode = new Map(), nodeToFixture = new Map(), nativePaths = new Map(), nodePaths = new Map();
  const nodeTimes = new Map();
  let nodeDataRoot;
  const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture,
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName: 'year-list-http',
    fields: 'SortName',
    captureResponseBodies: true, captureErrorText: true, captureCaseRuntimeErrors: true,
    trackUserData: true, trackFilesystem: true, captureShutdownState: true, captureEndpointStages: true,
    captureFilesystemDomains: true,
    configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
    prepareScenario: async ({ database, programDataPath, user, users }) => {
      nodeDataRoot = programDataPath;
      const control = await users.createUser({ Name: 'Years fixture control' });
      const administrator = await users.getUser(control.Id);
      await users.updatePolicy(control.Id, { ...administrator.Policy, IsAdministrator: true });
      // Both recorders merge each partial policy with their initial user.
      // Bind deletion permissions to the actual Native login observation.
      Object.assign(user.Policy, { EnableContentDeletion: nativePolicy.EnableContentDeletion,
        EnableContentDeletionFromFolders: [...nativePolicy.EnableContentDeletionFromFolders] });
      await users.updatePolicy(user.Id, { ...user.Policy });
      for (const row of nativeRows) {
        if (row.Type !== 'MediaBrowser.Controller.Entities.UserView') continue;
        const data = JSON.parse(row.Data ?? '{}');
        if (!data.UserId) continue;
        assert.equal(idKey(data.UserId), idKey(fixture.userId));
        const id = getNewItemId(`38_namedview_${idKey(user.Id)}${data.ViewType}`,
          'MediaBrowser.Controller.Entities.UserView', { programDataPath: 'Z:\\OracleUserViews' });
        fixtureToNode.set(idKey(row.Id), id); nodeToFixture.set(idKey(id), row.Id);
      }
      const identities = new Map([[idKey(fixture.userId), user.Id], ...fixtureToNode]);
      const projection = createFixtureIdentityProjector({ identities, viewRows: nativeRows });
      const locations = { aggregate: path.join(programDataPath, 'root'), userRoot: path.join(programDataPath, 'root/default'),
        collections: path.join(programDataPath, 'data/collections') };
      for (const letter of ['A', 'B', 'T', 'K', 'M']) {
        locations['physical' + letter] = path.join(programDataPath, 'library-content', letter);
        locations['library' + letter] = path.join(programDataPath, 'root/default', 'Library ' + letter);
      }
      const itemPath = item => item.pathKind === 'noPath' ? null : locations[item.pathKind]
        ?? (item.pathKind === 'view' ? path.join(programDataPath, 'metadata/views', idKey(identities.get(idKey(item.id)) ?? item.id))
          : item.pathKind === 'named' ? path.join(programDataPath, 'metadata', item.type, item.name)
            : item.pathKind === 'boxset' ? path.join(programDataPath, 'data/collections', item.key)
              : path.join(itemPath(fixture.items.find(parent => idKey(parent.id) === idKey(item.parentId))),
                item.key + (item.type === 'Movie' ? '.mkv' : '')));
      const physicalPaths = new Map();
      for (const item of fixture.items) {
        const row = nativeRows.find(row => idKey(row.Id) === idKey(item.id)); assert.ok(row, item.key);
        const target = itemPath(item);
        if (typeof row.Path === 'string' && typeof target === 'string') {
          physicalPaths.set(row.Path, target); nativePaths.set(row.Path, '$fixture:' + item.key); nodePaths.set(target, '$fixture:' + item.key);
        }
      }
      const convert = (table, row) => Object.fromEntries(tableDefinition(table).columns
        .filter(column => !column.generated || Object.hasOwn(row, column.name)).map(column => {
          const value = row[column.name], type = column.clrType.replace('?', '');
          return [column.name, value == null ? null : type === 'bool' ? Boolean(value)
            : type === 'long' || type === 'uint' ? BigInt(value) : value];
        }));
      // Copy the complete observed source, including the warmed menu views.
      // Known identity/path inputs are rebound using the existing typed token
      // projector; opaque metadata and unrelated strings keep their bytes.
      for (const row of nativeRows) {
        const values = convert('BaseItems', projection.row('BaseItems', row));
        values.Data = projectItemDataIdentities(values.Data, row.Type, new Map(), { paths: physicalPaths });
        if (physicalPaths.has(row.Path)) values.Path = physicalPaths.get(row.Path);
        await database.upsert('BaseItems', values);
      }
      for (const [table, name] of Object.entries(tables)) if (table !== 'BaseItems') {
        for (const row of stages.before.database[name]) await database.upsert(table, convert(table, projection.row(table, row)));
      }
      const reboundFilesystem = projection.snapshot({ database: {}, filesystem: stages.before.filesystem }).filesystem;
      for (const [domain, relative] of Object.entries({ userViews: 'root/default', metadata: 'metadata', libraries: 'library-content', collections: 'data/collections' })) {
        const source = reboundFilesystem[domain], directory = path.join(programDataPath, relative);
        if (source.exists) await mkdir(directory, { recursive: true });
        for (const entry of source.entries) {
          const target = path.join(directory, ...entry.path.split('/'));
          assert.ok(target.startsWith(directory + path.sep));
          if (entry.type === 'directory') await mkdir(target, { recursive: true });
          else {
            assert.ok(entry.path.endsWith('.collection'), 'Unexpected Native input file: ' + entry.path);
            await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, '');
          }
        }
      }
    },
    afterEndpoint: async ({ runtime, database }) => {
      for (const row of await database.rows('BaseItems', { where: { Type: yearType } })) {
        if (initial.has(idKey(row.Id)) || nodeTimes.has(idKey(row.Id))) continue;
        const directory = runtime.library.options.expandPath(row.Path);
        assert.ok(directory.startsWith(path.join(nodeDataRoot, 'metadata') + path.sep));
        const info = await stat(directory, { bigint: true });
        nodeTimes.set(idKey(row.Id), { birthtimeNs: String(info.birthtimeNs), mtimeNs: String(info.mtimeNs) });
      }
    },
  });
  await writeFile(path.join(root, 'postgres.json'), json(actual), { flag: 'wx' });
  for (const testCase of fixture.cases.filter(item => item.policy)) {
    const policy = actual.cases.find(item => item.name === testCase.name).policyReadback;
    assert.ok(policy, testCase.name);
    assert.equal(policy.EnableContentDeletion, nativePolicy.EnableContentDeletion, testCase.name);
    assert.deepEqual(policy.EnableContentDeletionFromFolders, nativePolicy.EnableContentDeletionFromFolders, testCase.name);
  }
  const nodeOriginal = new Set(actual.beforeReads.BaseItems.map(row => idKey(row.Id)));
  const nodeCreated = actual.afterReads.BaseItems.filter(row => !nodeOriginal.has(idKey(row.Id)));
  const nodeIdentity = createFixtureIdentityProjector({ identities: new Map([
    [idKey(actual.userId), fixture.userId], ...nodeToFixture,
  ]), viewRows: actual.afterReads.BaseItems });
  const yearRow = rows => new Map(rows.filter(row => row.Type === yearType).map(row => [idKey(row.Id), row]));
  const nativeYearRows = yearRow(nativeCreated), nodeYearRows = yearRow(nodeCreated);
  for (const [rows, time] of [[nativeCreated, row => stages.afterReads.filesystem.metadata.entries.find(entry => entry.path
    === row.Path.slice('%MetadataPath%'.length).replaceAll('\\', '/').replace(/^\//u, ''))], [nodeCreated, row => nodeTimes.get(idKey(row.Id))]]) {
    for (const row of rows) {
      assert.equal(row.Type, yearType); const info = time(row); assert.ok(info, row.Name);
      assert.equal(dateTicks(row.DateCreated), fileTicks(info.birthtimeNs));
      assert.equal(dateTicks(row.DateModified), fileTicks(info.mtimeNs));
    }
  }
  const projectRow = (table, source, node) => {
    const row = node ? nodeIdentity.row(table, source) : source;
    const paths = node ? nodePaths : nativePaths, created = table === 'BaseItems' && (node ? nodeYearRows : nativeYearRows).get(idKey(row.Id));
    return Object.fromEntries(tableDefinition(table).columns.filter(column => Object.hasOwn(row, column.name)).map(column => {
      let value = row[column.name]; const type = column.clrType.replace('?', '');
      if (created && ['DateCreated', 'DateModified'].includes(column.name)) {
        assert.equal(dateTicks(value), dateTicks(created[column.name])); value = '$directory-time';
      } else if (value != null) {
        if (column.name === 'Data' && table === 'BaseItems') value = projectItemDataIdentities(value, row.Type, new Map(), { paths });
        else if (column.name === 'Path' && table === 'BaseItems') value = paths.get(value) ?? value;
        else if (type === 'Guid') value = idKey(value);
        else if (type === 'bool') value = Boolean(value);
        else if (type === 'long' || type === 'uint') value = String(value);
        else if (type === 'DateTime') value = dateText(value);
      }
      return [column.name, value];
    }));
  };
  const snapshot = (database, node, userData) => Object.fromEntries(Object.entries(tables).map(([table, native]) => [table,
    sorted((node && table === 'UserData' ? userData : database[node ? table : native])
      .map(row => projectRow(table, row, node)))]));
  const fsShape = filesystem => Object.fromEntries(Object.entries(filesystem).map(([domain, value]) => [domain,
    { exists: value.exists, entries: value.entries.map(({ path: entryPath, type }) => ({ path: entryPath, type }))
      .sort((left, right) => left.path.localeCompare(right.path, 'en')) }]));
  const nodeFilesystem = filesystem => fsShape(nodeIdentity.snapshot({ database: {}, filesystem }).filesystem);
  const normalize = (value, node, status) => {
    const rows = node ? nodeYearRows : nativeYearRows;
    const metadataRoot = node ? path.join(nodeDataRoot, 'metadata') : nativeMetadataRoot;
    const body = projectItemBody(node ? nodeIdentity.body(value) : value, { status, serverId: node ? actual.serverId : nativeServerId,
      path: entry => (node ? nodePaths : nativePaths).get(entry)
        ?? (entry.startsWith(metadataRoot + path.sep) ? '$metadata' + entry.slice(metadataRoot.length) : entry),
      date: (entry, { field, owner }) => {
        const row = rows.get(idKey(owner.Id));
        if (row && field === 'DateCreated') { assert.equal(dateTicks(entry), dateTicks(row.DateCreated)); return '$directory-time'; }
        return dateText(entry);
      },
    });
    if (body?.status !== 400 || body.title !== 'One or more validation errors occurred.'
      || body.type !== 'https://tools.ietf.org/html/rfc9110#section-15.5.1' || !body.errors || Array.isArray(body.errors)) return body;
    // Keep the existing narrow ModelState wording equivalence, including its
    // field, rejected value and error count. Raw response bytes remain saved.
    return { ...body, errors: Object.fromEntries(Object.entries(body.errors).map(([field, errors]) => [field,
      Array.isArray(errors) ? errors.map(message => typeof message === 'string'
        ? message.replace(/^The value ('[\s\S]*') is (?:not valid|invalid)\.$/u, 'The value $1 is not valid.') : message) : errors])) };
  };
  const differences = [];
  const compare = (label, operation) => { try { operation(); } catch (error) { differences.push({ label, message: error.message }); } };
  compare('input', () => assert.deepEqual(snapshot(actual.beforeReads, true, actual.userDataBeforeReads), snapshot(stages.before.database, false)));
  compare('input-filesystem', () => assert.deepEqual(nodeFilesystem(actual.filesystemDomainsBeforeReads), fsShape(stages.before.filesystem)));
  for (const item of actual.cases) for (const endpoint of item.endpoints) {
    const reference = nativeResponse(item.name, endpoint.endpoint), response = endpoint.response;
    const input = fixture.cases.find(testCase => testCase.name === item.name);
    compare(item.name + ':' + endpoint.endpoint + ':http', () => {
      assert.equal(response.status, reference.status); assert.equal(response.contentType, reference.contentType);
      if (input.randomWindow) {
        const native = normalize(reference.bodyJson, false, reference.status), node = normalize(response.body, true, response.status);
        const baseline = normalize(nativeResponse(input.baseline).bodyJson, false, 200);
        assert.equal(native.StartIndex, 0); assert.equal(node.StartIndex, native.StartIndex);
        assert.equal(native.TotalRecordCount, 130); assert.equal(node.TotalRecordCount, native.TotalRecordCount);
        for (const page of [native, node]) {
          assert.equal(page.Items.length, 5); assert.equal(new Set(page.Items.map(item => item.Id)).size, 5);
          for (const member of page.Items) assert.deepEqual(member, baseline.Items.find(item => item.Id === member.Id));
        }
      } else if (Object.hasOwn(reference, 'bodyJson')) assert.deepEqual(normalize(response.body, true, response.status), normalize(reference.bodyJson, false, reference.status));
      else assert.equal(response.bodyText, reference.bodyText);
    });
  }
  for (const stage of actual.caseStages) {
    const reference = nativeStage(stage.name, stage.endpoint); assert.ok(reference);
    for (const phase of ['before', 'after']) {
      compare(stage.name + ':' + stage.endpoint + ':' + phase + ':database', () => assert.deepEqual(
        snapshot(stage[phase].database, true, stage[phase].userData), snapshot(reference[phase].database, false)));
      compare(stage.name + ':' + stage.endpoint + ':' + phase + ':filesystem', () => assert.deepEqual(nodeFilesystem(stage[phase].filesystemDomains), fsShape(reference[phase].filesystem)));
    }
  }
  compare('final', () => assert.deepEqual(snapshot(actual.afterReads, true, actual.userDataAfterReads), snapshot(stages.afterReads.database, false)));
  await writeFile(path.join(root, 'postgres-comparison.json'), json({ passed: differences.length === 0, responses: 66,
    phaseAcceptance: false, releaseAcceptance: false, createdYears: nativeCreated.map(row => row.Name), nodeDirectoryTimes: [...nodeTimes], differences,
    boundary: 'All original 53 Years requests plus 13 CollectionFolder Items/legacy controls, complete ordered HTTP DTOs, count/window values, every captured table and per-request persisted prefix, plus all filesystem domains. This input adds an explicit CollectionFolder own link to existing media outside its physical children; the full new graph is recorded and does not replace earlier evidence. Warm menu input, typed fixture identities and declared path inputs are aligned. Newly created Year timestamps bind to their actual directories; unknown Data TEXT remains byte exact. Existing equivalent English ModelState invalid/not-valid templates and opaque ProblemDetails trace IDs retain their established narrow scope.' }), { flag: 'wx' });
  assert.deepEqual(actual.afterReads, actual.afterShutdown);
  assert.deepEqual(actual.filesystemAfterReads, actual.filesystemAfterShutdown);
  assert.deepEqual(actual.filesystemDomainsAfterReads, actual.filesystemDomainsAfterShutdown);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterReads);
  assert.ok(Object.values(actual.cleanup).every(Boolean));
  assert.deepEqual(differences, []);
}));
