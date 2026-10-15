import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { serializeNfo } from '../../plugins/nfo/saver.js';
import { readXml } from '../../src/core/xml.js';
import { setupChildrenFixture } from './children-fixture.js';

const fixtureRoot = new URL('./fixtures/nfo-member-stream/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', fixtureRoot), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', fixtureRoot), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('NFO member recording binds actual native custom writers and unchanged source inputs', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', fixtureRoot), 'utf8'));
  assert.equal(hash(await readFile(new URL('input.json', fixtureRoot))), provenance.inputSha256);
  assert.equal(hash(await readFile(new URL('native.json', fixtureRoot))), provenance.nativeSha256);
  for (const source of provenance.oracleSources) {
    const file = source.name === 'Directory.Build.props' ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixtureRoot);
    assert.equal(hash(await readFile(file)), source.sha256);
  }
  assert.equal(native.actualNativeNfoCustomMembers, true);
  assert.equal(native.physicalChildrenControlled, true);
  assert.equal(native.results.length, input.length);
  assert.equal(provenance.sourceInputsStable, true);
  assert.equal(provenance.candidateVerified, false);
});

test('real PostgreSQL typed NFO member sequences preserve native scope, sort and final bytes', async t => {
  const fixture = await setupChildrenFixture(t);
  const spoolRoot = fixture.spoolRoot;
  for (const scenario of input) await t.test(scenario.name, async () => {
    const neutral = { ...scenario, items: scenario.items.map(item => ({ ...item,
      ...(item.RunTimeTicks == null ? {} : { RunTimeTicks: BigInt(item.RunTimeTicks) }) })) };
    const id = await fixture.seed(neutral);
    const loaded = await fixture.loadContext({ Id: id }, { includeChildren: false });
    try {
      const prepared = await serializeNfo(loaded.item, {fileSystem: testFileSystem,  ...loaded.context, spoolRoot });
      try {
        const chunks = [];
        for await (const chunk of prepared.stream()) {
          assert.ok(chunk.length <= 8192);
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        assert.equal(BigInt(bytes.length), prepared.size);
        const document = readXml(bytes.toString('utf8'));
        const members = document.children.filter(node => ['track', 'album'].includes(node.name))
          .map(node => ({ type: node.name, fields: Object.fromEntries(node.children.map(child => [child.name, child.text])) }));
        assert.deepEqual(members, native.results.find(result => result.name === scenario.name).members);
      } finally { await prepared.close(); }
    } finally { await loaded.dispose(); }
    assert.deepEqual(await readdir(spoolRoot), []);
  });
});
