import { stringifyNativeJson } from '../core/json.js';

export function decodeSubtitle(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return Buffer.from(bytes.subarray(2)).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw Object.assign(new Error('Subtitle character-set detection is not implemented for this encoding.'), { status: 501 }); }
}

function ticks(text) {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(text);
  if (!match) return null;
  return ((BigInt(match[1] ?? 0) * 3600n + BigInt(match[2]) * 60n + BigInt(match[3])) * 1000n + BigInt(match[4].padEnd(3, '0'))) * 10000n;
}

const subtitleError = (message, status = 400) => Object.assign(new Error(message), { status });

// ASS/SSA is intentionally limited to the grammar covered by the frozen native
// oracle. Valid features outside this subset fail instead of being approximated.
function assTicks(value) {
  const match = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/u.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw subtitleError('The ASS/SSA dialogue timestamp is invalid.');
  const result = (BigInt(match[1]) * 3600n + BigInt(match[2]) * 60n + BigInt(match[3])) * 10000000n + BigInt(match[4]) * 100000n;
  if (result > 9223372036854775807n) throw subtitleError('The ASS/SSA dialogue timestamp is invalid.');
  return result;
}

function assText(value, format) {
  if (!value || value.trim() !== value) throw subtitleError('The ASS/SSA dialogue text is outside the supported subset.', 501);
  let result = '', position = false;
  const styles = [];
  for (let index = 0; index < value.length;) {
    const char = value[index];
    if (char === '\\') {
      if (value[index + 1] !== 'N') throw subtitleError('This ASS/SSA text escape is not implemented.', 501);
      result += '\r\n'; index += 2; continue;
    }
    if (char === '{') {
      const end = value.indexOf('}', index + 1);
      if (end < 0 || value.slice(index + 1, end).includes('{')) throw subtitleError('The ASS/SSA override tag is invalid.');
      const tag = value.slice(index, end + 1);
      if (/^\{\\pos\(\d+,\d+\)\}$/u.test(tag)) {
        if (position || result) throw subtitleError('This ASS/SSA position tag placement is not implemented.', 501);
        position = true; result += tag;
      } else {
        const style = /^\{\\([ib])([01])\}$/u.exec(tag);
        if (!style) throw subtitleError('This ASS/SSA override tag is not implemented.', 501);
        const [, name, enabled] = style;
        if (enabled === '1') {
          if (styles.includes(name)) throw subtitleError('The ASS/SSA style nesting is invalid.');
          styles.push(name);
        } else if (styles.pop() !== name) throw subtitleError('The ASS/SSA style nesting is invalid.');
        if (format === 'ssa') result += enabled === '1' ? `<${name}>` : `</${name}>`;
        else result += tag;
      }
      index = end + 1; continue;
    }
    if ('}<>'.includes(char)) throw subtitleError('This ASS/SSA dialogue text is not implemented.', 501);
    result += char; index++;
  }
  if (styles.length) throw subtitleError('The ASS/SSA style nesting is invalid.');
  return result;
}

function assCues(text, format) {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r\n|\n|\r/u);
  let events = false, columns, dialogues = false;
  const cues = [];
  for (const source of lines) {
    const line = source.trim();
    if (/^\[[^\]]+\]$/u.test(line)) {
      if (events) break;
      events = /^\[Events\]$/iu.test(line);
      continue;
    }
    if (!events || !line || line.startsWith(';')) continue;
    const declared = /^Format\s*:\s*(.*)$/iu.exec(line);
    if (declared) {
      if (dialogues || columns) throw subtitleError('The ASS/SSA event format declaration is invalid.');
      columns = declared[1].split(',').map(value => value.trim().toLowerCase());
      const known = new Set(['layer', 'marked', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']);
      if (columns.length < 3 || columns.some((value, index) => !value || columns.indexOf(value) !== index)
        || columns.some(value => !known.has(value)) || !columns.includes('start') || !columns.includes('end') || columns.at(-1) !== 'text') {
        throw subtitleError('The ASS/SSA event format is outside the supported subset.', 501);
      }
      continue;
    }
    const dialogue = /^Dialogue\s*:\s?(.*)$/iu.exec(source.trimStart());
    if (!dialogue) throw subtitleError('This ASS/SSA event type is not implemented.', 501);
    if (!columns) throw subtitleError('The ASS/SSA event format declaration is missing.');
    dialogues = true;
    const values = [];
    let remaining = dialogue[1];
    for (let index = 1; index < columns.length; index++) {
      const comma = remaining.indexOf(',');
      if (comma < 0) throw subtitleError('The ASS/SSA dialogue fields are invalid.');
      values.push(remaining.slice(0, comma).trim()); remaining = remaining.slice(comma + 1);
    }
    values.push(remaining);
    const start = assTicks(values[columns.indexOf('start')]), end = assTicks(values[columns.indexOf('end')]);
    if (end < start) throw subtitleError('The ASS/SSA dialogue interval is invalid.');
    cues.push({ Id: String(cues.length + 1), Text: assText(values.at(-1), format), StartPositionTicks: start, EndPositionTicks: end });
  }
  if (!cues.length) throw subtitleError(`Unsupported format: ${format}`);
  return cues;
}

