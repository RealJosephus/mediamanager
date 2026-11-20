import { captureMediaProcess } from '../media-execution/process.js';
import { StorageError } from './errors.js';
import { unsignedInteger } from './range.js';

const failure = (code, message, cause) => Object.assign(new StorageError(code, message), cause === undefined ? {} : { cause });
const checkAbort = signal => { if (signal?.aborted) throw failure('cancelled', 'Media probing was cancelled.', signal.reason); };
const operationFailure = errors => errors.length === 1 ? errors[0]
  : Object.assign(new AggregateError(errors, errors[0]?.message ?? 'Media process cleanup failed.', { cause: errors[0] }),
    Object.fromEntries(['code', 'status', 'statusCode'].filter(key => errors[0]?.[key] !== undefined).map(key => [key, errors[0][key]])));

function requireExecutable(value) {
  if (typeof value !== 'string' && value !== null) throw new TypeError('An explicit media executable is required.');
}

/** Startup version discovery has one fixed command and no media input. */
export async function readEncoderVersionOutput(executable, { signal, environment, onCleanupError } = {}) {
  requireExecutable(executable);
  return captureMediaProcess(executable, ['-version'], { signal, environment, maxOutputBytes: Infinity, onCleanupError });
}

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
  extractChapters = false, threads = 0, requiredHttpHeaders,
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
  if (requiredHttpHeaders !== undefined) {
    const headers = Object.entries(requiredHttpHeaders);
    if (headers.some(([name, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)
      || typeof value !== 'string' || /[\r\n\0]/u.test(value))) throw new TypeError('Invalid live probe HTTP headers.');
    if (headers.length) args.push('-headers', headers.map(([name, value]) => `${name}: ${value}\r\n`).join(''));
  }
  if (rtsp) args.push('-rtsp_transport', 'tcp+udp', '-rtsp_flags', 'prefer_tcp');
  args.push('-i', input, '-threads', String(unsignedInteger(threads, 'thread count')), '-v', 'warning', '-print_format', 'json', '-show_streams');
  if (extractChapters) args.push('-show_chapters');
  args.push('-show_format');
  return args;
}

// Returns raw probe data explicitly. Native normalization and persistence are separate required stages.
export async function probeRaw(bridge, virtualPath, {
  executable, environment, signal, timeoutMs = 60000, maxOutputBytes = 32 * 1024 * 1024, relatedPaths = [], version, ...probeOptions
} = {}) {
  requireExecutable(executable);
  checkAbort(signal);
  for (const limit of [timeoutMs, maxOutputBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Probe limits must be positive safe integers.');
  }
  const lease = await bridge.lease(virtualPath, { signal, expiresInMs: timeoutMs + 1000, relatedPaths, version });
  let result, primary;
  try {
    result = await runProbe(buildHttpProbeArguments(lease.url, probeOptions), lease.url,
      { executable, environment, signal, timeoutMs, maxOutputBytes, sourceConsistency: lease.consistency });
  } catch (error) { primary = error; }
  const errors = primary === undefined ? [] : [primary];
  try { await lease.release(); } catch (error) { errors.push(error); }
  if (errors.length) throw operationFailure(errors);
  return result;
}

/** Explicit native shortcut targets are remote media, never filesystem identities. */
export async function probeRemoteRaw(url, {
  executable, environment, signal, timeoutMs = 60000, maxOutputBytes = 32 * 1024 * 1024, ...probeOptions
} = {}) {
  requireExecutable(executable);
  checkAbort(signal);
  return runProbe(buildRemoteProbeArguments(url, probeOptions), url,
    { executable, environment, signal, timeoutMs, maxOutputBytes, sourceConsistency: 'unversioned' });
}

/** An explicitly selected original tuner URL. UDP remains unavailable to the
 * generic shortcut entry point; no encoder, demux copy or recording is run. */
export async function probeLiveRaw(url, {
  executable, environment, signal, timeoutMs = 60000, maxOutputBytes = 32 * 1024 * 1024, ...options
} = {}) {
  requireExecutable(executable);
  checkAbort(signal);
  if (typeof url !== 'string' || /[\0\r\n]/u.test(url)) throw new TypeError('A live probe requires an original tuner URL.');
  const input = new URL(url);
  if (!['http:', 'https:', 'rtsp:', 'rtp:', 'udp:'].includes(input.protocol)) throw new TypeError('Unsupported live probe protocol.');
  return runProbe(probeArguments(url, options, input.protocol === 'rtsp:'), url,
    { executable, environment, signal, timeoutMs, maxOutputBytes, sourceConsistency: 'unversioned' });
}

async function runProbe(args, source, { executable, environment, signal, timeoutMs, maxOutputBytes, sourceConsistency }) {
  for (const limit of [timeoutMs, maxOutputBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Probe limits must be positive safe integers.');
  }
  const result = await captureMediaProcess(executable, args, { signal, environment, timeoutMs, maxOutputBytes });
  let raw;
  try { raw = JSON.parse(result.stdout.toString('utf8')); }
  catch (error) { throw failure('invalid-response', 'ffprobe did not return valid JSON.', error); }
  if (!raw || (raw.streams == null && raw.format == null)) throw failure('invalid-response', 'ffprobe returned neither streams nor format information.');
  // The baseline consumes valid output without requiring a zero exit code.
  if (Array.isArray(raw.streams)) for (const stream of raw.streams) {
    if (stream.display_aspect_ratio === '0:1') stream.display_aspect_ratio = '';
    if (stream.sample_aspect_ratio === '0:1') stream.sample_aspect_ratio = '';
  }
  return { raw, diagnostics: result.stderr.toString('utf8').replaceAll(source, '[probe source]'), exitCode: result.exitCode, sourceConsistency };
}
