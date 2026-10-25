import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCompleteFilterHttpResponses } from './full-filter-wire.js';
import { loadNativeByNameFilterScenario } from './native-byname-filter-scenario.js';

test('full by-name wire control rejects extra fields, counts, order, bytes, headers and unbound identities', async () => {
  const scenario = await loadNativeByNameFilterScenario('artist');
  const scenarioName = 'byname-wire-control';
  const replaceServer = value => Array.isArray(value) ? value.map(replaceServer)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .map(([key, entry]) => [key, key === 'ServerId' ? 'byname_wire_control-postgres' : replaceServer(entry)])) : value;
  // Synthetic comparator controls never count as candidate runtime observations.
  const actual = { cases: scenario.records.map(record => {
    const body = replaceServer(structuredClone(record.response.bodyJson));
    return { name: record.name, endpoints: [{ endpoint: record.endpoint, response: { status: record.response.status,
      contentType: record.response.contentType, body, bodyText: JSON.stringify(body) } }] };
  }) };
  const options = { scenarioName, nativeServerId: scenario.nativeServerId };
  assert.equal(assertCompleteFilterHttpResponses(actual, scenario, options).responses, 95);
  const mutations = [
    value => { value.cases[0].endpoints[0].response.body.Items[0].Unexpected = { preserved: null }; },
    value => { delete value.cases[0].endpoints[0].response.body.Items[0].CommunityRating; },
    value => { value.cases[0].endpoints[0].response.body.Items[0].ServerId = 'foreign'; },
    value => { value.cases[0].endpoints[0].response.body.TotalRecordCount++; },
    value => { value.cases[0].endpoints[0].response.body.Items.reverse(); },
    value => { value.cases[0].endpoints[0].response.status = 201; },
    value => { value.cases[0].endpoints[0].response.contentType = 'text/plain'; },
    value => { value.cases.reverse(); },
    value => { value.cases.pop(); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(actual);
    mutate(changed);
    for (const entry of changed.cases) for (const endpoint of entry.endpoints) endpoint.response.bodyText = JSON.stringify(endpoint.response.body);
    assert.throws(() => assertCompleteFilterHttpResponses(changed, scenario, options));
  }
  const inconsistent = structuredClone(actual);
  inconsistent.cases[0].endpoints[0].response.bodyText = '{}';
  assert.throws(() => assertCompleteFilterHttpResponses(inconsistent, scenario, options));
});
