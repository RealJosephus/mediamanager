import { spawn } from 'node:child_process';
import path from 'node:path';
import { StorageError } from '../storage/errors.js';

export function mediaHttpHeaderArguments(headers = {}) {
  const entries = Object.entries(headers);
  if (entries.some(([name, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)
    || typeof value !== 'string' || /[\r\n\0]/u.test(value))) throw new TypeError('Invalid media input HTTP headers.');
  return entries.length ? ['-headers', entries.map(([name, value]) => `${name}: ${value}\r\n`).join('')] : [];
}

export function startMediaProcess(executable, args, { environment, cwd, input = 'ignore', output = 'pipe' } = {}) {
  if (cwd && /[\\/]/u.test(executable) && !path.isAbsolute(executable)) executable = path.resolve(executable);
  return spawn(executable, args, { shell: false, windowsHide: true, env: environment, cwd, stdio: [input, output, 'pipe'] });
}

const failure = (code, message, cause) => Object.assign(new StorageError(code, message), cause === undefined ? {} : { cause });
const checkAbort = signal => { if (signal?.aborted) throw failure('cancelled', 'Media probing was cancelled.', signal.reason); };
const operationFailure = errors => errors.length === 1 ? errors[0]
  : Object.assign(new AggregateError(errors, errors[0]?.message ?? 'Media process cleanup failed.', { cause: errors[0] }),
    Object.fromEntries(['code', 'status', 'statusCode'].filter(key => errors[0]?.[key] !== undefined).map(key => [key, errors[0][key]])));

export async function captureMediaProcess(executable, args, { signal, environment, timeoutMs, maxOutputBytes, onCleanupError }) {
  checkAbort(signal);
  let child, timer, killTimer, primary;
  const cleanupErrors = [], stdout = [], stderr = [];
  let stdoutSize = 0, stderrSize = 0;
  const stop = error => {
    primary ??= error;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill(); } catch (error) { cleanupErrors.push(error); }
    if (!killTimer) {
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch (error) { cleanupErrors.push(error); }
        }
      }, 1000); killTimer.unref();
    }
  };
  const onAbort = () => stop(failure('cancelled', 'Media probing was cancelled.', signal.reason));
  try {
    try { child = startMediaProcess(executable, args, { environment }); }
    catch (error) { throw failure('unavailable', 'The media process could not start.', error); }
    const done = new Promise(resolve => {
      child.once('error', error => {
        const startup = failure('unavailable', 'The media process could not start.', error);
        if (primary === undefined) primary = startup; else cleanupErrors.push(startup);
      });
      child.once('close', resolve);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (timeoutMs !== undefined) { timer = setTimeout(() => stop(failure('timeout', 'Media probing timed out.')), timeoutMs); timer.unref(); }
    child.stdout.on('data', (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > maxOutputBytes) stop(failure('invalid-response', 'Media process output exceeded the configured limit.'));
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrSize += chunk.length;
      if (maxOutputBytes === Infinity || stderrSize <= 1024 * 1024) stderr.push(chunk);
    });
    const readError = error => { if (primary !== undefined) cleanupErrors.push(error); stop(error); };
    child.stdout.once('error', readError); child.stderr.once('error', readError);
    await done;
  } catch (error) { primary ??= error; }
  finally { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', onAbort); }
  if (onCleanupError) for (const error of [...cleanupErrors]) {
    try { onCleanupError(error); } catch (error) { cleanupErrors.push(error); }
  }
  const errors = primary === undefined ? cleanupErrors : [primary, ...cleanupErrors];
  if (errors.length) {
    const error = operationFailure(errors);
    error.process = { executable, args, pid: child?.pid ?? null, exitCode: child?.exitCode ?? null, signal: child?.signalCode ?? null,
      stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
    throw error;
  }
  // All started processes have emitted close before their result is exposed.
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: child.exitCode,
    signal: child.signalCode, pid: child.pid };
}
