import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CollectionPosterVerifyPostScanTask } from '../../src/library/collection-poster-post-scan-task.js';
import { LibraryScanLifecycle } from '../../src/library/library-scan-lifecycle.js';
import { metadataScanOptions } from '../../src/library/metadata-scan-service.js';
import { newNativeItemEntity, isNativeItemEntity } from '../../src/library/native-item-entity.js';
import { StorageError } from '../../src/storage/errors.js';
import { guid } from '../../src/library/records.js';

const fixture = new URL('./fixtures/collection-poster/', import.meta.url);
const [nativeBytes, inputBytes, provenanceBytes] = await Promise.all(['native.json', 'input.json', 'provenance.json']
  .map(name => readFile(new URL(name, fixture))));
const native = JSON.parse(nativeBytes), input = JSON.parse(inputBytes), provenance = JSON.parse(provenanceBytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const nativeType = kind => `MediaBrowser.Controller.Entities.${kind === 'Movie' ? 'Movies.' : ''}${kind}`;
const makeItem = row => Object.assign(newNativeItemEntity(nativeType(row.type)), { Id: row.Id, Name: row.Name, Path: row.path,
  ImageInfos: row.images.map(image => ({ Type: image.type, Path: image.Path })) });
const snapshot = children => children.map(item => ({ Id: guid(item.Id), Name: item.Name, type: item.Type, path: item.Path,
  images: item.ImageInfos.map(image => ({ type: image.Type, Path: image.Path })) }));

test('Library poster fixtures preserve actual task and BaseItem refresh observations', async () => {
  assert.equal(hash(nativeBytes), provenance.nativeSha256); assert.equal(hash(inputBytes), provenance.inputSha256);
  assert.equal(native.inputSha256, provenance.inputSha256); assert.equal(native.results.length, 26); assert.equal(input.length, 26);
  for (const flag of ['actualPostScanTask', 'actualBaseItemRefresh', 'rootChildrenControlled', 'metadataProviderControlled']) assert.equal(native[flag], true);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  assert.equal(provenance.build.status, 0); assert.equal(provenance.process.status, 0);
  for (const entry of provenance.oracleSources) assert.equal(hash(await readFile(entry.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(entry.name, fixture))), entry.sha256);
  assert.equal(provenance.completeBuildInputClosure, false);
  for (const [index, sample] of input.entries()) for (const [key, value] of Object.entries(sample)) {
    if (key === 'Items') for (const [position, item] of value.entries()) for (const [field, entry] of Object.entries(item)) {
      assert.deepEqual(native.results[index].sample.Items[position][field], entry);
    }
    else assert.deepEqual(native.results[index].sample[key], value);
  }
});

for (const recording of native.results) test(`native library poster maintenance: ${recording.sample.Name}`, async () => {
  const { sample } = recording, children = recording.before.map(makeItem), calls = [], logs = [], progress = [];
  const controller = new AbortController();
  const cancel = () => controller.abort(new StorageError('cancelled', 'Controlled cancellation'));
  if (sample.CancelInitial) cancel();
  let failure;
  const task = new CollectionPosterVerifyPostScanTask({
    host: { async getUserRootFolder() {
      if (sample.FailRoot) throw new Error('Controlled root failure');
      return { Id: 'ba400000-0000-0000-0000-000000000999' };
    }, getCachedChildren: async () => children },
    logger: { debug: message => logs.push({ level: 'Debug', message }) },
    metadataScanner: { async refreshLiveItem(item, options) {
      assert.equal(isNativeItemEntity(item), true);
      const bound = metadataScanOptions(options), modes = ['None', 'ValidationOnly', 'Default', 'FullRefresh'];
      calls.push({ action: 'refresh', Id: guid(item.Id), Name: item.Name, path: item.Path,
        metadataMode: modes.indexOf(bound.MetadataRefreshMode), imageMode: modes.indexOf(bound.ImageRefreshMode),
        IsAutomated: bound.IsAutomated, ForceSave: bound.ForceSave, ReplaceAllMetadata: bound.ReplaceAllMetadata,
        ReplaceAllImages: bound.ReplaceAllImages, RemoveOldMetadata: bound.RemoveOldMetadata,
        images: item.ImageInfos.map(image => ({ type: image.Type, Path: image.Path })) });
      if (sample.CancelRefresh !== null && sample.CancelRefresh === item.Name) cancel();
      bound.signal.throwIfAborted();
      if (sample.FailRefresh !== null && sample.FailRefresh === item.Name) throw new Error('Controlled refresh failure');
      if (sample.AddChild) children.push(Object.assign(newNativeItemEntity(nativeType('CollectionFolder')), {
        Id: 'ba400000-0000-0000-0000-000000000888', Name: 'New after snapshot', Path: null }));
      if (sample.RemoveSibling && children.length > 1) children.splice(1, 1);
      if (sample.AddSiblingImage && children.length > 1) children[1].ImageInfos = [{ Type: 'Primary', Path: 'created after snapshot' }];
      if (sample.RenameSibling && children.length > 1) children[1].Name = 'Renamed after snapshot';
    } }
  });
  try { await task.run({ signal: controller.signal, reportProgress: value => {
    progress.push(value); if (sample.FailProgress) throw new Error('Controlled progress failure');
  } }); } catch (error) { failure = error; }
  assert.equal(Boolean(failure), Boolean(recording.failure), failure?.stack);
  if (recording.failure?.type === 'OperationCanceledException') assert.equal(failure?.code, 'cancelled');
  else if (recording.failure) assert.equal(failure?.message, recording.failure.Message);
  assert.deepEqual(calls, recording.calls);
  assert.deepEqual(logs.map(log => log.level), recording.logs.map(log => log.level));
  for (const [index, log] of logs.entries()) {
    assert.equal(log.message, `Library ${calls[index].Name ?? ''} is missing a primary image. Refreshing metadata.`);
    if (calls[index].Name !== null) assert.equal(log.message, recording.logs[index].message);
  }
  assert.deepEqual(progress, recording.progress); assert.deepEqual(snapshot(children), recording.after);
  if (process.env.MEDIAMANAGER_COLLECTION_POSTER_EVIDENCE) {
    const directory = process.env.MEDIAMANAGER_COLLECTION_POSTER_EVIDENCE; await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, String(native.results.indexOf(recording)).padStart(2, '0') + '.json'), JSON.stringify({
      name: sample.Name, calls, logs, progress, after: snapshot(children),
      failure: failure && { name: failure.name, code: failure.code, message: failure.message },
      rootChildrenControlled: true, metadataProviderControlled: true, phaseAcceptance: false
    }, null, 2) + '\n', { flag: 'wx' });
  }
});

