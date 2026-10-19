import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tableDefinition } from '../../src/database/model.js';
import { dateText, dateTicks, idKey, MIN_DATE } from '../../src/library/records.js';
import { recordUserViewsCandidate } from './user-views-http-scenario.js';
import { loadUserViewsNativeContract } from './fixtures/user-views/native-contract.js';
import { projectStatePath, projectStateMacroPath } from './fixture-state-path.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const bytes = await readFile(new URL('./fixtures/user-views/input.json', import.meta.url));
const fixture = JSON.parse(bytes), contract = await loadUserViewsNativeContract();
const { native, nativeCases, http, summary, manifest } = contract;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
assert.equal(summary.passed, true); assert.equal(summary.candidateVerified, false); assert.equal(summary.phaseAcceptance, false);
assert.equal(summary.cases, 108); assert.equal(summary.snapshots, 108); assert.equal(summary.portAvailable, true);
assert.deepEqual(summary.processResult, { code: 0, signal: null });
assert.equal(sha256(bytes), summary.fixtureSha256); assert.equal(sha256(bytes), manifest.sourceFiles['input.json'].sha256);
assert.equal(summary.recorderSha256, manifest.sourceFiles['record-native.mjs'].sha256);
const initialDatabaseHash = 'f548d2699c29900b51f88746eaf1114bee7b3b43a5286f318af78fa9e855657b';
assert.equal(manifest.sourceFiles['initial.db'].sha256, initialDatabaseHash);
assert.deepEqual(native.afterReads, native.afterShutdown); assert.equal(native.before.database.baseItems.length, 47);
assert.equal(native.afterReads.database.baseItems.length, 64); assert.equal(http.length, 108); assert.equal(nativeCases.length, 108);
const originalIds = new Set(native.before.database.baseItems.map(row => idKey(row.Id)));
const fresh = rows => rows.filter(row => !originalIds.has(idKey(row.Id)));
const newIds = new Set(fresh(native.afterReads.database.baseItems).map(row => idKey(row.Id)));
const columns = tableDefinition('BaseItems').columns, clocks = new Set(['DateCreated', 'DateLastSaved', 'DateLastRefreshed']);
const originalValueIds = new Set(native.before.database.itemValues.map(row => idKey(row.ItemValueId)));
const relationTables = { ancestorIds: 'AncestorIds', linkedChildren: 'LinkedChildren', itemValues: 'ItemValues',
  itemValueLinks: 'ItemValuesMap', userData: 'UserData', images: 'BaseItemImageInfos', providers: 'BaseItemProviders',
  lockedFields: 'BaseItemMetadataFields', peoples: 'Peoples', peopleLinks: 'PeopleBaseItemMap', mediaStreams: 'MediaStreamInfos', chapters: 'Chapters' };
const stable = rows => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
const dialects = process.env.MEDIAMANAGER_USER_VIEWS_DIALECT ? [process.env.MEDIAMANAGER_USER_VIEWS_DIALECT] : ['postgres'];
assert.ok(dialects.every(value => ['postgres'].includes(value)));

