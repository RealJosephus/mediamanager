import { readWebVttStyles, assStyleColor, assInlineStyle } from './subtitle-vtt-style.js';

const eol = '\r\n';
const assStyleColumns = 'Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
const ssaStyleColumns = 'Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding';
const eventColumns = 'Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';
const defaultAssStyle = 'Style: Default,Arial,20,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,2,10,10,10,1';
const defaultSsaStyle = 'Style: Default,Arial,20,16777215,65535,0,0,0,0,1,1,1,2,10,10,10,0,1';

const htmlColors = { black: '000000', silver: 'c0c0c0', gray: '808080', white: 'ffffff', maroon: '800000', red: 'ff0000',
  purple: '800080', fuchsia: 'ff00ff', magenta: 'ff00ff', green: '008000', lime: '00ff00', olive: '808000', yellow: 'ffff00',
  navy: '000080', blue: '0000ff', teal: '008080', aqua: '00ffff', cyan: '00ffff', orange: 'ffa500', transparent: 'ffffff' };

function htmlColor(value) {
  value = value.trim().toLowerCase();
  let hex = htmlColors[value] ?? (value.startsWith('#') ? value.slice(1) : 'ffffff');
  if (hex.length === 3) hex = [...hex].map(value => value + value).join('');
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,[^)]*)?\)$/u.exec(value);
  if (rgb && rgb.slice(1).every(value => Number(value) <= 255)) hex = rgb.slice(1).map(value => Number(value).toString(16).padStart(2, '0')).join('');
  if (!/^[\da-f]{6}(?:[\da-f]{2})?$/u.test(hex)) hex = 'ffffff';
  return hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2);
}

function styledText(text) {
  text = text.replace(/\r\n|\r|\n/gu, '\\N');
  if (!text.includes('<')) return text;
  for (const name of ['i', 'u', 'b']) text = text.replaceAll(`<${name}>`, `{\\${name}1}`).replaceAll(`</${name}>`, `{\\${name}0}`);
  for (let count = 0; count < 100; count++) {
    const match = /<font ([^>]*)>/u.exec(text);
    if (!match) break;
    const attributes = Object.fromEntries([...match[1].matchAll(/(?:^| )(face|size|color)=(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gu)]
      .map(value => [value[1], value[2] ?? value[3] ?? value[4]]));
    text = text.slice(0, match.index) + text.slice(match.index + match[0].length);
    const end = text.indexOf('</font>', match.index);
    if (end > 0) {
      const reset = end + 7 < text.length ? ['color', 'face', 'size'].filter(name => Object.hasOwn(attributes, name))
        .map(name => `{\\${{ color: 'c', face: 'fn', size: 'fs' }[name]}}`).join('') : '';
      text = text.slice(0, end) + reset + text.slice(end + 7);
    }
    const commands = ['color', 'size', 'face'].filter(name => Object.hasOwn(attributes, name)).map(name => name === 'color'
      ? `\\c&H${htmlColor(attributes.color)}&` : `\\${name === 'face' ? 'fn' : 'fs'}${attributes[name]}`).join('');
    if (commands && match.index < text.length) text = text.slice(0, match.index) + '{' + commands + '}' + text.slice(match.index);
  }
  // Adjacent formatting runs are one ASS override, while color reset remains a
  // separate run so that a following font change cannot hide the reset.
  text = text.replaceAll('{\\c}', '\0color-reset\0').replaceAll('}{', '').replaceAll('\0color-reset\0', '{\\c}')
    .replaceAll('{\\c}{\\c&', '{\\c&').replace(/(?:\{\\c\})+$/u, '');
  for (const command of ['fs', 'fn']) while (text.includes(`\\${command}\\${command}`)) text = text.replaceAll(`\\${command}\\${command}`, `\\${command}`);
  return text.replaceAll('\\c\\c&H', '\\c&H');
}

function assColorArgb(value, fallback) {
  const hex = /^&?H([\da-f]{1,8})&?$/iu.exec(value?.trim() ?? '')?.[1].padStart(6, '0');
  if (hex && hex.length !== 7) {
    const bgr = hex.slice(-6), alpha = hex.length === 8 ? 255 - Number.parseInt(hex.slice(0, 2), 16) : 255;
    return (alpha * 0x1000000 + Number.parseInt(bgr.slice(4, 6) + bgr.slice(2, 4) + bgr.slice(0, 2), 16)) | 0;
  }
  if (/^[+-]?\d+$/u.test(value?.trim() ?? '') && Number(value) >= -2147483648 && Number(value) <= 2147483647) {
    const bgr = Number(value) >>> 0;
    return (0xff000000 | (bgr & 255) << 16 | bgr & 0xff00 | bgr >>> 16 & 255);
  }
  return fallback;
}

export function readAssStyles(header) {
  let columns = assStyleColumns.split(',').map(value => value.trim().toLowerCase());
  const styles = [];
  for (const line of header.split(/\r\n|\r|\n/u)) {
    const declaration = /^Format:\s*(.*)$/iu.exec(line);
    if (declaration) columns = declaration[1].split(',').map(value => value.trim().toLowerCase());
    const row = /^Style:\s*(.*)$/iu.exec(line);
    if (row) styles.push(Object.fromEntries(row[1].split(',').map((value, index) => [columns[index], value.trim()])));
  }
  return styles;
}

function ssaStyles(header) {
  const number = (value, fallback) => /^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value ?? '') ? value : fallback;
  const integer = (value, fallback) => /^[+-]?\d+$/u.test(value ?? '') && Number(value) >= -2147483648 && Number(value) <= 2147483647 ? String(Number(value)) : fallback;
  return readAssStyles(header).map(style => 'Style: ' + [style.name, style.fontname || 'Arial',
    String(Math.round(Number(number(style.fontsize, '20')) * 10) / 10),
    assColorArgb(style.primarycolour, -1), assColorArgb(style.secondarycolour, -256),
    assColorArgb(style.outlinecolour, -16777216), assColorArgb(style.backcolour, -16777216),
    ['-1', '1'].includes(style.bold) ? '-1' : '0', ['-1', '1'].includes(style.italic) ? '-1' : '0', style.borderstyle ?? '1',
    number(style.outline, '1'), number(style.shadow, '1'),
    { 1: '1', 3: '3', 4: '9', 5: '10', 6: '11', 7: '5', 8: '6', 9: '7' }[style.alignment] ?? '2',
    integer(style.marginl, '10'), integer(style.marginr, '10'), integer(style.marginv, '10'), '0', '1'].join(','));
}

