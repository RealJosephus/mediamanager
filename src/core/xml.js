import { XMLParser, XMLValidator } from 'fast-xml-parser';

// Explicit XML-only entity table enables numeric references without enabling HTML entities.
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, parseAttributeValue: false, trimValues: false, ignoreDeclaration: true, ignorePiTags: true, processEntities: true,
  htmlEntities: { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } });

export class XmlError extends Error {
  constructor(message) { super(message); this.name = 'XmlError'; }
}

export function readXml(xml) {
  if (/<!DOCTYPE\b/i.test(xml)) throw new XmlError('DTD declarations are prohibited.');
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new XmlError(validation.err.msg);
  const convert = (entry, inheritedNamespaces = {}) => {
    const name = Object.keys(entry).find((key) => key !== ':@');
    const attributes = entry[':@'] ?? {};
    const namespaces = { ...inheritedNamespaces, ...Object.fromEntries(Object.entries(attributes).filter(([key]) => key === 'xmlns' || key.startsWith('xmlns:'))) };
    const content = entry[name].map((part) => Object.hasOwn(part, '#text') ? String(part['#text']) : convert(part, namespaces));
    return { name, attributes, namespaces, content, text: content.filter((part) => typeof part === 'string').join(''), children: content.filter((part) => typeof part !== 'string') };
  };
  const result = parser.parse(xml).filter((entry) => !Object.hasOwn(entry, '#text')).map((entry) => convert(entry));
  if (result.length !== 1) throw new XmlError('An XML document must have exactly one root element.');
  return result[0];
}

export const child = (node, name) => node.children.find((entry) => entry.name === name);
export const textOf = (node, name) => child(node, name)?.text;

export function escapeXml(value) {
  const text = String(value);
  if (/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/.test(text)) throw new XmlError('The value contains an invalid XML character.');
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export const escapeXmlAttribute = (value) => escapeXml(value).replaceAll('\n', '&#xA;').replaceAll('\r', '&#xD;').replaceAll('\t', '&#x9;');

export function xmlNode(node, subtreeRoot = true) {
  // XmlWriter.WriteNode preserves mixed-content ordering and carries namespace bindings
  // into the new document. A copied subtree cannot depend on the discarded original root.
  const bindings = subtreeRoot ? { ...node.namespaces, ...node.attributes } : node.attributes;
  const attributes = Object.entries(bindings).map(([name, value]) => ` ${name}="${escapeXmlAttribute(value)}"`).join('');
  const content = node.content.map((part) => typeof part === 'string' ? escapeXml(part) : xmlNode(part, false)).join('');
  return `<${node.name}${attributes}>${content}</${node.name}>`;
}
