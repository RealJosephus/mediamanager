import * as fs from 'node:fs/promises';
import path from 'node:path';
import { EOL } from 'node:os';
import model from './resources/configuration-model.json' with { type: 'json' };
import { defaultConfiguration, readConfigurationDocument } from './configuration-xml.js';

const schemaInstance = 'http://www.w3.org/2001/XMLSchema-instance';
const xmlText = value => String(value).replace(/[&<>\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/gu, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character] ?? `&#x${character.codePointAt(0).toString(16).toUpperCase()};`);
const xmlAttribute = value => xmlText(value).replaceAll('"', '&quot;').replaceAll('\t', '&#x9;').replaceAll('\n', '&#xA;').replaceAll('\r', '&#xD;');
const local = node => node.name.split(':').at(-1);
const namespace = node => node.namespaces?.[node.name.includes(':') ? node.name.split(':')[0] : ''] ?? '';

export function createConfigurationWriter(model) {
function scalar(value, type) {
  if (type.kind === 'boolean') return value ? 'true' : 'false';
  if (type.kind === 'enum') {
    const member = type.members.find(member => member.name === value || member.value === value
      || typeof value === 'bigint' && BigInt(member.value) === value);
    if (!member) throw Object.assign(new RangeError(`Invalid ${type.name} configuration value.`), { code: 'invalid-configuration-value' });
    return member.xml;
  }
  if (type.kind === 'number') {
    if (Number.isNaN(value)) return 'NaN'; if (value === Infinity) return 'INF'; if (value === -Infinity) return '-INF';
    if (Object.is(value, -0)) return '-0';
    const exponent = Number(value.toExponential().split('e')[1]);
    if (exponent < -4 || exponent >= 17) {
      const [mantissa, power] = value.toExponential().split('e');
      return mantissa + 'E' + (power.startsWith('-') ? '-' : '+') + Math.abs(Number(power)).toString().padStart(2, '0');
    }
    return String(value);
  }
  return String(value);
}

function valueNode(name, value, type, nullable = false) {
  if (value == null) return nullable ? { name, attributes: { 'xsi:nil': 'true' }, content: [] } : null;
  if (type.kind === 'object') {
    const definition = model.definitions[type.reference], content = [];
    for (const fieldName of definition.order) {
      const field = definition.fields[fieldName];
      if (field.defaultValue != null && value[fieldName] === field.defaultValue) continue;
      const node = valueNode(field.element, value[fieldName], field.type, field.nullable);
      if (node) content.push(node);
    }
    return { name, attributes: {}, content };
  }
  if (type.kind === 'array') return { name, attributes: {}, content: value.map(value => valueNode(type.element, value, type.item, type.nullableItem)).filter(Boolean) };
  return { name, attributes: {}, scalar: { value, type } };
}

function* render(node, depth = 0, inherited = {}) {
  const scalarText = node.scalar && scalar(node.scalar.value, node.scalar.type);
  const content = node.scalar ? scalarText === '' ? [] : [scalarText] : node.content;
  const spacing = '  '.repeat(depth), attributes = { ...node.attributes };
  for (const [prefix, uri] of Object.entries(node.namespaces ?? {})) {
    if (prefix === 'xml' || inherited[prefix] === uri) continue;
    attributes[prefix === '' ? 'xmlns' : 'xmlns:' + prefix] ??= uri;
  }
  const namespaces = { ...inherited, ...Object.fromEntries(Object.entries(attributes).filter(([name]) => name === 'xmlns' || name.startsWith('xmlns:')).map(([name, value]) => [name === 'xmlns' ? '' : name.slice(6), value])) };
  const open = '<' + node.name + Object.entries(attributes).map(([name, value]) => ` ${name}="${xmlAttribute(value)}"`).join('');
  if (!content.length) { yield spacing + open + ' />'; return; }
  // Original unmodeled subtrees retain their own text, including the absence
  // of whitespace between children. Formatting must not add new content.
  const mixed = Array.isArray(node.children) || content.some(value => typeof value === 'string');
  yield spacing + open + '>';
  try {
    for (const child of content) {
      if (typeof child === 'string') yield xmlText(child);
      else { if (!mixed) yield EOL; yield* render(child, mixed ? 0 : depth + 1, namespaces); }
    }
  } finally {
    // A formatter failure still closes its already emitted containers. A file
    // write failure remains the caller's physical partial-file boundary.
    yield (mixed ? '' : EOL + spacing) + `</${node.name}>`;
  }
}

function preservedNode(original, current, type) {
  if (!original || !current) return current;
  const attributes = Object.fromEntries(Object.entries(original.attributes).filter(([name]) =>
    !(name.includes(':') && name.split(':')[1] === 'nil' && original.namespaces[name.split(':')[0]] === schemaInstance)));
  const node = { ...current, attributes: { ...attributes, ...current.attributes }, namespaces: original.namespaces };
  if (type.kind !== 'object' && type.kind !== 'array') return node;
  if (type.kind === 'array') {
    const items = original.children.filter(child => namespace(child) === '' && local(child) === type.element);
    let position = 0;
    node.content = original.content.filter(value => typeof value === 'string' ? value.trim() !== '' : namespace(value) !== '' || local(value) !== type.element);
    node.content.push(...current.content.map(child => preservedNode(items[position++], child, type.item)));
    return node;
  }
  const definition = model.definitions[type.reference], output = new Map(current.content.map(child => [local(child), child]));
  const known = new Map(Object.values(definition.fields).map(field => [field.element, field.type]));
  const lastArrays = new Map();
  for (const part of original.children) if (namespace(part) === '' && known.get(local(part))?.kind === 'array') {
    const nil = Object.entries(part.attributes).find(([name]) => name.includes(':') && name.split(':')[1] === 'nil' && part.namespaces[name.split(':')[0]] === schemaInstance)?.[1];
    if (!['true', '1'].includes(nil?.trim())) lastArrays.set(local(part), part);
  }
  const used = new Set(); node.content = [];
  for (const part of original.content) {
    if (typeof part === 'string') { if (part.trim() !== '') node.content.push(part); continue; }
    const name = local(part);
    if (namespace(part) !== '' || !known.has(name)) { node.content.push(part); continue; }
    if (!output.has(name)) continue;
    if (known.get(name).kind === 'array' && lastArrays.has(name) && lastArrays.get(name) !== part) { node.content.push(part); continue; }
    if (used.has(name)) { node.content.push(part); continue; }
    used.add(name); node.content.push(preservedNode(part, output.get(name), known.get(name)));
  }
  for (const child of current.content) if (!used.has(local(child))) node.content.push(child);
  // Retain unknown content while writing modeled values in their serialization
  // order, including the durable prefix of a formatter failure.
  const order = new Map(definition.order.map((name, index) => [definition.fields[name].element, index]));
  const modeled = node.content.filter(part => typeof part !== 'string' && namespace(part) === '' && known.has(local(part)))
    .sort((left, right) => order.get(local(left)) - order.get(local(right)));
  let position = 0;
  node.content = node.content.map(part => typeof part !== 'string' && namespace(part) === '' && known.has(local(part)) ? modeled[position++] : part);
  return node;
}

function* chunks(root, value, { source } = {}) {
  const definition = model.roots[root]; if (!definition) throw new TypeError('Unknown configuration kind.');
  if (value == null) throw new TypeError('A native configuration object is required.');
  let node = valueNode(definition.element, value, definition.type);
  node.attributes = { 'xmlns:xsi': schemaInstance, 'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema' };
  if (source) node = preservedNode(source, node, definition.type);
  yield '<?xml version="1.0" encoding="utf-8"?>' + EOL;
  yield* render(node);
}

function serializeConfiguration(root, value, options) { return Buffer.from([...chunks(root, value, options)].join('')); }
serializeConfiguration.chunks = chunks;
return serializeConfiguration;
}
export const serializeConfiguration = createConfigurationWriter(model);

