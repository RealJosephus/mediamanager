import assert from 'node:assert/strict';
import path from 'node:path';

const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const signature = value => JSON.stringify(ordered(value));

export function structureNormalizer(row, sample) {
  assert.ok(path.isAbsolute(row.views), 'The observation binds its own current views directory.');
  const requested = new URL(sample.path, 'http://fixture.invalid').searchParams;
  const named = new Set(['Library', 'Taken', requested.get('name'), requested.get('newName')]);
  const temporary = [];
  for (const move of row.moveAttempts) for (const filename of [move.from, move.to]) {
    if (path.dirname(filename) !== row.views || named.has(path.basename(filename)) || temporary.includes(filename)) continue;
    temporary.push(filename);
  }
  const normalize = value => {
    if (typeof value === 'string') {
      if (!value.includes(row.views)) return value;
      for (const [index, directory] of temporary.entries()) value = value.replaceAll(directory, '{views}/temporary-' + (index + 1));
      return value.replaceAll(row.views, '{views}').replaceAll('\\', '/');
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
    return value;
  };
  return normalize;
}

function fileValues(files, row, normalize) {
  return files.map(file => {
    const filename = path.join(row.views, ...file.path.split('/'));
    const result = { path: normalize(filename), kind: file.kind };
    assert.ok(file.kind === 'directory' || file.kind === 'file', file.path);
    if (file.kind === 'file') {
      assert.equal(typeof file.bytesBase64, 'string', file.path);
      if (file.options) {
        result.options = { accepted: file.options.accepted, value: normalize(file.options.value) };
        if (!file.options.accepted) result.bytesBase64 = file.bytesBase64;
      } else result.bytesBase64 = file.bytesBase64;
    }
    return result;
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function projectStructureObservation(row, sample) {
  const normalize = structureNormalizer(row, sample);
  let body = row.hasJson ? structuredClone(row.jsonBody) : row.body;
  if (body && !Array.isArray(body) && typeof body === 'object' && Object.hasOwn(body, 'traceId')) {
    assert.equal(typeof body.traceId, 'string'); assert.ok(body.traceId.length > 0);
    delete body.traceId;
  }
  const actions = new Set(['get', 'create', 'delete', 'add-path', 'update-path', 'remove-path', 'shortcut']);
  if (sample.path.startsWith('/Library/VirtualFolders/LibraryOptions')) actions.add('item');
  const consumerRequests = row.calls.filter(entry => actions.has(entry.action));
  const refreshRequests = row.calls.filter(entry => ['validate-top', 'refresh-physical', 'validate-physical'].includes(entry.action)).map(entry => {
    if (!entry.value || typeof entry.value !== 'object') return entry;
    const { tokenCanCancel, ...value } = entry.value;
    return { action: entry.action, value };
  });
  const uniqueRefresh = [...new Map(refreshRequests.map(entry => [signature(entry), entry])).values()]
    .sort((left, right) => signature(left).localeCompare(signature(right), 'en'));
  return {
    name: row.name, status: row.status, contentType: row.contentType,
    allow: row.allow.split(',').map(value => value.trim()).filter(Boolean).sort(),
    hasJson: row.hasJson, body: normalize(body), consumerRequests: normalize(consumerRequests),
    refreshRequests: normalize(uniqueRefresh), injectedFailure: row.injectedFailure,
    beforeFiles: fileValues(row.beforeFiles, row, normalize), files: fileValues(row.files, row, normalize),
    events: normalize(row.events), savedOptions: normalize(row.savedOptions), optionsRead: normalize(row.optionsRead),
  };
}
