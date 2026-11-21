import { once } from 'node:events';
import { encoderVersionAtLeast, getEncodingThreadCount } from '../playback/media-encoder.js';
import { StorageError } from '../storage/errors.js';
import { mediaHttpHeaderArguments, startMediaProcess } from './process.js';

export async function recordTransportStream(mediaEncoder, source, url, write, onStarted, { signal, requestHeaders } = {}) {
  signal?.throwIfAborted();
  if (!mediaEncoder.ready) throw new StorageError('unavailable', 'The recording encoder is unavailable.');
  const args = ['-hide_banner', '-loglevel', 'error', '-async', '1', '-protocol_whitelist', 'http,https,tcp,tls,crypto'];
  const flags = [source.IgnoreDts && '+igndts', source.IgnoreIndex && '+ignidx', source.GenPtsInput && '+genpts'].filter(Boolean);
  if (flags.length) args.push('-fflags', flags.join(''));
  if (source.ReadAtNativeFramerate) {
    args.push('-re');
    if (encoderVersionAtLeast(mediaEncoder.version, 8)) args.push('-readrate_catchup', '100');
  }
  if (source.RequiresLooping) args.push('-stream_loop', '-1', '-reconnect_at_eof', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2');
  args.push(...mediaHttpHeaderArguments(requestHeaders));
  args.push('-analyzeduration', '5000000', '-i', url, '-codec:v:0', 'copy', '-fflags', '+genpts', '-map_metadata', '-1',
    '-threads', String(getEncodingThreadCount(mediaEncoder.getEncodingOptions())), '-codec:a:0', 'copy', '-sn', '-f', 'mpegts', 'pipe:1');
  const child = startMediaProcess(mediaEncoder.encoderPath, args, { input: 'pipe', environment: mediaEncoder.environment });
  const closed = new Promise(resolve => child.once('close', (code, terminationSignal) => resolve({ code, terminationSignal })));
  let stopTimer, processError;
  child.on('error', error => { processError ??= error; });
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null || stopTimer) return;
    child.stdin?.end('q\n');
    stopTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    stopTimer.unref();
  };
  child.stdin.on('error', () => {});
  child.stderr.resume();
  const started = once(child, 'spawn').then(onStarted);
  // Read immediately so a short-lived encoder cannot drain its stdout on
  // exit while recording state is still being saved.
  const media = (async () => {
    for await (const bytes of child.stdout) {
      await started;
      await write(bytes);
    }
  })();
  try {
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    await Promise.all([started, media]);
    const { code, terminationSignal } = await closed;
    if (processError) throw processError;
    if (code !== 0 && !signal?.aborted) throw new StorageError('invalid-response',
      `FFmpeg recording stopped (${code ?? terminationSignal}).`);
  } finally {
    stop();
    await Promise.allSettled([closed, started, media]);
    signal?.removeEventListener('abort', stop);
    clearTimeout(stopTimer);
  }
}

// ProcessStartInfo.Arguments accepts double quotes and escaping by runs of backslashes.
function processArguments(line) {
  const args = [];
  let argument = '', active = false, quoted = false;
  for (let i = 0; i < line.length; i++) {
    let character = line[i];
    if (/\s/u.test(character) && !quoted) {
      if (active) { args.push(argument); argument = ''; active = false; }
      continue;
    }
    active = true;
    if (character === '\\') {
      const start = i;
      while (line[i + 1] === '\\') i++;
      const count = i - start + 1;
      if (line[i + 1] !== '"') { argument += '\\'.repeat(count); continue; }
      argument += '\\'.repeat(Math.floor(count / 2));
      character = line[++i];
      if (count % 2) { argument += character; continue; }
    }
    if (character === '"') {
      if (quoted && line[i + 1] === '"') { argument += character; i++; }
      else quoted = !quoted;
    } else argument += character;
  }
  if (active) args.push(argument);
  return args;
}

export async function postProcessRecording(configuration, filename, { signal } = {}) {
  const executable = configuration.RecordingPostProcessor;
  if (!executable?.trim() || signal?.aborted) return;
  const line = (configuration.RecordingPostProcessorArguments ?? '"{path}"').replace(/\{path\}/giu, () => filename);
  const child = startMediaProcess(executable, processArguments(line), { output: 'ignore' });
  let startupError, killTimer;
  child.on('error', error => { startupError ??= error; });
  child.stderr.resume();
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1000).unref();
  };
  const done = new Promise(resolve => child.once('close', (exitCode, terminationSignal) => resolve({ exitCode, terminationSignal })));
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try {
    const result = await done;
    if (startupError && !signal?.aborted) throw startupError;
    return result;
  } finally { signal?.removeEventListener('abort', stop); clearTimeout(killTimer); }
}
