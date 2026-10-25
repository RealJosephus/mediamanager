import assert from 'node:assert/strict';
import { decodeNativeText } from '../../../../src/core/native-text.js';
import { deserializeLibraryOptions } from '../../../../src/library/options.js';

export function normalizeMutation(value, state) {
  if (typeof value === 'string') {
    const text = value.replaceAll(state, '{state}');
    return /^(?:\{state\}|%AppDataPath%|%MetadataPath%)/u.test(text) ? text.replaceAll('\\', '/') : text;
  }
  if (Array.isArray(value)) return value.map(entry => normalizeMutation(entry, state));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, normalizeMutation(entry, state)]));
  return value;
}

export function mutationFiles(files) {
  return files.map(entry => {
    const bytes = typeof entry.bytes === 'string' ? Buffer.from(entry.bytes, 'base64') : Buffer.from(entry.bytes);
    return { path: entry.path.replaceAll('\\', '/'), content: entry.path.endsWith('options.xml')
      ? deserializeLibraryOptions(decodeNativeText(bytes)) : decodeNativeText(bytes) };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function mutationObservation(row) {
  return normalizeMutation({ failure: row.operationFailed, calls: row.calls, folders: row.folders,
    reopenedFolders: row.reopenedFolders, files: mutationFiles(row.files), contentTypes: row.contentTypes,
    directories: row.directories.map(value => value.replaceAll('\\', '/')).sort(),
    options: row.options, coldOptions: row.coldOptions, primedOptions: row.beforeOptions,
    cachePrimed: row.cache.wasPrimed }, row.state);
}

/** A measured refusal changes the file operation boundary, never its prefix. */
export function mutationAccessExpectation(control, sample, admission, defaults) {
  assert.equal(typeof admission.operation.succeeded, 'boolean');
  assert.equal(typeof admission.read.succeeded, 'boolean');
  const expected = mutationObservation(control);
  assert.equal(expected.failure, false, 'The independent accessible control must complete the full mutation.');
  if (admission.operation.succeeded) return expected;
  expected.failure = true;
  const beforeFiles = normalizeMutation(mutationFiles(control.beforeFiles), control.state);
  if (sample.lockOptions) {
    expected.calls = expected.calls.filter(entry => entry.action !== 'options-updated');
    const original = beforeFiles.find(entry => entry.path.endsWith('/options.xml'));
    assert.ok(original);
    expected.files = expected.files.map(entry => entry.path === original.path ? original : entry);
    expected.coldOptions = expected.primedOptions;
    expected.reopenedFolders = expected.reopenedFolders.map(folder => ({ ...folder, LibraryOptions: expected.coldOptions }));
  } else {
    assert.equal(sample.lockDelete, true);
    expected.calls = expected.calls.filter(entry => entry.action !== 'invalidate');
    expected.files = beforeFiles;
    expected.directories = control.beforeDirectories.map(value => value.replaceAll('\\', '/')).sort();
    expected.options = structuredClone(defaults);
    expected.coldOptions = structuredClone(defaults);
    expected.folders = normalizeMutation(control.beforeFolders, control.state)
      .map(folder => ({ ...folder, LibraryOptions: structuredClone(defaults) }));
    expected.reopenedFolders = structuredClone(expected.folders);
  }
  return expected;
}
