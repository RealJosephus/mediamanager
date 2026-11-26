import path from 'node:path';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { defaultLibraryOptions, deserializeLibraryOptions } from '../../library/options.js';
import { serializeLibraryOptions } from '../../library/library-options-store.js';
import { decodeConfigurationXml } from '../../core/configuration-xml.js';
import { escapeXml, escapeXmlAttribute } from '../../core/xml.js';
import { XmlTokenCursor } from '../../core/xml-stream.js';
import { assetInventory, directory as ordinaryDirectory, exists, inventory } from './files.js';
import { editObjectFields, itemTypes, jsonProperty, same } from './format.js';

const keys = [
  'EnableRealtimeMonitor',
  'EnableChapterImageExtraction',
  'ExtractChapterImagesDuringLibraryScan',
  'SaveLocalMetadata',
  'PreferredMetadataLanguage',
  'MetadataCountryCode',
  'MetadataSavers',
  'SubtitleDownloadLanguages',
  'EnableEmbeddedTitles',
  'SaveSubtitlesWithMedia',
];
export function commonLibraryOptions(value = {}) {
  return Object.fromEntries(keys.filter((k) => Object.hasOwn(value, k)).map((k) => [k, value[k]]));
}
export const libraryLocations = (options) => (options.PathInfos ?? [])
  .map(info => info?.Path).filter(value => typeof value === 'string' && value.length);

function retainedMembers(previous, values, write) {
  const byKey = new Map();
  for (const { key, raw } of previous) {
    if (key === undefined) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(raw);
  }
  return values.map(key => byKey.get(key)?.shift() ?? write(key));
}

export function editEmbyLibraryOptions(original, value, fields) {
  const current = original ? JSON.parse(original) : {};
  const edits = {};
  if (fields.includes('CollectionType') && current.ContentType !== value.CollectionType)
    edits.ContentType = value.CollectionType;
  if (fields.includes('Options')) for (const [key, option] of Object.entries(commonLibraryOptions(value.Options)))
    if (!same(current[key], option)) edits[key] = option;
  if (fields.includes('Locations') && !same(libraryLocations(current), value.Locations)) {
    edits.PathInfos = (raw, array) => {
      if (array && !array.items && array.value !== null) throw new Error('Expected a PathInfos array');
      const previous = (array?.items ?? []).map(node => {
        const key = jsonProperty(node, 'Path')?.value;
        return { key: typeof key === 'string' && key ? key : undefined, raw: raw.slice(node.start, node.end) };
      });
      const paths = retainedMembers(previous, value.Locations, Path => JSON.stringify({ Path }));
      const members = previous.map(member => member.key === undefined ? member.raw : paths.shift()).filter(Boolean);
      return '[' + [...members, ...paths].join(',') + ']';
    };
  }
  return editObjectFields(original, edits);
}

function xmlSpans(xml) {
  const cursor = new XmlTokenCursor(xml);
  function element(token, start, inherited) {
    const namespaces = cursor.namespacesFor(token, inherited);
    const node = { ...token, namespaces, start, contentStart: cursor.position, children: [], text: '' };
    while (!token.empty) {
      const offset = cursor.position;
      const current = cursor.readToken();
      cursor.validateLookahead(current, namespaces, token.name);
      if (current.type === 'end') {
        node.contentEnd = offset;
        break;
      }
      if (current.type === 'start') node.children.push(element(current, offset, namespaces));
      if (current.type === 'text') node.text += current.value;
    }
    node.end = cursor.position;
    node.contentEnd ??= node.end;
    return node;
  }
  for (;;) {
    const start = cursor.position, token = cursor.readToken();
    if (token.type === 'start') return element(token, start);
    if (token.type === 'eof') throw new Error('Missing LibraryOptions root');
  }
}
const xmlChildren = (node, name) => node.children.filter(entry => entry.name === name && !entry.namespaces['']);
function xmlChild(node, name) {
  const matches = xmlChildren(node, name);
  if (matches.length > 1) throw new Error('Ambiguous library XML element ' + name);
  return matches[0];
}
const xsi = 'http://www.w3.org/2001/XMLSchema-instance';
const nilAttribute = (node) => Object.keys(node.attributes).find(name => name.endsWith(':nil') &&
  node.namespaces[name.split(':')[0]] === xsi);
