import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { LiveTvGuideImages } from '../../src/library/live-tv-guide-images.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { dateTicks, idKey } from '../../src/library/records.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { setupChildrenFixture, useIdentityPathReversalControl } from '../metadata/children-fixture.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const pgEnabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES);
const hash = value => createHash('sha256').update(value).digest('hex');
const type = 'MediaBrowser.Controller.LiveTv.LiveTvProgram';
const rootId = 'a9800000000000000000000000000001', channelId = 'a9800000000000000000000000000002';
const cutoff = '2500-01-03T00:00:00.0000000Z', before = '2500-01-02T23:59:59.9999999Z';
const Id = index => 'a9810000000000000000' + String(index).padStart(12, '0');
const image = (Type, Path) => ({ Type, Path, Width: 9, Height: 7, BlurHash: 'old', DateModified: '2026-01-01T00:00:00.0000000Z' });
const program = (index, images, EndDate = before) => ({ Id: Id(index), Name: 'Program ' + index, ParentId: channelId, ChannelId: channelId, EndDate, ImageInfos: images });
function samples(origin) {
  const url = name => origin + '/' + name;
  return [
    { name: 'strict end date and null end date filter before all images', limits: [false], items: [
      program(1, [image('Primary', url('ignored-equal'))], cutoff), program(2, null, null),
      program(3, [image('Primary', url('included'))], before)] },
    { name: 'identity distinct occurs after date eligibility and preserves first eligible', limits: [false], items: [
      program(4, [image('Primary', url('ignored-future'))], cutoff), program(4, [image('Primary', url('first'))]),
      program(4, [image('Primary', url('ignored-duplicate'))])], repeatSlot: 1 },
    { name: 'SD all predicate excludes empty local SD and mixed local SD', limits: [true], items: [
      program(5, []), program(6, [image('Primary', '/keep/local')]), program(7, [image('Primary', url('ScHeDuLeSdIrEcT-only'))]),
      program(8, [image('Primary', '/keep/local'), image('Thumb', url('schedulesdirect-second'))]),
      program(9, [image('Primary', url('ordinary')), image('Thumb', url('schedulesdirect-mixed'))])] },
    { name: 'daily limit is checked again inside worker', limits: [false, true], items: [program(10, [image('Primary', url('schedulesdirect-late'))])] },
    { name: 'daily limit changes between non-SD and SD image', limits: [false, false, true], items: [
      program(11, [image('Primary', url('normal-first')), image('Thumb', url('schedulesdirect-after-normal'))])] },
    { name: '403 and 404 retry URL alternatives and failures retain images', limits: [false], items: [
      program(12, [image('Primary', url('403') + '|' + url('404') + '|' + url('fallback')), image('Thumb', url('404') + '|' + url('403')),
        image('Logo', url('500') + '|' + url('must-not-retry')), image('Art', url('later-success'))])] },
    { name: 'index zero conversion preserves live aliases after independently saved snapshots', limits: [false], items: [
      program(13, [image('Backdrop', url('backdrop-one')), image('Backdrop', url('backdrop-two')), image('Thumb', '/keep/thumbnail')])] },
    { name: 'invalid image collection with irrelevant end date is never observed', limits: [true], items: [program(14, null, cutoff)] },
    { name: 'null image collection fails worker before any conversion', limits: [false], items: [program(15, null)] },
    { name: 'null path fails initial All predicate only when reached', limits: [true], items: [program(16, [image('Primary', null)])] },
  ];
}

