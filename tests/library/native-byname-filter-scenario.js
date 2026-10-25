import { projectIdentifiers } from '../helpers/byname-filter-input.js';
export { projectNativeByNameCandidateInput, seedNativeByNameFilterInput, assertNativeByNameFilterGetMutation } from '../helpers/byname-filter-input.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { idKey } from '../../src/library/records.js';
import { assertValidationOutputChild, validationFileUrl } from '../../tools/validation/paths.js';
import { assertCompleteFilterHttpResponses } from './full-filter-wire.js';
import { assertNativeByNameFilterOutput, nativeByNameFilterBinding, verifyNativeByNameFilterRecording } from './native-byname-filter-inputs.js';

export async function loadNativeByNameFilterScenario(kind, side = null) {
  const binding = await verifyNativeByNameFilterRecording(kind, side);
  const root = validationFileUrl('../../' + binding.logicalRoot + '/', import.meta.url);
  assert.equal(path.resolve(fileURLToPath(root)), path.resolve(binding.repetitions[0].filename));
  const load = name => readFile(new URL(name, root), 'utf8').then(JSON.parse);
  const [http, stages, summary, filesystem] = await Promise.all(['native-http.json', 'database-stages.json', 'summary.json', 'filesystem-stages.json'].map(load));
  assert.equal(summary.passed, true);
  const setup = kind === 'artist' ? null : await load('native-setup.json');
  const mapping = setup?.graph.fixtureKeyMapping ?? {};
  const identifiers = new Map(Object.values(mapping).map(entry => [idKey(entry.actualId), entry.fixtureId]));
  assert.equal(identifiers.size, Object.keys(mapping).length);
  assert.equal(new Set([...identifiers.values()].map(idKey)).size, identifiers.size);
  const preparation = JSON.parse(await readFile(nativeByNameFilterBinding.preparationInputFiles[0].filename, 'utf8'));
  const nativeServerId = preparation.observations.find(entry => entry.route === '/Users/AuthenticateByName').responseBody.SessionInfo.ServerId;
  const [login, ...remaining] = http.records;
  assert.equal(login.request.route, '/Users/AuthenticateByName');
  assert.equal(login.response.status, 200);
  assert.equal(login.response.bodyJson.ServerId, nativeServerId);
  const shutdown = remaining.pop();
  assert.equal(shutdown.request.route, '/System/Shutdown');
  assert.equal(shutdown.response.status, 204);
  assert.equal(remaining.length, binding.endpoints);
  const records = remaining.map(record => {
    assert.equal(record.request.method, 'GET');
    const separator = record.name.lastIndexOf(':');
    assert.ok(separator > 0);
    const name = record.name.slice(0, separator), endpoint = record.name.slice(separator + 1);
    assert.ok(['items', 'legacy'].includes(endpoint));
    const contentType = record.response.headers['content-type'];
    const response = { ...record.response, contentType };
    if (contentType?.includes('json')) {
      assert.deepEqual(JSON.parse(record.response.bodyText), record.response.bodyJson);
      response.bodyJson = projectIdentifiers(record.response.bodyJson, identifiers);
      response.bodyText = JSON.stringify(response.bodyJson);
    } else {
      if (record.response.bodyJson !== undefined) assert.equal(record.response.bodyJson, null);
      delete response.bodyJson;
    }
    return { name, endpoint, request: record.request, response };
  });
  return { recording: binding, root: fileURLToPath(root), http, stages, filesystem, mapping, identifiers, nativeServerId, records };
}

export async function writeCompleteByNameFilterEvidence(actual, scenario, { scenarioName }) {
  const comparison = assertCompleteFilterHttpResponses(actual, { records: scenario.records },
    { scenarioName, nativeServerId: scenario.nativeServerId });
  if (!process.env.MEDIAMANAGER_BYNAME_FILTER_WIRE_EVIDENCE) return comparison;
  assert.match(scenarioName, /^[a-z0-9-]+$/u);
  const root = assertNativeByNameFilterOutput(assertValidationOutputChild(path.resolve(process.env.MEDIAMANAGER_BYNAME_FILTER_WIRE_EVIDENCE)));
  await mkdir(root, { recursive: true });
  const output = assertNativeByNameFilterOutput(assertValidationOutputChild(path.join(root, scenarioName)));
  await mkdir(output);
  const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
  for (const [name, value] of [['postgres.json', actual], ['native-http.json', scenario.http],
    ['comparison.json', { ...comparison, scenarioName, logicalRoot: scenario.recording.logicalRoot,
      individuallyBoundGraphIdentifiers: scenario.mapping, completeHttpContractEqual: true, releaseAcceptance: false }]]) {
    await writeFile(path.join(output, name), json(value), { flag: 'wx' });
  }
  return comparison;
}

