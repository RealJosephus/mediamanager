import { availableParallelism } from 'node:os';
import { XMLValidator } from 'fast-xml-parser';
import model from './resources/configuration-model.json' with { type: 'json' };
import { XmlTokenCursor } from './xml-stream.js';
import { clrTrim } from '../metadata/whitespace.js';
import { wireGuid } from '../users/native.js';
import { networkConfigurationBaseUrl } from './network-configuration.js';

const xsi = 'http://www.w3.org/2001/XMLSchema-instance';
const xmlWhitespace = value => String(value).replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, '');
const invalid = message => { throw new Error('Invalid native configuration XML: ' + message); };
const characters = value => {
  if (!value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(value)) invalid('Invalid XML character.');
};

function encodingName(name) {
  const label = name.toLowerCase();
  if (['utf-8', 'utf8'].includes(label)) return 'utf-8';
  if (['utf-16', 'unicode', 'utf-16le'].includes(label)) return 'utf-16le';
  if (['utf-16be', 'unicodefffe'].includes(label)) return 'utf-16be';
  if (['utf-32', 'utf-32le'].includes(label)) return 'utf-32le';
  if (label === 'utf-32be') return 'utf-32be';
  if (['iso-8859-1', 'latin1', 'latin-1'].includes(label)) return 'latin1';
  if (['us-ascii', 'ascii'].includes(label)) return 'ascii';
  if (['utf-7', 'utf7'].includes(label)) invalid('Unsupported XML encoding.');
  try { return new TextDecoder(label).encoding; } catch { invalid('Unsupported XML encoding.'); }
}

function decodeConsumed(bytes, encoding, replacement = '\u0000') {
  let decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }); const output = [];
  for (const byte of bytes) {
    const input = Uint8Array.of(byte);
    try { output.push(decoder.decode(input, { stream: true })); }
    catch {
      output.push(replacement); decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
      try { output.push(decoder.decode(input, { stream: true })); } catch { decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }); }
    }
  }
  try { output.push(decoder.decode()); } catch { output.push(replacement); }
  return output.join('');
}

function decode(bytes, encoding, fatal = true) {
  if (encoding === 'utf-32le' || encoding === 'utf-32be') {
    let value = '';
    for (let index = 0; index + 4 <= bytes.length; index += 4) {
      const point = encoding === 'utf-32le' ? bytes.readUInt32LE(index) : bytes.readUInt32BE(index);
      value += point > 0x10ffff || point >= 0xd800 && point <= 0xdfff ? '\ufffd' : String.fromCodePoint(point);
    }
    return value + (bytes.length % 4 ? '\ufffd' : '');
  }
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const even = bytes.subarray(0, bytes.length - bytes.length % 2), data = encoding === 'utf-16be' ? Buffer.from(even).swap16() : even;
    return data.toString('utf16le') + (bytes.length % 2 ? '\u0000' : '');
  }
  if (encoding === 'latin1') return bytes.toString('latin1');
  if (encoding === 'ascii') return [...bytes].map(byte => byte < 128 ? String.fromCharCode(byte) : '?').join('');
  try { return new TextDecoder(encoding, { fatal, ignoreBOM: true }).decode(bytes); }
  catch { return decodeConsumed(bytes, encoding, encoding === 'gb18030' ? '?' : '\u0000'); }
}