test('Library scan continues later tasks after poster failure and propagates cancellation', async () => {
  const calls = [], required = ['getAggregateFolder', 'getUserRootFolder', 'clearIgnoreRuleCache', 'invalidateChildren',
    'refreshMetadata', 'validateChildren', 'withChildren', 'collectionDirectoryExists'];
  const host = Object.fromEntries(required.map(name => [name, async () => {}]));
  host.updateInheritedValues = async () => calls.push('inherit');
  const poster = new CollectionPosterVerifyPostScanTask({ host: { getUserRootFolder: async () => ({}),
    getCachedChildren: async () => [makeItem({ type: 'CollectionFolder', Id: 'ba400000-0000-0000-0000-000000000001',
      Name: 'Library', path: null, images: [] })] },
    metadataScanner: { refreshLiveItem: async () => { throw new Error('Controlled provider failure'); } } });
  const lifecycle = new LibraryScanLifecycle({ host, monitor: { start() {}, stop() {} }, postScanTasks: [poster,
    { name: 'Following task', run: async () => calls.push('following') }], logger: { error: (error, message) => calls.push(message) } });
  await lifecycle.runPostScanTasks();
  assert.deepEqual(calls, ['Post-scan task CollectionPosterVerify failed', 'following', 'inherit']);
  calls.length = 0; const controller = new AbortController(); controller.abort(new StorageError('cancelled', 'Controlled cancellation'));
  await assert.rejects(lifecycle.runPostScanTasks({ signal: controller.signal }), { code: 'cancelled' });
  assert.deepEqual(calls, []);
});
