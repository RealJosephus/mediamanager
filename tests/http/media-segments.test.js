import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DomainStore } from '../../src/database/domain-store.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { nativeGuid } from '../../src/users/native.js';
import { idKey } from '../../src/library/records.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { MediaSegmentService, mediaSegmentProviderId } from '../../src/library/media-segment-service.js';
import { stringifyNativeJson, parseLosslessJson } from '../../src/core/json.js';
import { createSqliteTarget, databaseDigest, getNativeEnvelope, transferDatabase } from '../../src/migration/database-transfer.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createTestApplication } from '../helpers/application.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { makeInput, itemId, hiddenId, userId, readerId } from './fixtures/media-segments-current/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const sha = value => createHash('sha256').update(value).digest('hex');
const errorRecord = error => ({ name: error?.name, message: error?.message, stack: error instanceof Error ? error.stack : undefined, code: error?.code, status: error?.status,
  cause: error?.cause === undefined ? null : errorRecord(error.cause), errors: error instanceof AggregateError ? error.errors.map(errorRecord) : null });
function wire(response) {
  let json;
  try { json = parseLosslessJson(response.body); } catch { }
  json = projectProblemTrace(json, response.status);
  return { status: response.status, contentType: response.contentType?.trim() ?? null,
    ...(json === undefined ? { body: response.body } : { json }) };
}

async function application(database, capture, diagnostics) {
  const store = new DomainStore(database), admin = { Id: userId, Policy: { IsAdministrator: true }, AccessSchedules: [] },
    reader = { Id: readerId, Policy: { IsAdministrator: false }, AccessSchedules: [] };
  const users = { getUser: async id => idKey(id) === readerId ? reader : admin };
  const authentication = new AuthenticationService({ store, users, serverId: 'media-segments', isLocalNetwork: () => true });
  authentication.authenticate = async request => {
    const identity = request.headers['x-identity'] ?? 'admin', user = identity === 'regular' ? reader : admin;
    return { IsAuthenticated: identity !== 'anonymous', IsApiKey: identity === 'apiKey', IsAdministrator: !['regular', 'anonymous'].includes(identity),
      UserId: identity === 'apiKey' ? '0'.repeat(32) : user.Id, User: identity === 'apiKey' || identity === 'anonymous' ? null : user };
  };
  const options = defaultLibraryOptions(), library = {
    options: { libraryOptions: new Map([['folder', options]]) },
    async getCollectionFolders() { return []; },
  };
  // Library lookup/options are controlled on both sides; the returned item
  // preserves the actual controller's authenticated-user or API-key selection.
  library.withItemRecord = async (id, { user }, operation) => {
    if (![itemId, hiddenId].includes(idKey(id)) || idKey(id) === hiddenId && user?.Id === readerId) {
      throw Object.assign(new Error('Item not found.'), { status: 404 });
    }
    const item = { Id: nativeGuid(id), Type: 'CollectionFolder' };
    library.options.libraryOptions.set(idKey(id), { ...options, DisabledMediaSegmentProviders: Object.hasOwn(capture.sample, 'disabled') ? capture.sample.disabled : [] });
    return await operation(item);
  };
  const segments = new MediaSegmentService({ store, library,
    providers: () => (capture.sample.providers ?? ['Control Primary', 'Secondary']).map(name => ({ name })) });
  const app = await createTestApplication({ store, library, mediaSegments: segments, configuration: { IsStartupWizardCompleted: true }, authentication, users,
    onError: error => diagnostics.push(errorRecord(error)) });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', () => { app.server.off('error', reject); resolve(); }); });
  return { ...app, store, segments, async request(sample) {
    capture.sample = sample;
    const response = await fetch('http://127.0.0.1:' + app.server.address().port + sample.path, { method: sample.method ?? 'GET',
      headers: { Accept: sample.accept ?? 'application/json', 'X-Identity': sample.identity ?? 'admin' }, signal: AbortSignal.timeout(30000) });
    return { name: sample.name, status: response.status, contentType: response.headers.get('content-type'), body: await response.text() };
  }, async close() {
    app.beginClose(); await app.drainRequests(); await app.webSockets?.close();
    await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); await store.close();
  } };
}

