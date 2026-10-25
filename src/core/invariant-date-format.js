// Invariant DateTime custom formatting used by the native NFO plugin.
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthShort = months.map(value => value.slice(0, 3));
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayShort = days.map(value => value.slice(0, 3));
const standards = {
  d: 'MM/dd/yyyy', D: 'dddd, dd MMMM yyyy', f: 'dddd, dd MMMM yyyy HH:mm', F: 'dddd, dd MMMM yyyy HH:mm:ss',
  g: 'MM/dd/yyyy HH:mm', G: 'MM/dd/yyyy HH:mm:ss', M: 'MMMM dd', m: 'MMMM dd',
  O: 'yyyy-MM-ddTHH:mm:ss.fffffffK', o: 'yyyy-MM-ddTHH:mm:ss.fffffffK',
  R: "ddd, dd MMM yyyy HH:mm:ss 'GMT'", r: "ddd, dd MMM yyyy HH:mm:ss 'GMT'", s: 'yyyy-MM-ddTHH:mm:ss',
  t: 'HH:mm', T: 'HH:mm:ss', u: "yyyy-MM-dd HH:mm:ss'Z'", U: 'dddd, dd MMMM yyyy HH:mm:ss', Y: 'yyyy MMMM', y: 'yyyy MMMM',
};
const fields = new Set('dMyhHmsfFtzKg'.split(''));
const pad = (value, length) => String(value).padStart(length, '0');
const escapeRegex = value => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const insensitiveRegex = value => [...value].map(char => {
  const lower = char.toLowerCase(), upper = char.toUpperCase();
  return lower !== upper && /^[A-Za-z]$/.test(char) ? `[${upper}${lower}]` : escapeRegex(char);
}).join('');
const namesRegex = values => values.map(insensitiveRegex).join('|');
const formatError = message => new RangeError(message);

function pattern(format, { parsing = false } = {}) {
  if (format === '') return parsing ? null : standards.G;
  if (format.length === 1) {
    if (parsing && format === '%') return null;
    if (!Object.hasOwn(standards, format)) throw formatError(`Invalid invariant date format: ${format}`);
    return standards[format];
  }
  return format;
}

function tokens(format, options) {
  const parsing = options?.parsing === true;
  format = pattern(format, options); if (format == null) return null;
  const result = [];
  for (let index = 0; index < format.length;) {
    const char = format[index];
    if (char === "'" || char === '"') {
      const quote = char; let text = ''; index++;
      while (index < format.length && format[index] !== quote) {
        if (format[index] === '\\' && index + 1 < format.length) text += format[index++ + 1]; else text += format[index];
        index++;
      }
      if (index >= format.length) {
        if (parsing) return null;
        throw formatError('Unterminated invariant date literal.');
      }
      result.push({ literal: text }); index++; continue;
    }
    if (char === '\\') {
      if (++index >= format.length) {
        if (parsing) return null;
        throw formatError('Incomplete invariant date escape.');
      }
      result.push({ literal: format[index++] }); continue;
    }
    if (char === '%') {
      if (++index >= format.length || format[index] === '%') {
        if (parsing) return null;
        throw formatError('Invalid invariant date percent escape.');
      }
      if (format[index] === '\\') {
        if (!parsing) throw formatError('Invalid invariant date percent escape.');
        if (++index >= format.length) {
          if (parsing) return null;
          throw formatError('Incomplete invariant date escape.');
        }
        result.push({ literal: format[index++] }); continue;
      }
      const specifier = format[index++];
      result.push(fields.has(specifier) ? { specifier, length: 1 } : { literal: specifier }); continue;
    }
    if (fields.has(char)) {
      let end = index + 1; while (format[end] === char) end++;
      result.push({ specifier: char, length: end - index }); index = end; continue;
    }
    result.push({ literal: char }); index++;
  }
  return result;
}

