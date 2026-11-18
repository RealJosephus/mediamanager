import { decodeConfigurationXml } from '../core/configuration-xml.js';
import { XmlTokenCursor } from '../core/xml-stream.js';
import { escapeXml } from '../core/xml.js';

export function rebaseSystemConfiguration(bytes, paths) {
  const cursor = new XmlTokenCursor(decodeConfigurationXml(bytes));
  let root;
  do { root = cursor.readToken(); }
  while (root.type === 'comment' || root.type === 'text' || root.type === 'processing-instruction');
  if (root.type !== 'start') throw new Error('Missing server configuration root.');
  const namespaces = cursor.namespacesFor(root);
  const remaining = new Map(Object.entries(paths));
  let result = '', offset = 0;
  while (remaining.size) {
    const token = cursor.readToken();
    if (token.type === 'end' || token.type === 'eof') {
      throw new Error(`Missing configured Jellyfin path: ${remaining.keys().next().value}`);
    }
    if (token.type !== 'start') continue;
    const contentStart = cursor.position;
    const node = cursor.readNode(token, namespaces);
    if (!remaining.has(node.name) || node.namespaces['']) continue;
    if (token.empty || node.children.length) throw new Error(`Invalid configured Jellyfin path: ${node.name}`);
    result += cursor.xml.slice(offset, contentStart) + escapeXml(remaining.get(node.name)).replaceAll('\r', '&#xD;');
    offset = cursor.xml.lastIndexOf('</', cursor.position - 1);
    remaining.delete(node.name);
  }
  result += cursor.xml.slice(offset);
  result = result.replace(/^<\?xml\s[^?]*\?>/u, declaration =>
    declaration.replace(/(\sencoding\s*=\s*)(["'])[^"']+\2/u, '$1"utf-8"'));
  return Buffer.from(result, 'utf8');
}
