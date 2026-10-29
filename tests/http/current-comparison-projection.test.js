import test from 'node:test';
import assert from 'node:assert/strict';
import { projectKeyObservation } from './api-keys-current-observations.js';
import { projectBrandingHttpBody, projectBrandingFixtureState } from '../helpers/branding-fixture-projection.js';

const token = '1234567890abcdef1234567890abcdef', date = '2026-10-27T03:00:00.1234567Z';
function keyRecord(camel = false) {
  const state = [{ Id: 1, Name: token, AccessToken: token, DateCreated: date, DateLastActivity: '0001-01-01 00:00:00' }];
  const dto = camel
    ? { accessToken: token, dateCreated: date, appName: token }
    : { AccessToken: token, DateCreated: date, AppName: token };
  Object.assign(dto, { traceId: 'literal DTO traceId', Extra: { traceId: token, AccessToken: token, DateCreated: date,
    ticks: 9223372036854775807n } });
  const list = camel ? { items: [dto], totalRecordCount: 1, startIndex: 0, Items: [{ AccessToken: token }] }
    : { Items: [dto], TotalRecordCount: 1, StartIndex: 0 };
  const observation = (status, json) => ({ status, json, body: '', contentType: 'application/json'
    + (camel ? '; profile="CamelCase"' : '') + '; charset=utf-8', allow: '', state,
    started: '2026-10-27T03:00:00.1000000Z', completed: '2026-10-27T03:00:00.2000000Z' });
  return { name: 'controlled current projection', before: [], after: state, observations: [observation(204, null),
    observation(200, { ...list, traceId: 'success business value' }),
    observation(400, { title: 'Bad Request', status: 400, traceId: 'actual transport trace',
      errors: { traceId: [token] }, ProviderIds: { traceId: token, AccessToken: token } })] };
}

test('current API key projection preserves opaque values and root trace presence while binding generated key fields', () => {
  const record = keyRecord(), before = structuredClone(record), actual = projectKeyObservation(record),
    dto = actual.observations[1].json.Items[0];
  assert.equal(dto.AccessToken, '$key-0'); assert.equal(dto.DateCreated, '$date-0');
  assert.equal(dto.AppName, token); assert.equal(dto.traceId, 'literal DTO traceId');
  assert.deepEqual(dto.Extra, before.observations[1].json.Items[0].Extra);
  assert.equal(actual.observations[1].json.traceId, 'success business value');
  assert.equal(actual.observations[2].json.traceId, '$trace');
  assert.deepEqual(actual.observations[2].json.errors.traceId, [token]);
  assert.deepEqual(actual.observations[2].json.ProviderIds, before.observations[2].json.ProviderIds);
  assert.equal(actual.after[0].Name, token); assert.deepEqual(record, before);
  const absent = structuredClone(record); delete absent.observations[2].json.traceId;
  assert.notDeepEqual(projectKeyObservation(absent), actual);
  for (const trace of [null, 7, {}]) {
    const invalid = structuredClone(record); invalid.observations[2].json.traceId = trace;
    assert.throws(() => projectKeyObservation(invalid));
  }
});

test('current API key CamelCase role keeps unknown casing and exact source-bound date ticks', () => {
  const record = keyRecord(true), actual = projectKeyObservation(record), body = actual.observations[1].json;
  assert.equal(body.items[0].accessToken, '$key-0'); assert.equal(body.items[0].dateCreated, '$date-0');
  assert.equal(body.items[0].appName, token); assert.equal(body.Items[0].AccessToken, token);
  assert.equal(body.items[0].Extra.ticks, 9223372036854775807n);
  record.observations[1].json.items[0].dateCreated = '2026-10-27T03:00:00.1234568Z';
  assert.throws(() => projectKeyObservation(record), /persisted key/u);
});

test('branding fixture alignment only changes declared path and image callback date roles', () => {
  const root = '/isolated-instance', options = { SplashscreenLocation: root + '/data/logo.png',
    LoginDisclaimer: root + '/literal disclaimer', CustomCss: root + '/literal.css',
    traceId: 'branding business trace', ProviderIds: { traceId: root + '/literal provider' } },
    original = { live: options, disk: options, files: [{ name: 'logo.png', bytes: 'aW1hZ2U=' }],
      calls: [{ phase: 'configuration-updated', options },
        { phase: 'image', path: root + '/data/logo.png', dateModified: date,
          headers: { traceId: root + '/literal header' } },
        { phase: 'unknown', path: root + '/literal path', dateModified: date }],
      traceId: 'summary business trace' }, before = structuredClone(original),
    actual = projectBrandingFixtureState(original, root);
  assert.equal(actual.live.SplashscreenLocation, '{state}/data/logo.png');
  assert.equal(actual.live.LoginDisclaimer, options.LoginDisclaimer); assert.equal(actual.live.CustomCss, options.CustomCss);
  assert.deepEqual(actual.live.ProviderIds, options.ProviderIds);
  assert.deepEqual(actual.calls[1].headers, original.calls[1].headers);
  assert.deepEqual(actual.calls[2], original.calls[2]); assert.deepEqual(actual.files, original.files);
  assert.equal(actual.traceId, original.traceId); assert.deepEqual(original, before);
  const changed = structuredClone(original); changed.calls[1].dateModified = '2026-10-27T03:00:00.1234568Z';
  assert.notEqual(projectBrandingFixtureState(changed, root).calls[1].dateModified, actual.calls[1].dateModified);
  const problem = { status: 400, title: 'Bad Request', traceId: 'wire trace', errors: { traceId: ['literal'] } };
  const projected = projectBrandingHttpBody(problem, { status: 400, route: '/Branding/Configuration', root });
  assert.equal(projected.traceId, '$trace'); assert.deepEqual(projected.errors, problem.errors);
  assert.deepEqual(projectBrandingHttpBody(problem, { status: 200, route: '/Branding/Configuration', root }), problem);
});
