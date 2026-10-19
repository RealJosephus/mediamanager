import { validationPath } from './validation/paths.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
const source = validationPath(path.resolve(root, process.argv[2] ?? '.agent-docs/evidence/resume-scope-native-v3'));
const target = validationPath(path.resolve(root, process.argv[3] ?? 'tests/library/fixtures/resume-query-scope/native.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const key = value => String(value).replaceAll('-', '').toLowerCase();
const raw = {};
for (const leaf of ['input.json', 'record-native.mjs', 'bindings-before.json', 'native-run/native-http.json', 'native-run/setup-http.json',
  'native-run/stages.json', 'native-run/endpoint-stages.json', 'native-run/summary.json', 'launcher.exit.json']) raw[leaf] = await fs.readFile(path.join(source, leaf));
const parse = leaf => JSON.parse(raw[leaf].toString('utf8'));
const input = parse('input.json'), native = parse('native-run/native-http.json'), setup = parse('native-run/setup-http.json');
const stages = parse('native-run/stages.json'), endpoints = parse('native-run/endpoint-stages.json').endpointStages;
const summary = parse('native-run/summary.json'), bindings = parse('bindings-before.json');
const expectedCount = input.cases.reduce((count, item) => count + item.endpoints.length, 0);
if (!summary.passed || summary.cases !== expectedCount || native.records.length !== expectedCount || endpoints.length !== expectedCount || summary.processResult.code !== 0 || !summary.portAvailable)
  throw new Error('A complete successful native response set is required.');
if (summary.fixtureSha256 !== sha(raw['input.json']) || summary.recorderSha256 !== sha(raw['record-native.mjs'])) throw new Error('Native input/recorder binding differs.');
const stable = value => JSON.stringify(value);
const before = stages.before;
if (!['afterReads', 'afterShutdown'].every(name => stable(before) === stable(stages[name]))
  || !endpoints.every(endpoint => stable(before.database) === stable(endpoint.database) && stable(before.filesystem) === stable(endpoint.filesystem)))
  throw new Error('Native media/UserData/filesystem state changed.');
const ids = new Set(input.items.map(item => key(item.id)));
const valueIds = new Set(input.itemValues.map(item => key(item.id))), personIds = new Set(input.people.map(item => key(item.id)));
const seed = {};
for (const [table, rows] of Object.entries(before.database.tables)) {
  seed[table] = rows.filter(row => table === 'BaseItems' ? ids.has(key(row.Id))
    : table === 'ItemValues' ? valueIds.has(key(row.ItemValueId)) : table === 'Peoples' ? personIds.has(key(row.Id))
    : table === 'LinkedChildren' ? ids.has(key(row.ParentId))
    : ids.has(key(row.ItemId)) && (table !== 'UserData' || key(row.UserId) === key(input.userId)));
}
const fixture = { schemaVersion: 1, nativeVerified: true, phaseAcceptance: false,
  input, seed, native: native.records, actualUserAndViews: setup.records.filter(row => row.kind === 'actual-user-and-views'),
  actualConfigurationUpdates: setup.records.filter(row => row.kind === 'actual-user-configuration-update'),
  provenance: { ...summary, rawDirectory: path.relative(root, source).replaceAll('\\', '/'), rawHashes: Object.entries(raw).map(([leaf, bytes]) => ({ path: leaf, bytes: bytes.length, sha256: sha(bytes) })),
    sourceBindings: bindings.sourceBindings, nativeRuntimeBindings: bindings.runtimeBindings,
    executedRecorderSource: raw['record-native.mjs'].toString('utf8'), exactInputSource: raw['input.json'].toString('utf8') },
  nativeState: { before, tables: Object.keys(before.database.tables), filesystemDomains: Object.keys(before.filesystem),
    beforeSha256: sha(stable(before)), afterReadsSha256: sha(stable(stages.afterReads)), afterShutdownSha256: sha(stable(stages.afterShutdown)),
    endpoints: endpoints.map(endpoint => ({ name: endpoint.name, endpoint: endpoint.endpoint, databaseSha256: sha(stable(endpoint.database)), filesystemSha256: sha(stable(endpoint.filesystem)) })) },
  boundary: `Mechanical projection of ${native.records.length} actual frozen-native HTTP responses, ${setup.records.filter(row => row.kind === 'actual-user-and-views').length} actual user/Views readbacks and ${setup.records.filter(row => row.kind === 'actual-user-configuration-update').length} actual LatestExcludes configuration updates. Full before-state of 12 media/UserData tables plus four filesystem domains, and each raw endpoint/read/shutdown hash, are retained. Seed contains only the controlled native items and their actual relation/progress rows; identity/path/parent/top/ancestor/DTO/order is not synthesized. No auth tokens/password hashes or authentication/configuration tables are copied. Other query, playback, renderer and host failure domains remain outside this fixture.` };
await fs.mkdir(path.dirname(target), { recursive: true });
const bytes = Buffer.from(JSON.stringify(fixture, null, 2) + '\n');
await fs.writeFile(target, bytes, { flag: 'wx' });
console.log(JSON.stringify({ target: path.relative(root, target), bytes: bytes.length, sha256: sha(bytes), responses: fixture.native.length,
  seedItems: seed.BaseItems.length, userData: seed.UserData.length, phaseAcceptance: false }));
