import { captureMediaProcess } from './process.js';

function secondsToTicks(seconds) {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(seconds)) return;
  const ticks = Number(seconds) * 10000000;
  return ticks < 2 ** 63 ? ticks : undefined;
}

// The designated FfProbeKeyframeExtractor reads packet PTS in demux order
// and uses the last valid stream duration, falling back to the format duration.
export function parseKeyframeProbe(text) {
  let streamDuration = 0, formatDuration = 0;
  const keyframes = [];
  for (const line of text.split(/\r?\n/u)) {
    const [kind, value, flags] = line.toLowerCase().split(',', 3);
    if (!value) continue;
    const ticks = secondsToTicks(value);
    if (ticks == null) continue;
    if (kind === 'packet' && flags?.startsWith('k_')) {
      const whole = Math.floor(ticks);
      const fraction = ticks - whole;
      keyframes.push(BigInt(whole + Number(fraction > 0.5 || fraction === 0.5 && whole % 2 === 1)));
    } else if (kind === 'stream' && flags == null) streamDuration = ticks;
    else if (kind === 'format' && flags == null) formatDuration = ticks;
  }
  return { TotalDuration: BigInt(Math.trunc(streamDuration > 0 ? streamDuration : formatDuration)), KeyframeTicks: keyframes };
}

export async function probeKeyframes(mediaEncoder, bridge, virtualPath, source, { signal } = {}) {
  const timeoutMs = 6 * 60 * 60 * 1000;
  const lease = await bridge.lease(virtualPath, { signal, version: source.version, expiresInMs: timeoutMs + 1000 });
  let result, primary;
  try {
    const { stdout } = await captureMediaProcess(mediaEncoder.probePath, [
      '-protocol_whitelist', 'http,tcp', '-fflags', '+genpts', '-v', 'error', '-skip_frame', 'nokey',
      '-show_entries', 'format=duration', '-show_entries', 'stream=duration',
      '-show_entries', 'packet=pts_time,flags', '-select_streams', 'v', '-of', 'csv', lease.url,
    ], { signal, environment: mediaEncoder.environment, timeoutMs, maxOutputBytes: 64 * 1024 * 1024 });
    result = { ...parseKeyframeProbe(stdout.toString('utf8')), source };
  } catch (error) { primary = error; }
  try { await lease.release(); }
  catch (error) {
    if (primary) throw new AggregateError([primary, error], primary.message, { cause: primary });
    throw error;
  }
  if (primary) throw primary;
  return result;
}