function generatedHeader(format, styles, title = 'untitled') {
  const ssa = format === 'ssa';
  return ['[Script Info]', `; This is ${ssa ? 'a Sub Station Alpha v4' : 'an Advanced Sub Station Alpha v4+'} script.`,
    'Title: ' + title, 'ScriptType: v4.00' + (ssa ? '' : '+'), ...(ssa ? ['Collisions: Normal', 'PlayDepth: 0'] : ['PlayDepth: 0', 'ScaledBorderAndShadow: Yes']),
    '', ssa ? '[V4 Styles]' : '[V4+ Styles]', 'Format: ' + (ssa ? ssaStyleColumns : assStyleColumns),
    styles ?? (ssa ? defaultSsaStyle : defaultAssStyle), '', '[Events]', 'Format: ' + (ssa ? 'Marked' : 'Layer') + ', ' + eventColumns].join(eol);
}

function assTimestamp(ticks, round) {
  let milliseconds = ticks / 10000n;
  if (round) milliseconds = milliseconds >= 0n ? (milliseconds + 5n) / 10n * 10n : (milliseconds - 5n) / 10n * 10n;
  const field = value => (value < 0n ? '-' : '') + String(value < 0n ? -value : value).padStart(2, '0');
  return `${milliseconds / 3600000n}:${field(milliseconds / 60000n % 60n)}:${field(milliseconds / 1000n % 60n)}.${field(milliseconds % 1000n / 10n)}`;
}

