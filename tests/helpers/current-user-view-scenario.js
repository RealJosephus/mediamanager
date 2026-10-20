import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getNewItemId } from '../../src/core/identity.js';
import { idKey } from '../../src/library/records.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { recordUserViewHttp } from '../../tools/compat/record-user-view-http.js';
export { filterEvidenceJson as userViewEvidenceJson } from '../../tools/compat/filter-reference-output.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const namedViewId = (user, type) => idKey(getNewItemId(`38_namedview_${idKey(user)}${type}`,
  'MediaBrowser.Controller.Entities.UserView', { programDataPath: 'Z:\\OracleUserViews' }));

/** Rebind only observed instance identities; Library A and all synthetic media stay literal. */
export async function currentUserViewScenario(scenario, fixtureBytes) {
  const root = path.join(validationOutputRoot(), `${scenario}-${randomUUID()}`);
  await recordUserViewHttp(scenario, root, 19000);
  const load = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
  const provenance = await load('provenance.json');
  for (const artifact of provenance.artifacts) {
    assert.equal(path.basename(artifact.path), artifact.path);
    assert.equal(digest(await readFile(path.join(root, artifact.path))), artifact.sha256);
  }
  const cleanup = await load('private-cleanup.json');
  assert.equal(cleanup.privateInstanceRemoved, true);
  const summary = await load('summary.json');
  assert.equal(summary.passed, true);
  assert.equal(summary.fixtureSha256, digest(fixtureBytes));
  assert.ok(Object.values(summary.checks).every(Boolean));
  const fixture = JSON.parse(fixtureBytes);
  const bindings = provenance.preparation.bindings;
  assert.deepEqual(bindings.map(binding => binding.kind), ['user', 'AggregateFolder', 'UserRootFolder']);
  assert.equal(new Set(bindings.map(binding => idKey(binding.actualId))).size, 3);
  const ids = new Map(bindings.map(binding => [idKey(binding.actualId), binding.fixtureId]));
  const stages = await load('stages.json');
  const user = bindings.find(binding => binding.kind === 'user');
  for (const row of stages.afterReads.database.baseItems) {
    if (row.Type !== 'MediaBrowser.Controller.Entities.UserView') continue;
    const data = JSON.parse(row.Data ?? '{}');
    if (!data.UserId) continue;
    assert.equal(idKey(data.UserId), idKey(user.actualId));
    assert.equal(idKey(row.Id), namedViewId(user.actualId, data.ViewType));
    ids.set(idKey(row.Id), namedViewId(user.fixtureId, data.ViewType));
  }
  const projectText = value => {
    if (ids.has(idKey(value))) {
      const mapped = ids.get(idKey(value));
      const key = idKey(mapped);
      if (value.includes('-')) return `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`
        [value === value.toUpperCase() ? 'toUpperCase' : 'toLowerCase']();
      return value === value.toUpperCase() ? key.toUpperCase() : key;
    }
    return value.replace(/views([\\/])([a-f0-9]{32})/giu,
      (match, separator, id) => ids.has(idKey(id)) ? `views${separator}${idKey(ids.get(idKey(id)))}` : match);
  };
  const project = value => {
    if (Array.isArray(value)) return value.map(project);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (key === 'Data' && typeof entry === 'string') return [key, JSON.stringify(project(JSON.parse(entry)))];
      return [key, project(entry)];
    }));
    return typeof value === 'string' ? projectText(value) : value;
  };
  const http = project(await load('native-http.json'));
  // A projected parsed body and its text remain one HTTP observation.
  for (const record of http.records) {
    if (record.response.status === 401 && typeof record.response.bodyJson === 'string') {
      assert.equal(typeof provenance.preparation.actualUserName, 'string');
      record.response.bodyJson = record.response.bodyJson.replaceAll(provenance.preparation.actualUserName, 'CoreFlowAdmin');
    }
    if (record.response.bodyJson !== undefined) record.response.bodyText = JSON.stringify(record.response.bodyJson);
  }
  const result = { root, http, stages: project(stages), caseStages: project(await load('case-stages.json')), summary };
  const inputRoot = fixture.items.find(item => item.key === 'libraryA');
  assert.equal(fixture.rootId, inputRoot.id);
  assert.equal(result.stages.before.database.baseItems.some(row => idKey(row.Id) === idKey(inputRoot.id)), true);
  await writeFile(path.join(root, 'identity-projection.json'), JSON.stringify({ bindings,
    generatedViews: [...ids].slice(3), queryRoot: fixture.rootId, fixtureSha256: summary.fixtureSha256 }, null, 2) + '\n', { flag: 'wx' });
  return result;
}

export function candidateCasesFromTrackedInput(fixture) {
  return fixture.cases.map(testCase => ({ ...testCase, expectedStatus: testCase.expectedStatus ?? 200 }));
}