function normalize(value, root) {
  if (Array.isArray(value)) return value.map(entry => normalize(entry, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    key === 'ServerId' ? '$server' : normalize(entry, root)]));
  return typeof value === 'string' ? projectStatePath(value, root, '$instance') : typeof value === 'bigint' ? value.toString() : value;
}
function rowContract(row, root, final) {
  const data = JSON.parse(row.Data ?? '{}');
  if (newIds.has(idKey(row.Id))) delete data.DateLastSaved;
  return Object.fromEntries(columns.filter(column => !newIds.has(idKey(row.Id)) || !clocks.has(column.name)
    && (final || !['DateModified', 'PresentationUniqueKey'].includes(column.name))).map(column => {
    const value = column.name === 'Path' ? projectStateMacroPath(row[column.name], root) : row[column.name], type = column.clrType.replace('?', '');
    return [column.name, column.name === 'Data' ? normalize(data, root) : value == null ? value
      : type === 'Guid' ? idKey(value) : type === 'bool' ? Boolean(value) : type === 'long' ? String(value) : normalize(value, root)];
  }));
}
const rowsContract = (rows, root, final) => stable(rows.map(row => rowContract(row, root, final)));
function relationContract(key, snapshot, root) {
  if (key === 'foreignKeyCheck') return stable(normalize(snapshot[key], root));
  const values = new Map(snapshot.itemValues.filter(row => !originalValueIds.has(idKey(row.ItemValueId)))
    .map(row => {
      assert.equal(row.Type, 6, 'Only the recorded new inherited-tag value has a generated UUID.');
      return [idKey(row.ItemValueId), `$generated-value:${row.Type}:${row.Value}:${row.CleanValue}`];
    }));
  return stable(snapshot[key].map(row => Object.fromEntries(tableDefinition(relationTables[key]).columns.map(column => {
    const value = row[column.name], type = column.clrType.replace('?', '');
    return [column.name, value == null ? value : column.name === 'ItemValueId' && values.has(idKey(value)) ? values.get(idKey(value))
      : type === 'Guid' ? idKey(value) : type === 'bool' ? Boolean(value) : type === 'long' ? String(value) : normalize(value, root)];
  }))));
}
function clockContract(rows) {
  return fresh(rows).map(row => {
    assert.ok(dateTicks(row.DateCreated) > 0n, row.Name + ' created');
    assert.ok(dateTicks(row.DateLastSaved) > 0n, row.Name + ' saved');
    assert.ok(dateTicks(row.DateCreated) <= dateTicks(row.DateLastSaved), row.Name + ' creation/save order');
    assert.equal(dateTicks(JSON.parse(row.Data).DateLastSaved), dateTicks(row.DateLastSaved), row.Name + ' Data saved stamp');
    if (row.DateLastRefreshed != null) {
      assert.ok(dateTicks(row.DateLastRefreshed) > 0n, row.Name + ' refreshed');
      assert.ok(dateTicks(row.DateLastRefreshed) <= dateTicks(row.DateLastSaved), row.Name + ' refresh/save order');
    }
    return { Id: idKey(row.Id), created: row.DateCreated != null, saved: row.DateLastSaved != null,
      refreshed: row.DateLastRefreshed != null };
  }).sort((a, b) => a.Id.localeCompare(b.Id, 'en'));
}
// Native BaseItem.GetEtag hashes DateLastSaved.Ticks as UTF-16LE and formats a GUID.
function etag(stamp) {
  const bytes = createHash('md5').update(Buffer.from(String(dateTicks(stamp ?? MIN_DATE)), 'utf16le')).digest();
  const result = Buffer.from(bytes); result.writeUInt32BE(bytes.readUInt32LE(0), 0); result.writeUInt16BE(bytes.readUInt16LE(4), 4); result.writeUInt16BE(bytes.readUInt16LE(6), 6);
  return result.toString('hex');
}
function bodyContract(response, stage, allStages, root, { nativeTransientEtags } = {}) {
  const body = structuredClone(response.bodyJson), byId = new Map(stage.after.database.baseItems.map(row => [idKey(row.Id), row]));
  for (const item of body.Items ?? []) if (newIds.has(idKey(item.Id))) {
    const row = byId.get(idKey(item.Id)); assert.ok(row, item.Name + ' persisted');
    assert.equal(dateTicks(item.DateCreated), dateTicks(row.DateCreated), item.Name + ' DTO creation ticks');
    const stamps = new Set([etag(MIN_DATE)]);
    const currentIndex = allStages.indexOf(stage);
    assert.ok(currentIndex >= 0, 'The HTTP observation belongs to its recorded stage.');
    // Future snapshots cannot validate an Etag returned by this response.
    for (const state of allStages.slice(0, currentIndex + 1)) for (const candidate of [state.before, state.after]) {
      const saved = candidate.database.baseItems.find(value => idKey(value.Id) === idKey(item.Id));
      if (saved) stamps.add(etag(saved.DateLastSaved));
    }
    assert.match(item.Etag, /^[a-f0-9]{32}$/u, item.Name + ' Etag GUID format');
    const beforeRow = stage.before.database.baseItems.find(value => idKey(value.Id) === idKey(item.Id));
    if (row.DateLastSaved == null) assert.equal(item.Etag, etag(MIN_DATE), item.Name + ' initial unsaved Etag');
    else if (row.DateLastRefreshed != null && beforeRow && dateTicks(beforeRow.DateLastSaved) === dateTicks(row.DateLastSaved)) {
      assert.equal(item.Etag, etag(row.DateLastSaved), item.Name + ' stable completed Etag');
    }
    if (!stamps.has(item.Etag)) {
      // Native UpdateItemsAsync mutates the shared cached item before and
      // after RunMetadataSavers. These recorded failed shadows retry on every
      // read; the intermediate cache clock can be returned without ever
      // appearing in an SQL snapshot. Candidate Etag still requires a real
      // observed saved stamp, and completed stable native views remain exact.
      assert.ok(nativeTransientEtags, item.Name + ' candidate Etag has an observed saved stamp');
      const data = JSON.parse(row.Data);
      assert.equal(row.DateLastRefreshed, null); assert.ok(!data.UserId);
      assert.ok(['movies', 'tvshows'].includes(data.ViewType));
      assert.ok(['Library A', 'Library B', 'Library T'].includes(row.Name));
      assert.ok(beforeRow && dateTicks(row.DateLastSaved) > dateTicks(beforeRow.DateLastSaved));
      nativeTransientEtags.push({ name: stage.name, endpoint: stage.endpoint, Id: item.Id, Name: item.Name, Etag: item.Etag,
        beforeSaved: beforeRow.DateLastSaved, afterSaved: row.DateLastSaved, refreshed: row.DateLastRefreshed,
        classification: 'native cached save stamp during a failed-view retry; SQL does not observe its intermediate clock' });
    }
    item.DateCreated = '$created'; item.Etag = '$observed-saved-etag';
  }
  return normalize(body, root);
}

