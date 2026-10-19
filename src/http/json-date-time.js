import { epochTicks, maximumDateTicks } from '../syncplay/time.js';

// EF's DateTimeKindValueConverter calls ToUniversalTime before persistence.
// Local and Unspecified values use local wall time, and overflow is clamped.
export function jsonDateTimeUtcTicks({ ticks, kind }) {
  if (kind === 'Utc') return ticks;
  const date = new Date(Number(ticks / 10000000n * 1000n - epochTicks / 10000n));
  const local = new Date(0);
  local.setFullYear(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  local.setHours(date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), 0);
  const utc = epochTicks + BigInt(local.valueOf()) * 10000n + ticks % 10000000n;
  return utc < 0n ? 0n : utc > maximumDateTicks ? maximumDateTicks : utc;
}

// DateTime subtraction uses wall-clock ticks regardless of Kind. In particular,
// an explicit offset is converted to the server's local time by GetDateTime.
export function parseJsonDateTime(value) {
  if (typeof value !== 'string') throw new TypeError('Expected a JSON DateTime string.');
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{0,16}))?)?(Z|[+-]\d{2}(?::\d{2})?)?)?$/.exec(value);
  if (!match || value.endsWith('.')) throw new RangeError('Invalid JSON DateTime.');
  const [, y, m, d, h = '00', min = '00', s = '00', fraction = '', zone] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
  date.setUTCHours(Number(h), Number(min), Number(s), 0);
  if (Number(y) < 1 || Number(y) > 9999 || date.getUTCFullYear() !== Number(y) || date.getUTCMonth() + 1 !== Number(m)
    || date.getUTCDate() !== Number(d) || Number(h) > 23 || Number(min) > 59 || Number(s) > 59) throw new RangeError('Invalid JSON DateTime.');
  let ticks = epochTicks + BigInt(date.valueOf()) * 10000n + BigInt(fraction.slice(0, 7).padEnd(7, '0'));
  let kind = zone === 'Z' ? 'Utc' : 'Unspecified';
  if (zone && zone !== 'Z') {
    const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4));
    if (hours > 14 || minutes > 59 || hours === 14 && minutes !== 0) throw new RangeError('Invalid JSON DateTime offset.');
    const offset = (hours * 60 + minutes) * (zone[0] === '-' ? -1 : 1);
    const utc = ticks - BigInt(offset) * 600000000n;
    if (utc < 0n || utc > maximumDateTicks) throw new RangeError('JSON DateTime UTC instant is outside the native range.');
    const instant = new Date(Number(utc / 10000000n * 1000n - epochTicks / 10000n));
    const local = new Date(0);
    local.setUTCFullYear(instant.getFullYear(), instant.getMonth(), instant.getDate());
    local.setUTCHours(instant.getHours(), instant.getMinutes(), instant.getSeconds(), 0);
    ticks = epochTicks + BigInt(local.valueOf()) * 10000n + utc % 10000000n;
    // DateTimeOffset.LocalDateTime clamps when converting a valid UTC instant
    // to local wall time would overflow the DateTime range.
    ticks = ticks < 0n ? 0n : ticks > maximumDateTicks ? maximumDateTicks : ticks;
    kind = 'Local';
  }
  if (ticks < 0n || ticks > maximumDateTicks) throw new RangeError('JSON DateTime is outside the native range.');
  return { ticks, kind };
}
