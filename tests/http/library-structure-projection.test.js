import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectStructureObservation, structureNormalizer } from './fixtures/library-structure-current/observations.js';

const sample = { method: 'GET', path: '/Library/VirtualFolders?newName=Renamed' };
const originalRoot = path.resolve('original-structure-views'), currentRoot = path.resolve('current-structure-views');
const opaque = { Name: originalRoot, Path: originalRoot, MessageId: originalRoot, traceId: originalRoot,
  LibraryOptions: { PathInfos: [{ Path: originalRoot }] }, Suffix: originalRoot + '\\literal' };
function observation(views, temporary) {
  const options = { PathInfos: [{ Path: path.join(views, 'Library'), Unknown: structuredClone(opaque) }],
    SeasonZeroDisplayName: originalRoot, MetadataSavers: [originalRoot], TypeOptions: [{ MetadataFetchers: [originalRoot] }], Unknown: structuredClone(opaque) };
  const folder = { Name: originalRoot, Locations: [path.join(views, 'Library')], LibraryOptions: options, Unknown: structuredClone(opaque) };
  const file = relative => ({ path: relative, kind: 'file', bytesBase64: Buffer.from('Reader-equivalent XML layout').toString('base64'),
    options: { accepted: true, value: options } });
  return { name: 'typed paths and opaque text', views, status: 200, contentType: 'application/json; charset=utf-8', allow: '',
    hasJson: true, body: JSON.stringify([folder]), jsonBody: [folder],
    moveAttempts: [{ from: path.join(views, 'Library'), to: path.join(views, temporary) },
      { from: path.join(views, temporary), to: path.join(views, 'Renamed') }],
    beforeFiles: [file('Library/options.xml')], files: [file(temporary + '/options.xml')],
    calls: [{ action: 'create', value: { name: originalRoot, options, Unknown: structuredClone(opaque) } },
      { action: 'add-path', value: { name: originalRoot, info: { Path: path.join(views, 'Library'), Unknown: structuredClone(opaque) } } },
      { action: 'shortcut', value: { directory: path.join(views, temporary), info: { Path: path.join(views, 'Library') } } },
      { action: 'validate-physical', value: { id: 'fixed-item', recursive: true, tokenCanCancel: false, Unknown: structuredClone(opaque) } }],
    events: [{ libraryPath: path.join(views, 'Library'), options, Unknown: structuredClone(opaque) }],
    savedOptions: options, optionsRead: options, injectedFailure: null };
}

test('LibraryStructure projection binds actual path roles and keeps display/provider/unknown values literal', () => {
  const original = observation(originalRoot, 'original-temporary'), current = observation(currentRoot, 'current-temporary');
  const expected = projectStructureObservation(original, sample);
  assert.deepEqual(projectStructureObservation(current, sample), expected);
  assert.equal(expected.body[0].Name, originalRoot);
  assert.deepEqual(expected.body[0].Unknown, opaque);
  assert.deepEqual(expected.body[0].LibraryOptions.PathInfos[0].Unknown, opaque);
  assert.deepEqual(expected.savedOptions.MetadataSavers, [originalRoot]);
  assert.deepEqual(expected.events[0].Unknown, opaque);
  assert.deepEqual(expected.refreshRequests[0].value.Unknown, opaque);
  for (const change of [value => { value.savedOptions = { ...value.savedOptions, SeasonZeroDisplayName: currentRoot }; },
    value => { value.events[0].options = { ...value.events[0].options, MetadataSavers: [currentRoot] }; },
    value => { value.calls[0].value.name = currentRoot; },
    value => { const body = JSON.parse(value.body); body[0].Unknown.Path = currentRoot; value.body = JSON.stringify(body); }]) {
    const changed = structuredClone(current); change(changed);
    assert.notDeepEqual(projectStructureObservation(changed, sample), expected);
  }
});

