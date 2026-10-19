import { validationPath } from '../validation/paths.js';
// Preserve frozen Genre-menu observations while removing repeated immutable rows.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const idKey = value => String(value ?? '').replaceAll('-', '').toLowerCase();
const stringify = value => JSON.stringify(value);

export async function projectGenreMenu({ directory, inputPath, outputPath, errorResponses, responseCount, newRows }) {
  const inputs = {};
  const bindings = [];
  for (const name of ['input.json', 'summary.json', 'native-http.json', 'stages.json', 'case-stages.json',
    'reference-stdout.log', 'record-native.mjs']) {
    const relative = `${directory}/${name}`;
    const bytes = await readFile(validationPath(path.join(repo, relative)));
    inputs[name] = name.endsWith('.json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8');
    bindings.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const fixtureBytes = await readFile(validationPath(path.join(repo, inputPath)));
  const fixture = JSON.parse(fixtureBytes.toString('utf8'));
  assert.equal(inputs['summary.json'].fixtureSha256, sha256(fixtureBytes));
  assert.deepEqual(fixture, inputs['input.json']);
  const summary = inputs['summary.json'];
  assert.equal(summary.passed, true);
  assert.equal(summary.candidateVerified, false);
  assert.equal(summary.phaseAcceptance, false);
  assert.equal(summary.cases, responseCount);
  assert.equal(summary.snapshots, responseCount);
  assert.equal(summary.portAvailable, true);
  assert.deepEqual(summary.processResult, { code: 0, signal: null });
  assert.equal(summary.recorderSha256, bindings.find(item => item.path.endsWith('/record-native.mjs')).sha256);
  const fullStages = inputs['stages.json'];
  assert.deepEqual(fullStages.afterReads, fullStages.afterShutdown);
  const originalIds = new Set(fullStages.before.database.baseItems.map(row => idKey(row.Id)));
  const originalRows = stringify(fullStages.before.database.baseItems);
  const immutableTables = Object.keys(fullStages.before.database).filter(key => key !== 'baseItems');
  const states = []; const stateIndexes = new Map();
  function projectState(stage) {
    assert.equal(stringify(stage.database.baseItems.filter(row => originalIds.has(idKey(row.Id)))), originalRows);
    for (const key of immutableTables) assert.deepEqual(stage.database[key], fullStages.before.database[key], key);
    for (const key of ['userViews', 'libraries', 'collections']) {
      assert.deepEqual(stage.filesystem[key], fullStages.before.filesystem[key], key);
    }
    const state = { database: { baseItems: stage.database.baseItems.filter(row => !originalIds.has(idKey(row.Id))) },
      filesystem: { metadata: stage.filesystem.metadata } };
    const text = stringify(state);
    let index = stateIndexes.get(text);
    if (index === undefined) { index = states.length; states.push(state); stateIndexes.set(text, index); }
    return index;
  }
  const stages = Object.fromEntries(Object.entries(fullStages).filter(([key]) => ['before', 'afterReads', 'afterShutdown'].includes(key))
    .map(([key, value]) => [key, projectState(value)]));
  const caseStages = inputs['case-stages.json'].map(stage => ({ name: stage.name, endpoint: stage.endpoint,
    before: projectState(stage.before), after: projectState(stage.after) }));
  assert.equal(caseStages.length, responseCount);
  assert.equal(states[stages.afterReads].database.baseItems.length, newRows);
  const http = inputs['native-http.json'];
  assert.equal(http.records.length, responseCount);
  const errors = http.records.filter(record => record.response.status === 400);
  assert.equal(errors.length, errorResponses);
  const diagnostics = [...inputs['reference-stdout.log'].matchAll(
    /Jellyfin\.Api\.Middleware\.ExceptionMiddleware: Error processing request\. URL GET ([^\r\n]+)\.[\r\n]+System\.ArgumentException: Guid can't be empty \(Parameter 'id'\)/gu,
  )].map(match => ({ requestPath: match[1], diagnostic: match[0] }));
  assert.equal(diagnostics.length, errorResponses);
  for (const [index, record] of errors.entries()) {
    assert.equal(record.response.bodyText, 'Error processing request.');
    assert.equal(diagnostics[index].requestPath, record.endpoint === 'items' ? '/Items' : `/Users/${idKey(fixture.userId)}/Items`);
  }
  const projection = {
    format: 1, frozenJellyfin: true, fixtureInputSha256: sha256(fixtureBytes), sourceBindings: bindings,
    projection: {
      immutableTables, immutableFilesystemDomains: ['userViews', 'libraries', 'collections'],
      immutableTablesAndOriginalRowsVerified: true,
      method: 'Preserve complete HTTP observations and BaseItem seed rows. Each endpoint state contains every newly created BaseItem column and the complete metadata tree. Omit only original BaseItems, other tables and directory domains after verifying their exact equality in every window. Intern identical projected states without changing values or array order. Authentication setup, sessions and password tables are excluded.'
    },
    summary, initial: { baseItems: fullStages.before.database.baseItems,
      userDataCount: fullStages.before.database.userData.length,
      immutableTableCounts: Object.fromEntries(immutableTables.map(key => [key, fullStages.before.database[key].length])) },
    http, diagnostics, states, stages, caseStages,
  };
  const bytes = JSON.stringify(projection) + '\n';
  await writeFile(validationPath(path.join(repo, outputPath)), bytes, { flag: 'wx' });
  const binding = { outputPath, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes), projectorPath: 'tools/compat/project-user-view-genre-menu.js',
    projectorSha256: sha256(await readFile(fileURLToPath(import.meta.url))), responses: responseCount, newRows, distinctStates: states.length };
  await writeFile(validationPath(path.join(repo, directory, 'fixture-projection.json')), JSON.stringify(binding, null, 2) + '\n', { flag: 'wx' });
  return binding;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [kind = 'main'] = process.argv.slice(2);
  const definition = kind === 'main'
    ? { directory: '.agent-docs/evidence/user-view-genre-menu-native-v1/native-run-v2',
      inputPath: 'tests/library/fixtures/user-view-genre-menu/input.json',
      outputPath: 'tests/library/fixtures/user-view-genre-menu/native.json', errorResponses: 8, responseCount: 224, newRows: 14 }
    : kind === 'lazy' ? { directory: '.agent-docs/evidence/user-view-genre-menu-lazy-native-v1/native-run',
      inputPath: 'tests/library/fixtures/user-view-genre-menu/lazy-input.json',
      outputPath: 'tests/library/fixtures/user-view-genre-menu/lazy-native.json', errorResponses: 4, responseCount: 8, newRows: 10 } : null;
  assert.ok(definition, 'Unknown Genre-menu projection.');
  console.log(JSON.stringify(await projectGenreMenu(definition)));
}