function sourceParts(value) {
  const text = value instanceof Date ? value.toISOString() : String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!match) throw new RangeError(`Invalid invariant date value: ${text}`);
  let [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', zone = 'Z'] = match;
  const local = { year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute), second: Number(second), fraction: fraction.padEnd(7, '0'), zone };
  if (local.year < 1 || local.month < 1 || local.month > 12 || local.day < 1 || local.day > 31 || local.hour > 23 || local.minute > 59 || local.second > 59) throw new RangeError(`Invalid invariant date value: ${text}`);
  const date = new Date(0); date.setUTCFullYear(local.year, local.month - 1, local.day); date.setUTCHours(local.hour, local.minute, local.second, Number(local.fraction.slice(0, 3)));
  if (!Number.isFinite(date.valueOf()) || date.getUTCFullYear() !== local.year || date.getUTCMonth() + 1 !== local.month || date.getUTCDate() !== local.day) throw new RangeError(`Invalid invariant date value: ${text}`);
  if (zone && zone !== 'Z') {
    const zoneHour = Number(zone.slice(1, 3)), zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) throw new RangeError(`Invalid invariant date value: ${text}`);
    const sign = zone[0] === '+' ? 1 : -1, offset = sign * (zoneHour * 60 + zoneMinute);
    date.setTime(date.getTime() - offset * 60000);
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw new RangeError(`Invalid invariant date value: ${text}`);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds(), fraction: local.fraction, zone: 'Z' };
  }
  return local;
}

function dayIndex(parts) { const date = new Date(0); date.setUTCFullYear(parts.year, parts.month - 1, parts.day); return date.getUTCDay(); }

export function formatInvariantDate(value, format) {
  const parts = sourceParts(value), values = tokens(format), weekday = dayIndex(parts);
  let output = '';
  for (const token of values) {
    if (token.literal != null) { output += token.literal; continue; }
    const { specifier, length } = token; let value = '';
    if (specifier === 'd') value = length === 1 ? String(parts.day) : length === 2 ? pad(parts.day, 2) : length === 3 ? dayShort[weekday] : days[weekday];
    else if (specifier === 'M') value = length === 1 ? String(parts.month) : length === 2 ? pad(parts.month, 2) : length === 3 ? monthShort[parts.month - 1] : months[parts.month - 1];
    else if (specifier === 'y') value = length <= 2 ? (length === 1 ? String(parts.year % 100) : pad(parts.year % 100, 2)) : pad(parts.year, length);
    else if (specifier === 'H') value = length === 1 ? String(parts.hour) : pad(parts.hour, 2);
    else if (specifier === 'h') { const hour = parts.hour % 12 || 12; value = length === 1 ? String(hour) : pad(hour, 2); }
    else if (specifier === 'm') value = length === 1 ? String(parts.minute) : pad(parts.minute, 2);
    else if (specifier === 's') value = length === 1 ? String(parts.second) : pad(parts.second, 2);
    else if (specifier === 'f') { if (length > 7) throw formatError('Invariant date fractions cannot exceed seven digits.'); value = parts.fraction.slice(0, length); }
    else if (specifier === 'F') { if (length > 7) throw formatError('Invariant date fractions cannot exceed seven digits.'); value = parts.fraction.slice(0, length).replace(/0+$/, ''); if (!value && output.endsWith('.')) output = output.slice(0, -1); }
    else if (specifier === 't') value = (parts.hour < 12 ? 'AM' : 'PM').slice(0, length === 1 ? 1 : 2);
    else if (specifier === 'z') value = length === 1 ? '+0' : length === 2 ? '+00' : '+00:00';
    else if (specifier === 'K') value = 'Z'.repeat(length);
    else if (specifier === 'g') value = 'A.D.';
    output += value;
  }
  return output;
}

function addGroup(state, name, expression, apply) {
  const key = `${name}${state.groups.length}`; state.regex += `(?<${key}>${expression})`; state.groups.push({ key, apply });
}

