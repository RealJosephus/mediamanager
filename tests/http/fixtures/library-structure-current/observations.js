import assert from 'node:assert/strict';
import path from 'node:path';
import { projectProblemTrace } from '../../../helpers/http-body-projection.js';
import { parseLosslessJson } from '../../../../src/core/json.js';

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
  const within = (value, directory) => value === directory || value.startsWith(directory + path.sep);
  return value => {
    if (typeof value !== 'string') return value;
    for (const [index, directory] of temporary.entries()) if (within(value, directory)) {
      return '{views}/temporary-' + (index + 1) + value.slice(directory.length).split(path.sep).join('/');
    }
    return within(value, row.views) ? '{views}' + value.slice(row.views.length).split(path.sep).join('/') : value;
  };
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, roles) => object(value) ? Object.fromEntries(Object.entries(value)
  .map(([key, entry]) => [key, Object.hasOwn(roles, key) ? roles[key](entry) : entry])) : value;
const pathInfo = (value, normalize) => fields(value, { Path: normalize });
const libraryOptions = (value, normalize) => fields(value, { PathInfos: values => Array.isArray(values)
  ? values.map(entry => pathInfo(entry, normalize)) : values });

function consumerRequest(value, normalize) {
  const options = entry => libraryOptions(entry, normalize), info = entry => pathInfo(entry, normalize);
  const roles = { create: { options }, 'add-path': { info }, 'update-path': { info },
    'remove-path': { path: normalize }, shortcut: { directory: normalize, info } };
  return Object.hasOwn(roles, value.action) ? { ...value, value: fields(value.value, roles[value.action]) } : value;
}

function renameConflictBody(value, row, sample, normalize) {
  if (row.status !== 409 || !row.hasJson || typeof value !== 'string' || (sample.method ?? 'GET').toUpperCase() !== 'POST') return value;
  const requested = new URL(sample.path, 'http://fixture.invalid');
  if (requested.pathname.toLowerCase() !== '/library/virtualfolders/name') return value;
  const name = requested.searchParams.get('newName');
  if (!name) return value;
  const target = path.join(row.views, name);
  if (path.dirname(target) !== row.views || !row.beforeFiles.some(file => file.kind === 'directory' && file.path === name)) return value;
  // Native RenameVirtualFolder's 409 consumes this actual existing target.
  // Bind that directory only when the entire public template matches it.
  const prefix = 'The media library already exists at ';
  return value === prefix + target + '.' ? prefix + normalize(target) + '.' : value;
}

function fileValues(files, row, normalize) {
  return files.map(file => {
    const filename = path.join(row.views, ...file.path.split('/'));
    const result = { path: normalize(filename), kind: file.kind };
    assert.ok(file.kind === 'directory' || file.kind === 'file', file.path);
    if (file.kind === 'file') {
      assert.equal(typeof file.bytesBase64, 'string', file.path);
      if (file.options) {
        result.options = { accepted: file.options.accepted, value: libraryOptions(file.options.value, normalize) };
        if (!file.options.accepted) result.bytesBase64 = file.bytesBase64;
      } else result.bytesBase64 = file.bytesBase64;
    }
    return result;
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function projectStructureObservation(row, sample) {
  const normalize = structureNormalizer(row, sample);
  let body = row.hasJson ? projectProblemTrace(typeof row.body === 'string'
    ? parseLosslessJson(row.body) : structuredClone(row.jsonBody), row.status) : row.body;
  body = renameConflictBody(body, row, sample, normalize);
  if (row.status === 200 && (sample.method ?? 'GET').toUpperCase() === 'GET'
    && new URL(sample.path, 'http://fixture.invalid').pathname.toLowerCase() === '/library/virtualfolders' && Array.isArray(body)) {
    body = body.map(value => fields(value, { Locations: values => Array.isArray(values) ? values.map(normalize) : values,
      LibraryOptions: value => libraryOptions(value, normalize) }));
  }
  const actions = new Set(['get', 'create', 'delete', 'add-path', 'update-path', 'remove-path', 'shortcut']);
  if (sample.path.startsWith('/Library/VirtualFolders/LibraryOptions')) actions.add('item');
  const consumerRequests = row.calls.filter(entry => actions.has(entry.action)).map(entry => consumerRequest(entry, normalize));
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
    hasJson: row.hasJson, body, consumerRequests,
    refreshRequests: uniqueRefresh, injectedFailure: row.injectedFailure,
    beforeFiles: fileValues(row.beforeFiles, row, normalize), files: fileValues(row.files, row, normalize),
    events: row.events.map(value => fields(value, { libraryPath: normalize, options: value => libraryOptions(value, normalize) })),
    savedOptions: libraryOptions(row.savedOptions, normalize), optionsRead: libraryOptions(row.optionsRead, normalize),
  };
}
