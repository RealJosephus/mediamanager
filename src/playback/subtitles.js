import { stringifyNativeJson } from '../core/json.js';
import { writeAssSubtitle, readAssStyles } from './subtitle-writers.js';
import { writeTtmlSubtitle } from './subtitle-ttml.js';
import { readSamiCues } from './subtitle-sami.js';

export { decodeSubtitleBytes as decodeSubtitle } from './subtitle-charset.js';

function ticks(text) {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(text);
  if (!match) return null;
  return ((BigInt(match[1] ?? 0) * 3600n + BigInt(match[2]) * 60n + BigInt(match[3])) * 1000n + BigInt(match[4].padEnd(3, '0'))) * 10000n;
}

const subtitleError = (message, status = 400) => Object.assign(new Error(message), { status });

function webVttMapMilliseconds(line) {
  if (!/^X-TIMESTAMP-MAP=/iu.test(line) || !/MPEGTS:/iu.test(line)) return null;
  const compact = line.replaceAll(' ', '');
  const local = /LOCAL:([\d:.]*)/iu.exec(compact)?.[1] ?? '';
  const parts = local.split(/[:.]/u);
  if (parts.length === 3) parts.unshift('0');
  let localMilliseconds = 0;
  if (parts.length === 4) {
    if (parts.some(value => !/^\d+$/u.test(value) || Number(value) > 2147483647)) {
      throw subtitleError('The WebVTT timestamp map is invalid.');
    }
    localMilliseconds = ((Number(parts[0]) * 60 + Number(parts[1])) * 60 + Number(parts[2])) * 1000 + Number(parts[3]);
  }
  const media = /MPEGTS:(\d+)/iu.exec(compact);
  if (!media || BigInt(media[1]) > 9223372036854775807n) return 0;
  const seconds = Number(media[1]) / 90000 - localMilliseconds / 1000;
  return seconds > 0 && seconds < 90000 ? seconds * 1000 : 0;
}

function assTicks(value) {
  const match = /^([+-]?\d+):([+-]?\d+):([+-]?\d+)\.([+-]?\d+)$/u.exec(value);
  if (!match) throw subtitleError('The ASS/SSA dialogue timestamp is invalid.');
  const result = (BigInt(match[1]) * 3600n + BigInt(match[2]) * 60n + BigInt(match[3])) * 10000000n + BigInt(match[4]) * 100000n;
  if (result < -9223372036854775808n || result > 9223372036854775807n) throw subtitleError('The ASS/SSA dialogue timestamp is invalid.');
  return result;
}

function assColor(value) {
  const hex = value.replaceAll('&', '').replace(/^H+/u, '').padStart(6, '0');
  return ('#' + hex.slice(0, -6) + hex.slice(-2) + hex.slice(-4, -2) + hex.slice(-6, -4)).toLowerCase();
}

function ssaFont(text, name) {
  const prefix = '{\\' + name, reset = prefix + '}';
  const start = text.indexOf(prefix), end = text.indexOf('}', start);
  if (start < 0 || end < 0 || text.startsWith(reset, start) || name === 'c' && text.startsWith('{\\clip', start)) return text;
  const content = text.slice(start + prefix.length, end);
  const [value, ...commands] = content.indexOf('\\') > 0 ? content.split('\\') : [content];
  if (name === 'fs' && (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value) || !Number.isFinite(Number(value)))) return text;
  const attribute = name === 'fn' ? 'face' : name === 'fs' ? 'size' : 'color';
  let attributes = ` ${attribute}="${attribute === 'color' ? assColor(value.slice(1)) : value}"`, italic = false;
  const unknown = [];
  for (const command of commands.filter(Boolean).slice(0, 10)) {
    if (command.startsWith('fs') && command.length > 2) attributes += ` size="${command.slice(2)}"`;
    else if (command.startsWith('fn') && command.length > 2) attributes += ` face="${command.slice(2)}"`;
    else if (command.startsWith('c') && command.length > 2) attributes += ` color="${assColor(command.slice(2))}"`;
    else if (command.startsWith('i1')) italic = true;
    else unknown.push(command);
  }
  const replacement = `<font${attributes}>` + (unknown.length ? '{\\' + unknown.join('\\') + '}' : '') + (italic ? '<i>' : '');
  text = text.slice(0, start) + replacement + text.slice(end + 1);
  const closing = text.indexOf(reset, start);
  const next = text.indexOf(prefix + (attribute === 'color' ? '&' : ''), start);
  if (attribute === 'color' && next > 0 && (closing < 0 || next < closing)) return text.slice(0, next) + '</font>' + text.slice(next);
  if (closing > 0) return text.slice(0, closing) + '</font>' + text.slice(closing + reset.length);
  if (next > 0) return text.slice(0, next) + '</font>' + text.slice(next);
  const colorReset = text.indexOf('{\\c}', start);
  if (attribute !== 'color' && colorReset > 0 && text.indexOf('{\\', start) >= colorReset) return text.slice(0, colorReset) + '</font>' + text.slice(colorReset);
  return text + '</font>';
}