test('MediaSegments uses actual MVC and Native EF rows with bounded PG HTTP delivery and insertion-order exchange', {
  skip: !enabled, timeout: 600000,
}, async () => {
  const output = path.join(validationOutputRoot(), 'media-segments-' + randomUUID()); await mkdir(output, { recursive: true });
  const input = makeInput(), inputBytes = Buffer.from(JSON.stringify(input)), inputFile = path.join(output, 'input.json'); await writeFile(inputFile, inputBytes);
  const report = { scope: { actualMvcControllerManagerEf: true, actualPostgresHttp: true,
    controlled: ['authentication principal', 'library lookup and visibility boundary', 'library options', 'enabled read-provider names'],
    excluded: ['provider generation/analysis', 'full Native host authentication', 'production media-segment-provider installation', 'release acceptance'] },
    captures: [], cases: [], differences: [], diagnostics: [], cleanup: [], phaseAcceptance: false, releaseAcceptance: false };
  let current, database, fresh, app, source, target, failed = false, primary;
  const capture = { sample: {} };
  try {
    current = await currentNativeReference();
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/MediaSegmentsController.cs',
      'Jellyfin.Server.Implementations/MediaSegments/MediaSegmentManager.cs', 'MediaBrowser.Model/MediaSegments/MediaSegmentDto.cs',
      'MediaBrowser.Model/Querying/QueryResult.cs', 'src/Jellyfin.Database/Jellyfin.Database.Implementations/Enums/MediaSegmentType.cs',
      'src/Jellyfin.Extensions/Json/Converters/JsonGuidConverter.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs',
      'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs']);
    const oracle = async (label, filename, mode) => {
      const receipt = await recordOracle({ project: 'tests/http/fixtures/media-segments-current/Oracle.csproj', output: path.join(output, label),
        environment: current.environment, args: [inputFile, '{output}/native.json', path.join(output, label + '-data'), filename, mode] });
      assert.equal(receipt.passed, true); const bytes = await readFile(path.join(output, label, 'native.json')), native = parseLosslessJson(bytes.toString('utf8'));
      assert.equal(native.inputSha256, sha(inputBytes)); assert.equal(native.before, native.after);
      for (const flag of ['actualMvc', 'actualController', 'actualManager', 'actualEfSqlite', 'hostStopped', 'hostDisposed']) assert.equal(native[flag], true);
      assert.equal(native.providerMethodsInvoked, false); for (const assembly of native.assemblies) assert.equal(sha(await readFile(assembly.filename)), assembly.sha256);
      report.captures.push({ label, receipt, native }); return native;
    };
    const first = await oracle('first', current.sourceDatabase, 'seed');
    database = await createPostgresTestDatabase(null, 'media_segments');
    source = new SqliteDatabase(first.databaseFilename, { readOnly: true, requireMigrationHistory: true });
    report.instanceBinding = { serverId: current.preparation.nativeServerId, originIdentityDigest: sha(await readFile(first.databaseFilename)) };
    report.import = await transferDatabase(source, database, { instanceBinding: report.instanceBinding });
    assert.deepEqual(await databaseDigest(source), await databaseDigest(database)); source.close(); source = undefined;
    app = await application(database, capture, report.diagnostics);
    const compareCases = async (label, native) => {
      const before = stringifyNativeJson(await database.rows('MediaSegments'));
      for (const [index, sample] of input.cases.entries()) {
        const expected = native.results[index]; assert.equal(expected.name, sample.name); assert.equal(expected.status, sample.status ?? 200, sample.name);
        const actual = await app.request(sample); report.cases.push({ label, sample, actual, expected });
        try { assert.deepEqual(wire(actual), wire(expected), label + ': ' + sample.name); }
        catch (error) { report.differences.push({ label, sample: sample.name, actual: wire(actual), expected: wire(expected), error: errorRecord(error) }); }
      }
      assert.equal(stringifyNativeJson(await database.rows('MediaSegments')), before);
    };
    await compareCases('imported', first);
    const baseline = parseLosslessJson(report.cases[0].actual.body);
    assert.equal(baseline.Items.length, 262); assert.equal(baseline.TotalRecordCount, 262);
    assert.equal(baseline.Items[0].StartTicks, -9223372036854775808n);
    assert.equal(baseline.Items.at(-1).EndTicks, 9223372036854775807n);
    assert.equal(baseline.Items.at(-1).Type, 99);
    // Real Node-period writes change the equal-start order, add one segment and
    // remove another before the complete database is consumed again by Native.
    await app.store.transaction(async db => {
      const row = (await db.rows('MediaSegments', { where: { Id: nativeGuid(input.rows[0].id) } }))[0];
      await db.delete('MediaSegments', { Id: row.Id }); await db.insert('MediaSegments', row);
      await db.delete('MediaSegments', { Id: nativeGuid(input.rows[1].id) });
      await db.insert('MediaSegments', { ...row, Id: nativeGuid('cf22' + '0'.repeat(24) + '9999'), EndTicks: 12n });
    });
    const changed = await databaseDigest(database), exported = path.join(output, 'exported.db');
    target = await createSqliteTarget(exported, await getNativeEnvelope(database));
    report.export = await transferDatabase(database, target); assert.deepEqual(await databaseDigest(target), changed); target.close(); target = undefined;
    const continued = await oracle('native-read-export', exported, 'read'); await compareCases('native-consumed-export', continued);
    fresh = await createPostgresTestDatabase(null, 'segments_fresh'); source = new SqliteDatabase(continued.databaseFilename, { readOnly: true, requireMigrationHistory: true });
    report.reimport = await transferDatabase(source, fresh, { instanceBinding: report.instanceBinding });
    assert.deepEqual(await databaseDigest(fresh), changed); source.close(); source = undefined;
    const ordered = async db => { const rows = []; let after; for (;;) { const batch = await db.relationRowsInInsertionOrder('MediaSegments', { after, limit: 128 }); if (!batch.rows.length) break; rows.push(...batch.rows); after = batch.after; } return rows; };
    assert.deepEqual(await ordered(fresh), await ordered(database));
    assert.deepEqual(report.differences, []); report.completeReadExchangeVerified = true;
  } catch (error) { failed = true; primary = error; report.failure = errorRecord(error); }
  const cleanup = [];
  for (const [label, close] of [['sqlite-source', () => source?.close()], ['sqlite-target', () => target?.close()],
    ['http-store', () => app?.close()], ['postgres', () => dropPostgresTestDatabase(database)],
    ['fresh-postgres', () => dropPostgresTestDatabase(fresh)], ['reference', () => current?.finish()]]) {
    try { await close(); report.cleanup.push({ label, closed: true }); }
    catch (error) { cleanup.push(error); report.cleanup.push({ label, error: errorRecord(error) }); }
  }
  await writeFile(path.join(output, 'report.json'), stringifyNativeJson(report));
  if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Media segment differential cleanup failed.', failed ? { cause: primary } : undefined);
  if (failed) throw primary;
});

