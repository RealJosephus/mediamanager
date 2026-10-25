import { readXml, escapeXml, escapeXmlAttribute } from '../core/xml.js';

const namespace = 'http://www.w3.org/ns/ttml';
const stylingNamespace = namespace + '#styling';
const alignmentRegions = ['bottomLeft', 'bottomCenter', 'bottomRight', 'centerLeft', 'center\u0421enter', 'centerRight', 'topLeft', 'topCenter', 'topRight'];
const localName = name => name.slice(name.indexOf(':') + 1);
const element = (name, attributes = {}, content = '') => '<' + name + Object.entries(attributes)
  .map(([name, value]) => ` ${name}="${escapeXmlAttribute(value)}"`).join('') + (content ? '>' + content + '</' + name + '>' : '/>');

function plainText(text) {
  let start = text.indexOf('{\\');
  const karaoke = text.indexOf('{Kara Effector');
  if (karaoke >= 0 && (start < 0 || karaoke < start)) start = karaoke;
  while (start >= 0) {
    const end = text.indexOf('}', start + 1);
    if (end < 0) break;
    text = text.slice(0, start) + text.slice(end + 1);
    start = text.indexOf('{', start);
  }
  return text.replace(/\\[Nn]/gu, '\r\n').replaceAll('\\h', ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/gu, '');
}

function inlineText(text) {
  text = text.replaceAll('<i><i>', '<i>').replaceAll('</i></i>', '</i>').replaceAll('</i> <i>', ' ');
  const opens = text.split('<i>').length - 1, closes = text.split('</i>').length - 1;
  if (opens === 1 && closes === 0) {
    const start = text.indexOf('<i>'), closing = text.indexOf('</', start);
    text = closing < 0 ? text + '</i>' : text.slice(0, closing) + '</i>' + text.slice(closing);
  } else if (opens === 0 && closes === 1) text = '<i>' + text;
  text = text.split(/\r\n|\r|\n/u).join('<br/>');
  try {
    const root = readXml('<root>' + text.replaceAll('&', '&amp;') + '</root>');
    const convert = node => node.content.map(part => {
      if (typeof part === 'string') return escapeXml(part);
      const content = convert(part), name = localName(part.name);
      if (name === 'br') return element('br', {}, content);
      const attributes = name === 'i' ? { 'tts:fontStyle': 'italic' } : name === 'b' ? { 'tts:fontWeight': 'bold' }
        : name === 'u' ? { 'tts:textDecoration': 'underline' } : name === 'font' ? Object.fromEntries([
          ['tts:fontFamily', part.attributes.face], ['tts:color', part.attributes.color]].filter(([, value]) => value !== undefined))
          : name.startsWith('bouten-') || name === 'horizontalDigit' || name.startsWith('ruby-') ? { style: name } : null;
      return attributes && content ? element('span', attributes, content) : content;
    }).join('');
    return convert(root);
  } catch {
    return escapeXml(text.replace(/[<>]/gu, ''));
  }
}

function seconds(ticks) {
  const negative = ticks < 0n;
  const milliseconds = ((negative ? -ticks : ticks) + 5000n) / 10000n;
  const fraction = String(milliseconds % 1000n).padStart(3, '0').replace(/0{1,2}$/u, '');
  return (negative ? '-' : '') + String(milliseconds / 1000n) + '.' + fraction + 's';
}

function styleColor(value) {
  let bgr;
  if (/^&?H[\da-f]{1,8}&?$/iu.test(value ?? '')) bgr = value.replace(/^&?H/iu, '').replace(/&$/u, '').slice(-6).padStart(6, '0');
  else if (/^[+-]?\d+$/u.test(value ?? '')) bgr = (Number(value) & 0xffffff).toString(16).padStart(6, '0');
  else return '#ffffff';
  return '#' + (bgr.slice(4, 6) + bgr.slice(2, 4) + bgr.slice(0, 2)).toLowerCase();
}

export function writeTtmlSubtitle(cues, styles = []) {
  const styleNodes = styles.length ? styles.map(style => element('style', { 'xml:id': style.name,
    'tts:fontFamily': style.fontname || 'Arial', 'tts:fontWeight': ['1', '-1'].includes(style.bold) ? 'bold' : 'normal',
    'tts:fontStyle': ['1', '-1'].includes(style.italic) ? 'italic' : 'normal', 'tts:color': styleColor(style.primarycolour),
    'tts:fontSize': style.fontsize || '20' })).join('') : element('style', { 'xml:id': 's0', 'tts:backgroundColor': 'black',
      'tts:fontStyle': 'normal', 'tts:fontSize': '16px', 'tts:fontFamily': 'sansSerif', 'tts:color': 'white' });
  const regions = [];
  for (const [column, textAlign] of [['Left', 'start'], ['Center', 'center'], ['Right', 'end']]) {
    for (const [row, origin, displayAlign] of [['top', '10% 10%', 'before'], ['center', '10% 30%', 'center'], ['bottom', '10% 50%', 'after']]) {
      regions.push(element('region', { 'tts:extent': '80% 40%', 'tts:origin': origin, 'tts:displayAlign': displayAlign,
        'tts:textAlign': textAlign, 'xml:id': row + column }));
    }
  }
  const paragraphs = cues.map((cue, index) => {
    const alignment = /^\{\\an([1-9])\}/u.exec(cue.Text)?.[1];
    const attributes = { begin: seconds(cue.StartPositionTicks), 'xml:id': 'p' + index, end: seconds(cue.EndPositionTicks) };
    if (alignment) attributes.region = alignmentRegions[Number(alignment) - 1];
    if (styles.some(style => style.name === cue.file?.style) && cue.file.style !== 's0') attributes.style = cue.file.style;
    return element('p', attributes, inlineText(plainText(cue.Text)));
  }).join('');
  const head = element('head', {}, element('metadata', {}, element('ttm:title')) + element('styling', {}, styleNodes) + element('layout', {}, regions.join('')));
  return '<?xml version="1.0" encoding="utf-8"?>\r\n' + element('tt', { xmlns: namespace,
    'xmlns:ttp': namespace + '#parameter', 'ttp:timeBase': 'media', 'xmlns:tts': stylingNamespace,
    'xml:lang': 'en', 'xmlns:ttm': namespace + '#metadata' }, head + element('body', { style: 's0' }, paragraphs ? element('div', {}, paragraphs) : ''));
}

