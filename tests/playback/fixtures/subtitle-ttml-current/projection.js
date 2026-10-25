import { readXml } from '../../../../src/core/xml.js';
import { stringifyNativeJson } from '../../../../src/core/json.js';
import { readTtmlSubtitle } from './read-generated.js';
import { convertSubtitle } from '../../../../src/playback/subtitles.js';
import { subtitleLayoutProjection } from '../../layout-projection.js';

export function generatedBodyProjection(text, format) {
  if (format !== 'ttml') return subtitleLayoutProjection(text, format);
  const qualified = (name, namespaces, attribute = false) => {
    const split = name.indexOf(':'), prefix = split < 0 ? '' : name.slice(0, split), local = name.slice(split + 1);
    const uri = prefix === 'xml' ? 'http://www.w3.org/XML/1998/namespace'
      : prefix ? namespaces['xmlns:' + prefix] ?? '' : attribute ? '' : namespaces.xmlns ?? '';
    return '{' + uri + '}' + local;
  };
  const project = (node, preserveSpace = false) => {
    preserveSpace = node.attributes['xml:space'] === 'preserve' || preserveSpace && node.attributes['xml:space'] !== 'default';
    return { name: qualified(node.name, node.namespaces), attributes: Object.fromEntries(Object.entries(node.attributes)
      .filter(([name]) => name !== 'xmlns' && !name.startsWith('xmlns:'))
      .map(([name, value]) => [qualified(name, node.namespaces, true), value])),
      content: node.content.filter(part => typeof part !== 'string' || preserveSpace || !node.children.length
        || !/^\s*$/u.test(part)).map(part => typeof part === 'string'
        ? part.replace(/\r\n|\r/gu, '\n') : project(part, preserveSpace)) };
  };
  return project(readXml(text));
}

export function readGeneratedBody(text, format) {
  return format === 'ttml' ? stringifyNativeJson(readTtmlSubtitle(text)) : convertSubtitle(text, format, 'json', { copyTimestamps: true });
}
