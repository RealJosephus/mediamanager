import test from 'node:test';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { tableDefinition } from '../../src/database/model.js';
import { idKey, dateTicks } from '../../src/library/records.js';
import { tokenizeJson } from '../../src/core/json-tokens.js';
import { XmlTokenCursor } from '../../src/core/xml-stream.js';
import { recordInternalEdits, editHttpTables } from '../../tools/compat/record-internal-edits.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { currentEditHttpCandidate } from '../helpers/current-edit-http-candidate.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE) });

const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry);
const sorted = rows => rows.sort((left, right) => json(left).localeCompare(json(right), 'en'));
function saveClocks(database, before, window, clocks, label) {
  for (const row of database.BaseItems) {
    const previous = before.BaseItems.find(value => idKey(value.Id) === idKey(row.Id));
    if (previous && row.DateLastSaved !== previous.DateLastSaved) {
      assert.ok(dateTicks(row.DateLastSaved) >= dateTicks(window.startedAt)
        && dateTicks(row.DateLastSaved) <= dateTicks(window.finishedAt) + 9999n, `Save clock belongs to ${window.startedAt}: ${row.Id}`);
      clocks.set(idKey(row.Id) + ':' + dateTicks(row.DateLastSaved), '$save-' + label);
    }
  }
}
function canonicalDatabase(database, { clocks = new Map() } = {}) {
  const values = new Map(), seen = new Set();
  for (const row of database.ItemValues) {
    const { ItemValueId, ...fields } = row, key = json(fields);
    assert.equal(seen.has(key), false, 'ItemValues semantic identities must be unique.'); seen.add(key);
    values.set(idKey(ItemValueId), key);
  }
  return Object.fromEntries(editHttpTables.map(table => [table, sorted(database[table].map(row => {
    assert.deepEqual(Object.keys(row).sort(), tableDefinition(table).columns.map(column => column.name).sort(), table);
    const result = {};
    for (const column of tableDefinition(table).columns) {
      let value = row[column.name], type = column.clrType.replace('?', '');
      if (value != null && type === 'Guid') value = idKey(value);
      if (value != null && column.type === 'INTEGER') value = type === 'bool' ? Boolean(value) : String(value);
      if (value != null && column.type === 'BLOB') value = Buffer.from(value).toString('hex');
      if (column.name === 'ItemValueId') {
        assert.ok(values.has(idKey(row[column.name]))); value = values.get(idKey(row[column.name]));
      }
      result[column.name] = value;
    }
    if (table === 'BaseItems' && row.DateLastSaved) {
      const clock = clocks.get(idKey(row.Id) + ':' + dateTicks(row.DateLastSaved));
      if (clock) {
        result.DateLastSaved = clock;
        if (row.Data) {
          const properties = tokenizeJson(row.Data).properties;
          const tokens = properties.filter(([name]) => name === 'DateLastSaved');
          assert.equal(tokens.length, 1);
          const token = tokens[0][1];
          assert.equal(dateTicks(token.value), dateTicks(row.DateLastSaved));
          const replacements = [[token, JSON.stringify(clock)]];
          // AggregateFolder.VirtualChildren is a getter-only process cache;
          // native JSON deserialization does not restore its serialized items.
          if (row.Type === 'MediaBrowser.Controller.Entities.AggregateFolder') {
            const virtualChildren = properties.filter(([name]) => name === 'VirtualChildren');
            assert.equal(virtualChildren.length, 1);
            assert.ok(Array.isArray(virtualChildren[0][1].items));
            replacements.push([virtualChildren[0][1], '[]']);
          }
          result.Data = row.Data;
          for (const [span, value] of replacements.sort(([left], [right]) => right.start - left.start)) {
            result.Data = result.Data.slice(0, span.start) + value + result.Data.slice(span.end);
          }
        }
      }
    }
    return result;
  }))]));
}

function equalDatabase(actual, expected, actualOptions, expectedOptions, label) {
  const left = canonicalDatabase(actual, actualOptions), right = canonicalDatabase(expected, expectedOptions);
  for (const table of editHttpTables) {
    assert.equal(left[table].length, right[table].length, `${label}:${table}:row count`);
    // GUIDs retain their input IDs. Only independently checked ItemValues IDs
    // use a semantic relation key; no arbitrary generated-ID erasure occurs.
    for (let index = 0; index < left[table].length; index++) assert.deepEqual(left[table][index], right[table][index], `${label}:${table}:${index}`);
  }
}

