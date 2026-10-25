import colorNames from 'color-name';

const hexByte = value => value.toString(16).padStart(2, '0').toUpperCase();

function color(value) {
  value = value.toLowerCase();
  if (value === 'transparent') return [255, 255, 255, 0];
  if (Object.hasOwn(colorNames, value)) return [...colorNames[value], 255];
  let hex = /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/u.exec(value)?.[1];
  if (hex) {
    if (hex.length === 3) hex = [...hex].map(character => character + character).join('');
    return [0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16)).concat(hex.length === 8 ? Number.parseInt(hex.slice(6), 16) : 255);
  }
  const rgb = /^rgba?\(([^)]*)\)$/u.exec(value)?.[1].replaceAll(' ', '').split(',').filter(Boolean);
  if (!rgb || rgb.length < 3 || rgb.slice(0, 3).some(part => !/^[+-]?\d+$/u.test(part) || Number(part) < 0 || Number(part) > 255)) return null;
  const alpha = rgb.length === 4 && /^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(rgb[3]) ? Math.fround(Number(rgb[3])) : 1;
  return rgb.slice(0, 3).map(Number).concat(alpha >= 0 && alpha < 1 ? Math.trunc(Math.fround(alpha * 255)) : 255);
}

// Property values map directly to ASS file commands.
function commands(declarations) {
  const values = {};
  for (const declaration of declarations.split(';')) {
    const parts = declaration.split(':');
    if (parts.length !== 2) continue;
    const [name, value] = parts.map(part => part.trim());
    if (!value) continue;
    if (name === 'color' || name === 'background-color') {
      const parsed = color(value); if (parsed) values[name === 'color' ? 'c' : '3c'] = parsed;
    } else if (name === 'font-family') values.fn = value;
    else if (name === 'font-style' && ['italic', 'oblique', 'normal'].includes(value)) values.i = value === 'normal' ? 0 : 1;
    else if (name === 'font-weight' && ['bold', 'bolder', 'normal'].includes(value)) values.b = value === 'normal' ? 0 : 1;
    else if (name === 'text-decoration' && value === 'underline') values.u = 1;
    else if (name === 'text-decoration' && value === 'line-through') values.s = 1;
    else if (name === 'text-shadow') {
      const [shade, width, ...extra] = value.split(/\s/u), parsed = color(shade);
      const number = width?.replaceAll('px', '');
      if (!extra.length && parsed && /^[+-]?\d+$/u.test(number ?? '') && Number(number) >= -2147483648 && Number(number) <= 2147483647) {
        values['4c'] = parsed; values.shad = Number(number);
      }
    }
  }
  return values;
}

export function readWebVttStyles(header) {
  const rules = [];
  let active = false, current = '';
  const append = () => {
    const selector = /\(([.\w#-]+)\)/u.exec(current)?.[1];
    const body = /\{([ .\w:#\s,_;()\-]+)\}/u.exec(current)?.[1];
    if (selector && body?.trim()) rules.push({ selector, commands: commands(body) });
    current = '';
  };
  for (const line of header.split(/\r\n|\r|\n/u).map(line => line.trim())) {
    if (/^STYLE$/iu.test(line)) { append(); active = true; continue; }
    if (!active) continue;
    if (!line) { append(); active = false; continue; }
    if (line.startsWith('::cue(')) { append(); current = line; }
    else if (current) current += ' ' + line;
  }
  append();
  return rules;
}

export function assStyleColor(rgba) {
  return '&H' + [255 - rgba[3], rgba[2], rgba[1], rgba[0]].map(hexByte).join('');
}

export function assInlineStyle(values) {
  const output = [];
  for (const command of ['c', '3c', '4c', 'shad', 'fn', 'i', 'b', 'u']) {
    const value = values[command];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value[3] < 255) output.push('\\' + (command === 'c' ? 'alpha' : command[0] + 'a') + '&H' + hexByte(255 - value[3]) + '&');
      output.push('\\' + command + '&H' + [value[2], value[1], value[0]].map(hexByte).join(''));
    } else output.push('\\' + command + value);
  }
  return output.length ? '{' + output.join('') + '}' : '';
}