function webVttText(text) {
  text = text.replace(/\{\\[^}]*\}/g, '').replace(/(?:\r\n){3,}/g, '\r\n\r\n')
    .replaceAll('</font>', '</c>').replace(/<font color="?([a-z]+)"?>/g, '<c.$1>');
  let result = '', inTag = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index], remaining = text.slice(index);
    if (char === '<') {
      const simple = /^<(?:i|b|u|c|v)>/i.exec(remaining);
      if (simple) { result += simple[0]; index += simple[0].length - 1; }
      else if (/^<\//.test(remaining) || /^<(?:ruby|font|v[. ]|c[. ]|lang[. ])/i.test(remaining)) { result += char; inTag = true; }
      else result += '&lt;';
    } else if (char === '>') { result += inTag ? char : '&gt;'; inTag = false; }
    else if (char === '&') result += /^&(?:lrm|amp|lt|gt|\p{L}{2,3});/iu.test(remaining) ? '&' : '&amp;';
    else result += char;
  }
  return result;
}

export function convertSubtitle(text, inputFormat, outputFormat, { startPositionTicks = 0n, endPositionTicks = 0n, copyTimestamps = false } = {}) {
  inputFormat = inputFormat.toLowerCase();
  outputFormat = outputFormat.toLowerCase();
  if (['subrip', 'webvtt'].includes(inputFormat)) throw Object.assign(new Error(`Unsupported file extension: ${inputFormat}`), { status: 400 });
  if (!['srt', 'vtt', 'ass', 'ssa'].includes(inputFormat) || !['srt', 'subrip', 'vtt', 'webvtt', 'json'].includes(outputFormat)) {
    throw Object.assign(new Error('This subtitle conversion has not been implemented.'), { status: 501 });
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const cues = ['ass', 'ssa'].includes(inputFormat) ? assCues(text, inputFormat) : [];
  const header = ['WEBVTT'];
  if (inputFormat === 'vtt' && lines[0].startsWith('WEBVTT')) header[0] = lines[0];
  for (let index = 0; !['ass', 'ssa'].includes(inputFormat) && index < lines.length; index++) {
    if (inputFormat === 'vtt' && /^(?:NOTE|STYLE|REGION)(?: |$)/.test(lines[index]) && !lines[index - 1]) {
      const block = [];
      do { block.push(lines[index]); } while (++index < lines.length && lines[index]);
      if (!cues.length) header.push(block.join('\r\n'));
      continue;
    }
    const time = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[index]);
    if (!time) continue;
    const start = ticks(time[1]), end = ticks(time[2]);
    if (start === null || end === null) continue;
    const number = inputFormat === 'srt' && /^[+-]?\d+$/.test(lines[index - 1]?.trim()) ? Number(lines[index - 1].trim()) : cues.length + 1;
    const content = [];
    while (++index < lines.length && lines[index].trim()) content.push(inputFormat === 'vtt' ? lines[index].trim() : lines[index].replaceAll('\0', ' ').trimEnd());
    let value = content.join('\r\n');
    if (inputFormat === 'vtt') value = value.replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
    cues.push({ Id: String(number), Text: value, StartPositionTicks: start, EndPositionTicks: end });
  }
  if (!cues.length) throw Object.assign(new Error(`Unsupported format: ${inputFormat}`), { status: 400 });
  const start = BigInt(startPositionTicks), end = BigInt(endPositionTicks);
  const filtered = cues.filter(cue => !(cue.StartPositionTicks < start && cue.EndPositionTicks < start) && !(end > 0n && cue.StartPositionTicks > end));
  if (!copyTimestamps) for (const cue of filtered) {
    cue.StartPositionTicks = cue.StartPositionTicks < start ? 0n : cue.StartPositionTicks - start;
    cue.EndPositionTicks = cue.EndPositionTicks < start ? 0n : cue.EndPositionTicks - start;
  }
  if (outputFormat === 'json') {
    return stringifyNativeJson({ TrackEvents: filtered });
  }
  const timestamp = (value, separator = '.') => {
    const ms = value / 10000n;
    return `${String(ms / 3600000n).padStart(2, '0')}:${String(ms / 60000n % 60n).padStart(2, '0')}:${String(ms / 1000n % 60n).padStart(2, '0')}${separator}${String(ms % 1000n).padStart(3, '0')}`;
  };
  if (outputFormat === 'srt' || outputFormat === 'subrip') return filtered.map(cue => `${cue.Id}\r\n${timestamp(cue.StartPositionTicks, ',')} --> ${timestamp(cue.EndPositionTicks, ',')}\r\n${cue.Text}`).join('\r\n\r\n').trim() + '\r\n\r\n';
  return (header.join('\r\n\r\n') + '\r\n\r\n' + filtered.map(cue => `${timestamp(cue.StartPositionTicks)} --> ${timestamp(cue.EndPositionTicks)}\r\n${webVttText(cue.Text)}`).join('\r\n\r\n')).trim();
}