const text = value => escapeXml(value).replaceAll('\r', '&#xD;');
function replaceSpans(xml, spans) {
  for (const [start, end, value] of spans.sort((a, b) => b[0] - a[0]))
    xml = xml.slice(0, start) + value + xml.slice(end);
  return xml;
}
function withContents(xml, node, contents, nil = false) {
  const nilName = nilAttribute(node);
  if (!node.empty && !nilName && !nil)
    return xml.slice(node.start, node.contentStart) + contents + xml.slice(node.contentEnd, node.end);
  const attrs = Object.entries(node.attributes).filter(([key]) => key !== nilName);
  if (nil) {
    const prefix = Object.keys(node.namespaces).find(key => node.namespaces[key] === xsi && key);
    attrs.push(...(prefix ? [[prefix + ':nil', 'true']] : [['xmlns:xsi', xsi], ['xsi:nil', 'true']]));
  }
  const attributes = attrs.map(([key, value]) => ' ' + key + '="' + escapeXmlAttribute(value) + '"').join('');
  return '<' + node.name + attributes + '>' + contents + '</' + node.name + '>';
}
function xmlListContents(xml, node, values, childName, memberKey, write) {
  if (!node || node.empty) return (values ?? []).map(write).join('');
  const children = xmlChildren(node, childName).map(child => ({
    child, key: memberKey(child), raw: xml.slice(child.start, child.end),
  })).filter(entry => entry.key !== undefined);
  const next = retainedMembers(children, values ?? [], write);
  const spans = children.map(({ child }) => [child.start - node.contentStart, child.end - node.contentStart,
    next.shift() ?? '']);
  return replaceSpans(xml.slice(node.contentStart, node.contentEnd), spans) + next.join('');
}
export function editJellyfinLibraryOptions(bytes, value, fields) {
  if (!bytes) {
    const options = defaultLibraryOptions();
    if (fields.includes('Options')) Object.assign(options, commonLibraryOptions(value.Options));
    if (fields.includes('Locations')) options.PathInfos = value.Locations.map(Path => ({ Path }));
    const serialized = serializeLibraryOptions(options);
    if (serialized.failure) throw serialized.failure;
    return serialized.bytes;
  }
  const original = decodeConfigurationXml(bytes), root = xmlSpans(original);
  const current = deserializeLibraryOptions(original), edits = {};
  if (fields.includes('Options')) for (const [key, option] of Object.entries(commonLibraryOptions(value.Options)))
    if (!same(current[key], option)) edits[key] = option;
  if (fields.includes('Locations') && !same(libraryLocations(current), value.Locations))
    edits.PathInfos = value.Locations;
  if (!Object.keys(edits).length) return bytes;
  const added = [], spans = [];
  for (const [key, option] of Object.entries(edits)) {
    const node = xmlChild(root, key);
    const array = ['PathInfos', 'MetadataSavers', 'SubtitleDownloadLanguages'].includes(key);
    let contents;
    if (key === 'PathInfos') contents = xmlListContents(original, node, option, 'MediaPathInfo',
      child => xmlChild(child, 'Path')?.text || undefined,
      value => '<MediaPathInfo><Path>' + text(value) + '</Path></MediaPathInfo>');
    else if (array) contents = xmlListContents(original, node, option, 'string',
      child => ['true', '1'].includes(child.attributes[nilAttribute(child)]?.trim()) ? null : child.text,
      value => value == null ? '<string xmlns:xsi="' + xsi + '" xsi:nil="true"/>' : '<string>' + text(value) + '</string>');
    else contents = option == null ? '' : text(option);
    if (node) spans.push([node.start, node.end,
      option == null && !array ? '' : withContents(original, node, contents, option == null)]);
    else if (option != null) added.push('<' + key + '>' + contents + '</' + key + '>');
  }
  if (root.empty && added.length) spans.push([root.start, root.end, withContents(original, root, added.join(''))]);
  else if (added.length) spans.push([root.contentEnd, root.contentEnd, added.join('')]);
  const updated = replaceSpans(original, spans).replace(/^<\?xml\s[^?]*\?>/u, declaration =>
    declaration.replace(/(\sencoding\s*=\s*)(["'])[^"']+\2/u, '$1"utf-8"'));
  return Buffer.from(updated, 'utf8');
}
function libraryDirectoryName(folder) {
  const candidate = folder.Path ? path.win32.basename(folder.Path) : folder.Name;
  if (!candidate || candidate === '.' || candidate === '..' || /[\\/:]/u.test(candidate))
    throw new Error('Cannot identify the options directory for ' + folder.Name);
  return candidate;
}
const libraryConfigRoot = instance => path.join(instance, 'data', 'root', 'default');
const filename = (instance, folder) => path.join(libraryConfigRoot(instance), libraryDirectoryName(folder), 'options.xml');

export async function reconcileJellyfinLibraryRemovals(changes, instance, {
  sourceRows, targetRows, previousSource, previousTargetAssets, report,
}) {
  const deletions = new Set(changes.filter(({ value }) => !value).map(({ key }) => key));
  const libraries = new Map();
  for (const [key, row] of targetRows) {
    if (!key.startsWith('item/') || row.type !== itemTypes[4]) continue;
    const name = libraryDirectoryName(row);
    if (!libraries.has(name)) libraries.set(name, []);
    libraries.get(name).push(key);
  }
  const replacements = new Set(changes.filter(({ key, value }) => key.startsWith('item/') && value?.type === itemTypes[4])
    .map(({ value }) => libraryDirectoryName(value)));
  const baseline = assetInventory(previousTargetAssets);
  const excludedDirectories = new Set(), conflicts = new Set();
  for (const [name, keys] of libraries) {
    if (!keys.some(key => previousSource.get(key)?.type === itemTypes[4] && !sourceRows.has(key))) continue;
    // Stale source-side files cannot recreate a deleted library or remove
    // configuration from a library retained by the row reconciler.
    excludedDirectories.add(name);
    if (replacements.has(name) || keys.some(key => !deletions.has(key))) continue;
    const directory = path.join(libraryConfigRoot(instance), name);
    if (!await exists(directory)) continue;
    const prefix = name + '/';
    const current = (await lstat(directory)).isDirectory() ? await inventory(directory) : null;
    const beforeMembers = Object.keys(baseline.members).filter(member => member.startsWith(prefix));
    const beforeDirectories = new Set(baseline.directories.filter(member => member.startsWith(prefix)));
    if (!current || !baseline.directories.includes(name) || Object.keys(current.members).length !== beforeMembers.length
      || Object.entries(current.members).some(([member, hash]) => baseline.members[prefix + member] !== hash)
      || current.directories.length !== beforeDirectories.size
      || current.directories.some(member => !beforeDirectories.has(prefix + member))) {
      for (const key of keys) {
        conflicts.add(key);
        report('conflict', 'item', key.slice(5), 'deletion', 'target library configuration directory has edits');
      }
    } else await rm(await ordinaryDirectory(directory), { recursive: true });
  }
  return { changes: changes.filter(({ key, value }) => value || !conflicts.has(key)), excludedDirectories };
}

export async function readJellyfinLibraryOptions(view, instance) {
  for (const [key, row] of view.rows) {
    if (!key.startsWith('item/') || row.type !== itemTypes[4]) continue;
    const file = filename(instance, row);
    const options = (await exists(file))
      ? deserializeLibraryOptions(decodeConfigurationXml(await readFile(file)))
      : defaultLibraryOptions();
    row.Options = commonLibraryOptions(options);
    if (options.PathInfos?.length) row.Locations = libraryLocations(options);
  }
}
export async function writeJellyfinLibraryOptions(changes, instance, report) {
  for (const { key, value, fields } of changes) {
    if (
      !key.startsWith('item/') ||
      value?.type !== itemTypes[4] ||
      !fields.some((f) => ['Options', 'Locations'].includes(f))
    )
      continue;
    const file = filename(instance, value);
    const before = (await exists(file)) ? await readFile(file) : null;
    let bytes;
    try {
      bytes = editJellyfinLibraryOptions(before, value, fields);
    } catch (error) {
      report('conflict', 'item', key.slice(5), 'Options', error.message);
      continue;
    }
    if (bytes === before) continue;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes);
  }
}
