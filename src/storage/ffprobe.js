import { spawn } from 'node:child_process';
import { StorageError, checkAbort } from './errors.js';
import { unsignedInteger } from './range.js';

function numericOption(value, name) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?[kKmMgG]?$/u.test(value)) throw new TypeError(`Invalid ${name}.`);
  return value;
}

// A VFS lease is always HTTP input,
// so the native inputProtocol == File first-video-frame branch does not apply here.
export function buildHttpProbeArguments(url, options = {}) {
  const input = new URL(url);
  if (input.protocol !== 'http:' || input.hostname !== '127.0.0.1' || !/^\/[a-f0-9]{64}(?:\/[^/]+)?$/u.test(input.pathname)
    || input.username || input.password || input.search || input.hash) throw new TypeError('ffprobe requires a private bridge lease.');
  return probeArguments(input.href, options);
}

export function buildRemoteProbeArguments(url, options = {}) {
  if (typeof url !== 'string' || /[\0\r\n]/u.test(url)) throw new TypeError('Remote probing requires a shortcut URL.');
  const input = new URL(url);
  if (!['http:', 'https:', 'rtsp:', 'rtp:'].includes(input.protocol)) throw new TypeError('Unsupported shortcut probe protocol.');
  return probeArguments(url, options, input.protocol === 'rtsp:');
}

function probeArguments(input, {
  analyzeDurationMs = 0, configuredAnalyzeDuration, configuredProbeSize, userAgent,
  extractChapters = false, threads = 0,
} = {}, rtsp = false) {
  const duration = unsignedInteger(analyzeDurationMs, 'analyze duration');
  const args = [];
  if (duration > 0n) args.push('-analyzeduration', String(duration * 1000n));
  else if (configuredAnalyzeDuration) args.push('-analyzeduration', numericOption(configuredAnalyzeDuration, 'analyze duration'));
  if (configuredProbeSize) args.push('-probesize', numericOption(configuredProbeSize, 'probe size'));
  if (userAgent !== undefined) {
    if (typeof userAgent !== 'string' || /[\r\n\0]/u.test(userAgent)) throw new TypeError('Invalid probe user agent.');
    args.push('-user_agent', userAgent);
  }
  if (rtsp) args.push('-rtsp_transport', 'tcp+udp', '-rtsp_flags', 'prefer_tcp');
  args.push('-i', input, '-threads', String(unsignedInteger(threads, 'thread count')), '-v', 'warning', '-print_format', 'json', '-show_streams');
  if (extractChapters) args.push('-show_chapters');
  args.push('-show_format');
  return args;
}

// Returns raw probe data explicitly. Native normalization and persistence are separate required stages.
export async function probeRaw(bridge, virtualPath, {
  executable, signal, timeoutMs = 60000, maxOutputBytes = 32 * 1024 * 1024, relatedPaths = [], ...probeOptions
} = {}) {
  checkAbort(signal);
  for (const limit of [timeoutMs, maxOutputBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Probe limits must be positive safe integers.');
  }
  const lease = await bridge.lease(virtualPath, { signal, expiresInMs: timeoutMs + 1000, relatedPaths });
  try {
    return await runProbe(buildHttpProbeArguments(lease.url, probeOptions), lease.url,
      { executable, signal, timeoutMs, maxOutputBytes, sourceConsistency: lease.consistency });
  } finally { await lease.release(); }
}

/** Explicit native shortcut targets are remote media, never filesystem identities. */
export async function probeRemoteRaw(url, {
  executable, signal, timeoutMs = 60000, maxOutputBytes = 32 * 1024 * 1024, ...probeOptions
} = {}) {
  checkAbort(signal);
  return runProbe(buildRemoteProbeArguments(url, probeOptions), url,
    { executable, signal, timeoutMs, maxOutputBytes, sourceConsistency: 'unversioned' });
}

async function runProbe(args, source, { executable = 'ffprobe', signal, timeoutMs, maxOutputBytes, sourceConsistency }) {
  for (const limit of [timeoutMs, maxOutputBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Probe limits must be positive safe integers.');
  }
  let child;
  try {
    checkAbort(signal);
    child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let failure;
    let stdoutSize = 0;
    let stderrSize = 0;
    const stdout = [];
    const stderr = [];
    let killTimer;
    const terminate = (error) => {
      failure ??= error;
      child.kill();
      if (!killTimer) {
        killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
        killTimer.unref();
      }
    };
    const onAbort = () => terminate(new StorageError('cancelled', 'Media probing was cancelled.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => terminate(new StorageError('timeout', 'Media probing timed out.')), timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > maxOutputBytes) terminate(new StorageError('invalid-response', 'Probe output exceeded the configured limit.'));
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize <= 1024 * 1024) stderr.push(chunk);
    });
    try {
      await new Promise((resolve, reject) => {
        child.once('error', () => reject(new StorageError('unavailable', 'The ffprobe process could not start.')));
        child.once('close', () => resolve());
      });
    } finally { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', onAbort); }
    if (failure) throw failure;
    let raw;
    try { raw = JSON.parse(Buffer.concat(stdout).toString('utf8')); }
    catch { throw new StorageError('invalid-response', 'ffprobe did not return valid JSON.'); }
    if (!raw || (raw.streams == null && raw.format == null)) throw new StorageError('invalid-response', 'ffprobe returned neither streams nor format information.');
    // The baseline consumes valid output without requiring a zero exit code.
    if (Array.isArray(raw.streams)) for (const stream of raw.streams) {
      if (stream.display_aspect_ratio === '0:1') stream.display_aspect_ratio = '';
      if (stream.sample_aspect_ratio === '0:1') stream.sample_aspect_ratio = '';
    }
    const diagnostics = Buffer.concat(stderr).toString('utf8').replaceAll(source, '[probe source]');
    return { raw, diagnostics, exitCode: child.exitCode, sourceConsistency };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }
}
