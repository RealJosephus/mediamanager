import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import model from '../../src/core/resources/live-tv-configuration-model.json' with { type: 'json' };
import { LiveTvService } from '../../src/library/live-tv-service.js';
import { liveTvConfigurationReader as reader, serializeLiveTvConfiguration as serialize } from '../../src/core/live-tv-configuration-store.js';
import { loadConfigurationFile } from '../../src/core/configuration-file.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const inputUrl = new URL('./fixtures/live-tv-configuration/input.json', import.meta.url);
const bytes = await readFile(inputUrl), input = JSON.parse(bytes);
const sha = value => createHash('sha256').update(value).digest('hex');

test('Live TV configuration preserves native XML defaults, full fields, recovery and cold reads', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000,
}, async t => {
  const root = path.join(validationOutputRoot(), 'live-tv-configuration-' + randomUUID());
  await mkdir(root);
  const record = await recordOracle({ project: 'tests/library/fixtures/live-tv-configuration/Oracle.csproj',
    output: path.join(root, 'native'), args: [fileURLToPath(inputUrl), '{output}/native.json'] });
  const native = JSON.parse(await readFile(path.join(root, 'native/native.json'), 'utf8'));
  assert.ok(record.passed && native.actualXmlSerializer && native.actualConfigurationHelper && native.privateInputsRemoved);
  assert.equal(native.inputSha256, sha(bytes));
  assert.deepEqual(model, native.model);
  const directory = await mkdtemp(path.join(tmpdir(), 'mm-live-tv-configuration-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('mm-live-tv-configuration-'));
    await rm(directory, { recursive: true });
  });
  const observations = [], differences = [], consumers = [];
  for (const [index, sample] of input.cases.entries()) {
    const expected = native.results.find(value => value.name === sample.name);
    const filename = path.join(directory, String(index), 'livetv.xml');
    await mkdir(path.dirname(filename));
    if (sample.text !== undefined) await writeFile(filename, sample.text);
    let value, error;
    try { value = reader.parseConfigurationXml(Buffer.from(sample.text ?? ''), 'livetv'); }
    catch (failure) { error = failure.message; }
    const issues = [];
    const loaded = await loadConfigurationFile(filename, 'livetv', { reader, serialize, onError: error => issues.push(error.message) });
    const saved = await readFile(filename);
    observations.push({ name: sample.name, value, error, loaded, issues, savedSha256: sha(saved) });
    try {
      assert.equal(error === undefined, expected.accepted, sample.name);
      if (expected.accepted) assert.deepEqual(value, expected.value, sample.name);
      assert.deepEqual(loaded, expected.loaded, sample.name);
      assert.deepEqual(reader.parseConfigurationXml(saved, 'livetv'), loaded, sample.name);
    } catch (failure) { differences.push({ name: sample.name, message: failure.message }); }
    consumers.push({ name: sample.name, filename });
  }
  const consumerInput = path.join(root, 'consumer-input.json');
  await writeFile(consumerInput, JSON.stringify({ cases: consumers }), { flag: 'wx' });
  const consumedRecord = await recordOracle({ project: 'tests/library/fixtures/live-tv-configuration/Oracle.csproj',
    output: path.join(root, 'consume'), args: [consumerInput, '{output}/native.json'] });
  const consumed = JSON.parse(await readFile(path.join(root, 'consume/native.json'), 'utf8'));
  assert.ok(consumedRecord.passed && consumed.privateInputsRemoved);
  assert.equal(consumed.inputSha256, sha(await readFile(consumerInput)));
  for (const item of consumed.results) {
    assert.ok(item.accepted, item.name);
    assert.deepEqual(item.value, observations.find(value => value.name === item.name).loaded);
  }
  const cachedDirectory = path.join(directory, 'cache');
  await mkdir(cachedDirectory);
  const cacheFile = path.join(cachedDirectory, 'livetv.xml');
  await writeFile(cacheFile, '<LiveTvOptions><GuideDays>2</GuideDays></LiveTvOptions>');
  const service = new LiveTvService({ configurationDirectoryPath: cachedDirectory });
  const first = await service.getConfiguration();
  await writeFile(cacheFile, '<LiveTvOptions><GuideDays>11</GuideDays></LiveTvOptions>');
  assert.equal(await service.getConfiguration(), first);
  assert.equal(first.GuideDays, 2);
  assert.equal((await new LiveTvService({ configurationDirectoryPath: cachedDirectory }).getConfiguration()).GuideDays, 11);
  await writeFile(path.join(root, 'comparison.json'), JSON.stringify({ passed: differences.length === 0,
    releaseAcceptance: false, configurations: input.cases.length, nativeConsumers: consumed.results.length,
    cacheAndColdReadVerified: true, observations, differences }, null, 2) + '\n', { flag: 'wx' });
  assert.deepEqual(differences, []);
});