async function httpFixture(t, hold) {
  const png = await fs.readFile(new URL('../images/fixtures/http/poster.png', import.meta.url)), requests = [], responses = new Set();
  const server = createServer(async (request, response) => {
    responses.add(response); response.on('close', () => responses.delete(response)); requests.push(request.url);
    if (hold && request.url === '/held') { hold.entered.resolve(); await hold.release.promise; }
    const status = /^\/(403|404|500)$/u.exec(request.url)?.[1];
    response.writeHead(status ? Number(status) : 200, { 'content-type': 'image/png', 'content-length': status ? 0 : png.length }); response.end(status ? undefined : png);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { hold?.release.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(responses.size, 0); });
  return { origin: 'http://127.0.0.1:' + server.address().port, requests, png };
}

async function setup(t, sample, { parallelism = 1, limit, onError = () => {}, updates: decorateUpdates } = {}) {
  const fixture = await setupChildrenFixture(t); useIdentityPathReversalControl(fixture);
  await fixture.seed({ target: 'root', items: [{ key: 'root', type: 'Folder', Id: rootId, Name: 'Guide root', Path: null }] });
  const parent = await fixture.library.itemCreation.getItemById(rootId), channel = newNativeItemEntity('MediaBrowser.Controller.LiveTv.LiveTvChannel');
  Object.assign(channel, { Id: channelId, Name: 'Guide channel', ParentId: rootId, ServiceName: 'Emby' });
  await fixture.library.itemCreation.createItems([channel], parent, { creationIntent: 'library-save' });
  const items = sample.items.map(value => Object.assign(newNativeItemEntity(type), structuredClone(value)));
  // Persistence setup stays bounded, independently of the production cohort.
  for (let offset = 0; offset < items.length; offset += 128) {
    const valid = items.slice(offset, offset + 128).filter(item => Array.isArray(item.ImageInfos) && item.ImageInfos.every(value => value?.Path != null));
    if (valid.length) await fixture.library.itemCreation.createItems(valid, channel, { creationIntent: 'library-save' });
  }
  if (sample.repeatSlot != null) items.push(items[sample.repeatSlot]);
  const cohort = await createNativeItemCohort({ linkedChildren: fixture.linkedChildren,
    resolveLiveItem: id => fixture.library.itemCreation.getCachedItemById(id) });
  for (const [index, item] of items.entries()) await cohort.capture(item, { ordinal: BigInt(index + 1) });
  let calls = 0;
  const updates = decorateUpdates?.(fixture.host.updates, fixture) ?? fixture.host.updates;
  const service = new LiveTvGuideImages({ store: fixture.store, linkedChildren: fixture.linkedChildren, loadContext: fixture.loadContext,
    itemCreation: fixture.library.itemCreation, updates, images: fixture.host.images, parallelism, onError,
    isImageDailyLimitActive: limit ?? (() => sample.limits[Math.min(calls++, sample.limits.length - 1)]),
    runWorker: operation => fixture.store.runDetached(() => fixture.loadContext.withDetachedScope(operation)) });
  const closeHost = fixture.host.close.bind(fixture.host);
  fixture.host.close = async () => { await service.close(); await cohort.release(); await closeHost(); };
  t.after(async () => { await service.close(); await cohort.release(); });
  return { ...fixture, service, cohort, items, calls: () => calls };
}

function projectImages(values) {
  return values?.map(value => value == null ? null : { Path: value.Path == null || /^http/i.test(value.Path) || value.Path.startsWith('/keep/') ? value.Path : '$LOCAL/' + value.Type,
    Type: value.Type, Width: value.Width ?? 0, Height: value.Height ?? 0, BlurHash: value.BlurHash ?? null }) ?? null;
}
async function projectItems(cohort) {
  const items = [];
  for (let after = 0n; ;) {
    const page = await cohort.page({ after, limit: 128 });
    try {
      if (!page.entries.length) break;
      for (const { item } of page.entries) items.push({ Id: idKey(item.Id), Images: projectImages(item.ImageInfos),
        aliases: item.ImageInfos?.map(value => item.ImageInfos.indexOf(value)) ?? null });
      after = page.entries.at(-1).Ordinal;
    } finally { await page.release(); }
  }
  return items;
}
async function assertReleased(fixture) {
  const result = await fixture.database.client.query(`SELECT (SELECT count(*) FROM ${q(fixture.linkedChildren.schemaName)}.item_states) AS states,
    (SELECT count(*) FROM ${q(fixture.linkedChildren.schemaName)}.item_cohorts) AS views`);
  assert.equal(BigInt(result.rows[0].states), 0n); assert.equal(BigInt(result.rows[0].views), 0n);
}

test('guide precache matches actual native private predicates and ConvertImageToLocal with real HTTP, mapped writes and PostgreSQL updates', { skip: !enabled, timeout: 300000 }, async t => {
  const http = await httpFixture(t), input = { maxCacheDate: cutoff, cases: samples(http.origin) }, bytes = Buffer.from(JSON.stringify(input));
  const output = path.join(validationOutputRoot(), 'live-tv-guide-images-' + randomUUID()); await fs.mkdir(output);
  const inputFile = path.join(output, 'input.json'); await fs.writeFile(inputFile, bytes, { flag: 'wx' });
  const report = { comparisons: [] }; let failure;
  try {
    const current = await currentNativeReference();
    report.sourceBindings = await current.sourceBindings(['src/Jellyfin.LiveTv/Guide/GuideManager.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/ItemImageInfo.cs', 'MediaBrowser.Controller/LiveTv/LiveTvProgram.cs',
      'MediaBrowser.Controller/LiveTv/LiveTvChannel.cs', 'MediaBrowser.Providers/Manager/ImageSaver.cs', 'MediaBrowser.Controller/Providers/IProviderManager.cs']);
    // recordOracle uses spawnSync. Keep this thread serving the actual native
    // HttpClient while a separately owned worker records the native process.
    const worker = new Worker(new URL('./fixtures/live-tv-guide-images/oracle-worker.js', import.meta.url), {
      workerData: { project: 'tests/library/fixtures/live-tv-guide-images/Oracle.csproj', output: path.join(output, 'native'), args: [inputFile, '{output}/native.json'] },
      trackUnmanagedFds: true,
    });
    t.after(async () => { if (worker.threadId !== -1) await worker.terminate(); });
    let workerMessages = 0, workerExitCode;
    const receipt = await new Promise((resolve, reject) => {
      let result, workerError;
      worker.on('message', message => { workerMessages++; result = message; });
      worker.once('error', error => { workerError = error; });
      worker.once('exit', code => {
        workerExitCode = code;
        if (workerError) { reject(workerError); return; }
        if (code !== 0 || workerMessages !== 1 || typeof result?.ok !== 'boolean') { reject(new Error('The guide image oracle worker exited without one valid result.')); return; }
        if (!result.ok) { reject(Object.assign(new Error(result.error?.message ?? 'Guide image oracle worker failed.'), result.error)); return; }
        if (result.record?.passed !== true) { reject(new Error('Guide image oracle worker returned no passing receipt.')); return; }
        resolve(result.record);
      });
    });
    report.oracleWorker = { messages: workerMessages, exitCode: workerExitCode, threadExited: worker.threadId === -1 };
    assert.deepEqual(report.oracleWorker, { messages: 1, exitCode: 0, threadExited: true });
    const nativeBytes = await fs.readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.ok(receipt.passed && native.actualPrivatePreCacheImages && native.actualConvertImageToLocal && native.actualLoopbackHttp);
    assert.ok(native.controlledProviderImageWriter && native.controlledRepositorySave && native.controlledSdLimit);
    assert.equal(native.databaseOwnersOpened, false); assert.equal(native.executorsStarted, false); assert.equal(native.selectedParallelism, 1);
    assert.ok(native.nativeParallelism > 0 && native.nativeParallelism <= 10); assert.equal(native.inputSha256, hash(bytes));
    for (const assembly of native.assemblies) assert.equal(hash(await fs.readFile(assembly.filename)), assembly.sha256);
    report.inputSha256 = hash(bytes); report.nativeOutputSha256 = hash(nativeBytes);
    for (const [Type, expected] of [['LiveTvProgram', native.programMetadataPath], ['LiveTvChannel', native.channelMetadataPath]]) {
      assert.equal(internalImagePath({ Type, Id: rootId }, '/METADATA'), expected);
      assert.equal(internalImagePath({ Type, Id: rootId }, 'C:\\METADATA').replaceAll('\\', '/'), 'C:' + expected);
    }
    for (const sample of input.cases) await t.test(sample.name, async t => {
      const expected = structuredClone(native.results.find(value => value.name === sample.name));
      for (const item of expected.items) delete item.originals;
      const errors = [], updates = []; http.requests.length = 0;
      const fixture = await setup(t, sample, { onError: error => errors.push(error.nativeException ?? (error.code === 'http-error' ? 'HttpRequestException' : error.name)),
        updates: host => ({ async update(loaded, result, reason) {
          await host.update(loaded, result, reason); updates.push({ Id: idKey(result.Item.Id), Images: projectImages(result.Item.ImageInfos) });
        } }) });
      let error = null;
      try { await fixture.service.preCache(fixture.cohort, cutoff); } catch (caught) { error = caught.nativeException ?? caught.name; }
      const actual = { name: sample.name, error, requests: [...http.requests], updates, limits: fixture.calls(), errors, items: await projectItems(fixture.cohort) };
      report.comparisons.push({ expected, actual }); assert.deepEqual(actual, expected, sample.name);
      for (const item of actual.items) if (item.Images?.some(value => value?.Path?.startsWith('$LOCAL'))) {
        const loaded = await fixture.loadContext(item.Id);
        try {
          assert.equal(loaded.parent.Type, 'LiveTvChannel');
          for (const value of loaded.context.images.filter(value => !/^http/i.test(value.Path) && !value.Path.startsWith('/keep/'))) {
            assert.ok(value.Path.replaceAll('\\', '/').includes('/metadata/livetv/' + idKey(item.Id) + '/'));
            assert.deepEqual(await loaded.imageAssets.read(value.Path), http.png);
          }
          const row = (await fixture.database.rows('BaseItems', { where: { Id: item.Id } }))[0]; assert.ok(dateTicks(row.DateLastSaved) > 0n);
        } finally { await loaded.dispose(); }
      }
      if (sample.name.startsWith('index zero')) {
        const stored = await fixture.loadContext(sample.items[0].Id);
        try { assert.equal(stored.context.images.filter(value => value.Type === 'Backdrop' && /^http/i.test(value.Path)).length, 1, 'Last outer alias assignment follows the independent repository save.'); }
        finally { await stored.dispose(); }
      }
      await fixture.service.close(); await fixture.cohort.release(); await assertReleased(fixture);
    });
  } catch (error) { failure = error; }
  finally { await fs.writeFile(path.join(output, 'comparison.json'), JSON.stringify({ ...report, passed: !failure, phaseAcceptance: false, releaseAcceptance: false, error: failure?.stack }, null, 2) + '\n'); }
  if (failure) throw failure;
});

test('guide image SQL selection and identity dedup remain bounded beyond 128 programs', { skip: !pgEnabled, timeout: 240000 }, async t => {
  const http = await httpFixture(t), sample = { limits: [false], items: Array.from({ length: 131 }, (_, index) => program(100 + index, [image('Primary', http.origin + '/program-' + index)])), repeatSlot: 0 };
  const fixture = await setup(t, sample, { parallelism: 3 }), pages = [];
  fixture.database.queryHook = async (...args) => {
    const result = await fixture.database.client.query(...args), sql = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (sql.includes('guide-image-slot-page')) { assert.ok(result.rows.length <= 128); pages.push(result.rows.length); }
    return result;
  };
  t.after(() => { fixture.database.queryHook = null; });
  await fixture.service.preCache(fixture.cohort, new Date(cutoff)); fixture.database.queryHook = null;
  assert.equal(http.requests.length, 131); assert.equal(new Set(http.requests).size, 131); assert.ok(pages.length > 1);
  const count = await fixture.database.client.query('SELECT count(*) AS count FROM "BaseItemImageInfos"'); assert.equal(BigInt(count.rows[0].count), 131n);
  await fixture.service.close(); await fixture.cohort.release(); await assertReleased(fixture);
});

test('guide image close cancels foreach admission while a running HTTP conversion commits before dependencies close', { skip: !pgEnabled, timeout: 30000 }, async t => {
  const hold = { entered: Promise.withResolvers(), release: Promise.withResolvers() }, http = await httpFixture(t, hold);
  const fixture = await setup(t, { limits: [false], items: [program(500, [image('Primary', http.origin + '/held'), image('Thumb', http.origin + '/must-not-start')])] });
  const pending = fixture.service.preCache(fixture.cohort, cutoff); t.after(() => { hold.release.resolve(); return Promise.allSettled([pending]); });
  await hold.entered.promise; let drained = false; const closing = fixture.service.close().then(() => { drained = true; });
  await assert.rejects(fixture.service.preCache(fixture.cohort, cutoff), { status: 503 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  hold.release.resolve(); await pending; await closing; assert.equal(drained, true); assert.deepEqual(http.requests, ['/held']);
  const images = await fixture.database.rows('BaseItemImageInfos', { where: { ItemId: Id(500) } });
  assert.equal(images.filter(value => !/^http/i.test(value.Path)).length, 1); assert.equal(images.filter(value => /^http/i.test(value.Path)).length, 1);
  await fixture.cohort.release(); await assertReleased(fixture);
});

test('guide image SQL persistence failure is logged per image after real download and mapped write, without deleting the remote', { skip: !pgEnabled, timeout: 30000 }, async t => {
  const http = await httpFixture(t), errors = [], fixture = await setup(t, { limits: [false], items: [program(600, [image('Primary', http.origin + '/failure')])] }, { onError: error => errors.push(error) });
  await fixture.database.client.query(`ALTER TABLE "BaseItems" ADD CONSTRAINT guide_image_failure CHECK ("DateLastSaved"<'2000-01-01') NOT VALID`);
  await fixture.service.preCache(fixture.cohort, cutoff); assert.equal(errors.length, 1); assert.equal(errors[0].code, '23514');
  const loaded = await fixture.loadContext(Id(600));
  try {
    const local = path.join(internalImagePath(loaded.item, loaded.metadataPath), 'poster.png'); assert.deepEqual(await loaded.imageAssets.read(local), http.png);
    assert.equal(loaded.context.images[0].Path, http.origin + '/failure');
  } finally { await loaded.dispose(); }
  assert.deepEqual(http.requests, ['/failure']); await fixture.service.close(); await fixture.cohort.release(); await assertReleased(fixture);
});
