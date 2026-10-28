import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { chromium } from 'playwright';
import { browserInputs } from '../../tools/validation/browser-inputs.js';
import { jellyfinWebInputs } from '../../tools/validation/jellyfin-web-inputs.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { fallbackFontBrowserInput, fallbackFontFailureFiles } from './fixtures/fallback-fonts/input.js';
import { libassAssets } from './fixtures/fallback-fonts/browser-assets.js';
import { captureFontResponse, openMissingFontHost, seedFaultFiles, sourceError } from './fixtures/fallback-fonts/node-failures.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'jellyfinWeb', 'browser'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_JELLYFIN_WEB_ROOT && process.env.MEDIAMANAGER_BROWSER_EXECUTABLE;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const combineFailures = (errors, message) => errors.length === 1 ? errors[0] : Object.assign(new AggregateError(errors, message, { cause: errors[0] }),
  Object.fromEntries(['code', 'status', 'statusCode'].filter(key => errors[0]?.[key] !== undefined).map(key => [key, errors[0][key]])));
const expectedBytes = step => {
  const fixture = fallbackFontFailureFiles.find(file => step.path.endsWith(path.basename(file.path)));
  return fixture.length === undefined ? Buffer.from(fixture.bytes, 'base64') : Buffer.alloc(fixture.length);
};

async function fontFile(worker, filename) {
  return worker.evaluate(filename => {
    if (typeof Module === 'undefined' || !Module.FS) return { filesystemReady: false };
    let bytes;
    try { bytes = Module.FS.readFile('/fonts/font0-' + filename); }
    catch (error) { return { filesystemReady: true, available: false, failure: { name: error.name, message: error.message, errno: error.errno, code: error.code } }; }
    // Serialization must not turn a successful file read into an unavailable
    // font, or depend on the worker's maximum function argument count.
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { filesystemReady: true, available: true, bodyBase64: btoa(binary) };
  }, filename);
}

