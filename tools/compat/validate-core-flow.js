import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { createSqliteTarget, getNativeEnvelope, transferDatabase } from '../../src/migration/database-transfer.js';
import { createRuntime } from '../../src/runtime.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { recordCoreFlow } from './record-core-flow.js';

const [directory, output, referenceFile = 'reference-parent-responses.json'] = process.argv.slice(2);
if (!directory || !output) throw new Error('Usage: validate-core-flow SCENARIO NEW_OUTPUT [REFERENCE_FILE]');
if (!process.env.MEDIAMANAGER_TEST_POSTGRES) throw new Error('An isolated PostgreSQL connection is required.');
await mkdir(output, { recursive: false });
const identities = JSON.parse(await readFile(path.join(directory, 'identities.json'), 'utf8'));
const settings = await readInstanceConfiguration(path.join(directory, 'reference'));
const source = new SqliteDatabase(path.join(directory, 'initial.db'), { readOnly: true, requireMigrationHistory: true });
let database, runtime;
const schema = `core_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`;
try {
  database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  await transferDatabase(source, database);
  const errors = [];
  runtime = await createRuntime({ ...settings, serverName: identities.serverName, database, onError: error => errors.push({ message: error.message, stack: error.stack }) });
  await runtime.start();
  const base = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
  const records = await recordCoreFlow(base, identities);
  await writeFile(path.join(output, 'responses.json'), JSON.stringify(records, null, 2));
  await writeFile(path.join(output, 'errors.json'), JSON.stringify(errors, null, 2));
  const expected = JSON.parse(await readFile(path.join(directory, referenceFile), 'utf8'));
  const referenceStarted = JSON.parse(await readFile(path.join(directory, 'process-seeded.json'), 'utf8')).started;
  const earliest = Date.parse(referenceStarted) - 1000;
  const normalized = [];
  function normalize(value, location = '') {
    if (Array.isArray(value)) return value.map((entry, index) => normalize(entry, `${location}/${index}`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (key === 'AccessToken') { assert.match(entry, /^[0-9a-f]{32}$/); normalized.push(`${location}/${key}: independently generated token; request reuse and revocation exercised`); return [key, '<generated-token>']; }
      if (key === 'traceId') { assert.match(entry, /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/); return [key, '<request-trace>']; }
      if (['LastLoginDate', 'LastActivityDate', 'LastPlaybackCheckIn', 'LastPausedDate', 'LastPlayedDate'].includes(key) && Date.parse(entry) >= earliest) {
        assert.ok(Date.parse(entry) <= Date.now() + 1000);
        normalized.push(`${location}/${key}: wall clock timestamp generated during this run`);
        return [key, '<current-time>'];
      }
      return [key, normalize(entry, `${location}/${key}`)];
    }));
    return value;
  }
  function diff(expected, actual, location = '') {
    if (JSON.stringify(expected) === JSON.stringify(actual)) return [];
    if (expected && actual && typeof expected === 'object' && typeof actual === 'object') return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].flatMap(key => diff(expected[key], actual[key], `${location}/${key}`));
    return [{ path: location, expected, actual }];
  }
  const cases = expected.map((reference, index) => ({ name: reference.name, differences: diff(normalize(reference), normalize(records[index])) }));
  const final = await createSqliteTarget(path.join(output, 'flow-final.db'), await getNativeEnvelope(database));
  try { await transferDatabase(database, final); } finally { final.close(); }
  const migration = await exerciseMigration(base, identities);
  await writeFile(path.join(output, 'migration-state.json'), JSON.stringify(migration, null, 2));
  const returned = await createSqliteTarget(path.join(output, 'returned.db'), await getNativeEnvelope(database));
  try { await transferDatabase(database, returned); } finally { returned.close(); }
  const report = { engine: 'postgres', checkedAt: new Date().toISOString(), compatible: cases.every(entry => !entry.differences.length), cases: cases.length, equal: cases.filter(entry => !entry.differences.length).length,
    differing: cases.filter(entry => entry.differences.length), normalizations: [...new Set(normalized)],
    boundaries: ['Synthetic native media records; no network scan or byte playback in this scenario.', 'Intentional removed transcoding capability remains an explicit reported difference.', 'Remaining differences are failures, not accepted compatibility.'] };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ engine: report.engine, compatible: report.compatible, cases: report.cases, equal: report.equal, differing: report.differing }));
  if (!report.compatible) process.exitCode = 1;
} finally {
  try { source.close(); }
  finally {
    try {
      if (runtime) await runtime.close();
      else await database?.close();
    } finally {
      if (database) {
        const cleanup = await PostgresDatabase.open({
          connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
          schema,
        });
        try { await cleanup.client.query(`DROP SCHEMA IF EXISTS ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`); }
        finally { await cleanup.close(); }
      }
    }
  }
}

async function exerciseMigration(base, ids) {
  let token;
  const auth = device => `MediaBrowser Client="CoreMigration", Device="IsolatedTest", DeviceId="${device}", Version="1.0"${token ? `, Token="${token}"` : ''}`;
  async function request(route, method, body, device = 'core-migration-admin') {
    const response = await fetch(base + route, { method, headers: { Authorization: auth(device), Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `${method} ${route}: ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  token = (await request('/Users/AuthenticateByName', 'POST', { Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' })).AccessToken;
  const user = await request('/Users/New', 'POST', { Name: 'CoreFlowMigrated', Password: 'isolated-migrated-password' });
  await request(`/Users/${user.Id}/Configuration`, 'POST', { ...user.Configuration, AudioLanguagePreference: 'zho', SubtitleLanguagePreference: 'chi', EnableNextEpisodeAutoPlay: false });
  await request(`/Users/${user.Id}/Policy`, 'POST', { ...user.Policy, EnableRemoteAccess: false, MaxActiveSessions: 3 });
  const login = await request('/Users/AuthenticateByName', 'POST', { Username: 'CoreFlowMigrated', Pw: 'isolated-migrated-password' }, 'core-migration-new-user');
  token = login.AccessToken;
  const userData = await request(`/UserItems/${ids.movie}/UserData`, 'POST', { PlaybackPositionTicks: 36000000000, PlayCount: 4,
    IsFavorite: true, Played: false, LastPlayedDate: '2026-09-26T12:00:00Z' }, 'core-migration-new-user');
  return { userId: user.Id, accessToken: login.AccessToken, username: user.Name, configuration: login.User.Configuration,
    policy: login.User.Policy, userData, movieId: ids.movie, createdByCandidateHttp: true };
}
