import definitions from './calendar-timezones.json' with { type: 'json' };
import { epochTicks, maximumDateTicks, formatUtcTicks } from '../syncplay/time.js';

const fixedOffsets = new Map();
for (const zone of definitions.timeZones) {
  let name;
  try { name = new Intl.DateTimeFormat('en-US', { timeZone: zone.ianaId }).resolvedOptions().timeZone; }
  catch { continue; }
  fixedOffsets.set(name, zone.offsetMinutes);
}

export function calendarDateToUtc(year, month, day) {
  const date = new Date(0), offset = fixedOffsets.get(Intl.DateTimeFormat().resolvedOptions().timeZone);
  let ticks;
  if (offset != null) {
    // A fixed Windows zone has no historical IANA offsets or DST. Preserve
    // its base offset across the entire native DateTime range.
    date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
    ticks = epochTicks + BigInt(date.valueOf()) * 10000n - BigInt(offset) * 600000000n;
  } else {
    date.setFullYear(year, month - 1, day); date.setHours(0, 0, 0, 0);
    ticks = epochTicks + BigInt(date.valueOf()) * 10000n;
  }
  return formatUtcTicks(ticks < 0n ? 0n : ticks > maximumDateTicks ? maximumDateTicks : ticks);
}