function webVttAssText(text, styles = []) {
  const colors = { white: 'FFFFFF', lime: '00FF00', cyan: 'FFFF00', red: '0000FF', yellow: '00FFFF', magenta: 'FF00FF', blue: 'FF0000', black: '000000' };
  for (const name of ['i', 'b', 'u']) text = text.replaceAll(`<${name}>`, `{\\${name}1}`).replaceAll(`</${name}>`, `{\\${name}0}`);
  const classes = [], output = [];
  let copied = 0;
  for (let match = /<\/?c[a-z_.A-Z#\d-]*>/u.exec(text); match; match = /<\/?c[a-z_.A-Z#\d-]*>/u.exec(text)) {
    if (match[0] === '</c>' && match.index > copied) {
      // Class boundaries are removed from the input while the text cursor keeps
      // the preceding boundary. Preserve the resulting visible ASS cue text.
      output.push(text.slice(copied, copied + Math.min(text.length - copied, match.index)));
      copied = match.index;
      classes.pop();
    } else if (match[0].startsWith('<c.')) {
      classes.push(match[0].slice(3, -1).split('.'));
      const active = classes.flat(), color = active.findLast(name => colors[name]);
      if (styles.length) {
        const values = {};
        for (const name of active) {
          const rule = styles.find(rule => rule.selector === '.' + name);
          if (rule) Object.assign(values, Object.fromEntries(Object.entries(rule.commands).filter(([command]) => command !== 's')));
          else if (['i', 'b', 'u'].includes(name)) values[name] = 1;
          else if (colors[name]) values.c = [4, 2, 0].map(index => Number.parseInt(colors[name].slice(index, index + 2), 16)).concat(255);
        }
        output.push(assInlineStyle(values));
      } else {
        const commands = (color ? '\\c&H' + colors[color] : '') + ['i', 'b', 'u'].filter(name => active.includes(name)).map(name => '\\' + name + '1').join('');
        if (commands) output.push('{' + commands + '}');
      }
    }
    text = text.slice(0, match.index) + text.slice(match.index + match[0].length);
  }
  if (text.length > copied) output.push(text.slice(copied));
  return output.join('').trim();
}

export function writeAssSubtitle(document, cues, format) {
  const ssa = format === 'ssa';
  const styles = readAssStyles(document.header ?? '');
  const webStyles = document.format === 'vtt' && !ssa ? readWebVttStyles(document.header ?? '') : [];
  let header, validStyles = false;
  if (ssa && document.header?.includes('[V4+ Styles]')) {
    const converted = ssaStyles(document.header);
    header = generatedHeader(format, converted.length ? converted.join(eol) + eol : undefined);
    validStyles = true;
  } else if (document.header?.includes(ssa ? '[V4 Styles]' : '[V4+ Styles]')) {
    header = document.header.trim() + eol + 'Format: ' + (ssa ? 'Marked' : 'Layer') + ', ' + eventColumns;
    validStyles = true;
  } else {
    const declarations = webStyles.map(({ selector, commands: values }) => {
      const row = defaultAssStyle.slice(7).split(',');
      row[0] = selector; row[15] = '3';
      if (values.fn !== undefined) row[1] = values.fn;
      for (const [command, index] of [['c', 3], ['4c', 4], ['3c', 5]]) if (values[command]) row[index] = assStyleColor(values[command]);
      for (const [command, index] of [['b', 7], ['i', 8], ['u', 9], ['s', 10]]) if (values[command] !== undefined) row[index] = values[command] ? '-1' : '0';
      if (values.shad !== undefined) row[17] = String(values.shad);
      if (values['3c']?.[3] === 0) row[6] = row[5];
      return 'Style: ' + row.join(',');
    });
    header = generatedHeader(format, declarations.length ? [defaultAssStyle, ...declarations].join(eol) : undefined, document.format === 'vtt' && !ssa ? '' : 'untitled');
  }
  const names = styles.map(style => style.name);
  const margin = value => /^[+-]?\d+$/u.test(value ?? '') && Number(value) >= -2147483648 && Number(value) <= 2147483647 ? ssa ? value.padStart(4, '0') : value : ssa ? '0000' : '0';
  const rows = cues.map((cue, index) => {
    const fields = cue.file ?? {};
    let style = validStyles && names.includes(fields.style) ? fields.style : 'Default';
    if (!ssa && !fields.style && names.length) style = names[0];
    if (ssa && style === 'Default') style = '*Default';
    const layer = document.format === 'vtt' && !ssa ? index : fields.layer ?? 0;
    let text = cue.Text;
    if (document.format === 'vtt' && !ssa) {
      const tags = [...text.matchAll(/<c\.[a-z_.A-Z#\d-]+>/gu)];
      const selected = tags.length === 1 && text.startsWith('<c.') && text.endsWith('</c>')
        ? webStyles.find(rule => rule.selector === tags[0][0].slice(2, -1)) : null;
      if (selected) { style = selected.selector; text = text.slice(tags[0][0].length).replaceAll('</c>', ''); }
      else text = webVttAssText(text, webStyles);
    }
    return (fields.comment ? 'Comment: ' : 'Dialogue: ') + [ssa ? 'Marked=' + layer : layer,
      assTimestamp(cue.StartPositionTicks, !ssa), assTimestamp(cue.EndPositionTicks, !ssa), style, fields.actor || (ssa ? 'NTP' : ''),
      margin(fields.marginl), margin(fields.marginr), margin(fields.marginv), fields.effect ?? '', styledText(text)].join(',');
  });
  const footer = /\[(?:Fonts|Graphics|Aegisub Extradata)\](?:\r\n|\r|\n)/u.test(document.footer ?? '') ? eol + eol + document.footer : '';
  return (header + eol + rows.join(eol) + footer).trim() + eol;
}
