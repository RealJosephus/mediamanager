import assert from 'node:assert/strict';
import test from 'node:test';
import { projectItemBody, projectProblemTrace, projectPlaybackInfoBody } from '../helpers/http-body-projection.js';

test('public metadata cannot disappear behind request-trace or isolated-instance projections', () => {
  const opaque = { traceId: 'provider-trace', ServerId: 'provider-server', DateCreated: 'not-a-date',
    Path: '/instance/a', Id: 'instance-user', Type: 'Movie' };
  const input = { Items: [{ Id: 'movie', Type: 'Movie', ServerId: 'instance', Path: '/instance/a',
    Overview: '/instance/a', OriginalTitle: 'instance-user', DateCreated: '2026-01-01T00:00:00Z',
    DateLastSaved: '2026-01-01T00:00:00Z', DateLastRefreshed: 'metadata value',
    ProviderIds: opaque, Unknown: { ...opaque }, traceId: 'business-trace', status: 400, title: 'Business title',
    MediaSources: [{ Id: 'movie', Path: '/instance/a', RequiredHttpHeaders: opaque }],
  }], TotalRecordCount: 1, StartIndex: 0, Unknown: opaque };
  const original = structuredClone(input);
  const project = body => projectItemBody(body, { serverId: 'instance',
    path: value => value.replace('/instance/', '$root/'), identity: value => value === 'instance-user' ? '$user' : value });
  const result = project(input), item = result.Items[0];
  assert.equal(item.ServerId, '$server'); assert.equal(item.Path, '$root/a');
  assert.equal(item.MediaSources[0].Path, '$root/a');
  assert.equal(item.Overview, '/instance/a'); assert.equal(item.OriginalTitle, 'instance-user');
  assert.equal(item.DateLastSaved, '2026-01-01T00:00:00Z'); assert.equal(item.DateLastRefreshed, 'metadata value');
  assert.equal(item.traceId, 'business-trace');
  assert.deepEqual(item.ProviderIds, opaque); assert.deepEqual(item.Unknown, opaque);
  assert.deepEqual(item.MediaSources[0].RequiredHttpHeaders, opaque); assert.deepEqual(result.Unknown, opaque);
  for (const field of ['traceId', 'ServerId', 'DateCreated', 'Path', 'Id']) {
    const different = structuredClone(input); different.Items[0].ProviderIds[field] += '-changed';
    assert.notDeepEqual(project(different), result, field);
  }
  assert.throws(() => projectItemBody(input, { serverId: 'wrong-instance' }));
  assert.deepEqual(input, original);
});

test('problem trace values may differ while presence, type, errors and nested metadata remain observable', () => {
  const problem = { type: 'about:blank', title: 'Bad Request', status: 400, traceId: 'actual-request',
    errors: { traceId: ['The provider trace is invalid.'] } };
  const projected = projectProblemTrace(problem, 400);
  assert.equal(projected.traceId, '$trace'); assert.deepEqual(projected.errors, problem.errors);
  assert.deepEqual(projectProblemTrace({ ...problem, traceId: 'another-request' }, 400), projected);
  const { traceId, ...missing } = problem;
  assert.notDeepEqual(projectProblemTrace(missing, 400), projected);
  for (const value of [null, 0, false, '', {}]) assert.throws(() => projectProblemTrace({ ...problem, traceId: value }, 400));
  assert.deepEqual(projectProblemTrace(problem, 200), problem);
  const ordinary = { traceId: 'metadata', status: 400 };
  assert.deepEqual(projectProblemTrace(ordinary, 400), ordinary);
});

test('PlaybackInfo correlation and fixture paths cannot conceal missing fields or opaque source data', () => {
  const opaque = { PlaySessionId: 'provider-session', traceId: 'provider-trace', ServerId: 'provider-server',
    DateCreated: 'provider-date', Path: '/fixture/subtitle.srt' };
  const body = { PlaySessionId: 'actual-session', MediaSources: [{ Id: 'source', Path: '/fixture/movie.mkv',
    Name: '/fixture/subtitle.srt', RequiredHttpHeaders: opaque, Unknown: { ...opaque },
    MediaStreams: [{ Path: '/fixture/subtitle.srt', DisplayTitle: '/fixture/subtitle.srt', Unknown: { ...opaque } }] }], Unknown: opaque };
  const original = structuredClone(body), project = value => projectPlaybackInfoBody(value, {
    status: 200, path: value => value === '/fixture/subtitle.srt' ? '$subtitle' : value,
  });
  const result = project(body);
  assert.equal(result.PlaySessionId, '$play-session');
  assert.equal(result.MediaSources[0].MediaStreams[0].Path, '$subtitle');
  assert.equal(result.MediaSources[0].Name, body.MediaSources[0].Name);
  assert.equal(result.MediaSources[0].MediaStreams[0].DisplayTitle, body.MediaSources[0].MediaStreams[0].DisplayTitle);
  assert.deepEqual(result.MediaSources[0].RequiredHttpHeaders, opaque); assert.deepEqual(result.Unknown, opaque);
  for (const field of Object.keys(opaque)) {
    const changed = structuredClone(body); changed.MediaSources[0].RequiredHttpHeaders[field] += '-changed';
    assert.notDeepEqual(project(changed), result, field);
  }
  const missing = structuredClone(body); delete missing.PlaySessionId;
  assert.notDeepEqual(project(missing), result);
  assert.throws(() => project({ ...body, PlaySessionId: null }));
  assert.deepEqual(projectPlaybackInfoBody({ status: 400, title: 'Bad Request', traceId: 'request', Unknown: opaque }, { status: 400 }).Unknown, opaque);
  assert.deepEqual(body, original);
});
