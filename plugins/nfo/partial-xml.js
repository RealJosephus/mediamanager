import { readXml, XmlError, escapeXml, escapeXmlAttribute } from '@mediamanager/plugin-sdk/core/xml';

const namePattern = /^[\p{L}_:][\p{L}\p{N}_.:\-\u00b7\p{M}]*$/u;
const invalid = message => new XmlError(message);
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace', declarationNamespace = 'http://www.w3.org/2000/xmlns/';
function textValue(text) {
  escapeXml(text);
  for (const match of text.matchAll(/&([^;\s<&]*);?/g)) {
    const complete = match[0].endsWith(';'), value = match[1];
    if (!complete || !/^(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+)$/.test(value)) throw invalid('Invalid XML entity.');
    if (value.startsWith('#') && parseInt(value.slice(value[1] === 'x' ? 2 : 1), value[1] === 'x' ? 16 : 10) > 0x10ffff) throw invalid('Invalid XML character reference.');
  }
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&([^;]+);/g, (_, value) => value[0] === '#'
    ? String.fromCodePoint(parseInt(value.slice(value[1] === 'x' ? 2 : 1), value[1] === 'x' ? 16 : 10)) : entities[value]);
}

// XmlReader yields nodes before a later XML error. WriteNode keeps those nodes.
export function readNfoSaveXml(input) {
  const xml = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let offset = 0, root = null, closed = false, error = null, phase = 'root';
  const stack = [];
  const addText = text => { if (stack.length) stack.at(-1).content.push(text); else if (text.trim()) throw invalid('Text outside XML root.'); };
  try {
    while (offset < xml.length) {
      if (xml[offset] !== '<') {
        const end = xml.indexOf('<', offset), last = end < 0 ? xml.length : end;
        const text = xml.slice(offset, last);
        if (!stack.length && !/^[\t\n ]*$/.test(text)) throw invalid('Text outside XML root.');
        if (text.includes(']]>')) throw invalid('Invalid XML text.');
        addText(textValue(text)); offset = last; continue;
      }
      if (xml.startsWith('<!--', offset)) {
        const end = xml.indexOf('-->', offset + 4);
        if (end < 0 || xml.slice(offset + 4, end).includes('--')) throw invalid('Invalid XML comment.');
        offset = end + 3; continue;
      }
      if (xml.startsWith('<?', offset)) {
        const end = xml.indexOf('?>', offset + 2); if (end < 0) throw invalid('Invalid XML processing instruction.');
        const target = /^<\?([^?\s]+)/.exec(xml.slice(offset, end + 2))?.[1];
        if (target?.toLowerCase() === 'xml' && (target !== 'xml' || offset !== 0)) throw invalid('Invalid XML declaration position.');
        offset = end + 2; continue;
      }
      if (xml.startsWith('<![CDATA[', offset)) {
        if (!stack.length) throw invalid('CDATA outside XML root.');
        const end = xml.indexOf(']]>', offset + 9); if (end < 0) throw invalid('Incomplete XML CDATA.');
        const value = xml.slice(offset + 9, end); escapeXml(value); stack.at(-1).content.push({ cdata: value }); offset = end + 3; continue;
      }
      if (xml.startsWith('<!', offset)) throw invalid('DTD declarations are prohibited.');
      if (xml.startsWith('</', offset)) {
        const end = xml.indexOf('>', offset + 2); if (end < 0) throw invalid('Incomplete XML end element.');
        const name = xml.slice(offset + 2, end).trim();
        if (!namePattern.test(name) || name !== stack.at(-1)?.name) throw invalid('Mismatched XML end element.');
        stack.pop(); if (!stack.length) closed = true;
        offset = end + 1; continue;
      }
      let end = offset + 1, quote = null;
      for (; end < xml.length; end++) {
        const char = xml[end];
        if (quote) { if (char === quote) quote = null; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === '>') break;
        else if (char === '<') throw invalid('Invalid XML start element.');
      }
      if (end === xml.length) throw invalid('Incomplete XML start element.');
      if (closed) throw invalid('Multiple XML roots.');
      const tag = xml.slice(offset, end + 1), empty = /\/\s*>$/.test(tag);
      const name = /^<([^\s/>]+)/.exec(tag)?.[1];
      if (!name || !namePattern.test(name) || name.split(':').length > 2) throw invalid('Invalid XML name.');
      const parent = stack.at(-1), namespaces = parent?.namespaces ?? {};
      const declarations = Object.entries(namespaces).map(([key, value]) => ' ' + key + '="' + escapeXml(value) + '"').join('');
      const parsed = readXml('<wrapper' + declarations + '>' + (empty ? tag : tag + '</' + name + '>') + '</wrapper>').children[0];
      for (const match of tag.matchAll(/\s([^\s=/>]+)\s*=\s*(["'])(.*?)\2/gs)) parsed.attributes[match[1]] = textValue(match[3].replace(/[\n\t]/g, ' '));
      parsed.namespaces = { ...namespaces, ...Object.fromEntries(Object.entries(parsed.attributes).filter(([key]) => key === 'xmlns' || key.startsWith('xmlns:'))) };
      for (const [key, value] of Object.entries(parsed.attributes).filter(([key]) => key === 'xmlns' || key.startsWith('xmlns:'))) {
        const prefix = key === 'xmlns' ? '' : key.slice(6);
        if (prefix === 'xmlns' || prefix === 'xml' && value !== xmlNamespace || prefix !== 'xml' && value === xmlNamespace
          || value === declarationNamespace || prefix && !value) throw invalid('Invalid XML namespace declaration.');
      }
      const checkName = qualified => {
        const parts = qualified.split(':');
        if (parts.length > 2 || !namePattern.test(qualified) || parts.length === 2 && parts[0] !== 'xml' && !parsed.namespaces['xmlns:' + parts[0]]) throw invalid('Invalid XML namespace prefix.');
        return parts.length === 2 ? (parts[0] === 'xml' ? xmlNamespace : parsed.namespaces['xmlns:' + parts[0]]) + '#' + parts[1] : '#' + qualified;
      };
      checkName(name);
      const expanded = new Set();
      for (const key of Object.keys(parsed.attributes).filter(key => key !== 'xmlns' && !key.startsWith('xmlns:'))) {
        const identity = checkName(key); if (expanded.has(identity)) throw invalid('Duplicate XML attribute.'); expanded.add(identity);
      }
      const node = { name, attributes: parsed.attributes, namespaces: parsed.namespaces, content: [], children: [], text: '' };
      if (parent) { parent.content.push(node); parent.children.push(node); }
      else { if (root) throw invalid('Multiple XML roots.'); root = node; phase = 'body'; }
      if (!empty) stack.push(node); else if (!parent) closed = true;
      offset = end + 1;
    }
    if (!root || stack.length) throw invalid('Incomplete XML document.');
  } catch (failure) { error = failure; }
  const finalize = node => {
    node.text = node.content.filter(part => typeof part === 'string' || Object.hasOwn(part, 'cdata')).map(part => typeof part === 'string' ? part : part.cdata).join('');
    node.children.forEach(finalize); return node;
  };
  return { root: root && finalize(root), error, phase };
}

const escaped = (value, attribute = false) => {
  try { return attribute ? escapeXmlAttribute(value) : escapeXml(value); }
  catch (error) { throw Object.assign(new TypeError(error.message), { nativeException: 'ArgumentException' }); }
};
export function writeNfoXmlNode(node, namespaces = {}, newLine = '\r\n') {
  const attributes = { ...node.attributes }, output = { ...namespaces, ...Object.fromEntries(Object.entries(attributes).filter(([key]) => key === 'xmlns' || key.startsWith('xmlns:'))) };
  const bind = (qualified, attribute = false) => {
    const parts = qualified.split(':'), prefix = parts.length === 2 ? parts[0] : '';
    if (attribute && !prefix || prefix === 'xml') return;
    const key = prefix ? 'xmlns:' + prefix : 'xmlns', value = node.namespaces[key] ?? '';
    if ((output[key] ?? '') !== value) { attributes[key] = value; output[key] = value; }
  };
  bind(node.name);
  for (const key of Object.keys(node.attributes).filter(key => key !== 'xmlns' && !key.startsWith('xmlns:'))) bind(key, true);
  const attributesText = Object.entries(attributes).map(([key, value]) => ' ' + key + '="' + escaped(value, true) + '"').join('');
  const content = node.content.map(part => typeof part === 'string' ? escaped(part).replace(/\r\n?|\n/g, newLine)
    : Object.hasOwn(part, 'cdata') ? '<![CDATA[' + part.cdata.replace(/\r\n?|\n/g, newLine) + ']]>' : writeNfoXmlNode(part, output, newLine)).join('');
  return content ? '<' + node.name + attributesText + '>' + content + '</' + node.name + '>' : '<' + node.name + attributesText + ' />';
}
