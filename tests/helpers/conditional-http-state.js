import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { errorObservation } from './error-observation.js';
import { ConditionalHttpAdapter } from '../migration/fixtures/remote-assets-http/adapter.js';

const serverScript = fileURLToPath(new URL('../migration/fixtures/remote-assets-http/server.mjs', import.meta.url));
const cleanupMilliseconds = 10000;

function waitFor(operation, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', aborted); callback(value);
    };
    const aborted = () => finish(reject, signal.reason);
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function rebindPort(port, signal) {
  const listener = createServer();
  try {
    const listening = once(listener, 'listening', { signal });
    listener.listen({ port, host: '127.0.0.1', signal });
    await listening;
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  } catch (error) {
    if (listener.listening) {
      try { await new Promise((resolve, reject) => listener.close(failure => failure ? reject(failure) : resolve())); }
      catch (failure) { throw new AggregateError([error, failure], 'Conditional HTTP port rebind and close failed.', { cause: error }); }
    }
    throw error;
  }
}

export async function ownedConditionalHttpFixture(t, label = 'remote-assets-http') {
  assert.match(label, /^[a-z][a-z0-9-]{0,63}$/u);
  const root = path.join(validationOutputRoot(), label + '-' + randomUUID());
  await mkdir(root, { recursive: true });
  const report = { scope: 'Independent durable conditional HTTP process and fixture SDK adapter; actual HTTP bytes/versions, capture/restore, restart, external writes and descriptor/listener drain. This does not certify AList/WebDAV reliable versions or a full instance.',
    phaseAcceptance: false, releaseAcceptance: false, servers: [], assertions: {} };
  const workers = [], registries = [];
  const openServer = async ({ startup = 'normal' } = {}) => {
    assert.ok(['normal', 'fail-after-listener', 'ready-with-descriptor'].includes(startup));
    t.signal.throwIfAborted();
    const child = spawn(process.execPath, [serverScript, path.join(root, 'remote'), startup], { windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const observation = { pid: child.pid }; report.servers.push(observation);
    let stdout = '', stderr = '', result, opening, stopping, draining, commands = Promise.resolve();
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', error => { observation.processError = errorObservation(error); });
    const exited = new Promise(resolve => child.once('close', (code, signal) => {
      result = { code, signal }; Object.assign(observation, { result, stdout, stderr }); resolve(result);
    }));
    const message = ({ command } = {}) => new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true; child.off('message', received); child.off('error', failed); child.off('close', closed);
        callback(value);
      };
      const received = value => finish(resolve, value), failed = error => finish(reject, error);
      const closed = () => failed(new Error('The HTTP object process exited before its response.', { cause: { ...result, stderr } }));
      child.once('message', received); child.once('error', failed); child.once('close', closed);
      if (result) { closed(); return; }
      if (command !== undefined) {
        try { child.send(command, error => { if (error) failed(error); }); }
        catch (error) { failed(error); }
      }
    });
    const worker = { child, exited, observation,
      command(value, { signal = t.signal } = {}) {
        const actual = commands.then(() => {
          signal.throwIfAborted(); return message({ command: value });
        });
        // Once admitted, track the real reply independently of caller abort so
        // a late business reply cannot be mistaken for the close response.
        commands = actual.catch(() => {}); return waitFor(actual, signal);
      },
      close() { return stopping ??= (async () => {
        // Business cancellation must not cancel the independent owner drain.
        const signal = AbortSignal.timeout(cleanupMilliseconds);
        const ready = await waitFor(opening, signal);
        await waitFor(commands, signal);
        const closed = await worker.command({ type: 'close' }, { signal });
        observation.closed = closed;
        assert.equal(closed.type, 'closed'); assert.equal(closed.activeRequests, 0); assert.equal(closed.openDescriptors, 0);
        assert.deepEqual(await waitFor(exited, signal), { code: 0, signal: null });
        await rebindPort(ready.port, signal);
        observation.portRebound = true; return closed;
      })(); },
      drain() { return draining ??= (async () => {
        try { return await worker.close(); }
        catch (error) {
          observation.normalShutdownFailed = true; observation.cleanupError = errorObservation(error);
          const failures = [error];
          if (!result) {
            observation.forcedCleanup = true;
            try { observation.killRequested = child.kill(); } catch (failure) { failures.push(failure); }
          }
          try { await waitFor(exited, AbortSignal.timeout(5000)); } catch (failure) { failures.push(failure); }
          if (failures.length > 1) throw new AggregateError(failures, 'Conditional HTTP owner drain and emergency cleanup failed.', { cause: error });
          throw error;
        }
      })(); } };
    // Register ownership synchronously after spawn, before readiness can fail or
    // the business signal can abort. The independent opening observation stays
    // live so cleanup can close a listener/FD acquired during initialization.
    workers.push(worker);
    opening = message().then(ready => {
      observation.ready = ready;
      assert.ok(Number.isInteger(ready.port) && ready.port > 0 && ready.port <= 65535);
      worker.origin = 'http://127.0.0.1:' + ready.port; return ready;
    });
    opening.catch(() => {});
    try {
      const ready = await waitFor(opening, t.signal);
      if (ready.type === 'initialization-failed') throw Object.assign(
        new Error('The conditional HTTP fixture failed after opening its listener and descriptor.', { cause: ready.failure }),
        { code: ready.failure.code });
      assert.equal(ready.type, 'ready'); return worker;
    } catch (error) {
      observation.initializationError = errorObservation(error);
      try { await worker.drain(); }
      catch (failure) { throw new AggregateError([error, failure], 'Conditional HTTP initialization and owner cleanup failed.', { cause: error }); }
      throw error;
    }
  };
  const openVfs = async worker => {
    const registry = new StorageRegistry(); registries.push(registry);
    registry.registerType('conditional-http', () => new ConditionalHttpAdapter(worker.origin));
    const adapter = await registry.createInstance('remote', 'conditional-http', {});
    const vfs = new VirtualFileSystem(registry);
    vfs.mount({ path: '/remote', instanceId: 'remote', capabilities: { create: true, replace: true, atomicReplace: true, conditionalWrite: true } });
    return { registry, adapter, vfs };
  };
  const put = async (worker, filename, bytes, version) => {
    const response = await fetch(worker.origin + filename, { method: 'PUT', body: bytes, signal: t.signal,
      headers: version ? { 'If-Match': version } : { 'If-None-Match': '*' } });
    assert.ok(response.status === 200 || response.status === 201); return await response.json();
  };
  t.after(async () => {
    const failures = [];
    for (const registry of registries) try { await registry.close(); } catch (error) { failures.push(error); }
    for (const worker of workers) try { await worker.drain(); } catch (error) { failures.push(error); }
    report.cleanupFailures = failures.map(errorObservation);
    try { await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Conditional HTTP fixture cleanup failed.', { cause: failures[0] });
  });
  return { root, report, openServer, openVfs, put, async packageDirectory() {
    const directory = path.join(root, 'package'); await mkdir(path.join(directory, 'files'), { recursive: true }); return directory;
  } };
}
