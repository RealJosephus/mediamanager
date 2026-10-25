import { readXml } from '../../../../src/core/xml.js';

const namespace = 'http://www.w3.org/ns/ttml';
const localName = name => name.slice(name.indexOf(':') + 1);
const regionAlignments = { bottomLeft: 1, bottomRight: 3, centerLeft: 4, centerCenter: 5, centerRight: 6, topLeft: 7, topCenter: 8, topRight: 9 };

function timeTicks(value) {
  const offset = /^([+-]?)(\d+)(?:[.,](\d+))?(ms|s|t)$/u.exec(value);
  if (offset) {
    const units = { ms: 10000n, s: 10000000n, t: 1n }[offset[4]], precision = 10n ** BigInt(offset[3]?.length ?? 0);
    const result = BigInt(offset[2]) * units + BigInt(offset[3] ?? '0') * units / precision;
    return offset[1] === '-' ? -result : result;
  }
  const clock = /^(\d+):(\d+):(\d+)(?:[.,](\d+))?$/u.exec(value);
  if (!clock) throw new Error('The TTML writer timestamp is invalid.');
  return (BigInt(clock[1]) * 3600n + BigInt(clock[2]) * 60n + BigInt(clock[3])) * 10000000n + BigInt((clock[4] ?? '').padEnd(3, '0')) * 10000n;
}

/** Read generated TTML text through the existing XML reader. */
export function readTtmlSubtitle(text) {
  const root = readXml(text);
  const qualifiedNamespace = node => node.namespaces[node.name.includes(':') ? 'xmlns:' + node.name.split(':')[0] : 'xmlns'];
  if (qualifiedNamespace(root) !== namespace || localName(root.name) !== 'tt') throw new Error('The TTML writer namespace is invalid.');
  const descendants = function* (node, name) {
    for (const child of node.children) {
      if (qualifiedNamespace(child) === namespace && localName(child.name) === name) yield child;
      yield* descendants(child, name);
    }
  };
  const styles = new Map([...descendants(root, 'style')].map(style => [style.attributes['xml:id'] ?? style.attributes.id, style.attributes]));
  const content = (node, preserveSpace = false) => {
    preserveSpace = node.attributes['xml:space'] === 'preserve' || preserveSpace && node.attributes['xml:space'] !== 'default';
    return node.content.map(part => {
      if (typeof part === 'string') return preserveSpace || /\S/u.test(part) ? part : '';
      const name = localName(part.name);
      if (name === 'br') return '\r\n';
      if (name !== 'span') return '';
      const attributes = { ...styles.get(part.attributes.style), ...part.attributes };
      const tags = [];
      if (attributes['tts:fontStyle'] === 'italic') tags.push(['<i>', '</i>']);
      if (attributes['tts:fontWeight'] === 'bold') tags.push(['<b>', '</b>']);
      if (attributes['tts:textDecoration'] === 'underline') tags.push(['<u>', '</u>']);
      const face = attributes['tts:fontFamily'], color = attributes['tts:color'];
      if (face || color) tags.push(['<font' + (face ? ` face="${face}"` : '') + (color ? ` color="${color}"` : '') + '>', '</font>']);
      return tags.map(tag => tag[0]).join('') + content(part, preserveSpace) + tags.toReversed().map(tag => tag[1]).join('');
    }).join('');
  };
  const cues = [];
  for (const paragraph of descendants(root, 'p')) {
    const start = paragraph.attributes.begin ? timeTicks(paragraph.attributes.begin) : 0n;
    const end = paragraph.attributes.end ? timeTicks(paragraph.attributes.end) : start + (paragraph.attributes.dur ? timeTicks(paragraph.attributes.dur) : 30000000n);
    const alignment = regionAlignments[paragraph.attributes.region];
    const value = ((alignment ? `{\\an${alignment}}` : '') + content(paragraph)).trim().replace(/(?:\r\n){2,}/gu, '\r\n');
    cues.push({ Id: String(cues.length + 1), Text: value, StartPositionTicks: start, EndPositionTicks: end });
  }
  return { TrackEvents: cues };
}
