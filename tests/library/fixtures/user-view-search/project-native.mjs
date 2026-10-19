import { validationPath } from '../../../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const target = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(target, '../../../..');
const source = path.resolve(process.argv[2]);
const sha = value => createHash('sha256').update(value).digest('hex');
const bound = [];
async function load(file) {
  const full = path.join(source, file), bytes = await readFile(full);
  bound.push({ path: path.relative(repo, full).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes) });
  return { bytes, value: JSON.parse(bytes) };
}
const { bytes: inputBytes, value: input } = await load('input.json');
const { value: http } = await load('native-run/native-http.json');
const { value: stages } = await load('native-run/stages.json');
const { value: endpoints } = await load('native-run/endpoint-stages.json');
const { value: summary } = await load('native-run/summary.json');
const { value: runtime } = await load('runtime-source-bindings.json');
const { value: reclaimed } = await load('process-reclamation.json');
const recorderBytes = await readFile(path.join(source, 'record-native.mjs'));
bound.push({ path: path.relative(repo, path.join(source, 'record-native.mjs')).replaceAll('\\', '/'),
  bytes: recorderBytes.length, sha256: sha(recorderBytes) });
assert.equal(sha(recorderBytes), summary.recorderSha256);
assert.deepEqual(recorderBytes, await readFile(path.join(target, 'NativeRecorder.mjs')));
assert.equal(sha(inputBytes), summary.fixtureSha256);
assert.equal(sha(await readFile(validationPath(path.join(repo, '.agent-docs/evidence/core-flow-20260926/initial.db')))), summary.sourceDatabaseSha256);
assert.equal(sha(await readFile(validationPath(path.join(repo, '.agent-docs/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll')))), summary.dllSha256);
assert.equal(summary.passed, true); assert.deepEqual(summary.processResult, { code: 0, signal: null });
assert.equal(summary.portAvailable, true); assert.equal(summary.error, null); assert.equal(reclaimed.reclaimed, true);
assert.deepEqual(reclaimed.checkedPids, [summary.referencePid, summary.recorderPid]); assert.deepEqual(reclaimed.liveProcesses, []);
assert.equal(runtime.copiedEveryFile, true); assert.equal(runtime.everySourceAndCopyShaEqual, true);
assert.equal(runtime.files.length, 230); assert.equal(runtime.sourceBindings.length, 11);
for (const binding of runtime.files) {
  assert.equal(sha(await readFile(path.join(source, 'frozen-runtime-after', binding.path))), binding.sha256);
  assert.equal(sha(await readFile(validationPath(path.join(repo, '.agent-docs/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0', binding.path)))), binding.sha256);
}
for (const binding of runtime.sourceBindings) assert.equal(sha(await readFile(validationPath(path.join(repo, binding.path)))), binding.sha256);
assert.equal(http.records.length, 18); assert.equal(input.cases.length, 18); assert.equal(endpoints.endpointStages.length, 18);
const fullState = stages.before;
assert.deepEqual(stages.afterReads, fullState); assert.deepEqual(stages.afterShutdown, fullState);
const tables = Object.keys(fullState.database.tables);
assert.deepEqual(tables, ['BaseItems', 'AncestorIds', 'LinkedChildren', 'ItemValues', 'ItemValuesMap', 'Peoples',
  'PeopleBaseItemMap', 'BaseItemImageInfos', 'BaseItemProviders', 'BaseItemMetadataFields', 'MediaStreamInfos', 'UserData']);
assert.deepEqual(fullState.database.foreignKeyCheck, []);
assert.deepEqual(Object.keys(fullState.filesystem), ['userViews', 'metadata', 'libraries', 'collections']);
const statusCounts = {};
for (const [index, record] of http.records.entries()) {
  assert.deepEqual([record.name, record.endpoint], [input.cases[index].name, 'items']);
  const stage = endpoints.endpointStages[index];
  assert.deepEqual([stage.name, stage.endpoint], [record.name, record.endpoint]);
  assert.deepEqual({ database: stage.database, filesystem: stage.filesystem }, fullState);
  const nohit = record.name.endsWith('-nohit'), apiKey = record.name.includes('-apiKey-');
  assert.equal(record.response.status, nohit && apiKey ? 500 : 200);
  statusCounts[record.response.status] = (statusCounts[record.response.status] ?? 0) + 1;
  if (record.response.status === 500) assert.equal(record.response.bodyText, 'Error processing request.');
  else {
    assert.equal(record.response.bodyJson.TotalRecordCount, nohit ? 0 : record.name.endsWith('-explicit-union') ? 4 : 3);
    assert.equal(record.response.bodyJson.Items.length, nohit ? 0 : 2);
    if (!nohit) assert.deepEqual(record.response.bodyJson.Items.map(item => item.Type), ['Movie', 'Audio']);
  }
}
assert.deepEqual(statusCounts, { 200: 15, 500: 3 });
const projection = { format: 1, frozenJellyfin: true, inputSha256: sha(inputBytes), recorderSha256: sha(recorderBytes),
  sourceBindings: bound, nativeSourceBindings: runtime.sourceBindings, runtimeBindings: runtime,
  summary, http, nativeState: fullState,
  audit: { passed: true, phaseAcceptance: false, responses: 18, endpointSnapshots: 18, completeStageWindows: 3,
    allRecordedStateEqual: true, tables, tableCounts: Object.fromEntries(tables.map(name => [name, fullState.database.tables[name].length])),
    filesystemDomains: Object.keys(fullState.filesystem), statusCounts, processReclaimed: true },
  projection: 'All eighteen raw HTTP records are retained without field removal. All twelve recorded media/UserData tables, four filesystem domains and foreign-key checks at eighteen endpoints and three windows are verified exactly equal before retaining one full native state. Authentication setup, Users, policies and token/password tables are outside these recorded state snapshots and are not projected. Runtime copies are post-execution; the executable also matches the recorder pre-run hash. No stage acceptance.' };
await writeFile(path.join(target, 'input.json'), inputBytes, { flag: 'wx' });
const bytes = Buffer.from(JSON.stringify(projection, null, 2) + '\n');
await writeFile(path.join(target, 'native.json'), bytes, { flag: 'wx' });
console.log(JSON.stringify({ inputSha256: sha(inputBytes), nativeSha256: sha(bytes), bytes: bytes.length,
  sourceBindings: bound.length, nativeSourceBindings: runtime.sourceBindings.length, runtimeFiles: runtime.files.length }));