function setPart(parts, key, value) {
  if (parts.seen.has(key) && parts[key] !== value) parts.invalid = true;
  else { parts[key] = value; parts.seen.add(key); }
}

function zoneOffset(text) {
  if (!text || text === 'Z') return 0;
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(text);
  if (!match) return null;
  const hour = Number(match[2]), minute = Number(match[3] ?? 0);
  if (hour > 14 || minute > 59 || (hour === 14 && minute !== 0)) return null;
  return (match[1] === '+' ? 1 : -1) * (hour * 60 + minute);
}

export function parseInvariantDateExact(value, format, { now = () => new Date() } = {}) {
  const values = tokens(format, { parsing: true }); if (values == null) return null;
  const state = { regex: '^', groups: [] };
  for (const token of values) {
    if (token.literal != null) { state.regex += escapeRegex(token.literal); continue; }
    const { specifier, length } = token;
    if (specifier === 'd') {
      if (length <= 2) addGroup(state, 'day', length === 1 ? '\\d{1,2}' : '\\d{2}', (parts, text) => setPart(parts, 'day', Number(text)));
      else if (length <= 4) {
        const names = length === 3 ? dayShort : days;
        addGroup(state, 'weekday', namesRegex(names), (parts, text) => setPart(parts, 'weekday', names.findIndex(name => name.toLowerCase() === text.toLowerCase())));
      }
      else state.regex += '(?!)';
    } else if (specifier === 'M') {
      if (length <= 2) addGroup(state, 'month', length === 1 ? '\\d{1,2}' : '\\d{2}', (parts, text) => setPart(parts, 'month', Number(text)));
      else {
        const names = length === 3 ? monthShort : months;
        addGroup(state, 'monthName', namesRegex(names), (parts, text) => setPart(parts, 'month', names.findIndex(name => name.toLowerCase() === text.toLowerCase()) + 1));
      }
    } else if (specifier === 'y') addGroup(state, 'year', length === 1 ? '\\d{1,2}' : length === 2 ? '\\d{2}' : `\\d{${length}}`, (parts, text) => setPart(parts, 'year', length <= 2 ? (Number(text) <= 49 ? 2000 : 1900) + Number(text) : Number(text)));
    else if (specifier === 'H') addGroup(state, 'hour24', length === 1 ? '\\d{1,2}' : '\\d{2}', (parts, text) => setPart(parts, 'hour24', Number(text)));
    else if (specifier === 'h') addGroup(state, 'hour12', length === 1 ? '\\d{1,2}' : '\\d{2}', (parts, text) => setPart(parts, 'hour12', Number(text)));
    else if (specifier === 'm') addGroup(state, 'minute', length === 1 ? '\\d{1,2}' : '\\d{2}', (parts, text) => setPart(parts, 'minute', Number(text)));
    else if (specifier === 's') addGroup(state, 'second', length === 1 ? '\\d{1,2}' : '\\d{2}', (parts, text) => setPart(parts, 'second', Number(text)));
    else if (specifier === 'f' || specifier === 'F') {
      if (length > 7) return null;
      if (specifier === 'F' && state.regex.endsWith('\\.')) {
        const key = `fraction${state.groups.length}`; state.regex = state.regex.slice(0, -2) + `(?:\\.(?<${key}>\\d{1,${length}}))?`;
        state.groups.push({ key, apply: (parts, text = '') => setPart(parts, 'fraction', text.padEnd(7, '0')) });
      } else addGroup(state, 'fraction', specifier === 'f' ? `\\d{${length}}` : `\\d{0,${length}}`, (parts, text = '') => setPart(parts, 'fraction', text.padEnd(7, '0')));
    } else if (specifier === 't') {
      addGroup(state, 'meridiem', length === 1 ? '[Aa]|[Pp]' : '[Aa][Mm]|[Pp][Mm]', (parts, text) => setPart(parts, 'meridiem', text[0].toUpperCase()));
    }
    else if (specifier === 'z') addGroup(state, 'zone', length === 1 ? '[+-]\\d{1,2}' : length === 2 ? '[+-]\\d{2}' : '[+-]\\d{2}:\\d{2}', (parts, text) => {
      const offset = zoneOffset(text); if (offset == null) parts.invalid = true; else setPart(parts, 'zoneOffset', offset);
    });
    else if (specifier === 'K') addGroup(state, 'zone', `Z{${length}}|(?:[+-]\\d{2}:\\d{2}){${length}}|`, (parts, text) => {
      const chunks = text.startsWith('Z') ? Array(length).fill('Z') : text ? text.match(/.{6}/g) : [''];
      const offsets = chunks.map(zoneOffset);
      if (offsets.some(offset => offset == null || offset !== offsets[0])) parts.invalid = true;
      else setPart(parts, 'zoneOffset', offsets[0]);
    });
    else if (specifier === 'g') addGroup(state, 'era', `${insensitiveRegex('A.D.')}|${insensitiveRegex('AD')}`, () => {});
  }
  state.regex += '$';
  let match;
  try { match = new RegExp(state.regex).exec(String(value)); } catch { throw formatError(`Invalid invariant date format: ${format}`); }
  if (!match) return null;
  const current = now(); const hasDate = state.groups.some(group => /^(?:year|month|monthName|day)/.test(group.key));
  const parts = { year: hasDate ? 1 : current.getUTCFullYear(), month: hasDate ? 1 : current.getUTCMonth() + 1, day: hasDate ? 1 : current.getUTCDate(), hour24: 0, minute: 0, second: 0, fraction: '', seen: new Set(), invalid: false };
  if (hasDate && !state.groups.some(group => group.key.startsWith('year'))) parts.year = current.getUTCFullYear();
  for (const group of state.groups) group.apply(parts, match.groups[group.key]);
  if (parts.invalid || (parts.seen.has('hour12') && parts.seen.has('hour24'))) return null;
  if (parts.meridiem === 'P' && parts.hour12 == null) return null;
  let hour = parts.hour24;
  if (parts.hour12 != null) {
    if (parts.hour12 < 1 || parts.hour12 > 12) return null;
    hour = parts.hour12 % 12 + (parts.meridiem === 'P' ? 12 : 0);
  } else if (parts.meridiem && (hour >= 12) !== (parts.meridiem === 'P')) {
    return null;
  }
  if (parts.year < 1 || parts.year > 9999 || parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 || hour > 23 || parts.minute > 59 || parts.second > 59) return null;
  const local = new Date(0); local.setUTCFullYear(parts.year, parts.month - 1, parts.day); local.setUTCHours(hour, parts.minute, parts.second, Number((parts.fraction || '').padEnd(3, '0').slice(0, 3)));
  if (local.getUTCFullYear() !== parts.year || local.getUTCMonth() + 1 !== parts.month || local.getUTCDate() !== parts.day) return null;
  if (parts.weekday != null && local.getUTCDay() !== parts.weekday) return null;
  if (parts.seen.has('zoneOffset')) {
    local.setTime(local.getTime() - parts.zoneOffset * 60000);
    const minimum = new Date(0); minimum.setUTCFullYear(1, 0, 1); minimum.setUTCHours(0, 0, 0, 0);
    const maximum = new Date(0); maximum.setUTCFullYear(9999, 11, 31); maximum.setUTCHours(23, 59, 59, 999);
    if (local < minimum) local.setTime(local.getTime() + 86400000);
    if (local < minimum || local > maximum) return null;
  }
  const base = local.toISOString(); const fraction = (parts.fraction || '').padEnd(7, '0');
  return fraction.slice(3).replace(/0/g, '') ? base.replace(/\.\d{3}Z$/, `.${fraction}Z`) : base;
}
