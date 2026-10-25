import { availableParallelism } from 'node:os';
import { parseConfigurationVersion } from '../core/configuration-xml.js';
import { decodeNativeText } from '../core/native-text.js';
import { readEncoderVersionOutput } from '../storage/ffprobe.js';

const minimumLibraries = new Map([
  ['libavutil', [56, 70]], ['libavcodec', [58, 134]], ['libavformat', [58, 76]],
  ['libavdevice', [58, 13]], ['libavfilter', [7, 110]], ['libswscale', [5, 9]], ['libswresample', [3, 9]],
]);
const closed = () => Object.assign(new Error('The media encoder is closed.'), { code: 'closed' });
const operationFailure = errors => errors.length === 1 ? errors[0]
  : Object.assign(new AggregateError(errors, errors[0]?.message ?? 'Media encoder initialization failed.', { cause: errors[0] }),
    Object.fromEntries(['code', 'status', 'statusCode'].filter(key => errors[0]?.[key] !== undefined).map(key => [key, errors[0][key]])));

export function deriveProbePath(value) {
  return value.replace(/[^/\\]+?(\.[^/\\\n.]+)?$/u, 'ffprobe$1');
}

export function getEncodingThreadCount(options, cpuCoreLimit) {
  const threads = cpuCoreLimit ?? options.EncodingThreadCount;
  return threads <= 0 ? 0 : Math.min(threads, availableParallelism());
}

export function mediaEncoderVersion(output) {
  const match = /^ffmpeg version n?((?:[0-9]+\.?)+)/u.exec(output);
  const version = match && parseConfigurationVersion(match[1]);
  if (version) return version;
  const libraries = new Map();
  for (const match of output.matchAll(/((lib\w+)\s+([0-9]+)\.\s*([0-9]+))/gu)) {
    if (libraries.has(match[2])) throw new Error('The encoder returned duplicate library versions.');
    if (BigInt(match[3]) > 2147483647n || BigInt(match[4]) > 2147483647n) throw new RangeError('The encoder returned an invalid library version.');
    libraries.set(match[2], [Number(match[3]), Number(match[4])]);
  }
  return [...minimumLibraries].every(([name, minimum]) => {
    const found = libraries.get(name);
    return found && (found[0] > minimum[0] || found[0] === minimum[0] && found[1] >= minimum[1]);
  }) ? '4.4' : null;
}

export function encoderVersionAtLeast(version, major, minor = 0) {
  if (version === null) return false;
  const values = version.split('.').map(Number);
  return values[0] > major || values[0] === major && values[1] >= minor;
}

export function readMediaEncoderStartupOptions({ args = [], environment = {} } = {}) {
  const values = new Map();
  for (const [key, value] of Object.entries(environment)) {
    if (key.slice(0, 9).toLowerCase() === 'jellyfin_') values.set(key.slice(9).replaceAll('__', ':').toLowerCase(), value);
  }
  let startupFFmpegPath = values.get('ffmpeg') ?? '';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--ffmpeg') {
      if (index + 1 === args.length || args[index + 1].startsWith('--')) throw new TypeError('The --ffmpeg option requires a value.');
      startupFFmpegPath = args[++index];
    } else if (args[index].startsWith('--ffmpeg=')) startupFFmpegPath = args[index].slice(9);
  }
  const raw = values.get('ffmpeg:novalidation');
  let skipValidation = false;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || !/^(?:true|false)$/iu.test(raw.trim())) throw new TypeError('FFmpeg:novalidation must be true or false.');
    skipValidation = raw.trim().toLowerCase() === 'true';
  }
  return { startupFFmpegPath, skipValidation };
}

/** One startup selection shared by probing, subtitle extraction and packet copy. */
export class MediaEncoder {
  #initialization;
  #lifetime = new AbortController();
  #closing;
  #closed = false;
  #encoderPath = '';
  #probePath = null;
  #probeThreads = 0;
  #version = null;
  #ready = false;
  #cleanupErrors = [];

  constructor({ startupFFmpegPath = '', skipValidation = false, getEncodingOptions, saveEncodingOptions, environment, onError = () => {} }) {
    if (typeof startupFFmpegPath !== 'string' || typeof skipValidation !== 'boolean') throw new TypeError('Media encoder startup options are required.');
    if (typeof getEncodingOptions !== 'function' || typeof saveEncodingOptions !== 'function') throw new TypeError('The media encoder requires current encoding configuration and its save operation.');
    Object.assign(this, { startupFFmpegPath, skipValidation, getEncodingOptions, saveEncodingOptions, environment, onError });
  }
  get encoderPath() { return this.#encoderPath; }
  get probePath() { return this.#probePath; }
  get probeThreads() { return this.#probeThreads; }
  get version() { return this.#version; }
  get ready() { return this.#ready; }

  initialize() {
    if (this.#closed) return Promise.reject(closed());
    return this.#initialization ??= this.#initialize();
  }
  async #initialize() {
    if (this.skipValidation) { this.#ready = true; return true; }
    const selected = this.startupFFmpegPath || this.getEncodingOptions().EncoderAppPath || 'ffmpeg';
    let result;
    try { result = await this.#readVersion(selected); }
    catch (error) {
      if (this.#lifetime.signal.aborted) throw error;
      this.#encoderPath = null;
      try { await this.onError(error); } catch (reportError) { throw operationFailure([error, reportError]); }
      return false;
    }
    const output = decodeNativeText(result.stdout);
    const version = /Libav developers/iu.test(output) ? null : mediaEncoderVersion(output);
    if (!encoderVersionAtLeast(version, 4, 4)) { this.#encoderPath = null; return false; }
    this.#encoderPath = selected;
    const options = this.getEncodingOptions();
    options.EncoderAppPathDisplay = selected;
    // The actual value supplied to SaveConfiguration also supplies the startup
    // threads after its synchronous observers, even if an observer saves another value.
    await this.saveEncodingOptions(options);
    this.#probePath = deriveProbePath(selected);
    let discovered;
    try { discovered = await this.#readVersion(selected); }
    catch (error) {
      if (this.#lifetime.signal.aborted) throw error;
      try { await this.onError(error); } catch (reportError) { throw operationFailure([error, reportError]); }
    }
    this.#version = discovered ? mediaEncoderVersion(decodeNativeText(discovered.stdout)) : null;
    this.#probeThreads = getEncodingThreadCount(options);
    this.#ready = true;
    return true;
  }
  #readVersion(selected) {
    return readEncoderVersionOutput(selected, { signal: this.#lifetime.signal, environment: this.environment,
      onCleanupError: error => this.#cleanupErrors.push(error) });
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const completion = Promise.withResolvers(); this.#closing = completion.promise;
    this.#lifetime.abort(closed());
    // Cancelling version discovery must drain its process. A configuration save
    // already handed to the manager finishes before its owner can close.
    (async () => {
      await Promise.allSettled([this.#initialization]);
      if (this.#cleanupErrors.length) completion.reject(operationFailure(this.#cleanupErrors));
      else completion.resolve();
    })();
    return this.#closing;
  }
}
