const epochTicks = 621355968000000000n;
const maximumTicks = 3155378975999999999n;
const dayTicks = 864000000000n;
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const normalizedSpace = value => value.replace(/[\u0009-\u000d\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, ' ').replace(/^ +| +$/g, '');
const yearValue = value => value.length < 3 && Number(value) < 100 ? Number(value) + (Number(value) < 50 ? 2000 : 1900) : Number(value);

function dateMilliseconds(year, month, day, hour = 0, minute = 0, second = 0) {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(hour, minute, second, 0);
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
  return value.valueOf();
}

function localOffset(year, month, day, hour, minute, second) {
  const value = new Date(0);
  value.setFullYear(year, month - 1, day);
  value.setHours(hour, minute, second, 0);
  return value.getTimezoneOffset();
}

function formatTicks(ticks) {
  const milliseconds = (ticks / 10000000n) * 1000n - epochTicks / 10000n;
  const seconds = new Date(Number(milliseconds)).toISOString().slice(0, 19);
  return `${seconds}.${String(ticks % 10000000n).padStart(7, '0')}Z`;
}

function dateParts(value, now) {
  if (!value) return [now.getFullYear(), now.getMonth() + 1, now.getDate()];
  if (/[-/.]\s*[-/.]|[-/]\s*$|^\s*[-/.]/.test(value)) return null;
  const words = value.replaceAll(',', ' ').match(/[A-Za-z]+\.?|\d+/g) ?? [];
  if (value.replace(/[A-Za-z]+\.?|\d+|[\s,./-]/g, '')) return null;
  const numbers = words.filter(word => /^\d+$/.test(word));
  const named = words.filter(word => !/^\d+$/.test(word));
  if (named.length > 1 || words.length < 2 || words.length > 3) return null;
  if (named.length) {
    const name = named[0].replace(/\.$/, '').toLowerCase();
    const month = months.findIndex(month => month === name || month.slice(0, 3) === name) + 1;
    if (!month) return null;
    if (numbers.length === 1) {
      if (words[0] === named[0] && numbers[0].length < 3) return [now.getFullYear(), month, Number(numbers[0])];
      return [yearValue(numbers[0]), month, 1];
    }
    const [first, second] = numbers;
    return first.length >= 3 || Number(first) > 31 ? [yearValue(first), month, Number(second)] : [yearValue(second), month, Number(first)];
  }
  if (numbers.length === 2) {
    const [first, second] = numbers;
    if (first.length >= 3) return [yearValue(first), Number(second), 1];
    if (second.length >= 3) return [yearValue(second), Number(first), 1];
    return [now.getFullYear(), Number(first), Number(second)];
  }
  const [first, second, third] = numbers;
  return first.length >= 3 ? [yearValue(first), Number(second), Number(third)] : [yearValue(third), Number(first), Number(second)];
}

function fallback(raw, { now, offsetMinutes }) {
  if (raw.includes('\uFEFF')) return null;
  let text = normalizedSpace(raw.replace(/\0+$/, ''));
  let offset;
  const utc = text.match(/(?:GMT|Z)$/i);
  if (utc) {
    if (utc[0].toLowerCase() === 'gmt' && /\dT\d/i.test(text)) return null;
    offset = 0; text = normalizedSpace(text.slice(0, -utc[0].length));
  }
  else {
    const zone = text.match(/([+-])(\d{1,4})(?::(\d{1,2}))?$/);
    const prefix = zone ? text.slice(0, zone.index) : '';
    if (zone && (/\s$/.test(prefix) || /\d+[-/.]\d+[-/.]\d+$/.test(prefix) || prefix.includes(':') && /^[\d.,]+$/.test(prefix.slice(prefix.lastIndexOf(':') + 1)))) {
      let hours; let minutes;
      if (zone[3] !== undefined) { if (zone[2].length > 2) return null; hours = Number(zone[2]); minutes = Number(zone[3]); }
      else if (zone[2].length > 2) { hours = Number(zone[2].slice(0, -2)); minutes = Number(zone[2].slice(-2)); }
      else { hours = Number(zone[2]); minutes = 0; }
      if (hours > 14 || minutes > 59 || hours === 14 && minutes) return null;
      offset = (hours * 60 + minutes) * (zone[1] === '+' ? -1 : 1);
      text = normalizedSpace(text.slice(0, zone.index));
    }
  }
  let weekday;
  const dayNames = text.match(/\b(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b\.?/gi) ?? [];
  if (dayNames.length > 1) return null;
  if (dayNames.length) {
    weekday = weekdays.findIndex(day => day.startsWith(dayNames[0].replace('.', '').toLowerCase()));
    text = normalizedSpace(text.replace(dayNames[0], ' ').replace(/^,|,$/g, ''));
  }
  const eras = text.match(/\b(?:AD|A\.D\.)/gi) ?? [];
  for (const era of eras) text = normalizedSpace(text.replace(era, ' '));
  let hour = 0; let minute = 0; let second = 0; let fraction = ''; let date;
  if (/[年月日時时分秒년월일시분초]/.test(text)) {
    const components = [...text.matchAll(/(\d+)\s*([年月日時时分秒년월일시분초])/g)];
    const parts = {};
    const names = { 年: 'year', 년: 'year', 月: 'month', 월: 'month', 日: 'day', 일: 'day', 時: 'hour', 时: 'hour', 시: 'hour', 分: 'minute', 분: 'minute', 秒: 'second', 초: 'second' };
    for (const component of components) {
      const name = names[component[2]];
      if (parts[name] != null) return null;
      parts[name] = name === 'year' ? yearValue(component[1]) : Number(component[1]);
    }
    let remainder = normalizedSpace(text.replace(/\d+\s*[年月日時时分秒년월일시분초]/g, ''));
    const clock = remainder.match(/^(\d{1,2})\s*:\s*(\d{1,2})(?:\s*:\s*(\d{1,2})(?:[.,](\d*))?)?$/);
    if (clock && parts.hour == null && parts.minute == null && parts.second == null) {
      [parts.hour, parts.minute, parts.second, fraction] = [Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0), clock[4] ?? ''];
      remainder = '';
    }
    if (/^\d+$/.test(remainder) && parts.month != null && parts.day == null) { parts.day = Number(remainder); remainder = ''; }
    if (/^(?:AM|PM)$/i.test(remainder) && parts.hour != null) {
      if (remainder.toUpperCase() === 'AM') { if (parts.hour > 12) return null; if (parts.hour === 12) parts.hour = 0; }
      else if (parts.hour < 12) parts.hour += 12;
      remainder = '';
    }
    if (remainder) return null;
    date = parts.year != null || parts.month != null || parts.day != null ? [parts.year ?? now.getFullYear(), parts.month ?? 1, parts.day ?? 1] : [now.getFullYear(), now.getMonth() + 1, now.getDate()];
    [hour, minute, second] = [parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0];
  } else {
    const meridiems = text.match(/\b(?:AM|PM)\b|(?<=\d)(?:AM|PM)\b/gi) ?? [];
    if (meridiems.length > 1) return null;
    const meridiem = meridiems[0]?.toUpperCase();
    if (meridiem) text = normalizedSpace(text.replace(meridiems[0], ' '));
    const clock = text.match(/(?<!\d)(\d{1,2})\s*:\s*(\d{1,2})(?:\s*:\s*(\d{1,2})(?:[.,](\d*))?)?/);
    if (clock) {
      const iso = text[clock.index - 1]?.toLowerCase() === 't';
      if (iso && (clock[1].length !== 2 || clock[2].length !== 2 || clock[3] != null && clock[3].length !== 2 || clock[4] === '')) return null;
      hour = Number(clock[1]); minute = Number(clock[2]); second = Number(clock[3] ?? 0); fraction = clock[4] ?? '';
      text = normalizedSpace(text.slice(0, clock.index - (iso ? 1 : 0)) + ' ' + text.slice(clock.index + clock[0].length));
    } else if (meridiem) {
      if (/^\s*(?:AM|PM)/i.test(raw)) return null;
      const hours = [...text.matchAll(/\d+/g)];
      if (!hours.length) return null;
      const match = meridiems[0] && /^\s*(?:AM|PM)/i.test(raw) ? hours[0] : hours.at(-1);
      hour = Number(match[0]); text = normalizedSpace(text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length));
    }
    if (meridiem === 'AM' && hour > 12) return null;
    if (meridiem === 'AM' && hour === 12) hour = 0;
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (!text && !clock && !meridiem) return null;
    date = dateParts(text, now);
  }
  if (!date) return null;
  const [year, month, day] = date;
  const milliseconds = dateMilliseconds(year, month, day, hour, minute, second);
  if (milliseconds == null || weekday != null && new Date(milliseconds).getUTCDay() !== weekday) return null;
  let ticks = BigInt(milliseconds) * 10000n + epochTicks + BigInt(Math.round(Number(`0.${fraction || '0'}`) * 10000000));
  if (ticks > maximumTicks) return null;
  if (offset !== undefined) {
    ticks += BigInt(offset) * 600000000n;
    // DateTimeParse wraps the time on minimum-year underflow with an explicit zone.
    if (ticks < 0n) ticks += dayTicks;
    if (ticks > maximumTicks) return null;
  } else {
    ticks += BigInt(offsetMinutes?.(...date, hour, minute, second) ?? localOffset(...date, hour, minute, second)) * 600000000n;
    ticks = ticks < 0n ? 0n : ticks > maximumTicks ? maximumTicks : ticks;
  }
  return formatTicks(ticks);
}

export function parseInvariantDate(raw, { now = new Date(), offsetMinutes } = {}) {
  if (typeof raw !== 'string') return null;
  return fallback(raw, { now, offsetMinutes });
}

export function parseLegacyPlayedDateValue(raw, { now = new Date(), offsetMinutes } = {}) {
  if (normalizedSpace(raw) === '') return undefined;
  if (/^\d{14}$/.test(raw)) {
    const parts = [Number(raw.slice(0, 4)), Number(raw.slice(4, 6)), Number(raw.slice(6, 8)), Number(raw.slice(8, 10)), Number(raw.slice(10, 12)), Number(raw.slice(12, 14))];
    const milliseconds = dateMilliseconds(...parts);
    if (milliseconds != null) {
      const ticks = BigInt(milliseconds) * 10000n + epochTicks;
      const localTicks = ticks - BigInt(offsetMinutes?.(...parts) ?? localOffset(...parts)) * 600000000n;
      if (localTicks >= 0n && localTicks <= maximumTicks) return formatTicks(ticks);
    }
  }
  return fallback(raw, { now, offsetMinutes });
}
