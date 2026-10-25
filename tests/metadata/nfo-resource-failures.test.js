import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { VirtualFileSystem } from '../../src/storage/vfs.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';
import { testFileSystem } from '../storage/plugin-files.js';

const original = Buffer.from('<movie><title>Original title</title><custom>Keep original bytes</custom></movie>');
const item = { Type: 'Video', Path: '/media/item.mkv', Name: 'Updated title', DateCreated: '2026-01-02T03:04:05Z' };
const rawFailure = value => value == null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(rawFailure)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(value), ...(value instanceof Error ? ['name', 'message', 'stack'] : [])])]
    .map(key => [key, rawFailure(value[key])]));
const failurePayload = value => {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(failurePayload);
  const error = value instanceof Error;
  return Object.fromEntries(Object.getOwnPropertyNames(value).filter(key => !error || !['name', 'stack'].includes(key))
    .map(key => [key, failurePayload(value[key])]));
};
const controlledFailure = (message, code, status) => Object.assign(new Error(message, {
  cause: Object.assign(new Error(message + ' original cause.'), { code: 'original-io' }),
}), { code, status, statusCode: status, errors: [new Error(message + ' first detail.'), new Error(message + ' second detail.')] });
const bindMethods = (target, overrides) => new Proxy(target, {
  get(value, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key];
    const result = Reflect.get(value, key);
    return typeof result === 'function' ? result.bind(value) : result;
  },
});

function failingRead(handle, primary, cleanup, report) {
  return { ...handle, stream: (async function* () { for await (const part of handle.stream) { yield part.subarray(0, 1); throw primary; } })(),
    async close() {
      await handle.close();
      report.observations.push({ phase: 'sidecar-close-after-real-release', failure: rawFailure(cleanup) });
      throw cleanup;
    } };
}

async function fixture(t) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = path.join(output, 'nfo-resource-' + randomUUID()); assertValidationOutputChild(root);
  const media = path.join(root, 'media'), spoolRoot = path.join(root, 'spool');
  await fs.mkdir(media, { recursive: true }); await fs.mkdir(spoolRoot);
  const filename = path.join(media, 'item.nfo'); await fs.writeFile(filename, original);
  const registry = new StorageRegistry(); registry.registerType('local', configuration => LocalAdapter.open(configuration));
  const report = { name: t.name, scope: 'Node NFO provider, real Local VFS sidecar and state spool. Controlled failures occur at the admitted read/write/release boundaries. No Native exception or full server equivalence claim.',
    observations: [], cleanup: {}, phaseAcceptance: false, releaseAcceptance: false };
  const state = { root, filename, spoolRoot, registry, report, failSpoolCleanup: true,
    cleanupError: controlledFailure('Controlled NFO spool unlink failure.', 'EIO', 503) };
  t.after(async () => {
    const errors = [];
    try { await registry.close(); report.cleanup.storageClosed = true; } catch (error) { errors.push(error); report.cleanup.storageFailure = rawFailure(error); }
    try { report.finalSidecarBase64 = (await fs.readFile(filename)).toString('base64'); report.spoolEntries = await fs.readdir(spoolRoot); }
    catch (error) { errors.push(error); report.cleanup.observationFailure = rawFailure(error); }
    try { await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'NFO resource fixture cleanup failed.', { cause: errors[0] });
  });
  await registry.createInstance('local', 'local', { root: media, writable: true });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/media', instanceId: 'local', root: '/', capabilities: { create: true, replace: true, delete: true } });
  Object.assign(state, { vfs, fileSystem: bindMethods(testFileSystem, {
    async unlink(target) {
      await testFileSystem.unlink(target);
      if (state.failSpoolCleanup && path.basename(target) === 'frame.xml' && path.dirname(target).startsWith(spoolRoot + path.sep)) {
        state.cleanupError.path = target;
        report.observations.push({ phase: 'spool-unlink-after-real-release', path: target, failure: rawFailure(state.cleanupError) });
        throw state.cleanupError;
      }
    },
  }) });
  state.plugin = options => createNfoPlugin({ vfs, spoolRoot, fileSystem: state.fileSystem, ...options });
  state.captureFailure = async (phase, operation) => {
    try { await operation(); }
    catch (error) { report.observations.push({ phase, failure: rawFailure(error) }); return error; }
    assert.fail('The admitted ' + phase + ' operation should fail.');
  };
  state.assertOriginal = async () => {
    assert.deepEqual(await fs.readFile(filename), original);
    assert.deepEqual(await fs.readdir(spoolRoot), []);
  };
  return state;
}

function assertCombined(error, primary, cleanup, message) {
  assert.deepEqual(failurePayload(error), {
    message, cause: failurePayload(primary), errors: [failurePayload(primary), failurePayload(cleanup)],
    ...Object.fromEntries(['code', 'status', 'statusCode'].filter(key => primary?.[key] !== undefined).map(key => [key, primary[key]])),
  });
}

