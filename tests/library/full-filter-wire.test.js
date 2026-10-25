import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCompleteFilterHttpResponses } from './full-filter-wire.js';
const options = { scenarioName: 'filter-wire-unit', nativeServerId: 'native-isolated' };
const response = (body, native = false, status = 200) => ({ status, contentType: 'application/json; charset=utf-8',
  bodyText: JSON.stringify(body), [native ? 'bodyJson' : 'body']: body });
const pair = () => {
  const body = { Items: [{ Id: 'item', ServerId: 'native-isolated', CommunityRating: 7.5, RunTimeTicks: 72000000000,
    MediaSources: [{ SupportsTranscoding: true }], Unknown: { preserved: null } }], TotalRecordCount: 1, StartIndex: 0 };
  const observed = structuredClone(body); observed.Items[0].ServerId = 'filter_wire_unit-postgres';
  return { actual: { cases: [{ name: 'one', endpoints: [{ endpoint: 'items', response: response(observed) }] }] },
    native: { records: [{ name: 'one', endpoint: 'items', response: response(body, true) }] } };
};
test('complete response guard retains unknown/null fields and exact non-identity values', () => {
  const value = pair(); assert.equal(assertCompleteFilterHttpResponses(value.actual, value.native, options).responses, 1);
  for (const field of ['CommunityRating', 'RunTimeTicks', 'Unknown']) {
    const copy = structuredClone(value); const item = copy.actual.cases[0].endpoints[0].response.body.Items[0];
    delete item[field]; copy.actual.cases[0].endpoints[0].response.bodyText = JSON.stringify(copy.actual.cases[0].endpoints[0].response.body);
    assert.throws(() => assertCompleteFilterHttpResponses(copy.actual, copy.native, options));
  }
});
test('complete response guard rejects changed static capability, status and unbound ServerId', () => {
  for (const change of [value => { value.body.Items[0].MediaSources[0].SupportsTranscoding = false; },
    value => { value.status = 204; }, value => { value.body.Items[0].ServerId = 'unexpected'; }]) {
    const value = pair(), observed = value.actual.cases[0].endpoints[0].response;
    change(observed); observed.bodyText = JSON.stringify(observed.body);
    assert.throws(() => assertCompleteFilterHttpResponses(value.actual, value.native, options));
  }
});
test('complete response guard never drops successful or nested trace fields', () => {
  const value = pair(), observed = value.actual.cases[0].endpoints[0].response;
  observed.body.Items[0].traceId = 'not-a-problem'; observed.bodyText = JSON.stringify(observed.body);
  assert.throws(() => assertCompleteFilterHttpResponses(value.actual, value.native, options));
});
test('only valid unique top-level problem traces normalize, with raw JSON still checked', () => {
  const a = { title: 'Bad request', status: 400, traceId: '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01' };
  const e = { ...a, traceId: '00-' + 'c'.repeat(32) + '-' + 'd'.repeat(16) + '-01' };
  const actual = { cases: [{ name: 'error', endpoints: [{ endpoint: 'items', response: response(a, false, 400) }] }] };
  const native = { records: [{ name: 'error', endpoint: 'items', response: response(e, true, 400) }] };
  assert.equal(assertCompleteFilterHttpResponses(actual, native, options).candidateTracesValidated, 1);
  actual.cases.push(structuredClone(actual.cases[0])); native.records.push(structuredClone(native.records[0]));
  assert.throws(() => assertCompleteFilterHttpResponses(actual, native, options));
  actual.cases.pop(); native.records.pop(); actual.cases[0].endpoints[0].response.bodyText = '{}';
  assert.throws(() => assertCompleteFilterHttpResponses(actual, native, options));
});

test('an empty response body and the JSON literal null remain distinct', () => {
  const actual = { cases: [{ name: 'empty', endpoints: [{ endpoint: 'detail', response: { status: 404,
    contentType: 'application/json', bodyText: '', body: null } }] }] };
  const native = { records: [{ name: 'empty', endpoint: 'detail', response: { status: 404,
    contentType: 'application/json', bodyText: '', bodyJson: null } }] };
  assert.equal(assertCompleteFilterHttpResponses(actual, native, options).responses, 1);
  actual.cases[0].endpoints[0].response.bodyText = 'null';
  assert.throws(() => assertCompleteFilterHttpResponses(actual, native, options));
});

test('a native plain-text controller failure retains every response byte', () => {
  const actual = { cases: [{ name: 'failed', endpoints: [{ endpoint: 'items', response: { status: 500,
    contentType: 'text/plain; charset=utf-8', bodyText: 'Error processing request.', body: null } }] }] };
  const native = { records: [{ name: 'failed', endpoint: 'items', response: { status: 500,
    contentType: 'text/plain; charset=utf-8', bodyText: 'Error processing request.' } }] };
  assert.equal(assertCompleteFilterHttpResponses(actual, native, options).responses, 1);
  actual.cases[0].endpoints[0].response.bodyText += '\n';
  assert.throws(() => assertCompleteFilterHttpResponses(actual, native, options));
});