for (const dialect of dialects) test(`${dialect}: GetUserViews 108 complete HTTP contracts and 17 persisted view lifecycles`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const output = process.env.MEDIAMANAGER_USER_VIEWS_EVIDENCE ? path.resolve(process.env.MEDIAMANAGER_USER_VIEWS_EVIDENCE)
    : path.join(validationOutputRoot(), 'user-views-' + randomUUID());
  let actual;
  try { actual = await recordUserViewsCandidate({ dialect, fixture, contract, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES }); }
  catch (error) {
    if (output) { await mkdir(output, { recursive: true }); await writeFile(path.join(output, dialect + '-failure.json'), json({ passed: false,
      phaseAcceptance: false, completeResponsesCaptured: false, candidate: error.candidateEvidence,
      error: { name: error.name, message: error.message, stack: error.stack } }), { flag: 'wx' }); }
    throw error;
  }
  const differences = [], nativeTransientEtags = [], check = (name, scope, operation) => { try { operation(); } catch (error) { differences.push({ name, scope, message: error.message }); } };
  const sourceAfter = await loadUserViewsNativeContract();
  check('source', 'tracked native projection unchanged', () => assert.deepEqual(sourceAfter.manifest, manifest));
  const compareStage = (name, candidate, reference, final = false) => {
    check(name, 'complete BaseItems contracts', () => assert.deepEqual(rowsContract(candidate.database.baseItems, actual.root, final), rowsContract(reference.database.baseItems, actual.referenceRoot, final)));
    for (const key of Object.keys(reference.database)) if (key !== 'baseItems') check(name, key, () => assert.deepEqual(relationContract(key, candidate.database, actual.root), relationContract(key, reference.database, actual.referenceRoot)));
    check(name, 'four filesystem domains', () => assert.deepEqual(candidate.filesystem, reference.filesystem));
  };
  compareStage('before', actual.before, native.before);
  for (const [index, expected] of http.entries()) {
    const observed = actual.records[index], candidateStage = actual.caseStages[index], referenceStage = nativeCases[index], name = expected.name + '/' + expected.endpoint;
    check(name, 'HTTP status and content type', () => assert.deepEqual([observed.response.status, observed.response.contentType], [expected.response.status, expected.response.contentType]));
    check(name, 'complete HTTP JSON and classified Etag/creation invariants', () => assert.deepEqual(bodyContract(observed.response, candidateStage, actual.caseStages, actual.root), bodyContract(expected.response, referenceStage, nativeCases, actual.referenceRoot, { nativeTransientEtags })));
    compareStage(name + '/before', candidateStage.before, referenceStage.before);
    compareStage(name + '/after', candidateStage.after, referenceStage.after);
  }
  compareStage('afterReads', actual.afterReads, native.afterReads, true); compareStage('afterShutdown', actual.afterShutdown, native.afterShutdown, true);
  check('final', 'actual dates and failure status', () => assert.deepEqual(clockContract(actual.afterReads.database.baseItems), clockContract(native.afterReads.database.baseItems)));
  check('final', 'three real null-user provider failures', () => {
    const failed = fresh(actual.afterReads.database.baseItems).filter(row => row.DateLastRefreshed == null);
    assert.deepEqual(failed.map(row => row.Name).sort(), ['Library A', 'Library B', 'Library T']);
    assert.ok(failed.every(row => !JSON.parse(row.Data).UserId));
    assert.ok(actual.runtimeErrors.length >= 3);
    // Background diagnostics retain their actual internal shape in the
    // artifact. Public errors are checked by the complete HTTP contracts.
  });
  check('cleanup', 'closed snapshot and resources', () => {
    assert.deepEqual(actual.afterReads, actual.afterShutdown);
    assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true, portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null, programDataDirectoryRemoved: true });
  });
  if (output) {
    await mkdir(output, { recursive: true }); await writeFile(path.join(output, dialect + '.json'), json(actual), { flag: 'wx' });
    await writeFile(path.join(output, dialect + '-comparison.json'), json({ passed: differences.length === 0, phaseAcceptance: false, dialect,
      responses: http.length, endpointSnapshots: nativeCases.length, newRows: fresh(actual.afterReads.database.baseItems).length,
      fixtureSha256: summary.fixtureSha256, recorderSha256: summary.recorderSha256,
      nativeProjection: manifest.projection, nativeSourceFiles: manifest.sourceFiles,
      harnessSha256: sha256(await readFile(new URL('./user-views-http-scenario.js', import.meta.url))), testSha256: sha256(await readFile(new URL(import.meta.url))),
      normalization: 'ServerId and isolated instance root; Guid casing/boolean/long representation follow storage contracts. The sole newly generated Type6 inherited-tag ItemValueId and its references use (Type,Value,CleanValue) graph identity because frozen ItemPersistenceService uses Guid.NewGuid; original value identities remain exact. New view DateCreated/DateLastSaved/DateLastRefreshed retain raw values and compare actual validity/order, Data saved equality and exact nullable failure status. HTTP DateCreated equals its stored row. New Etag retains raw values, validates GUID format, exact MIN hash while unsaved and exact saved hash on stable completed repeats. Candidate dynamic Etag must match an independently hashed observed saved stamp; only the explicitly recorded native A/B/T null-user failure retries with advancing SQL saved dates may have a transient cached Etag absent from SQL observations (LibraryManager2663/2667). Intermediate asynchronous DateModified/PresentationUniqueKey are retained raw; final values compare exactly. Other complete HTTP JSON, BaseItems fields, all media relation tables, UserData and four filesystem domains compare exactly.',
      limitations: 'Server configuration uses equivalent complete native runtime input; configuration controller is not validated. Collage with local source images remains explicit 501; actual channels/live TV, native cancellation/races and phase acceptance are not covered.',
      differences, nativeTransientEtags, nativeTransientEtagTimingVerified: false, cleanup: actual.cleanup, native: summary }), { flag: 'wx' });
  }
  assert.equal(differences.length, 0, JSON.stringify(differences.slice(0, 4)));
});