const spoolFailure = error => new AggregateError([error], 'The XML spool could not be completely released.');

test('NFO read failure and handle release failure remain one owned failure without changing the sidecar', { timeout: 30000 }, async t => {
  const state = await fixture(t);
  const primary = controlledFailure('Controlled NFO sidecar read failure.', 'io', 507);
  const cleanup = controlledFailure('Controlled NFO read handle close failure.', 'EIO', 503);
  const vfs = bindMethods(state.vfs, {
    async openRead(...args) {
      const handle = await state.vfs.openRead(...args);
      return failingRead(handle, primary, cleanup, state.report);
    },
  });
  const error = await state.captureFailure('provider-read', () => state.plugin({ vfs }).getMetadata(item));
  assertCombined(error, primary, cleanup, 'NFO read and resource cleanup failed.');
  await state.assertOriginal();
});

for (const phase of ['prepare', 'apply']) test('NFO ' + phase + ' snapshot cannot turn a composite read and close failure into a missing file', { timeout: 30000 }, async t => {
  const state = await fixture(t); state.failSpoolCleanup = false;
  const primary = controlledFailure('Controlled NFO opened sidecar read loss.', 'not-found', 404);
  const cleanup = controlledFailure('Controlled NFO opened sidecar release failure.', 'EIO', 503);
  let failRead = phase === 'prepare';
  const vfs = bindMethods(state.vfs, {
    async openRead(...args) {
      const handle = await state.vfs.openRead(...args);
      return failRead ? failingRead(handle, primary, cleanup, state.report) : handle;
    },
  });
  const saver = state.plugin({ vfs }).providers.find(provider => provider.kind === 'saver' && provider.itemTypes.includes('Video'));
  let operation = () => saver.prepareSave(item);
  if (phase === 'apply') {
    const prepared = await saver.prepareSave(item); failRead = true;
    operation = () => prepared.apply();
  }
  const error = await state.captureFailure(phase + '-file-snapshot', operation);
  assertCombined(error, primary, cleanup, 'NFO read and resource cleanup failed.');
  await state.assertOriginal();
});

test('NFO cancellation after preparation preserves its full reason when real spool cleanup also fails', { timeout: 30000 }, async t => {
  const state = await fixture(t), controller = new AbortController();
  const primary = controlledFailure('Controlled NFO request cancellation.', 'request-cancelled', 499);
  const saver = state.plugin().providers.find(provider => provider.kind === 'saver' && provider.itemTypes.includes('Video'));
  const error = await state.captureFailure('prepare-cancelled', () => saver.prepareSave(item, {
    signal: controller.signal, getPeople: async () => { controller.abort(primary); return []; },
  }));
  assertCombined(error, primary, spoolFailure(state.cleanupError), 'NFO preparation and resource cleanup failed.');
  await state.assertOriginal();
});

test('NFO admitted upload failure keeps its complete payload before real spool cleanup failure', { timeout: 30000 }, async t => {
  const state = await fixture(t), primary = controlledFailure('Controlled NFO upload failure.', 'upload-failed', 507);
  const vfs = bindMethods(state.vfs, {
    async write(target, stream) {
      for await (const bytes of stream) {
        state.report.observations.push({ phase: 'admitted-upload', target, firstBytesBase64: bytes.toString('base64'), failure: rawFailure(primary) });
        break;
      }
      throw primary;
    },
  });
  const error = await state.captureFailure('provider-save', () => state.plugin({ vfs }).save(item));
  assertCombined(error, primary, spoolFailure(state.cleanupError), 'NFO save and resource cleanup failed.');
  await state.assertOriginal();
});

test('NFO real external-write conflict survives spool cleanup failure and preserves the external bytes', { timeout: 30000 }, async t => {
  const state = await fixture(t);
  const saver = state.plugin().providers.find(provider => provider.kind === 'saver' && provider.itemTypes.includes('Video'));
  const prepared = await saver.prepareSave(item);
  const external = Buffer.from('<movie><title>External update</title><custom>External bytes</custom></movie>');
  await state.vfs.write('/media/item.nfo', external, { overwrite: true });
  const error = await state.captureFailure('apply-external-conflict', () => prepared.apply());
  const primary = { message: 'The NFO file changed before saving.', code: 'version-changed', details: {} };
  assertCombined(error, primary, spoolFailure(state.cleanupError), 'NFO save and resource cleanup failed.');
  assert.deepEqual(await fs.readFile(state.filename), external);
  assert.deepEqual(await fs.readdir(state.spoolRoot), []);
});

test('NFO successful upload remains committed when only the real spool release reports a failure', { timeout: 30000 }, async t => {
  const state = await fixture(t);
  const error = await state.captureFailure('save-release-only', () => state.plugin().save(item));
  assert.deepEqual(failurePayload(error), failurePayload(spoolFailure(state.cleanupError)));
  assert.equal((await state.plugin().getMetadata(item)).Item.Name, item.Name);
  assert.deepEqual(await fs.readdir(state.spoolRoot), []);
});
