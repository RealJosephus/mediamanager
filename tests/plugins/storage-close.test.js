import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';
import { openConfiguredPluginHost } from './configuration-host.js';

const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true };

async function remainsPending(pending, message) {
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await immediate();
  assert.equal(settled, false, message);
}

test('configured storage repeated closes wait for real Local upload cleanup before releasing the registry', { timeout: 60000 }, async t => {
  for (const atomic of [false, true]) await t.test(atomic ? 'atomic' : 'direct', async t => {
    const output = path.resolve(validationOutputRoot());
    await fs.mkdir(output, { recursive: true });
    const root = await fs.mkdtemp(path.join(output, 'configured-storage-close-'));
    const work = path.join(root, 'work'), evidence = path.join(root, 'evidence');
    const media = path.join(work, 'media'), directory = path.join(work, 'host');
    await fs.mkdir(work); await fs.mkdir(evidence);
    const report = { scope: 'Configured storage, installed Local plugin, VFS upload and fresh configuration recovery.',
      atomic, assertions: {}, phaseAcceptance: false, releaseAcceptance: false };
    const nextEntered = Promise.withResolvers(), nextRelease = Promise.withResolvers();
    const returnEntered = Promise.withResolvers(), returnRelease = Promise.withResolvers();
    let host, storage, source, uploadOutcome, closing, closingAgain;
    t.after(async () => {
      nextRelease.resolve(); returnRelease.resolve();
      const errors = [];
      const attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
      await attempt(() => storage?.close());
      await attempt(() => uploadOutcome);
      await attempt(() => Promise.all([closing, closingAgain]));
      await attempt(() => source?.close());
      await attempt(() => host?.close());
      await attempt(async () => {
        assert.equal(path.dirname(work), root); assert.equal(path.dirname(root), output);
        await fs.rm(work, { recursive: true, force: false });
        report.fixtureWorkRemoved = true;
      });
      report.cleanupErrors = errors.map(error => errorObservation(error));
      await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      if (errors.length) throw new AggregateError(errors, 'Configured storage fixture cleanup failed.', { cause: errors[0] });
    });
    host = await openConfiguredPluginHost({ directory });
    storage = await createConfiguredStorage(undefined, { plugins: host });
    const definition = storage.configuration();
    definition.instances.push({ id: 'media', type: 'local', config: { root: media, writable: true, createRoot: true } });
    definition.mounts.push({ path: '/media', instanceId: 'media', capabilities });
    await storage.configure(definition);
    const filename = path.join(host.directory, 'storage.json');
    const configurationBytes = await fs.readFile(filename);
    await fs.writeFile(path.join(evidence, 'storage-before.json'), configurationBytes);
    const original = Buffer.from('Original committed destination.\n');
    const sourceBytes = Buffer.alloc(131143, 0x6d), prefix = sourceBytes.subarray(0, 65536);
    const sourcePath = path.join(work, 'source.bin'), target = path.join(media, 'target.bin');
    await fs.writeFile(sourcePath, sourceBytes);
    await storage.vfs.write('/media/target.bin', original);
    source = await fs.open(sourcePath, 'r');
    let sent = false;
    const iterator = {
      async next() {
        if (sent) { nextEntered.resolve(); await nextRelease.promise; return { done: true }; }
        sent = true;
        const bytes = Buffer.alloc(prefix.length);
        for (let offset = 0; offset < bytes.length;) {
          const read = await source.read(bytes, offset, bytes.length - offset, offset);
          assert.ok(read.bytesRead > 0); offset += read.bytesRead;
        }
        return { done: false, value: bytes };
      },
      async return() {
        returnEntered.resolve(); await returnRelease.promise; await nextRelease.promise;
        await source.close(); return { done: true };
      },
    };
    const upload = storage.vfs.write('/media/target.bin', { [Symbol.asyncIterator]: () => iterator }, { atomic, overwrite: true });
    uploadOutcome = upload.then(value => ({ failed: false, value }), error => ({ failed: true, error }));
    await nextEntered.promise;
    closing = storage.close(); closingAgain = storage.close();
    await returnEntered.promise;
    await remainsPending(upload, 'The upload still owns its actual source return.');
    await remainsPending(closing, 'The first close waits for the Local adapter to finish the admitted upload.');
    await remainsPending(closingAgain, 'Repeated close waits for the same actual registry drain.');
    await assert.rejects(storage.configure(definition), { status: 503 });
    await assert.rejects(storage.vfs.write('/media/late.bin', Buffer.from('late')), { code: 'closed' });
    assert.deepEqual(await fs.readFile(filename), configurationBytes);
    assert.equal((await source.stat()).size, sourceBytes.length);
    const names = await fs.readdir(media), during = await fs.readFile(target);
    assert.deepEqual(during, atomic ? original : prefix);
    await fs.writeFile(path.join(evidence, 'target-during-return.bin'), during);
    if (atomic) {
      const staging = names.filter(name => name !== 'target.bin');
      assert.equal(staging.length, 1);
      const bytes = await fs.readFile(path.join(media, staging[0]));
      assert.deepEqual(bytes, prefix);
      await fs.writeFile(path.join(evidence, 'staging-during-return.bin'), bytes);
    } else assert.deepEqual(names, ['target.bin']);
    report.assertions.bothClosesWaitedForActualSourceReturn = true;
    report.assertions.lateConfigurationAndUploadRejected = true;
    report.assertions.committedAndStagingBytesVerified = true;
    nextRelease.resolve(); returnRelease.resolve();
    const result = await uploadOutcome;
    assert.equal(result.failed, true); assert.equal(result.error.code, 'cancelled');
    report.uploadFailure = errorObservation(result.error);
    await Promise.all([closing, closingAgain]);
    await assert.rejects(source.stat(), { code: 'EBADF' });
    assert.deepEqual(await fs.readFile(sourcePath), sourceBytes);
    assert.deepEqual(await fs.readFile(target), atomic ? original : prefix);
    assert.deepEqual(await fs.readdir(media), ['target.bin']);
    await fs.writeFile(path.join(evidence, 'target-after-close.bin'), await fs.readFile(target));
    assert.deepEqual(await fs.readFile(filename), configurationBytes);
    report.assertions.sourceFileClosedAndOnlyCommittedTargetRemained = true;
    await host.close();
    host = await openConfiguredPluginHost({ directory });
    storage = await createConfiguredStorage(filename, { plugins: host });
    assert.deepEqual(storage.configuration(), definition);
    const recovered = await storage.vfs.write('/media/target.bin', sourceBytes, { atomic, size: sourceBytes.length });
    assert.equal(recovered.size, BigInt(sourceBytes.length));
    const handle = await storage.vfs.openRead('/media/target.bin');
    try {
      const chunks = []; for await (const chunk of handle.stream) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), sourceBytes);
    } finally { await handle.close(); }
    assert.deepEqual(await fs.readdir(media), ['target.bin']);
    await fs.writeFile(path.join(evidence, 'target-after-recovery.bin'), await fs.readFile(target));
    await storage.close(); await host.close();
    report.assertions.freshStorageWroteAndReadCompleteBytes = true;
  });
});
