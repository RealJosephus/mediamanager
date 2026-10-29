import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { metadataChildSequence } from '../../src/library/metadata-child-sequence.js';
import { idKey, mapRecord } from '../../src/library/records.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

export const outcome = pending => Promise.resolve(pending).then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
export const reasonCases = () => [['false', false], ['zero', 0], ['empty-string', ''], ['null', null], ['undefined', undefined],
  ['error', Object.assign(new Error('The library source failed.', { cause: undefined }), {
    code: 0, status: 422, statusCode: 409, errors: [false, 0, '', null, undefined, new Error('Nested library failure.', { cause: false })] })],
  ['business', { name: 'business-name', stack: 'business-stack', message: 'The library source refused the operation.',
    code: 'LIBRARY_SOURCE', status: 503, statusCode: 507, cause: undefined, errors: [false, 0, '', null, undefined] }]];
export const functional = value => value == null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(functional)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(value),
    ...['message', 'code', 'status', 'statusCode', 'cause', 'errors', 'name', 'stack'].filter(key => key in value)])]
    .filter(key => !(value instanceof Error && ['name', 'stack'].includes(key))).map(key => [key, functional(value[key])]));
export const sameReason = (actual, expected) => assert.deepEqual(functional(actual), functional(expected));
const observed = value => value == null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(observed)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(value),
    ...['message', 'code', 'status', 'statusCode', 'cause', 'errors', 'name', 'stack'].filter(key => key in value)])]
    .map(key => [key, observed(value[key])]));
