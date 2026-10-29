import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { assertValidationOutputChild } from '../validation/paths.js';
import { currentNativeReference } from './current-native-reference.js';
import { createPrivateFilterOutput } from './filter-reference-output.js';
import { observeExecutionPhase } from '../validation/execution-diagnostics.js';
import { identitySideEffectInput, identitySideEffectRoute } from './identity-side-effect-input.js';

const tables = ['BaseItems', 'AncestorIds', 'LinkedChildren', 'ItemValues', 'ItemValuesMap', 'UserData',
  'MediaStreamInfos', 'Peoples', 'PeopleBaseItemMap', 'BaseItemImageInfos', 'BaseItemProviders', 'BaseItemMetadataFields'];
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const available = port => new Promise(resolve => {
  const server = createServer();
  server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});

/** All identity observations come from the current native HTTP/SQLite process. */
export async function recordCurrentIdentities(kind, mode, destination, { port, precondition } = {}) {
  const input = identitySideEffectInput(kind, mode);
  destination = assertValidationOutputChild(path.resolve(destination));
  if (existsSync(destination)) throw new Error('Identity recording requires a new evidence directory.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !await available(port)) throw new Error('Identity recording requires an available loopback port.');
  const output = await createPrivateFilterOutput(destination), root = output.root;
  let failure;
  try {
    const current = await currentNativeReference();
    output.addSecret(current.accessToken);
    const referenceRoot = path.join(root, 'reference');
    const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
    const metadataRoot = path.join(referenceRoot, 'data/metadata');
    await mkdir(root);
    await observeExecutionPhase('native.copy.instance', () => cp(current.sourceRoot, referenceRoot, { recursive: true, filter: filename => {
      const relative = path.relative(current.sourceRoot, filename).replaceAll('\\', '/');
      return !relative.startsWith('log/') && !/^data\/data\/jellyfin\.db(?:-wal|-shm)?$/u.test(relative);
    } }), { fixture: 'tools/compat/record-current-identities.js' });
    await observeExecutionPhase('native.copy.database', () => cp(current.sourceDatabase, databasePath,
      { force: false, errorOnExist: true }), { fixture: 'tools/compat/record-current-identities.js' });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
    await current.prepareClone(referenceRoot, port);
    if (mode === 'conflicts') {
      assert.equal(precondition?.kind, kind);
      const shadow = precondition.identities.Shadow;
      const blocked = precondition.identities.Blocked;
      for (const [name, identity] of [['Shadow', shadow], ['Blocked', blocked]]) {
        assert.equal(identity.row.Name, name);
        assert.equal(identity.row.Type, input.entityType);
        assert.equal(identity.relative, name);
        assert.equal(identity.row.Path.replaceAll('\\', '/'), `%MetadataPath%/${input.metadataDirectory}/${name}`);
      }
      const directory = path.join(metadataRoot, input.metadataDirectory);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, blocked.relative), precondition.blockedText, { flag: 'wx' });
      const database = new DatabaseSync(databasePath);
      try {
        const movie = database.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?').get('22222222-2222-2222-2222-222222222222');
        assert.ok(movie);
        const row = { ...movie, Id: shadow.row.Id, Name: 'Shadow Collision Movie', CleanName: 'shadow collision movie',
          SortName: 'shadow collision movie', Path: `Z:\\${kind === 'artist' ? 'Artist' : 'Studio'}Conflict\\shadow.mkv`,
          PresentationUniqueKey: `${kind}-conflict-shadow` };
        const names = Object.keys(row);
        database.prepare(`INSERT INTO "BaseItems" (${names.map(name => `"${name}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`)
          .run(...names.map(name => row[name]));
        assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
      } finally { database.close(); }
      await writeFile(path.join(root, 'precondition.json'), json(precondition), { flag: 'wx' });
    } else assert.equal(precondition, undefined);
    const snapshot = async () => {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      const rows = {};
      try {
        database.exec('PRAGMA busy_timeout=5000');
        for (const table of tables) rows[table] = database.prepare(`SELECT * FROM "${table}"`).all().map(row => ({ ...row }))
          .sort((left, right) => json(left).localeCompare(json(right), 'en'));
        assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
      } finally { database.close(); }
      const filesystem = [];
      const visit = async directory => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const filename = path.join(directory, entry.name);
          assert.equal(entry.isSymbolicLink(), false);
          const value = { path: path.relative(metadataRoot, filename).replaceAll('\\', '/'), type: entry.isDirectory() ? 'directory' : 'file' };
          if (!entry.isDirectory()) {
            assert.equal(mode, 'conflicts');
            assert.equal(value.path, `${input.metadataDirectory}/Blocked`);
            const bytes = await readFile(filename);
            value.size = bytes.length; value.sha256 = digest(bytes);
          }
          filesystem.push(value);
          if (entry.isDirectory()) await visit(filename);
        }
      };
      if (existsSync(metadataRoot)) await visit(metadataRoot);
      return { database: rows, filesystem: filesystem.sort((left, right) => left.path.localeCompare(right.path, 'en')) };
    };
    const origin = `http://127.0.0.1:${port}`;
    const request = async (route, method = 'GET') => {
      const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(20000),
        headers: { Accept: 'application/json', Authorization: `MediaBrowser Client="IdentityOracle", Device="Isolated", DeviceId="current-identity-oracle", Version="1", Token="${current.accessToken}"` } });
      const bodyText = await response.text();
      let bodyJson;
      try { bodyJson = bodyText === '' ? null : JSON.parse(bodyText); } catch { /* Preserve non-JSON errors. */ }
      return { status: response.status, contentType: response.headers.get('content-type'), bodyText,
        ...(bodyJson === undefined ? {} : { bodyJson }) };
    };
    const records = [], caseStages = [], stages = {};
    let processOutcome, executionError;
    const interval = { startedAt: new Date().toISOString() };
    const instance = current.start({ referenceRoot, outputRoot: root, label: 'reference', origin });
    try {
      await instance.ready();
      const account = await request('/Users/Me');
      assert.equal(account.status, 200);
      assert.equal(idKey(account.bodyJson.Id), idKey(current.userId));
      stages.before = await snapshot();
      for (const testCase of input.fixture.cases) {
        const queries = testCase.parallelQueries ?? Array.from({ length: testCase.parallelRequests ?? 1 }, () => testCase.query);
        const responses = await Promise.all(queries.map(async (query, index) => {
          const route = identitySideEffectRoute(input, testCase, query);
          return { name: testCase.name, endpoint: 'items', index, query, route, response: await request(route) };
        }));
        records.push(...responses);
        caseStages.push({ name: testCase.name, after: await snapshot() });
      }
      stages.afterReads = await snapshot();
    } catch (error) { executionError = error; }
    finally {
      processOutcome = await instance.stop(async () => (await request('/System/Shutdown', 'POST')).status, () => available(port));
      stages.afterShutdown = await snapshot();
      interval.finishedAt = new Date().toISOString();
    }
    await writeFile(path.join(root, 'native-http.json'), json({ origin, records }), { flag: 'wx' });
    await writeFile(path.join(root, 'stages.json'), json(stages), { flag: 'wx' });
    await writeFile(path.join(root, 'case-stages.json'), json(caseStages), { flag: 'wx' });
    const originalIds = new Set(stages.before?.database.BaseItems.map(row => idKey(row.Id)));
    const createdRows = stages.afterReads?.database.BaseItems.filter(row => !originalIds.has(idKey(row.Id))) ?? [];
    const checks = { correctDelta: createdRows.length === input.expectedCreatedRows,
      nativeIdentityDiscovery: createdRows.every(row => row.Type === input.entityType && input.names.includes(row.Name)),
      completeResponses: records.length === input.fixture.cases.reduce((total, testCase) => total + (testCase.parallelQueries?.length ?? testCase.parallelRequests ?? 1), 0)
        && records.every(record => record.response.status === 200 && record.response.contentType === 'application/json; charset=utf-8'),
      stopped: processOutcome.cleanShutdown && processOutcome.code === 0 && processOutcome.pidGone && processOutcome.portAvailable };
    const passed = !executionError && Object.values(checks).every(Boolean);
    const summary = { passed, kind, mode, checks, interval, createdRows, process: processOutcome,
      nativeServerId: current.preparation.nativeServerId, actualUserId: current.userId,
      error: executionError ? { name: executionError.name, message: executionError.message, stack: executionError.stack } : null };
    await writeFile(path.join(root, 'summary.json'), json(summary), { flag: 'wx' });
    await current.finish();
    await writeFile(path.join(root, 'provenance.json'), json({ preparation: current.preparation,
      recorder: { filename: fileURLToPath(import.meta.url), sha256: digest(await readFile(fileURLToPath(import.meta.url))) },
      historicalEvidenceReplaced: false, artifacts: [] }), { flag: 'wx' });
    if (!passed) throw new Error(`Native ${kind} ${mode} recording failed: ${json(summary.error ?? checks)}`);
    return { root: destination, summary };
  } catch (error) { failure = error; }
  finally { await output.publishAndClose(); }
  throw output.publicError(failure);
}