export async function writeConfigurationFile(filename, root, value, { fileSystem = fs, source, writer = serializeConfiguration } = {}) {
  const file = await fileSystem.open(filename, 'w'), failures = [];
  try {
    for (const chunk of writer.chunks(root, value, { source })) {
      const bytes = Buffer.from(chunk);
      for (let offset = 0; offset < bytes.length;) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
        if (!bytesWritten) throw Object.assign(new Error('The configuration write made no progress.'), { code: 'EIO' });
        offset += bytesWritten;
      }
    }
  } catch (error) { failures.push(error); }
  try { await file.close(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw Object.assign(new AggregateError(failures, failures[0]?.message ?? 'Configuration save failed.', { cause: failures[0] }),
    Object.fromEntries(['code', 'status', 'statusCode'].filter(name => failures[0]?.[name] !== undefined).map(name => [name, failures[0][name]])));
}

export async function readConfigurationFile(filename, root, { fileSystem = fs, processors, reader = { readConfigurationDocument } } = {}) {
  return reader.readConfigurationDocument(await fileSystem.readFile(filename), root, { processors }).value;
}

export async function loadConfigurationFile(filename, root, { fileSystem = fs, onError = () => {}, processors, rewriteValid = true, reader = { readConfigurationDocument, defaultConfiguration }, serialize = serializeConfiguration } = {}) {
  let bytes, value, source, recovered = false;
  try {
    bytes = await fileSystem.readFile(filename);
    const document = reader.readConfigurationDocument(bytes, root, { processors }); value = document.value; source = document.node;
  } catch (error) {
    if (error.code !== 'ENOENT') onError(error);
    value = reader.defaultConfiguration(root, { processors });
    recovered = true;
  }
  if (!rewriteValid && !recovered) return value;
  const canonical = serialize(root, value);
  if (!bytes || !canonical.equals(bytes)) {
    let info;
    try { info = await fileSystem.stat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (process.platform === 'win32' && info?.isFile() && !(info.mode & 0o222)) throw Object.assign(new Error('Native configuration is read-only.'), { code: 'EACCES' });
    await fileSystem.mkdir(path.dirname(filename), { recursive: true });
    await fileSystem.writeFile(filename, serialize(root, value, { source }));
  }
  return value;
}