function assText(value, format) {
  let text = value.replace(/\\[Nn]/gu, '\r\n');
  if (format !== 'ssa') return text;
  // SSA readers expose basic inline formatting as HTML. Complex overrides stay
  // ordinary subtitle text; accepting them does not render or burn subtitles.
  if (!/\\(?:alpha|be[01]|bord|blur|clip|fad|fa|fsc[xy]|fr|iclip|[kK]|move|org|p|s[01]|t\(|[xy](?:bord|shad))/u.test(text)) {
    for (let index = 0; index < 10; index++) {
      text = text.replace('{\\i1\\', '<i>{\\');
      for (const name of ['fn', 'fs', 'c', '1c']) text = ssaFont(text, name);
    }
  }
  for (const name of ['i', 'u', 'b']) {
    text = text.replaceAll(`{\\${name}1}`, `<${name}>`).replaceAll(`{\\${name}0}`, `</${name}>`).replaceAll(`{\\${name}}`, `</${name}>`);
    if (text.split(`<${name}>`).length > text.split(`</${name}>`).length) text += `</${name}>`;
  }
  return text;
}

function assDocument(text, format) {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r\n|\n|\r/u);
  let events = false, columns = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  const cues = [], header = [], footer = [];
  let footerStarted = false;
  for (const source of lines) {
    const line = source.trim();
    if (footerStarted) {
      const section = /^\[(Fonts|Graphics|Aegisub Extradata)\]$/iu.exec(line);
      if (section) footer.push('', '[' + { fonts: 'Fonts', graphics: 'Graphics', 'aegisub extradata': 'Aegisub Extradata' }[section[1].toLowerCase()] + ']');
      else footer.push(source);
      continue;
    }
    if (/^\[[^\]]+\]$/u.test(line)) {
      if (events) {
        if (/^\[(?:Fonts|Graphics|Aegisub Extradata)\]$/iu.test(line)) { footerStarted = true; footer.push(line); continue; }
        break;
      }
      header.push(source);
      events = /^\[Events\]$/iu.test(line);
      continue;
    }
    if (!events) header.push(source);
    if (!events || !line || line.startsWith(';')) continue;
    const declared = /^Format\s*:\s*(.*)$/iu.exec(line);
    if (declared) {
      columns = declared[1].split(',').map(value => value.trim().toLowerCase());
      continue;
    }
    const dialogue = /^(?:Dialogue|Dialog|Comment)\s*:\s?(.*)$/iu.exec(source.trimStart());
    if (!dialogue) continue;
    const values = dialogue[1].split(','), textIndex = columns.indexOf('text');
    try {
      const start = assTicks(values[columns.indexOf('start')]?.trim()), end = assTicks(values[columns.indexOf('end')]?.trim());
      if (textIndex < 0 || textIndex >= values.length) continue;
      const field = name => values[columns.indexOf(name)];
      const rawLayer = field('layer')?.trim();
      cues.push({ Id: String(cues.length + 1), Text: assText(values.slice(textIndex).join(','), format), StartPositionTicks: start, EndPositionTicks: end,
        file: { style: format === 'ssa' ? field('style') : field('style')?.trim(),
          actor: format === 'ssa' ? field('name') : (field('name') ?? field('actor'))?.trim(),
          marginl: field('marginl')?.trim(), marginr: field('marginr')?.trim(), marginv: field('marginv')?.trim(),
          effect: format === 'ssa' ? field('effect') : field('effect')?.trim(),
          layer: /^[+-]?\d+$/u.test(rawLayer ?? '') && Number(rawLayer) >= -2147483648 && Number(rawLayer) <= 2147483647 ? Number(rawLayer) : 0,
          comment: /^Comment\s*:/iu.test(source.trimStart()) } });
    } catch (error) { if (error.status !== 400) throw error; }
  }
  if (!cues.length) throw subtitleError(`Unsupported format: ${format}`);
  return { cues, format, header: header.join('\r\n'), footer: footer.join('\r\n').trim() };
}

