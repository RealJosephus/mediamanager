import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { decodeJpegScaled } from '../../src/images/jpeg-codec/index.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

const image = new URL('./fixtures/blurhash-resampling/inputs/wide.jpg', import.meta.url), scale = 0.125;
const reasons = [['false', false], ['zero', 0], ['empty-string', ''], ['null', null], ['undefined', undefined],
  ['error', Object.assign(new Error('The JPEG caller cancelled.', { cause: { name: 'business-name', stack: 'business-stack' } }),
    { code: 'JPEG_CALLER', status: 409, statusCode: 499, errors: [false, 0, '', null, undefined] })],
  ['business', { name: 'business-name', stack: 'business-stack', message: 'The JPEG owner cancelled.',
    code: 'JPEG_OWNER', status: 503, cause: undefined, errors: [false, 0] }]];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const functional = value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functional);
  const keys = value instanceof Error ? [...new Set([
    ...Object.getOwnPropertyNames(value).filter(key => !['name', 'stack'].includes(key)),
    ...['message', 'code'].filter(key => key in value),
  ])] : Object.keys(value);
  return Object.fromEntries(keys.map(key => [key, functional(value[key])]));
};
const sameReason = (actual, expected) => assert.deepEqual(functional(actual), functional(expected));
const outcome = pending => Promise.resolve(pending).then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));

async function fixture(t) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'jpeg-cancellation-')), bytes = await fs.readFile(image);
  assert.equal(digest(bytes), 'dbbfdc198a408f7629a87810895c264c377dc1d30d3a6bcba0b344021fefd9bd');
  const baseline = await decodeJpegScaled(bytes, scale), observations = [];
  await fs.writeFile(path.join(root, 'source.jpg'), bytes); await fs.writeFile(path.join(root, 'baseline.rgba'), baseline.data);
  t.after(async () => {
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({
      scope: 'Real production JPEG worker cancellation and termination; paired uninterrupted Node pixels, without a new Native comparison.',
      input: { bytes: bytes.length, sha256: digest(bytes) }, baseline: { info: baseline.info, bytes: baseline.data.length, sha256: digest(baseline.data) },
      serialization: 'JSON retains its native undefined limitations. Exact reason and own-property comparisons execute before serialization.',
      observations, phaseAcceptance: false, releaseAcceptance: false,
    }, null, 2) + '\n');
  });
  return { bytes, baseline,
    record(name, result, extra = {}) { observations.push({ name, failed: result.failed, reason: errorObservation(result.reason), ...extra }); },
    async recovery(name) {
      const recovered = await decodeJpegScaled(bytes, scale);
      assert.deepEqual(recovered.info, baseline.info); assert.deepEqual(recovered.data, baseline.data);
      assert.deepEqual(await fs.readFile(image), bytes);
      await fs.writeFile(path.join(root, name + '.rgba'), recovered.data);
    },
  };
}

test('JPEG cancellation retains the actual caller reason before admission and during a real worker', { timeout: 60000 }, async t => {
  const current = await fixture(t);
  for (const [label, reason] of reasons) for (const stage of ['before', 'during']) await t.test(stage + '/' + label, async () => {
    const controller = new AbortController();
    if (stage === 'before') controller.abort(reason);
    const pending = outcome(decodeJpegScaled(current.bytes, scale, { signal: controller.signal }));
    if (stage === 'during') controller.abort(reason);
    const result = await pending; assert.equal(result.failed, true); sameReason(result.reason, controller.signal.reason);
    current.record(stage + '-' + label, result, { actualReason: errorObservation(controller.signal.reason) });
    await current.recovery(stage + '-' + label);
  });
});

test('JPEG cancellation waits for actual worker termination and preserves its cleanup rejection', { timeout: 60000 }, async t => {
  const current = await fixture(t);
  for (const [label, cleanup] of reasons) for (const stage of ['cancelled', 'decoded', 'late-cancel']) await t.test(stage + '/' + label, async t => {
    const terminated = Promise.withResolvers(), release = Promise.withResolvers(), terminate = Worker.prototype.terminate;
    let worker, pending;
    const mock = t.mock.method(Worker.prototype, 'terminate', async function () {
      const result = await terminate.call(this); worker = this;
      terminated.resolve(result); await release.promise;
      throw cleanup;
    });
    t.after(async () => { release.resolve(); mock.mock.restore(); await Promise.allSettled([pending]); });
    const controller = new AbortController();
    pending = outcome(decodeJpegScaled(current.bytes, scale, { signal: controller.signal }));
    if (stage === 'cancelled') controller.abort(false);
    await terminated.promise; assert.equal(worker.threadId, -1);
    if (stage === 'late-cancel') controller.abort(0);
    let settled = false; pending.then(() => { settled = true; });
    await immediate(); assert.equal(settled, false, 'Cancellation awaits its real termination operation.');
    release.resolve(); const result = await pending; assert.equal(result.failed, true);
    if (stage === 'decoded') sameReason(result.reason, cleanup);
    else { sameReason(result.reason.errors, [controller.signal.reason, cleanup]); sameReason(result.reason.cause, controller.signal.reason); }
    assert.equal(worker.threadId, -1);
    current.record(stage + '-cleanup-' + label, result, { workerStopped: true });
    mock.mock.restore(); await current.recovery(stage + '-cleanup-' + label);
  });
});