test('LibraryStructure binds only owned path prefixes and recorded transient moves', () => {
  const row = observation(originalRoot, 'original-temporary'), normalize = structureNormalizer(row, sample);
  assert.equal(normalize(path.join(originalRoot, 'original-temporary', 'notes')), '{views}/temporary-1/notes');
  assert.equal(normalize(path.join(originalRoot, 'Library')), '{views}/Library');
  for (const value of [originalRoot + '-sibling', 'caption ' + path.join(originalRoot, 'Library'), 'caption ' + opaque.Suffix]) assert.equal(normalize(value), value);
  assert.deepEqual(normalize(opaque), opaque);
});

test('LibraryStructure binds the exact rename conflict target only with its HTTP role and existing directory', () => {
  const rename = { method: 'POST', path: '/Library/VirtualFolders/Name?name=Library&newName=Taken' };
  const conflict = views => {
    const row = observation(views, 'temporary');
    const body = 'The media library already exists at ' + path.join(views, 'Taken') + '.';
    return { ...row, status: 409, body: JSON.stringify(body), jsonBody: body,
      beforeFiles: [...row.beforeFiles, { path: 'Taken', kind: 'directory' }] };
  };
  const original = conflict(originalRoot), current = conflict(currentRoot);
  assert.deepEqual(projectStructureObservation(original, rename), projectStructureObservation(current, rename));
  assert.equal(projectStructureObservation(original, rename).body, 'The media library already exists at {views}/Taken.');
  for (const input of [{ ...rename, method: 'GET' }, { ...rename, path: '/Other?newName=Taken' },
    { ...rename, path: '/Library/VirtualFolders/Name?name=Library&newName=Library' }]) {
    assert.notDeepEqual(projectStructureObservation(original, input), projectStructureObservation(current, input));
  }
  for (const change of [row => { row.status = 400; },
    row => { row.beforeFiles = row.beforeFiles.filter(file => file.path !== 'Taken'); },
    row => { row.beforeFiles = row.beforeFiles.map(file => file.path === 'Taken' ? { ...file, kind: 'file', bytesBase64: '' } : file); },
    row => { row.body = JSON.stringify('Ordinary error text: ' + row.jsonBody); },
    row => { row.body = JSON.stringify(row.jsonBody + ' Additional error context.'); }]) {
    const left = structuredClone(original), right = structuredClone(current); change(left); change(right);
    assert.notDeepEqual(projectStructureObservation(left, rename), projectStructureObservation(right, rename));
  }
  const wrongTarget = structuredClone(current); wrongTarget.body = original.body;
  assert.notDeepEqual(projectStructureObservation(original, rename), projectStructureObservation(wrongTarget, rename));
});

test('LibraryStructure preserves raw JSON precision, complete content type and actual ProblemDetails trace presence', () => {
  const row = observation(originalRoot, 'original-temporary');
  Object.assign(row, { status: 400, body: '{"status":400,"title":"Bad request","traceId":"request-trace","errors":{"traceId":["literal"]},"Unknown":{"Path":"literal","ticks":9223372036854775807}}' });
  row.jsonBody = JSON.parse(row.body);
  const expected = projectStructureObservation(row, sample);
  assert.equal(expected.body.traceId, '$trace');
  assert.deepEqual(expected.body.errors, { traceId: ['literal'] });
  assert.deepEqual(expected.body.Unknown, { Path: 'literal', ticks: 9223372036854775807n });
  const absent = structuredClone(row); absent.body = row.body.replace(',"traceId":"request-trace"', '');
  assert.notDeepEqual(projectStructureObservation(absent, sample), expected);
  const invalid = structuredClone(row); invalid.body = row.body.replace('"request-trace"', 'false');
  assert.throws(() => projectStructureObservation(invalid, sample), assert.AssertionError);
  assert.notDeepEqual(projectStructureObservation({ ...row, contentType: 'application/json; charset=utf-16' }, sample), expected);
  const success = { ...row, status: 200 };
  assert.notDeepEqual(projectStructureObservation(success, sample), projectStructureObservation({ ...success, body: row.body.replace('"request-trace"', '"other-business-value"') }, sample));
});