/** Original client bytes and real browser networking; no response or XHR interception. */
async function observeBrowser(browser, origin, step, signal, output, label) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 800, height: 600 } });
  const raw = { origin, request: step, responses: [], requestFailures: [], pageErrors: [], console: [], cleanup: {} }, pending = [], errors = [];
  const target = origin + step.path;
  const completed = Promise.withResolvers(), deadline = setTimeout(() => completed.reject(new Error('The actual font request did not settle.')), 30000);
  completed.promise.catch(() => {});
  context.on('request', request => { if (request.url() === target) raw.actualRequest = { url: request.url(), method: request.method() }; });
  context.on('requestfinished', request => { if (request.url() === target) completed.resolve(request); });
  context.on('requestfailed', request => { if (request.url() === target) completed.resolve(request); });
  context.on('response', response => {
    if (response.url() !== target) return;
    const value = { url: response.url(), status: response.status(), headers: response.headers() }; raw.responses.push(value);
    pending.push((async () => {
      try { value.finishedFailure = sourceError(await response.finished()); }
      catch (error) { value.finishedCallFailed = true; value.finishedFailureType = typeof error; value.finishedFailure = sourceError(error); }
      try { value.bodyBase64 = (await response.body()).toString('base64'); }
      catch (error) { value.bodyReadFailed = true; value.bodyReadFailureType = typeof error; value.bodyReadFailure = sourceError(error); }
    })());
  });
  context.on('requestfailed', request => { if (request.url() === target) raw.requestFailures.push({ url: request.url(), failure: request.failure() }); });
  let page;
  try {
    signal.throwIfAborted();
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => raw.pageErrors.push(sourceError(error)));
    page.on('console', message => raw.console.push({ type: message.type(), text: message.text() }));
    await page.goto(origin + '/font-consumer/index.html');
    const workerStarted = page.waitForEvent('worker');
    workerStarted.catch(() => {});
    await page.evaluate(({ path, mode }) => window.startFontCapture({ path, mode }), { path: step.path, mode: step.browserMode });
    const worker = await workerStarted;
    const filename = step.path.split('/').at(-1);
    const actualRequest = await completed.promise, actualResponse = await actualRequest.response();
    raw.targetOutcome = { status: actualResponse?.status() ?? null, transportFailure: actualRequest.failure() };
    assert.deepEqual(raw.actualRequest, { url: target, method: 'GET' });
    if (step.executionFault) {
      assert.ok(raw.targetOutcome.status >= 400 || raw.targetOutcome.transportFailure !== null, 'The actual requested font must fail at the HTTP or transport boundary.');
      await page.waitForFunction(() => window.fontCapture.errorObserved);
      raw.consumer = await page.evaluate(() => ({ errorObserved: window.fontCapture.errorObserved, errors: window.fontCapture.errors, messages: window.fontCapture.messages,
        visible: document.querySelector('#result').textContent,
        rendererCanvasConnected: Boolean(document.querySelector('.libassjs-canvas-parent')?.isConnected) }));
      assert.equal(raw.consumer.errorObserved, true);
      assert.equal(raw.consumer.visible, step.browserMode === 'worker' ? 'font-worker-error' : 'libass-onError');
      if (step.browserMode === 'worker') {
        raw.fontFile = await fontFile(worker, filename);
        assert.equal(raw.fontFile.filesystemReady, true); assert.equal(raw.fontFile.available, false);
      }
    } else {
      assert.equal(step.browserMode, 'worker');
      assert.equal(raw.targetOutcome.status, 200); assert.equal(raw.targetOutcome.transportFailure, null);
      const expected = expectedBytes(step).toString('base64'), deadline = performance.now() + 30000;
      do {
        raw.fontFile = await fontFile(worker, filename);
        if (raw.fontFile.available) break;
        signal.throwIfAborted(); await delay(50, undefined, { signal });
      } while (performance.now() < deadline);
      assert.equal(raw.fontFile.filesystemReady, true); assert.equal(raw.fontFile.available, true);
      assert.equal(raw.fontFile.bodyBase64, expected, 'Restored source bytes must reach the original worker font filesystem.');
      raw.consumer = await page.evaluate(() => ({ errors: window.fontCapture.errors, messages: window.fontCapture.messages,
        visible: document.querySelector('#result').textContent }));
    }
    await page.screenshot({ path: path.join(output, label + '.png') });
  } catch (error) { errors.push(error); raw.failed = true; raw.failureType = typeof error; raw.failure = sourceError(error); }
  finally {
    clearTimeout(deadline);
    try { await context.close(); raw.cleanup.contextClosed = true; }
    catch (error) { raw.cleanup.failed = true; raw.cleanup.failureType = typeof error; raw.cleanup.failure = sourceError(error); errors.push(error); }
    await Promise.allSettled(pending);
    try { await writeFile(path.join(output, label + '.json'), JSON.stringify(raw, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw combineFailures(errors, 'Browser font capture and context close failed.');
  return raw;
}

function nativeWorker(options) {
  const worker = new Worker(new URL('./fixtures/fallback-fonts/browser-native-worker.js', import.meta.url), { workerData: options });
  let received = false, result;
  const errors = [];
  const done = new Promise((resolve, reject) => {
    worker.on('message', value => { received = true; result = value; }); worker.once('error', error => { errors.push(error); });
    worker.once('exit', code => {
      if (errors.length) reject(combineFailures(errors, 'The Native producer worker failed.'));
      else if (received && result?.failed === true) reject(result.failure);
      else if (code !== 0 || !received || result === null || typeof result !== 'object' || !Object.hasOwn(result, 'record')) reject(Object.assign(new Error('The owned browser Native producer did not return its record.'), { code, producerMessage: result }));
      else resolve(result.record);
    });
  });
  return { done, get message() { return result; } };
}

test('locked libass browser consumes real Native and Node missing-font responses without accepting their public HTTP differences', {
  skip: !enabled, timeout: 360000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'fallback-font-consumer-' + randomUUID()); await mkdir(output, { recursive: true });
  const report = { scope: 'Pinned libass 4.2.4 modern worker and public onError, same execution phases and original files; other HTTP consumers remain unclassified.',
    compatibilityAcceptance: false, phaseAcceptance: false, releaseAcceptance: false, node: [], callbacks: [], cleanup: {} };
  let browser, local, control, producer, producerJoined = false;
  const errors = [];
  try {
    const web = await jellyfinWebInputs(), supplied = await browserInputs(), build = await verifyNativeBuild();
    report.web = { sourceHead: web.receipt.sourceHead, runtime: web.receipt.runtimeManifest.sha256 };
    report.browser = { revision: supplied.revision, version: supplied.browserVersion };
    report.nativeBuild = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256 };
    const assetRoot = path.join(output, 'browser-assets'), assets = await libassAssets(web, assetRoot);
    report.consumerSource = { dependency: assets.dependency, assets: assets.descriptors };
    const input = fallbackFontBrowserInput(), inputBytes = Buffer.from(JSON.stringify(input)), inputFile = path.join(output, 'input.json');
    await writeFile(inputFile, inputBytes, { flag: 'wx' }); report.inputSha256 = hash(inputBytes);
    browser = await chromium.launch({ headless: true, executablePath: supplied.executable }); assert.equal(browser.version(), supplied.browserVersion);
    const nodeDirectory = path.join(output, 'node/files'); await seedFaultFiles(nodeDirectory);
    local = await openMissingFontHost({ directory: nodeDirectory, assets: assets.assets });
    for (const sample of input) {
      const steps = [];
      report.node.push({ name: sample.name, steps });
      for (const [index, step] of sample.steps.entries()) {
        const fault = step.executionFault ? local.arm(step) : undefined;
        const observed = step.browserMode ? await observeBrowser(browser, local.origin, step, t.signal, output, 'node-' + sample.name + '-' + index)
          : await captureFontResponse(local.origin, step, t.signal);
        await local.drain();
        steps.push(observed);
        if (fault) {
          observed.executionFault = fault.executionFault; observed.finalResponse = fault.finalResponse;
          assert.ok(observed.executionFault, 'This browser request must execute its real missing-file boundary.');
          observed.executionFault.failure = sourceError(fault.sourceFailure);
          assert.equal(observed.executionFault.restored, true); assert.equal(observed.executionFault.cleanup, null);
          assert.ok(['ENOENT', 'not-found'].includes(fault.sourceFailure?.code)); assert.equal(observed.finalResponse.status, 404);
        } else if (!step.browserMode) {
          assert.equal(observed.status, 200); assert.equal(observed.bodyComplete, true);
          assert.deepEqual(Buffer.from(observed.bodyBase64, 'base64'), expectedBytes(step));
        }
      }
    }
    const callbackPath = '/observe-' + randomUUID();
    control = createServer(async (request, response) => {
      if (request.url !== callbackPath || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const callback = JSON.parse(Buffer.concat(chunks).toString());
        if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(callback.origin)) throw new Error('The Native browser target must be its actual loopback host.');
        const label = 'native-' + report.callbacks.length;
        const observation = await observeBrowser(browser, callback.origin, callback.step, t.signal, output, label);
        report.callbacks.push(observation);
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(observation));
      } catch (error) {
        report.callbacks.push({ failed: true, failureType: typeof error, failure: sourceError(error) }); response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ failed: true, failureType: typeof error, failure: sourceError(error) }));
      }
    });
    await new Promise((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve); });
    const browserConfig = path.join(output, 'browser.json');
    await writeFile(browserConfig, JSON.stringify({ assetRoot, assets: assets.descriptors,
      control: 'http://127.0.0.1:' + control.address().port + callbackPath }) + '\n', { flag: 'wx' });
    await seedFaultFiles(path.join(output, 'files'));
    producer = nativeWorker({ project: 'tests/http/fixtures/fallback-fonts/Oracle.csproj', output: path.join(output, 'native'),
      args: [inputFile, output, '{output}/native.json', browserConfig], processTimeoutMs: 240000 });
    try { report.oracle = await producer.done; } finally { producerJoined = true; }
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = parseLosslessJson(nativeBytes.toString());
    assert.equal(native.inputSha256, report.inputSha256);
    assert.equal(report.oracle.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const name of ['actualMvc', 'actualSubtitleController', 'actualPhysicalFileExecutor', 'actualExceptionMiddleware', 'hostStopped', 'hostDisposed']) assert.equal(native[name], true, name);
    report.nativeRaw = { filename: path.join(output, 'native/native.json'), sha256: hash(nativeBytes) };
    assert.equal(native.observations.length, input.length);
    for (const [index, sample] of input.entries()) {
      const observation = native.observations[index]; assert.equal(observation.name, sample.name);
      const [failed, recovered] = observation.steps;
      assert.equal(failed.executionFault.phase, sample.steps[0].executionFault);
      assert.ok(failed.executionFault.failure); assert.equal(failed.executionFault.restored, true); assert.equal(failed.executionFault.cleanup, null);
      assert.equal(failed.finalResponse.status, 404);
      assert.equal(failed.diskBeforeBase64, failed.diskAfterBase64); assert.equal(recovered.diskBeforeBase64, recovered.diskAfterBase64);
      if (!sample.steps[1].browserMode) {
        assert.equal(recovered.status, 200); assert.equal(recovered.bodyComplete, true);
        assert.deepEqual(Buffer.from(recovered.bodyBase64, 'base64'), expectedBytes(sample.steps[1]));
      }
      const expected = expectedBytes(sample.steps[0]);
      assert.equal(failed.executionFault.bytes, expected.length); assert.equal(failed.executionFault.sha256, hash(expected));
    }
    for (const fixture of fallbackFontFailureFiles) {
      assert.deepEqual(await readFile(path.join(output, 'files', fixture.path)), await readFile(path.join(nodeDirectory, fixture.path)));
    }
  } catch (error) { errors.push(error); report.failed = true; report.failureType = typeof error; report.failure = sourceError(error); }
  finally {
    const cleanupErrors = [];
    if (producer && !producerJoined) try { await producer.done; } catch (error) { cleanupErrors.push(error); } finally { producerJoined = true; }
    if (producer) { report.nativeProducerMessage = producer.message?.failed ? producer.message : { failed: false }; report.cleanup.nativeProducerFinished = producerJoined; }
    report.nodeFaults = local?.faults ?? [];
    report.nodeDiagnostics = local?.diagnostics.map(value => ({ ...value, error: sourceError(value.error) })) ?? [];
    for (const [name, close] of [['fontHost', () => local?.close()], ['browser', () => browser?.close()],
      ['control', async () => { if (control?.listening) await new Promise((resolve, reject) => control.close(error => error ? reject(error) : resolve())); }]]) {
      try { await close(); report.cleanup[name] = 'closed'; } catch (error) { cleanupErrors.push(error); }
    }
    report.cleanup.errors = cleanupErrors.map(error => ({ failureType: typeof error, failure: sourceError(error) }));
    errors.push(...cleanupErrors);
    try { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw combineFailures(errors, 'Font consumer and cleanup failed.');
});
