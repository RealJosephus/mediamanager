import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sortName } from '../../src/library/dto.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const inputUrl = new URL('./fixtures/live-tv-channel-sort/input.json', import.meta.url);
const bytes = await readFile(inputUrl), input = JSON.parse(bytes);
const sha = value => createHash('sha256').update(value).digest('hex');

test('channel numeric and text SortName match the current native getter', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 180000,
}, async () => {
  const root = path.join(validationOutputRoot(), 'live-tv-channel-sort-' + randomUUID());
  await mkdir(root);
  const record = await recordOracle({ project: 'tests/library/fixtures/live-tv-channel-sort/Oracle.csproj',
    output: path.join(root, 'native'), args: [fileURLToPath(inputUrl), '{output}/native.json'] });
  const native = JSON.parse(await readFile(path.join(root, 'native/native.json'), 'utf8'));
  assert.ok(record.passed && native.actualChannelCreateSortName);
  assert.equal(native.inputSha256, sha(bytes));
  for (const assembly of native.assemblies) assert.equal(sha(await readFile(assembly.filename)), assembly.sha256);
  assert.equal(native.cases.length, input.cases.length);
  const observations = [], differences = [];
  for (const sample of input.cases) {
    const item = newNativeItemEntity('MediaBrowser.Controller.LiveTv.LiveTvChannel');
    Object.assign(item, { Name: sample.name, Number: sample.number });
    const actual = { key: sample.key, SortName: item.SortName };
    observations.push(actual);
    try {
      assert.deepEqual(actual, native.cases.find(value => value.key === sample.key));
      assert.equal(sortName(item), item.SortName);
    } catch (error) { differences.push({ key: sample.key, message: error.message }); }
  }
  await writeFile(path.join(root, 'comparison.json'), JSON.stringify({ passed: differences.length === 0,
    releaseAcceptance: false, cases: input.cases.length, observations, differences }, null, 2) + '\n', { flag: 'wx' });
  assert.deepEqual(differences, []);
});
