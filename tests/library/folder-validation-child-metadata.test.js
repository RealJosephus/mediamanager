import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseLosslessJson } from '../../src/core/json.js';
import { idKey } from '../../src/library/records.js';
import { LibraryMetadataScanService } from '../../src/library/metadata-scan-service.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { assertDirectoryValidation } from './directory-validation-fixture.js';

const root = new URL('./fixtures/folder-traversal/', import.meta.url);
const [input, native] = await Promise.all(['input.json', 'native.json']
  .map(async file => parseLosslessJson(await readFile(new URL(file, root), 'utf8'))));
const source = input.find(sample => sample.name === 'recursive-new-descendants');
const expected = native.results.find(result => result.name === source.name);

for (const dialect of ['postgres']) test(`${dialect}: child metadata starts after recursive structure commits`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const sample = { ...structuredClone(source), refreshChildMetadata: true };
  const metadataCalls = [], providerCalls = [], observedProgress = [], providerProgress = [];
  await assertDirectoryValidation(t, dialect, sample, expected, {
    reconciliation: true,
    reportProgress: value => observedProgress.push(value),
    onRefreshProgress: event => {
      if (event.Item.Name === 'Parent') providerProgress.push(event.Progress);
    },
    metadataScanner: ({ fixture, scheduler }) => {
      const scanner = new LibraryMetadataScanService({
        scheduler,
        library: fixture.library,
        configuration: { ...fixture.configuration, LibraryScanFanoutConcurrency: 1 },
        metadata: {
          loadContext: fixture.loadContext,
          validateRefresh() {},
          async refresh(reference) {
            const row = (await fixture.database.rows('BaseItems')).find(item => idKey(item.Id) === idKey(reference));
            providerCalls.push(row?.Name ?? null);
            return { UpdateType: ItemUpdateType.None, Failures: 0 };
          }
        }
      });
      return {
        async refreshAccessibleChildren(children, options, traversal) {
        const rows = await fixture.database.rows('BaseItems');
        const observed = [];
        for await (const page of children.pages()) for (const child of page) {
          observed.push({ id: idKey(child.Id), name: child.Name });
        }
        metadataCalls.push({
          kind: 'children',
          children: observed,
          recursive: traversal.recursive,
          descendants: rows.filter(row => ['A', 'B'].includes(row.Name)).map(row => row.Name).sort(),
          signal: options.signal
        });
          return scanner.refreshAccessibleChildren(children, options, traversal);
        },
        async refreshContainer() { assert.fail('An ordinary Folder must use the accessible child workset.'); }
      };
    }
  });

  assert.equal(metadataCalls.length, 1);
  assert.equal(metadataCalls[0].kind, 'children');
  assert.equal(metadataCalls[0].children.length, 1);
  assert.equal(metadataCalls[0].children[0].name, 'Curated title');
  assert.equal(metadataCalls[0].recursive, true);
  assert.deepEqual(metadataCalls[0].descendants, ['A', 'B'],
    'Recursive Folder validation must commit descendants before metadata traversal begins.');
  assert.equal(metadataCalls[0].signal, undefined);
  assert.deepEqual(providerCalls, ['Curated title', 'Sub', 'A', 'B']);
  assert.deepEqual(observedProgress.slice(0, 4), [5, 5.5, 6, 7]);
  assert.equal(observedProgress.at(-1), 100);
  assert.ok(observedProgress.indexOf(50) < observedProgress.lastIndexOf(100));
  assert.deepEqual(providerProgress.slice(0, 4), [5, 5.5, 6, 7]);
  assert.equal(providerProgress.at(-1), 100);
  assert.ok(providerProgress.every((value, index) => !index || value > providerProgress[index - 1]));
});