function webVttText(text) {
  for (let start = text.indexOf('{\\'); start >= 0;) {
    const end = text.indexOf('}', start + 1);
    if (end < 0) break;
    text = text.slice(0, start) + text.slice(end + 1);
    start = text.indexOf('{', start);
  }
  text = text.replace(/(?:\r\n){3,}/g, '\r\n\r\n').replace(/\\[Nn]/gu, '\r\n').replaceAll('\\h', ' ')
    .replaceAll('</font>', '</c>').replace(/<font color="?([a-z]*)"?>/g, '<c.$1>')
    .replace(/<font color="#([\da-fA-F]*)">/gu, (_, value) => {
      const rgb = value.length === 3 ? [...value].map(char => char + char).join('') : value.length === 8 ? value.slice(2) : value;
      const colors = { white: [255, 255, 255], lime: [0, 255, 0], cyan: [0, 255, 255], red: [255, 0, 0],
        yellow: [255, 255, 0], magenta: [255, 0, 255], blue: [0, 0, 255], black: [0, 0, 0] };
      const nearest = rgb.length === 6 && Object.entries(colors).find(([, color]) => color.every((channel, index) => Math.abs(channel - Number.parseInt(rgb.slice(index * 2, index * 2 + 2), 16)) <= 25))?.[0];
      return `<c.${nearest || 'color' + value}>`;
    });
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

function webVttPosition(text) {
  const alignment = /^\{\\an([1-9])/u.exec(text)?.[1];
  const value = { 1: 'position:20%', 3: 'position:80%', 4: 'position:20% line:50%', 5: 'line:50%',
    6: 'position:80% line:50%', 7: 'position:20% line:20%', 8: 'line:20%', 9: 'position:80% line:20%' }[alignment];
  return value ? ' ' + value : '';
}

function webVttAlignment(settings) {
  const number = name => {
    const value = new RegExp(`(?:^|\\s)${name}:([^\\s]+)`, 'u').exec(settings)?.[1];
    return value && /^(?:\d+(?:\.\d*)?|\.\d+)%?$/u.test(value) ? { value: Number.parseFloat(value), percent: value.endsWith('%') } : null;
  };
  const position = number('position'), line = number('line');
  const horizontal = position?.percent && position.value < 25 ? 0 : position?.percent && position.value > 75 ? 2 : 1;
  const vertical = line?.percent ? line.value < 25 ? 0 : line.value < 75 ? 1 : 2
    : line && line.value <= 7 ? 0 : line && line.value < 11 ? 1 : 2;
  return horizontal === 1 && vertical === 2 ? '' : `{\\an${(2 - vertical) * 3 + horizontal + 1}}`;
}

export function convertSubtitle(text, inputFormat, outputFormat, { startPositionTicks = 0n, endPositionTicks = 0n, copyTimestamps = false } = {}) {
  inputFormat = inputFormat.toLowerCase();
  outputFormat = outputFormat.toLowerCase();
  if (['subrip', 'webvtt'].includes(inputFormat)) throw Object.assign(new Error(`Unsupported file extension: ${inputFormat}`), { status: 400 });
  if (inputFormat === 'sub') throw subtitleError('Unsupported format: sub');
  if (!['srt', 'vtt', 'ass', 'ssa', 'smi'].includes(inputFormat) || !['srt', 'subrip', 'vtt', 'webvtt', 'json', 'ass', 'ssa', 'ttml'].includes(outputFormat)) {
    throw Object.assign(new Error('This subtitle conversion has not been implemented.'), { status: 501 });
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const document = ['ass', 'ssa'].includes(inputFormat) ? assDocument(text, inputFormat)
    : { cues: inputFormat === 'smi' ? readSamiCues(text) : [], format: inputFormat };
  const { cues } = document;
  const header = ['WEBVTT'];
  let mappedMilliseconds = 0;
  if (inputFormat === 'vtt' && lines[0].startsWith('WEBVTT')) header[0] = lines[0];
  for (let index = 0; ['srt', 'vtt'].includes(inputFormat) && index < lines.length; index++) {
    if (inputFormat === 'vtt' && /^(?:NOTE|STYLE|REGION)(?: |$)/.test(lines[index]) && !lines[index - 1]) {
      const block = [];
      do { block.push(lines[index]); } while (++index < lines.length && lines[index]);
      if (!cues.length) header.push(block.join('\r\n'));
      continue;
    }
    if (inputFormat === 'vtt' && index > 0) {
      const mapped = webVttMapMilliseconds(lines[index]);
      if (mapped !== null) { mappedMilliseconds = mapped; continue; }
    }
    const time = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[index]);
    if (!time) continue;
    let start = ticks(time[1]), end = ticks(time[2]);
    if (start === null || end === null) continue;
    if (mappedMilliseconds) {
      // Apply the media clock before selecting the playback window or relocating cues.
      start = BigInt(Math.trunc((Number(start) / 10000 + mappedMilliseconds) * 10000));
      end = BigInt(Math.trunc((Number(end) / 10000 + mappedMilliseconds) * 10000));
    }
    const number = inputFormat === 'srt' && /^[+-]?\d+$/.test(lines[index - 1]?.trim()) ? Number(lines[index - 1].trim()) : cues.length + 1;
    const alignment = inputFormat === 'vtt' ? webVttAlignment(lines[index]) : '';
    const content = [];
    while (++index < lines.length && lines[index].trim()) content.push(inputFormat === 'vtt' ? lines[index].trim() : lines[index].replaceAll('\0', ' ').trimEnd());
    let value = content.join('\r\n');
    if (inputFormat === 'vtt') value = alignment + value.replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&').replace(/ {2,}/gu, ' ');
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
    return stringifyNativeJson({ TrackEvents: filtered.map(({ Id, Text, StartPositionTicks, EndPositionTicks }) => ({ Id, Text, StartPositionTicks, EndPositionTicks })) });
  }
  if (outputFormat === 'ttml') return writeTtmlSubtitle(filtered, readAssStyles(document.header ?? ''));
  if (outputFormat === 'ass' || outputFormat === 'ssa') return writeAssSubtitle({ ...document, header: document.header ?? header.join('\r\n') }, filtered, outputFormat);
  const timestamp = (value, separator = '.') => {
    const ms = value / 10000n;
    return `${String(ms / 3600000n).padStart(2, '0')}:${String(ms / 60000n % 60n).padStart(2, '0')}:${String(ms / 1000n % 60n).padStart(2, '0')}${separator}${String(ms % 1000n).padStart(3, '0')}`;
  };
  if (outputFormat === 'srt' || outputFormat === 'subrip') return filtered.map(cue => `${cue.Id}\r\n${timestamp(cue.StartPositionTicks, ',')} --> ${timestamp(cue.EndPositionTicks, ',')}\r\n${cue.Text}`).join('\r\n\r\n').trim() + '\r\n\r\n';
  return (header.join('\r\n\r\n') + '\r\n\r\n' + filtered.map(cue => `${timestamp(cue.StartPositionTicks)} --> ${timestamp(cue.EndPositionTicks)}${webVttPosition(cue.Text)}\r\n${webVttText(cue.Text)}`).join('\r\n\r\n')).trim();
}