export function decodeConfigurationXml(input) {
  const bytes = Buffer.from(input); let encoding = 'utf-8', offset = 0;
  const first = bytes.subarray(0, 4).toString('hex');
  if (first.startsWith('fffe0000')) { encoding = 'utf-32le'; offset = 4; }
  else if (first.startsWith('0000feff')) { encoding = 'utf-32be'; offset = 4; }
  else if (first.startsWith('efbbbf')) offset = 3;
  else if (first.startsWith('fffe')) { encoding = 'utf-16le'; offset = 2; }
  else if (first.startsWith('feff')) { encoding = 'utf-16be'; offset = 2; }
  else if (first.startsWith('3c000000')) encoding = 'utf-32le';
  else if (first.startsWith('0000003c')) encoding = 'utf-32be';
  else if (first.startsWith('3c00')) encoding = 'utf-16le';
  else if (first.startsWith('003c')) encoding = 'utf-16be';
  const probeLength = Math.min(bytes.length - offset, 4096), unit = encoding.startsWith('utf-32') ? 4 : encoding.startsWith('utf-16') ? 2 : 1;
  const probe = decode(bytes.subarray(offset, offset + probeLength - probeLength % unit), encoding, false);
  const declaration = /^<\?xml\s+([\s\S]*?)\?>/u.exec(probe);
  if (declaration) {
    const match = /^version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\4)?\s*$/u.exec(declaration[1]);
    if (!match) invalid('Invalid XML declaration.');
    if (match[3]) {
      let declared = encodingName(match[3]);
      if (match[3].toLowerCase() === 'utf-16') {
        if (!encoding.startsWith('utf-16')) invalid('A UTF-16 document requires a Unicode encoding signature.');
        declared = encoding;
      }
      encoding = declared;
    }
  }
  return decode(bytes.subarray(offset), encoding).replace(/\r\n?/gu, '\n');
}

