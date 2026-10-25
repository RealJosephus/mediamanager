import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sortName } from '../../src/library/dto.js';
import { setupChildrenFixture } from './children-fixture.js';

const root = new URL('./fixtures/metadata-sort-save/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const project = item => Object.fromEntries(['Name', 'ForcedSortName', 'SortName', 'IndexNumber', 'ParentIndexNumber'].map(field => [field, item[field] ?? null]));
const expectedFor = scenario => native.results.find(entry => entry.name === scenario.name);

test('metadata sort recording seals actual mapper hydration and outgoing entity projection', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  for (const [key, filename] of Object.entries({ input: 'input.json', native: 'native.json', oracle: 'Program.cs', project: 'Oracle.csproj' })) {
    assert.equal(createHash('sha256').update(await readFile(new URL(filename, root))).digest('hex'), provenance.files[key].sha256);
  }
  assert.equal(createHash('sha256').update(await readFile(new URL('../Directory.Build.props', import.meta.url))).digest('hex'), provenance.files.buildProperties.sha256);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 23); assert.equal(native.results.length, input.length);
  assert.ok(native.results.every(entry => entry.hydratedCache === null));
});

for (const scenario of input) test(`native cold metadata sort: ${scenario.name}`, () => {
  const item = { ...scenario.item, ...scenario.changes };
  item.SortName = sortName(item);
  assert.deepEqual(project(item), expectedFor(scenario).result);
});

for (const dialect of ['postgres']) test(`${dialect}: metadata saves write native cold sort values even with unchanged source names`, async t => {
  const fixture = await setupChildrenFixture(t, dialect);
  for (const scenario of input) await t.test(scenario.name, async () => {
    const { Type, ...item } = scenario.item;
    const Id = await fixture.seed({ target: 'target', items: [{ key: 'target', type: Type.split('.').at(-1), ...item }] });
    const loaded = await fixture.loadContext(Id);
    assert.equal(loaded.snapshot.SortName, scenario.item.SortName);
    Object.assign(loaded.item, scenario.changes);
    const events = [], report = event => events.push(project(event.Item));
    fixture.host.updates.on('ItemUpdated', report);
    try { await fixture.host.updates.update(loaded, { Item: loaded.item }, 16); }
    finally { fixture.host.updates.off('ItemUpdated', report); }
    const expected = expectedFor(scenario).result;
    assert.deepEqual(project((await fixture.database.rows('BaseItems', { where: { Id } }))[0]), expected);
    assert.deepEqual(project((await fixture.loadContext(Id)).item), expected);
    assert.deepEqual(events, [expected]);
  });
});
