import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCompleteFilterHttpResponses } from './full-filter-wire.js';

// Explicit synthetic observations exercise the shared HTTP comparison contract.
// Original historical input/audit revalidation remains archived separately.
test('complete identity responses reject added fields, content types, counts and reordered observations', () => {
  const names = ['parallel', 'followup'];
  const observations = names.map((name, index) => ({ name,
    body: { Items: [{ Id: `item-${index}`, Name: name }], TotalRecordCount: 1, StartIndex: 0 } }));
  const candidate = { serverId: 'synthetic-candidate', cases: observations.map(({ name, body }) => ({ name, endpoints: [{ endpoint: 'items',
    response: { status: 200, contentType: 'application/json', bodyText: JSON.stringify(body), body: structuredClone(body) },
  }] })) };
  const reference = { records: observations.map(({ name, body }) => ({ name, endpoint: 'items',
    response: { status: 200, contentType: 'application/json', bodyText: JSON.stringify(body), bodyJson: body },
  })) };
  const options = { scenarioName: 'synthetic-identity-comparator', nativeServerId: 'synthetic-reference' };
  const verify = value => assertCompleteFilterHttpResponses(value, reference, options);
  assert.equal(verify(candidate).responses, 2);
  for (const mutate of [
    value => { const response = value.cases[0].endpoints[0].response;
      response.body.Unexpected = true; response.bodyText = JSON.stringify(response.body); },
    value => { value.cases[0].endpoints[0].response.contentType = 'text/plain'; },
    value => { value.cases.pop(); },
    value => { value.cases.push(structuredClone(value.cases[0])); },
    value => { value.cases.reverse(); },
  ]) {
    const changed = structuredClone(candidate); mutate(changed);
    assert.throws(() => verify(changed));
  }
});
