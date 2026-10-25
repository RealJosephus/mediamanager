import { defaultNfoConfiguration } from '../../plugins/nfo/configuration.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { fixtureRow } from '../database/fixtures.js';
import { parseNfoAsync } from '../../plugins/nfo/parser.js';
import { applyNfoUserDataEntry } from '../../plugins/nfo/user-data-import.js';
import { UserDataService, readUserDataRows } from '../../src/sessions/user-data.js';
import { observeComparison } from '../comparison-observations.js';

const root = new URL('./fixtures/nfo-userdata-persistence/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'))));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const itemId = '20000000-0000-0000-0000-000000000001';
const userId = '10000000-0000-0000-0000-000000000001';
const blankItem = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));

function oracleDate(value) {
  if (value == null) return null;
  const [seconds, fraction = ''] = String(value).replace(' ', 'T').replace(/Z$/u, '').split('.');
  return `${seconds}.${fraction.padEnd(7, '0').slice(0, 7)}Z`;
}

const projectData = value => value == null ? null : ({
  Key: value.Key,
  Played: value.Played,
  PlayCount: value.PlayCount,
  lastPlayedDate: oracleDate(value.LastPlayedDate),
});
const projectRows = values => [...values].sort((left, right) => left.CustomDataKey.localeCompare(right.CustomDataKey, 'en')).map(value => ({
  CustomDataKey: value.CustomDataKey,
  Played: value.Played,
  PlayCount: value.PlayCount,
  lastPlayedDate: oracleDate(value.LastPlayedDate),
}));
function checkFailure(error, sample, signal) {
  if (sample.rehydrateFailure && error) {
    assert.equal(error.code, 'io');
    assert.match(error.message, /Injected user data rehydrate SELECT failure/u);
  }
  if (sample.sqlFailure && error) {
    assert.equal(error.code, 'P0001');
    assert.match(error.message, /Injected (?:user data update|second key) failure/u);
  }
  if (sample.eventFailureAt && error) assert.equal(error.code, 'io');
  if ((sample.preCancelled || sample.cancelAfterEvent) && error) {
    assert.equal(signal.aborted, true);
    assert.ok(error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.code === 'cancelled');
  }
  return error ? { name: error.name, message: error.message, code: error.code, status: error.status, stack: error.stack } : null;
}
const functionalResult = value => ({
  name: value.name,
  failed: value.exception != null,
  events: value.events,
  rows: value.rows,
  itemRows: value.itemRows,
  direct: value.direct,
  rehydrateFailureInjected: value.rehydrateFailureInjected,
  cancellationRequested: value.cancellationRequested,
});

async function installFailure(database, sample) {
  if (!sample.sqlFailure) return;
  const secondNode = sample.sqlFailure === 'second-node';
  await database.client.query(secondNode ? `
    CREATE FUNCTION fail_userdata_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."PlayCount" = 2 THEN RAISE EXCEPTION 'Injected user data update failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_userdata_update BEFORE UPDATE ON "UserData" FOR EACH ROW EXECUTE FUNCTION fail_userdata_write()` : `
    CREATE FUNCTION fail_userdata_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."CustomDataKey" = '${itemId}' THEN RAISE EXCEPTION 'Injected second key failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_userdata_second_key BEFORE INSERT ON "UserData" FOR EACH ROW EXECUTE FUNCTION fail_userdata_write()`);
}

