import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha } from '../../../helpers/library-exchange-state.js';

const workerScript = fileURLToPath(new URL('../../../helpers/state-package-process.js', import.meta.url));

/** The shared real restore worker, with only the enclosing 900-second deadline. */
export function startRestoreWorker(mode, options, signal) {
  assert.ok(['restore-preparation-interrupted', 'restore'].includes(mode));
  signal.throwIfAborted();
  const child = spawn(process.execPath, [workerScript, mode, options.instanceRoot, options.packageDirectory,
    options.destination, options.baseline], { env: { ...process.env, MM_STATE_PROCESS_SCHEMA: options.schema },
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = '', delivered = false, deliberatelyTerminated = false, emergencyTerminationRequested = false;
  child.stderr.on('data', bytes => { diagnostics += bytes; });
  const closed = new Promise(resolve => child.once('close', (code, exitSignal) => resolve({ pid: child.pid, code, signal: exitSignal })));
  const abort = () => {
    if (child.exitCode === null && child.signalCode === null) emergencyTerminationRequested = child.kill('SIGKILL') || emergencyTerminationRequested;
  };
  signal.addEventListener('abort', abort, { once: true });
  const message = new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = (operation, value) => { signal.removeEventListener('abort', onAbort); operation(value); };
    child.once('message', value => { delivered = true; settle(resolve, value); });
    child.once('error', error => settle(reject, error));
    child.once('close', () => { if (!delivered) settle(reject, new Error(mode + ' exited before its actual boundary: ' + diagnostics)); });
  });
  // Keep rejection observable to its owner without an unhandled rejection if
  // an enclosing failure reaches cleanup before that owner starts awaiting it.
  message.catch(() => {});
  closed.then(() => signal.removeEventListener('abort', abort));
  return { child, closed, message, diagnostics: () => diagnostics,
    async stop({ intentional = false } = {}) {
      if (intentional) signal.throwIfAborted();
      if (child.exitCode === null && child.signalCode === null) {
        const requested = child.kill('SIGKILL');
        if (intentional) deliberatelyTerminated = requested;
        else emergencyTerminationRequested = requested || emergencyTerminationRequested;
      }
      return { ...await closed, deliberatelyTerminated, emergencyTerminationRequested };
    } };
}

/** Compare every restored instance asset before starting a consumer that may write. */
export async function compareInstanceAssets(manifest, packageDirectory, destination) {
  const observations = [];
  for (const file of manifest.instanceFiles) {
    let expected = await readFile(path.join(packageDirectory, 'files', ...file.path.split('/')));
    assert.equal(expected.length, file.bytes); assert.equal(sha(expected), file.sha256);
    if (file.path === 'config/system.xml') {
      let xml = expected.toString('utf8');
      for (const [name, field] of [['metadata', 'MetadataPath'], ['cache', 'CachePath']]) {
        const binding = manifest.instanceState.pathBindings[name];
        if (!binding.configured) continue;
        const value = path.join(destination, binding.root, ...binding.relativePath.split('/').filter(Boolean))
          .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        const expression = new RegExp(`<${field}>([\\s\\S]*?)</${field}>`, 'gu');
        assert.equal([...xml.matchAll(expression)].length, 1);
        xml = xml.replace(expression, `<${field}>${value}</${field}>`);
      }
      expected = Buffer.from(xml);
    }
    const actual = await readFile(path.join(destination, ...file.path.split('/')));
    assert.deepEqual(actual, expected, file.path + ' complete instance bytes');
    observations.push({ path: file.path, bytes: actual.length, sha256: sha(actual) });
  }
  assert.equal(observations.length, manifest.instanceFiles.length);
  return observations;
}
