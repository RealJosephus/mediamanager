import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedMethods, projectResetObservation } from './password-reset-current-observations.js';

test('password reset HTTP observations compare Allow as a case-sensitive method set', () => {
  assert.deepEqual(allowedMethods('DELETE, GET, POST'), allowedMethods('POST, GET, DELETE'));
  assert.notDeepEqual(allowedMethods('GET, POST'), allowedMethods('POST'));
  assert.notDeepEqual(allowedMethods('get, POST'), allowedMethods('GET, POST'));
  for (const value of ['GET, GET', 'GET,,POST', 'GET POST', 'GET, /POST', 'GET,\nPOST']) assert.throws(() => allowedMethods(value));
});

test('password reset observations bind Windows and POSIX instance paths without accepting unrelated files or HTTP failures', async () => {
  const observation = (root, separator) => {
    const pinFile = root + separator + 'passwordreset-test.json', expiration = '2026-01-01T00:30:00Z';
    return { name: 'generated', ProgramData: root, before: { Users: [] }, after: { Users: [] },
      calls: [], events: [], catalogs: {}, passwordChecks: [], observations: [{ status: 200, contentType: 'application/json', allow: '',
        started: '2026-01-01T00:00:00Z', finished: '2026-01-01T00:00:00Z',
        json: { Action: 'PinCode', PinFile: pinFile, PinExpirationDate: expiration },
        files: [{ name: 'passwordreset-test.json', directory: false, readOnly: false,
          text: JSON.stringify({ Pin: '01-23-45-67', PinFile: pinFile, ExpirationDate: expiration }) }] }] };
  };
  const windows = observation('D:\\native\\program', '\\'), posix = observation('/tmp/candidate/program', '/');
  const contract = await projectResetObservation(windows);
  assert.deepEqual(await projectResetObservation(posix), contract);
  for (const pinFile of ['relative.json', 'D:\\native\\program-sibling\\passwordreset-test.json', 'D:\\native\\program\\child\\passwordreset-test.json']) {
    const changed = structuredClone(windows); changed.observations[0].json.PinFile = pinFile;
    await assert.rejects(projectResetObservation(changed));
  }
  const failed = structuredClone(posix); failed.observations[0].status = 500;
  assert.notDeepEqual(await projectResetObservation(failed), contract);
});

test('current password reset only projects actual root ProblemDetails and verified successful PIN fields', async () => {
  const body = '{"Action":"ContactAdmin","traceId":17,"ProviderIds":{"traceId":"literal","ticks":9223372036854775807}}',
    row = { name: 'current complete HTTP body', ProgramData: '/tmp/current-reset', before: { Users: [] }, after: { Users: [] },
      events: [], catalogs: {}, passwordChecks: [], observations: [{ status: 200, contentType: 'application/json', allow: '',
        hasJson: true, body, json: JSON.parse(body), files: [],
        started: '2026-01-01T00:00:00Z', finished: '2026-01-01T00:00:00Z' }] };
  const actual = await projectResetObservation(row);
  assert.equal(actual.observations[0].body.traceId, 17);
  assert.deepEqual(actual.observations[0].body.ProviderIds, { traceId: 'literal', ticks: 9223372036854775807n });
  const problem = { status: 400, title: 'Bad Request', traceId: 'transport trace', errors: { traceId: ['literal'] },
    Action: 'PinCode', PinFile: 'literal error extension', PinExpirationDate: 'literal date extension' };
  const error = structuredClone(row); Object.assign(error.observations[0], { status: 400, json: problem, body: JSON.stringify(problem) });
  const expected = await projectResetObservation(error);
  assert.equal(expected.observations[0].body.traceId, '$trace'); assert.deepEqual(expected.observations[0].body.errors, problem.errors);
  assert.equal(expected.observations[0].body.PinFile, problem.PinFile);
  assert.equal(expected.observations[0].body.PinExpirationDate, problem.PinExpirationDate);
  const absent = structuredClone(error); delete absent.observations[0].json.traceId;
  absent.observations[0].body = JSON.stringify(absent.observations[0].json);
  assert.notDeepEqual(await projectResetObservation(absent), expected);
  for (const trace of [null, 42, {}]) {
    const invalid = structuredClone(error); invalid.observations[0].json.traceId = trace;
    invalid.observations[0].body = JSON.stringify(invalid.observations[0].json);
    await assert.rejects(projectResetObservation(invalid));
  }
});
