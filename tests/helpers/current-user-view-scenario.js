import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getNewItemId } from '../../src/core/identity.js';
import { idKey } from '../../src/library/records.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { recordUserViewHttp } from '../../tools/compat/record-user-view-http.js';
import { createFixtureIdentityProjector } from './fixture-identity-projection.js';
export { filterEvidenceJson as userViewEvidenceJson } from '../../tools/compat/filter-reference-output.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const namedViewId = (user, type) => idKey(getNewItemId(`38_namedview_${idKey(user)}${type}`,
  'MediaBrowser.Controller.Entities.UserView', { programDataPath: 'Z:\\OracleUserViews' }));

/** Rebind only observed instance identities; Library A and all synthetic media stay literal. */
export async function currentUserViewScenario(scenario, fixtureBytes, { signal } = {}) {
  signal?.throwIfAborted();
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
  const project = createFixtureIdentityProjector({ identities: ids, viewRows: stages.afterReads.database.baseItems });
  const originalHttp = await load('native-http.json');
  const http = { ...originalHttp, records: originalHttp.records.map(record => ({ ...record,
    ...(record.request ? { request: project.request(record.request, record.route) } : {}),
    response: { ...record.response, ...(Object.hasOwn(record.response, 'bodyJson')
      ? { bodyJson: project.body(record.response.bodyJson) } : {}) },
  })) };
  // A projected parsed body and its text remain one HTTP observation.
  for (const record of http.records) {
    if (record.response.status === 401 && typeof record.response.bodyJson === 'string') {
      assert.equal(typeof provenance.preparation.actualUserName, 'string');
      record.response.bodyJson = record.response.bodyJson.replaceAll(provenance.preparation.actualUserName, 'CoreFlowAdmin');
    }
    if (record.response.bodyText !== '' && record.response.bodyJson !== undefined) record.response.bodyText = JSON.stringify(record.response.bodyJson);
  }
  const projectedStages = Object.fromEntries(Object.entries(stages).map(([name, value]) => [name,
    ['before', 'afterReads', 'afterShutdown'].includes(name) ? project.snapshot(value) : value]));
  const caseStages = (await load('case-stages.json')).map(stage => ({ ...stage,
    ...(stage.before ? { before: project.snapshot(stage.before) } : {}),
    ...(stage.after ? { after: project.snapshot(stage.after) } : {}),
  }));
  const result = { root, http, stages: projectedStages, caseStages, summary,
    nativeServerId: provenance.preparation.nativeServerId };
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