// Preserve element order, attributes, leaf text and empty-container syntax.
// Only the two rewritten files use their source-bound reader contracts; all
// raw text, sizes and digests remain in the published filesystem snapshots.
function editedXmlContract(text, kind) {
  const declaration = '\ufeff<?xml version="1.0" encoding="utf-8" standalone="yes"?>';
  assert.ok(text.startsWith(declaration));
  const cursor = new XmlTokenCursor(text.slice(declaration.length));
  const indented = new Set(['movie', 'Item', 'fileinfo', 'Genres', 'Studios', 'Tags']);
  const whitespace = value => typeof value === 'string' && /^[\t\r\n ]*$/.test(value);
  function read(start, parents = []) {
    const names = [...parents, start.name], node = { name: start.name,
      attributes: Object.entries(start.attributes).sort(([left], [right]) => left.localeCompare(right, 'en')),
      empty: start.empty, content: [] };
    if (!start.empty) while (true) {
      const token = cursor.readToken();
      if (token.type === 'end') { assert.equal(token.name, start.name); break; }
      if (token.type === 'start') node.content.push(read(token, names));
      else { assert.equal(token.type, 'text'); assert.equal(token.cdata, undefined); node.content.push(token.value); }
    }
    if (indented.has(start.name) && node.content.some(value => typeof value !== 'string')) node.content = node.content.filter(value => !whitespace(value));
    const empty = node.attributes.length === 0 && node.content.every(whitespace);
    // BaseNfoParser ignores empty studio names and skips the unrecognized art
    // element; retain nonempty art, attributes and all unknown extension data.
    if (kind === 'nfo' && names.join('/') === 'movie/studio' && empty && node.content.length === 0) return undefined;
    if (kind === 'nfo' && names.join('/') === 'movie/art' && empty) { node.empty = true; node.content = []; }
    if (kind === 'playlist' && names.join('/') === 'Item/LockedFields') {
      assert.equal(node.attributes.length, 0); assert.ok(node.content.every(value => typeof value === 'string'));
      node.content = [node.content.join('').split('|').sort().join('|')];
    }
    node.content = node.content.filter(value => value !== undefined);
    return node;
  }
  let token = cursor.readToken();
  while (token.type === 'text' && whitespace(token.value)) token = cursor.readToken();
  assert.equal(token.type, 'start'); assert.equal(token.name, kind === 'nfo' ? 'movie' : 'Item');
  const root = read(token);
  token = cursor.readToken();
  while (token.type === 'text' && whitespace(token.value)) token = cursor.readToken();
  assert.equal(token.type, 'eof');
  return root;
}

function equalFilesystem(actual, expected, label) {
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const root of Object.keys(actual)) {
    assert.equal(actual[root].length, expected[root].length, `${label}:${root}:entry count`);
    for (const [index, entry] of actual[root].entries()) {
      const other = expected[root][index], key = `${root}:${entry.path}`;
      if (entry.sha256 === other.sha256) { assert.deepEqual(entry, other, `${label}:${key}`); continue; }
      const kind = key === 'media:feature.nfo' ? 'nfo' : key === 'playlists:integration/playlist.xml' ? 'playlist' : undefined;
      assert.ok(kind, `${label}:${key}:bytes`);
      const contract = value => {
        const { text, size, sha256, ...identity } = value;
        assert.equal(size, Buffer.byteLength(text)); assert.equal(sha256, createHash('sha256').update(text).digest('hex'));
        return { ...identity, xml: editedXmlContract(text, kind) };
      };
      assert.deepEqual(contract(entry), contract(other), `${label}:${key}`);
    }
  }
}

test('postgres: current native internal metadata HTTP writes, complete rows, relations and files', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE, timeout: 600000
}, nativeCallback(async t => {
  const root = path.join(validationOutputRoot(), 'current-internal-edit-' + randomUUID());
  await mkdir(path.dirname(root), { recursive: true });
  const result = await recordInternalEdits(root, currentEditHttpCandidate);
  const { native, candidate, input } = result;
  const provenance = JSON.parse(await readFile(path.join(root, 'provenance.json')));
  for (const artifact of provenance.artifacts) assert.equal(createHash('sha256').update(await readFile(path.join(root, artifact.path))).digest('hex'), artifact.sha256);
  assert.equal(JSON.parse(await readFile(path.join(root, 'private-cleanup.json'))).privateInstanceRemoved, true);
  assert.equal(candidate.error, undefined, json(candidate.error));
  assert.deepEqual(candidate.runtimeErrors, []);
  assert.ok(Object.values(candidate.cleanup).every(Boolean));
  assert.equal(native.records.length, 18); assert.equal(candidate.records.length, 18);
  equalDatabase(candidate.before.database, native.before.database, undefined, undefined, 'initial');
  assert.deepEqual(candidate.before.filesystem, native.before.filesystem);
  const candidateClocks = new Map(), nativeClocks = new Map();
  for (const [index, record] of candidate.records.entries()) {
    assert.deepEqual(record, native.records[index]);
    const left = candidate.stages[index], right = native.stages[index];
    const leftBefore = index ? candidate.stages[index - 1].database : candidate.before.database;
    const rightBefore = index ? native.stages[index - 1].database : native.before.database;
    saveClocks(left.database, leftBefore, left.window, candidateClocks, record.name);
    saveClocks(right.database, rightBefore, right.window, nativeClocks, record.name);
    equalDatabase(left.database, right.database, { clocks: candidateClocks }, { clocks: nativeClocks }, record.name);
    equalFilesystem(left.filesystem, right.filesystem, record.name);
  }
  assert.deepEqual(candidate.afterShutdown, { database: candidate.stages.at(-1).database, filesystem: candidate.stages.at(-1).filesystem });
  assert.deepEqual(native.afterShutdown, { database: native.stages.at(-1).database, filesystem: native.stages.at(-1).filesystem });
  const final = candidate.stages.at(-1).filesystem;
  assert.ok(final.playlists.some(entry => entry.path === 'integration/playlist.xml' && entry.text.includes('Same lock state')));
  assert.ok(final.media.some(entry => entry.path === 'feature.nfo' && entry.text.includes('<lockdata>false</lockdata>')));
  await writeFile(path.join(root, 'comparison.json'), filterEvidenceJson({ passed: true, requests: input.cases.length,
    completeBaseItemColumns: tableDefinition('BaseItems').columns.length, relationTables: editHttpTables.length - 1,
    rawInitialFilesystemEqual: true, fileContractsEqual: true, independentSaveClocksBound: true,
    scopedRepresentations: ['AggregateFolder getter-only VirtualChildren', 'XML indentation and line endings',
      'NFO empty studio and art', 'playlist LockedFields membership with multiplicity'],
    sameRestoredInputPaths: true, cleanup: candidate.cleanup }), { flag: 'wx' });
}));