export const observation = value => ({ type: value === null ? 'null' : typeof value, value: observed(value),
  raw: inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null }) });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesValue = bytes => ({ bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') });
export function combined(actual, primary, cleanups) {
  assert.equal(Object.hasOwn(actual, 'cause'), true); sameReason(actual.cause, primary);
  assert.equal(actual.errors.length, cleanups.length + 1);
  actual.errors.forEach((reason, index) => sameReason(reason, [primary, ...cleanups][index]));
  for (const key of ['code', 'status', 'statusCode']) if (primary != null && key in Object(primary)) {
    assert.equal(Object.hasOwn(actual, key), true); sameReason(actual[key], primary[key]);
  }
}

export async function libraryFailureFixture(t, label) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = path.join(output, label + '-' + randomUUID()), privateRoot = path.join(root, 'private'), files = path.join(privateRoot, 'files');
  await fs.mkdir(files, { recursive: true });
  const source = await fs.readFile(new URL('../images/fixtures/processor/grid.png', import.meta.url));
  assert.equal(hash(source), 'dae6cccb9c43213b28013b3877bc48ae64c8613d8dfbde6efabdb4529ba7cd1e');
  await fs.writeFile(path.join(root, 'source.png'), source);
  const report = { scope: 'Real PostgreSQL item/cohort ownership and Local/VFS files. Controlled metadata handler, state-loader and supplied child membership; no Native provider, HTTP receipt serialization or complete metadata refresh claim.',
    faults: 'Source rejection follows a completed actual read or commit. Injected cleanup rejection follows completed real release/close; it does not claim an OS or PostgreSQL close failure.',
    serialization: 'All primitive and own-property assertions execute before JSON, including undefined. Raw inspect accompanies reason observations; JSON alone cannot preserve undefined.',
    input: bytesValue(source), cases: [], witnesses: [], sequences: [], states: [], commits: [], diagnostics: [], cleanup: {}, fixtureDisposal: {} };
  const registry = new StorageRegistry(), releases = [], schedulers = [];
  let database, store, links, library, creator, fileSystem;
  t.after(async () => {
    for (const release of releases) release();
    const errors = [];
    const closeAll = async operations => {
      const failures = []; for (const close of operations) try { await close(); } catch (error) { failures.push(error); }
      if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Library fixture owners failed to close.', { cause: failures[0] });
    };
    for (const [name, close] of [['schedulers', () => closeAll(schedulers.map(scheduler => () => scheduler.close()))],
      ['sequences', () => closeAll(report.sequences.filter(entry => !entry.closed).map(entry => () => entry.close()))],
      ['states', () => closeAll(report.states.filter(entry => !entry.closed).map(entry => () => entry.close()))],
      ['witnesses', () => closeAll(report.witnesses.filter(entry => !entry.closed).map(entry => () => entry.close()))],
      ['creator', () => creator?.close()], ['library', () => library?.close()], ['relations', () => links?.close()],
      ['store', () => store?.close()], ['postgres', () => dropPostgresTestDatabase(database)], ['storage', () => registry.close()]]) {
      try { await close(); report.cleanup[name] = true; } catch (error) { errors.push(error); }
    }
    try {
      assert.ok(report.witnesses.every(entry => entry.closed));
      assert.ok(report.sequences.every(entry => entry.closed)); assert.ok(report.states.every(entry => entry.closed));
      if (database) {
        assert.equal(database.closed, true); report.cleanup.databaseClosed = database.closed;
        const late = await outcome(database.rows('BaseItems')); assert.equal(late.failed, true); report.cleanup.databaseAdmission = observation(late);
      }
      if (fileSystem) {
        const late = await outcome(fileSystem.readFile(path.join(files, 'source.png'))); assert.equal(late.failed, true); report.cleanup.storageAdmission = observation(late);
      }
      report.cleanup.ownersReleased = true;
    } catch (error) { errors.push(error); }
    try {
      assert.equal(path.dirname(privateRoot), root); assert.equal(path.dirname(root), output);
      await fs.rm(privateRoot, { recursive: true }); report.fixtureDisposal.privateRootRemoved = true;
    } catch (error) { errors.push(error); }
    report.cleanup.errors = errors.map(observation);
    try { await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n'); }
    catch (error) { errors.push(error); }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Library failure fixture cleanup failed.', { cause: errors[0] });
  });
  registry.registerType('library-local', config => LocalAdapter.open(config));
  await registry.createInstance('library', 'library-local', { root: files, writable: true });
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/library-failures', instanceId: 'library',
    capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: files, accessRoot: '/library-failures',
    style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32', returnAccess: 'Isolated library failure files.' });
  fileSystem = new StorageFileSystem({ vfs, identityMap }); await fileSystem.writeFile(path.join(files, 'source.png'), source);
  database = await createPostgresTestDatabase(null, 'library_failure', { max: 1 }); store = new DomainStore(database);
  links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
  report.database = { schemaName: database.schemaName, relationSchema: links.schemaName };
  const logger = { error: reason => report.diagnostics.push(observation(reason)) };
  library = new LibraryService({ store, linkedChildren: links, fileSystem, configuration: {}, serverId: 'library-failure-fixture', onError: logger.error, logger });
  const loadContext = createMetadataContextLoader({ store, library, linkedChildren: links, fileSystem, vfs, identityMap,
    configuration: {}, programDataPath: privateRoot, metadataPath: path.join(privateRoot, 'metadata'), logger });
  creator = new ItemCreationService({ store, library, loadContext, linkedChildren: links }); library.itemCreation = creator;
  const id = number => 'cf980000-0000-0000-0000-' + String(number).padStart(12, '0');
  const definitions = [['root', 'Folder', null], ['first', 'Movies.Movie', 1], ['next', 'Movies.Movie', 1],
    ['series', 'TV.Series', 1], ['season', 'TV.Season', 4], ['episode', 'TV.Episode', 5],
    ['album', 'Audio.MusicAlbum', 1], ['audio', 'Audio.Audio', 7], ['artist', 'Audio.MusicArtist', null]];
  const ids = {};
  for (const [index, [key, type, parent]] of definitions.entries()) {
    ids[key] = id(index + 1);
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: ids[key], Type: 'MediaBrowser.Controller.Entities.' + type,
      Name: key === 'artist' ? 'Owner Artist' : key, ParentId: parent == null ? null : id(parent),
      IsFolder: ['Folder', 'TV.Series', 'TV.Season', 'Audio.MusicAlbum'].includes(type),
      Path: key === 'artist' ? null : path.join(files, key), Overview: '', Data: '{}',
      AlbumArtists: key === 'album' ? 'Owner Artist' : '', Artists: key === 'album' ? 'Owner Artist' : '' }));
  }
  report.initialRows = await database.rows('BaseItems');
  const item = async key => mapRecord((await database.rows('BaseItems', { where: { Id: ids[key] ?? key } }))[0]);
  const witness = async name => {
    const handle = await fileSystem.open(path.join(files, 'source.png'), 'r'), descriptor = handle.fd;
    const bytes = await handle.readFile(); assert.deepEqual(bytes, source); assert.equal(fstatSync(descriptor).isFile(), true);
    const entry = { name, descriptor, source: bytesValue(bytes), closed: false }; report.witnesses.push(entry);
    let closing;
    entry.close = () => closing ??= (async () => {
      await handle.close(); assert.throws(() => fstatSync(descriptor), error => {
        entry.closedObservation = observation(error); return error?.code === 'EBADF';
      }); entry.closed = true;
    })();
    return entry;
  };
  const sequence = async (keys, name, control = {}) => {
    const cohort = await createNativeItemCohort({ linkedChildren: links });
    try { for (const [index, key] of keys.entries()) await cohort.capture(await item(key), { ordinal: BigInt(index + 1) }); }
    catch (error) { await cohort.release(); throw error; }
    const actual = metadataChildSequence(cohort, links, store);
    let held;
    try { held = await witness(name); } catch (error) { await actual.close(); throw error; }
    const entry = { name, keys, closed: false, countCompleted: false, nextCompleted: false, returnCompleted: false }; report.sequences.push(entry);
    let closing;
    const owned = { async count() {
      const count = await actual.count(); entry.countCompleted = true;
      if (Object.hasOwn(control, 'countReason')) throw control.countReason;
      return count;
    }, pages() {
      const iterator = actual.pages()[Symbol.asyncIterator](); let advanced = false;
      return { [Symbol.asyncIterator]() { return this; }, async next() {
        const step = await iterator.next(); entry.nextCompleted = true;
        if (!step.done && control.invalidPage) return { done: false, value: Array.from({ length: 129 }, (_, index) => step.value[index % step.value.length]) };
        if (!advanced && !step.done && Object.hasOwn(control, 'nextReason')) {
          advanced = true; throw control.nextReason;
        }
        return step;
      }, async return() {
        const result = await iterator.return(); await held.close(); entry.returnCompleted = true;
        if (control.returnGate) { control.returnGate.entered.resolve(); await control.returnGate.release.promise; }
        if (Object.hasOwn(control, 'returnReason')) throw control.returnReason;
        return result;
      } };
    }, close() { return closing ??= (async () => {
      const errors = []; for (const close of [() => actual.close(), () => held.close()]) try { await close(); } catch (error) { errors.push(error); }
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Actual child fixture owners failed to close.', { cause: errors[0] });
      entry.closed = true; assert.equal((await outcome(Promise.resolve().then(() => actual.count()))).failed, true);
      if (Object.hasOwn(control, 'closeReason')) throw control.closeReason;
    })(); } };
    entry.close = () => owned.close(); return { owned, entry, held };
  };
  const reset = async () => {
    await database.transaction(async db => { for (const value of Object.values(ids)) await db.update('BaseItems', { Id: value }, { Overview: '' }); });
    for (const key of Object.keys(ids)) await fileSystem.rm(path.join(files, key + '.png'), { force: true });
  };
  const persist = async (reference, stage) => {
    const key = Object.keys(ids).find(key => idKey(ids[key]) === idKey(reference.Id)); assert.ok(key);
    const before = (await database.rows('BaseItems', { where: { Id: reference.Id } }))[0];
    await fileSystem.writeFile(path.join(files, key + '.png'), await fileSystem.readFile(path.join(files, 'source.png')));
    await store.transaction(db => db.update('BaseItems', { Id: reference.Id }, { Overview: stage }));
    const row = (await database.rows('BaseItems', { where: { Id: reference.Id } }))[0], bytes = await fileSystem.readFile(path.join(files, key + '.png'));
    assert.deepEqual(row, { ...before, Overview: stage }); assert.deepEqual(bytes, source);
    report.commits.push({ stage, itemId: reference.Id, before, after: row, bytes: bytesValue(bytes) });
  };
  const released = async () => {
    await links.flushReleases();
    const result = await database.client.query(`SELECT (SELECT count(*) FROM "${links.schemaName}".item_states) AS states,
      (SELECT count(*) FROM "${links.schemaName}".item_cohorts) AS cohorts`);
    assert.equal(BigInt(result.rows[0].states), 0n); assert.equal(BigInt(result.rows[0].cohorts), 0n);
    assert.ok(report.witnesses.every(entry => entry.closed)); return result.rows[0];
  };
  const gate = () => { const value = { entered: Promise.withResolvers(), release: Promise.withResolvers() }; releases.push(() => value.release.resolve()); return value; };
  const stateLoader = (name, control = {}) => async reference => {
    const current = await item(typeof reference === 'string' ? reference : reference.Id), held = await witness(name + ':state');
    const entry = { name, itemId: current.Id, closed: false }; report.states.push(entry);
    let closing;
    entry.close = () => closing ??= (async () => {
      await held.close(); entry.closed = true;
      if (Object.hasOwn(control, 'stateCloseReason')) throw control.stateCloseReason;
    })();
    return { item: current, children: { async physical() { return (await sequence(['first', 'next'], name + ':physical', control.physical)).owned; },
      async recursive() {
        const keys = idKey(current.Id) === idKey(ids.series) ? ['season', 'episode'] : idKey(current.Id) === idKey(ids.album) ? ['audio'] : [];
        return (await sequence(keys, name + ':recursive', control.recursive)).owned;
      } }, close() { return entry.close(); } };
  };
  return { report, root, database, store, links, library, creator, fileSystem, files, source, ids, item, witness,
    sequence, reset, persist, released, gate, schedulers, stateLoader };
}
