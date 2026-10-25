import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { validationExecutable } from '../../tools/validation/paths.js';

/** Own the actual child until close, including cancellation and bounded failures. */
export async function runMediaTool(tool, args, commands, signal) {
  signal?.throwIfAborted();
  assert.ok(tool === 'ffmpeg' || tool === 'ffprobe');
  const executable = tool === 'ffmpeg' ? validationExecutable('ffmpeg') : validationExecutable('ffprobe');
  const record = { executable, args, startedAt: new Date().toISOString(), pid: null,
    exitCode: null, signal: null, timedOut: false, closed: false };
  commands.push(record);
  const options = { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  const child = tool === 'ffmpeg'
    ? spawn(validationExecutable('ffmpeg'), args, options)
    : spawn(validationExecutable('ffprobe'), args, options);
  record.pid = child.pid ?? null;
  const stdout = [], stderr = [];
  let outputSize = 0, failed = false, failure;
  const fail = cause => { if (!failed) { failed = true; failure = cause; } };
  const close = new Promise(resolve => {
    child.once('error', fail);
    child.once('close', (code, signal) => { record.exitCode = code; record.signal = signal; resolve(); });
  });
  const capture = chunks => bytes => {
    outputSize += bytes.length;
    if (outputSize > 16 * 1024 * 1024) {
      fail(new Error('Controlled media tool output exceeded its bound.'));
      child.kill('SIGKILL');
    } else chunks.push(bytes);
  };
  child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
  const abort = () => { fail(signal.reason); child.kill('SIGKILL'); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => {
    record.timedOut = true; fail(new Error('Controlled media tool timed out.')); child.kill('SIGKILL');
  }, 60000);
  try { await close; }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    record.finishedAt = new Date().toISOString(); record.closed = true;
    record.stderr = Buffer.concat(stderr).toString('utf8');
    const bytes = Buffer.concat(stdout);
    record.stdout = bytes.toString('utf8'); record.stdoutBytes = bytes.length;
    record.stdoutSha256 = createHash('sha256').update(bytes).digest('hex');
    if (failed) record.error = failure instanceof Error
      ? { name: failure.name, message: failure.message, code: failure.code, cause: failure.cause }
      : { reason: failure };
  }
  if (failed) throw failure;
  assert.equal(record.exitCode, 0, record.stderr); assert.equal(record.signal, null);
  return Buffer.concat(stdout);
}