test('media segment cursor failures release real PG resources and the same HTTP consumer recovers', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 90000,
}, async () => {
  const output = path.join(validationOutputRoot(), 'media-segments-failures-' + randomUUID()); await mkdir(output, { recursive: true });
  const report = { faults: [], pages: [], diagnostics: [], cleanup: [], actualPostgres: true, actualNodeHttp: true, actualNativeFailure: false };
  let database, app, failed = false, primary;
  const capture = { sample: {} };
  try {
    database = await createPostgresTestDatabase(null, 'segments_errors');
    for (const source of makeInput().rows) await database.insert('MediaSegments', {
      Id: nativeGuid(source.id), ItemId: nativeGuid(source.itemId), SegmentProviderId: mediaSegmentProviderId(source.provider),
      Type: source.type, StartTicks: BigInt(source.startTicks), EndTicks: BigInt(source.endTicks),
    });
    app = await application(database, capture, report.diagnostics);
    const path = '/MediaSegments/' + itemId, baseline = wire(await app.request({ path }));
    assert.equal(baseline.status, 200); assert.equal(baseline.json.Items.length, 262);
    let inject = false, closeFault = false, backend, actualSqlFailure, actualCloseFailure;
    database.queryHook = async (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      if (inject && text === 'FETCH FORWARD 128 FROM media_segment_entries') {
        inject = false; backend = Number((await database.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        try { return await database.client.query('SELECT * FROM pg_catalog.mediamanager_missing_segment_relation'); }
        catch (error) { actualSqlFailure = error; throw error; }
      }
      if (closeFault && text === 'CLOSE media_segment_entries') {
        closeFault = false; backend = Number((await database.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        try { return await database.client.query('SELECT * FROM pg_catalog.mediamanager_missing_segment_close'); }
        catch (error) { actualCloseFailure = error; throw error; }
      }
      const result = await database.client.query(...args);
      if (text === 'FETCH FORWARD 128 FROM media_segment_entries') report.pages.push(result.rows.length);
      return result;
    };
    inject = true; const response = await app.request({ path }); assert.equal(response.status, 500);
    assert.equal(actualSqlFailure.code, '42P01');
    assert.equal((await database.client.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS present', [backend])).rows[0].present, false);
    report.faults.push({ phase: 'initial-fetch', backend, actualSqlFailure: errorRecord(actualSqlFailure), response });
    const recovered = wire(await app.request({ path })); assert.deepEqual(recovered, baseline);
    assert.ok(report.pages.every(count => count <= 128));
    let observed = false;
    try {
      await app.segments.read(itemId, { consume: async (metadata, pages) => {
        assert.equal(metadata.TotalRecordCount, 262);
        for await (const rows of pages) { assert.equal(rows.length, 128); throw false; }
      } });
    } catch (error) { assert.equal(error, false); observed = true; }
    assert.equal(observed, true); report.faults.push({ phase: 'consumer', deliveredReason: false, reasonCaptured: observed });
    assert.deepEqual(wire(await app.request({ path })), baseline);
    const business = Object.assign(new Error('Controlled consumer rejection.'), { code: 'CONSUMER_REJECTED', status: 409, statusCode: 409 });
    const hostile = Object.defineProperties({ status: 409 }, {
      code: { get() { throw new Error('A diagnostic getter cannot replace the consumer rejection.'); } },
      statusCode: { get() { throw new Error('A diagnostic getter cannot replace the consumer rejection.'); } },
    });
    for (const [label, reason] of [['public-business-error', business], ['literal-false', false], ['throwing-diagnostic-getter', hostile]]) {
      closeFault = true; let caught = false;
      try {
        await app.segments.read(itemId, { consume: async (_metadata, pages) => {
          for await (const _rows of pages) throw reason;
        } });
      } catch (error) {
        caught = true; assert.equal(error instanceof AggregateError, true); assert.deepEqual(error.cause, reason);
        assert.deepEqual(error.errors, [reason, actualCloseFailure]); assert.equal(actualCloseFailure.code, '42P01');
        if (reason === business) for (const field of ['code', 'status', 'statusCode']) assert.equal(error[field], reason[field]);
        if (reason === hostile) { assert.equal(error.status, 409); assert.equal(Object.hasOwn(error, 'code'), false); assert.equal(Object.hasOwn(error, 'statusCode'), false); }
        if (reason === false) for (const field of ['code', 'status', 'statusCode']) assert.equal(Object.hasOwn(error, field), false);
        report.faults.push({ phase: 'consumer-and-close', label, cleanup: errorRecord(actualCloseFailure),
          publicMetadata: { code: error.code, status: error.status, statusCode: error.statusCode }, originalReasonPreserved: true });
      }
      assert.equal(caught, true);
      assert.equal((await database.client.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS present', [backend])).rows[0].present, false);
      assert.deepEqual(wire(await app.request({ path })), baseline);
    }
    database.queryHook = null;
  } catch (error) { failed = true; primary = error; report.failure = errorRecord(error); }
  const cleanup = [];
  for (const [label, close] of [['http-store', () => app?.close()], ['postgres', () => dropPostgresTestDatabase(database)]]) {
    try { await close(); report.cleanup.push({ label, closed: true }); }
    catch (error) { cleanup.push(error); report.cleanup.push({ label, error: errorRecord(error) }); }
  }
  await writeFile(path.join(output, 'report.json'), stringifyNativeJson(report));
  if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Media segment recovery cleanup failed.', failed ? { cause: primary } : undefined);
  if (failed) throw primary;
});