async function candidateResult(sample, dialect, t) {
  const schema = `nfo_userdata_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const domainStore = new DomainStore(database);
  let rehydrateReadPending = false, rehydrateFailureInjected = false;
  const store = sample.rehydrateFailure ? {
    serializeWrites: (operation, options) => domainStore.serializeWrites(operation, options),
    run: (callback, options) => {
      if (rehydrateReadPending) {
        rehydrateReadPending = false;
        rehydrateFailureInjected = true;
        throw Object.assign(new Error('Injected user data rehydrate SELECT failure'), { code: 'io' });
      }
      return domainStore.run(callback, options);
    },
    transaction: async (callback, options) => {
      const result = await domainStore.transaction(callback, options);
      rehydrateReadPending = true;
      return result;
    },
  } : domainStore;
  t.after(async () => {
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await domainStore.close();
  });
  await database.insert('Users', { ...fixtureRow(tableDefinition('Users')), Id: userId, InternalId: 1n,
    Username: 'NFO UserData', NormalizedUsername: 'NFO USERDATA', RowVersion: 0n });
  await database.insert('BaseItems', { ...blankItem, Id: itemId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
    Name: 'NFO UserData', Data: '{}', IsFolder: false });
  if (sample.providerId) await database.insert('BaseItemProviders', { ItemId: itemId, ProviderId: 'Tmdb', ProviderValue: sample.providerId });
  await installFailure(database, sample);

  const item = { Id: itemId, Type: 'Movie', Name: 'Initial', ProviderIds: sample.providerId ? { Tmdb: sample.providerId } : {}, UserData: [] };
  const userData = new UserDataService({ store });
  const events = [];
  const cancellation = new AbortController();
  let eventCount = 0;
  userData.on('UserDataSaved', event => {
    eventCount++;
    events.push({ reason: event.SaveReason, keys: event.Keys, data: projectData(event.UserData), itemRows: projectRows(event.Item.UserData ?? []) });
    if (sample.cancelAfterEvent === eventCount) cancellation.abort();
    if (sample.eventFailureAt === eventCount) throw Object.assign(new Error('Injected user data event failure'), { code: 'io' });
  });
  if (sample.preCancelled) cancellation.abort();

  let error = null;
  try {
    await parseNfoAsync(sample.xml, {
      type: 'Movie', item, signal: cancellation.signal,
      onUserDataImport: entry => applyNfoUserDataEntry(entry, { getConfiguration: () => ({ ...defaultNfoConfiguration(), UserId: userId }), store, userData })
    });
  } catch (caught) { error = caught; }
  const rows = await database.rows('UserData', { where: { ItemId: itemId } });
  const direct = await domainStore.run(db => readUserDataRows(db, item, item.UserData ?? []));
  return {
    name: sample.name,
    exception: checkFailure(error, sample, cancellation.signal),
    events,
    rows: projectRows(rows),
    itemRows: projectRows(item.UserData ?? []),
    direct: projectData(direct),
    rehydrateFailureInjected,
    cancellationRequested: cancellation.signal.aborted,
  };
}

test('real NFO UserData persistence fixture binds oracle, source tree and actual assemblies', async () => {
  for (const file of Object.values(provenance.files)) {
    assert.equal(sha256(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  }
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false);
  assert.equal(provenance.candidateVerified, false);
  const portableNative = await readFile(new URL('native.json', root));
  assert.equal(provenance.files.native.sha256, 'c3fd8538959cc92ef6f8d9e3de4b91cd3009d92458660f3e59d305ea31eb997a');
  assert.equal(provenance.record.portableNativeSha256, provenance.files.native.sha256);
  assert.equal(provenance.record.rawNativeSha256, '676f006a761b2ec6faf6c7dbf8c8a0738f9003419e2803a670cfdfe39053e2e7');
  assert.equal(portableNative.includes(13), false);
  assert.equal(portableNative.at(-1), 10);
  assert.equal(sha256(Buffer.concat([
    Buffer.from(portableNative.subarray(0, -1).toString('utf8').replaceAll('\n', '\r\n')),
    Buffer.from('\n'),
  ])), provenance.record.rawNativeSha256);
  assert.equal(native.results.length, 7);
  assert.deepEqual(native.results.map(value => value.name), input.map(value => value.name));
  assert.equal(provenance.jellyfin.head, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  assert.equal(provenance.runtime.jellyfinDll.sha256, 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767');
  assert.equal(provenance.runtime.assemblies['MediaBrowser.XbmcMetadata.dll'].sha256, '82ddd82082f44faf43284258609ba4efce9a94759d24e0f7161ebf5c7d18558e');
  assert.equal(provenance.runtime.assemblies['Emby.Server.Implementations.dll'].sha256, '8d369435646570958505c58b9cb17da169855dabc105d0e933524361e9b7b1c8');
  assert.equal(Object.keys(provenance.runtime.assemblies).length, 4);
  assert.equal(Object.keys(provenance.jellyfin.sources).length, 4);
  assert.equal(provenance.jellyfin.sources['Emby.Server.Implementations/Library/UserDataManager.cs'], '476e1e7e2643b1fb1104efb8e21363a07280e608783561f6302d6317871e496b');
  assert.equal(provenance.record.sourceFilesSha256, '45c7ed112b819952982ef1b480a411564ded8603f3bd65687bad5251c85ef72d');
  assert.equal(provenance.record.oracleAssemblySha256, '87446406da5bf0b7fabc95eafab98f8feb418bb0a3a1bc870b296dc91641bd2a');
  assert.equal(provenance.record.sha256, 'd1982d119ece9ebcd97ea90e55656b503f7de565a6000c3020c1b00e714e1057');
});

test('actual UserDataManager freezes transaction, cache, event and cancellation boundaries', () => {
  const byName = new Map(native.results.map(value => [value.name, value]));
  const complete = byName.get(input[0].name);
  assert.equal(complete.events.length, 3);
  assert.deepEqual(complete.events.map(event => [event.data.Played, event.data.PlayCount, event.data.lastPlayedDate]), [
    [true, 0, null], [true, 2, null], [true, 2, '2025-01-02T03:04:05.0000000Z']
  ]);
  assert.equal(complete.events.every(event => event.itemRows.length === 2), true);
  assert.equal(complete.direct.Key, '501');
  assert.equal(complete.cached.Key, itemId);
  const cancelled = byName.get(input[1].name);
  assert.ok(cancelled.exception);
  assert.equal(cancelled.events.length, 1); assert.equal(cancelled.rows.length, 1);
  const failedNode = byName.get(input[2].name);
  assert.ok(failedNode.exception);
  assert.equal(failedNode.events.length, 1); assert.equal(failedNode.rows[0].PlayCount, 0);
  const failedKey = byName.get(input[3].name);
  assert.ok(failedKey.exception);
  assert.deepEqual([failedKey.events, failedKey.rows, failedKey.itemRows], [[], [], []]);
  const eventFailure = byName.get(input[4].name);
  assert.ok(eventFailure.exception);
  assert.equal(eventFailure.events.length, 1); assert.equal(eventFailure.rows.length, 1); assert.equal(eventFailure.itemRows.length, 1);
  const preCancelled = byName.get(input[5].name);
  assert.ok(preCancelled.exception);
  assert.deepEqual([preCancelled.events, preCancelled.rows, preCancelled.itemRows], [[], [], []]);
  const rehydrateFailure = byName.get(input[6].name);
  assert.ok(rehydrateFailure.exception);
  assert.equal(rehydrateFailure.rehydrateFailureInjected, true);
  assert.deepEqual([rehydrateFailure.events, rehydrateFailure.itemRows], [[], []]);
  assert.equal(rehydrateFailure.rows[0].Played, true);
  assert.equal(rehydrateFailure.direct.Played, false);
  assert.equal(rehydrateFailure.cached.Played, true);
});

for (const dialect of ['postgres']) for (const [index, sample] of input.entries()) test(
  `${dialect}: production NFO UserData persistence matches ${sample.name}`,
  {},
  async t => {
    const actual = await candidateResult(sample, dialect, t), expected = native.results[index];
    observeComparison(t, sample.name + ' user-data persistence', actual, expected);
    assert.deepEqual(functionalResult(actual), functionalResult(expected));
  }
);