class ConfigurationCursor extends XmlTokenCursor {
  readToken() {
    const before = this.position, token = super.readToken();
    characters(this.xml.slice(before, this.position));
    if (token.type === 'text') characters(token.value);
    if (token.type === 'start') {
      for (const match of this.xml.slice(before, this.position).matchAll(/([^\s"'=<>/]+)\s*=\s*(["'])([\s\S]*?)\2/gu)) {
        const normalized = match[3].replace(/[\t\n\r]/gu, ' ').replaceAll('"', '&quot;');
        token.attributes[match[1]] = new XmlTokenCursor('<v a="' + normalized + '"/>').readToken().attributes.a;
      }
      for (const value of Object.values(token.attributes)) characters(value);
    }
    return token;
  }
}

function qualifiedAttribute(node, name) {
  return Object.entries(node.attributes).find(([key]) => key.includes(':') && key.split(':')[1] === name && node.namespaces[key.split(':')[0]] === xsi)?.[1];
}
function isNil(node) {
  const value = qualifiedAttribute(node, 'nil');
  if (value === undefined) return false;
  const text = xmlWhitespace(value);
  if (!['true', 'false', '1', '0'].includes(text)) invalid('Invalid nullable marker.');
  return text === 'true' || text === '1';
}
function localName(node) { return node.name.includes(':') ? node.name.split(':')[1] : node.name; }
function namespace(node) { return node.namespaces[node.name.includes(':') ? node.name.split(':')[0] : ''] ?? ''; }
function scalar(node) {
  if (node.children.length) invalid('A scalar field contains nested elements.');
  return node.text;
}

export function parseConfigurationVersion(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length < 2 || parts.length > 4) return null;
  const numbers = parts.map(part => /^[ \t\n\v\f\r]*[+-]?\d+[ \t\n\v\f\r]*$/u.test(part) ? Number(part) : NaN);
  return numbers.every(number => Number.isInteger(number) && number >= 0 && number <= 2147483647) ? numbers.join('.') : null;
}

export function createConfigurationReader(model) {
function defaultConfiguration(root, { processors = availableParallelism() } = {}) {
  const descriptor = model.roots[root];
  if (!descriptor) throw new TypeError('Unknown configuration kind.');
  return defaults(descriptor.type.reference, processors);
}
function defaults(reference, processors) {
  const result = structuredClone(model.definitions[reference].defaults);
  if (reference === 'ServerConfiguration') result.CacheSize = processors * 100;
  if (reference === 'NetworkConfiguration') networkConfigurationBaseUrl(result);
  return result;
}

function number(node, type) {
  const text = xmlWhitespace(scalar(node));
  if (type.kind === 'integer') {
    if (!/^[+-]?\d+$/u.test(text)) invalid('Invalid configuration integer.');
    const value = BigInt(text), limit = 1n << BigInt(type.bits - (type.signed ? 1 : 0));
    if (value < (type.signed ? -limit : 0n) || value >= limit) invalid('Configuration integer is outside its range.');
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  }
  const special = { NaN: NaN, INF: Infinity, '-INF': -Infinity, Infinity: Infinity, '-Infinity': -Infinity };
  let value;
  if (/^[+-]?nan$/iu.test(text)) value = NaN;
  else if (/^[+-]?infinity$/iu.test(text)) value = text.startsWith('-') ? -Infinity : Infinity;
  else if (Object.hasOwn(special, text)) value = special[text];
  else {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text)) invalid('Invalid configuration number.');
    value = Number(text);
  }
  return type.single ? Math.fround(value) : value;
}
function assign(reference, object, name, value) {
  if (reference === 'ServerConfiguration' && name === 'PreviousVersionStr') {
    const parsed = parseConfigurationVersion(value);
    if (parsed != null) object.PreviousVersionStr = object.PreviousVersion = parsed;
    return;
  }

  object[name] = value;
}

function readValue(node, type, nullable, processors) {
  if (nullable && isNil(node)) return null;
  if (type.kind === 'string') return scalar(node);
  if (type.kind === 'boolean') {
    const text = xmlWhitespace(scalar(node)); if (!['true', 'false', '1', '0'].includes(text)) invalid('Invalid configuration Boolean.');
    return text === 'true' || text === '1';
  }
  if (type.kind === 'integer' || type.kind === 'number') return number(node, type);
  if (type.kind === 'guid') return wireGuid(scalar(node));
  if (type.kind === 'enum') {
    const text = scalar(node), member = type.members.find(member => member.xml === text);
    if (!member) invalid('Invalid configuration enumeration.'); return member.name;
  }
  if (type.kind === 'array') return node.children.filter(child => namespace(child) === '' && localName(child) === type.element)
    .map(child => readValue(child, type.item, type.nullableItem, processors));
  const definition = model.definitions[type.reference];
  const specifiedType = qualifiedAttribute(node, 'type');
  if (specifiedType) {
    const parts = specifiedType.split(':'), declared = parts.length === 2 ? node.namespaces[parts[0]] : node.namespaces[''] ?? '';
    if (parts.at(-1) !== definition.xmlType || declared !== '') invalid('Unexpected configuration object type.');
  }
  const result = defaults(type.reference, processors), seen = new Set();
  for (const child of node.children) {
    if (namespace(child) !== '') continue;
    const name = Object.keys(definition.fields).find(name => definition.fields[name].element === localName(child));
    if (!name) continue;
    const field = definition.fields[name];
    if (field.type.kind === 'array') { if (!isNil(child)) assign(type.reference, result, name, readValue(child, field.type, false, processors)); }
    else if (!seen.has(name)) {
      seen.add(name);
      if (field.type.kind === 'enum' && field.defaultValue != null && scalar(child) === '') continue;
      assign(type.reference, result, name, readValue(child, field.type, field.nullable, processors));
    }
  }
  return result;
}

function readConfigurationDocument(bytes, root, { processors = availableParallelism() } = {}) {
  const descriptor = model.roots[root]; if (!descriptor) throw new TypeError('Unknown configuration kind.');
  const xml = decodeConfigurationXml(bytes), cursor = new ConfigurationCursor(xml);
  let token;
  do { token = cursor.readToken(); } while (token.type === 'comment' || token.type === 'processing-instruction' || token.type === 'text' && /^[ \t\n]*$/u.test(token.value));
  if (token.type !== 'start') invalid('Missing configuration root.');
  const node = cursor.readNode(token), rootEnd = cursor.position;
  if (XMLValidator.validate(xml.slice(0, rootEnd)) !== true) invalid('Invalid XML structure.');
  if (localName(node) !== descriptor.element || namespace(node) !== '') invalid('Unexpected configuration root.');
  const result = readValue(node, descriptor.type, true, processors);
  const next = cursor.readToken();
  if (next.type === 'start' || next.type === 'end' || next.type === 'text' && !/^[ \t\n]*$/u.test(next.value)) invalid('Invalid content after the configuration root.');
  return { value: result, node };
}

function parseConfigurationXml(bytes, root, options) { return readConfigurationDocument(bytes, root, options).value; }

return { defaultConfiguration, readConfigurationDocument, parseConfigurationXml };
}
export const { defaultConfiguration, readConfigurationDocument, parseConfigurationXml } = createConfigurationReader(model);
