import path from 'node:path';
import { detectNativeCharset } from '../core/native-charset.js';
import { decodeNativeText, decodeNativeTextEncoding } from '../core/native-text.js';
import { newNativeItemEntity } from '../library/native-item-entity.js';
import { nativeDirectoryName, nativeFileName } from '../library/native-path.js';
import { probeFileChanged } from '../storage/probe-lifecycle.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { child, readXml } from '../core/xml.js';
import { MetadataImageAssets } from './image-assets.js';
import { StorageError } from '../storage/errors.js';
import {parsePlaylistMemberRelation} from './playlist-member-source.js';
import {releaseNativeItemLinks} from '../library/native-item-entity.js';

const playlistNativeType = 'MediaBrowser.Controller.Playlists.Playlist';
export const playlistFileExtensions = Object.freeze(['.m3u', '.m3u8', '.pls', '.wpl', '.zpl']);
const supported = new Set(playlistFileExtensions);

const windowsPath = value => /^[A-Za-z]:[\\/]|^\\\\/u.test(value ?? '');
const pathApi = value => windowsPath(value) ? path.win32 : path.posix;

function extension(value) {
  const name = nativeFileName(value, { windows: windowsPath(value) });
  if (typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  return dot < 0 || dot === name.length - 1 ? '' : name.slice(dot);
}

function lines(value) {
  // StringSplitOptions.RemoveEmptyEntries runs before Select(Trim), so a line
  // containing only whitespace survives as an empty parsed entry.
  return value.split(/\r|\n/u).filter(line => line.length > 0).map(line => line.trim());
}

function decodeUrlPath(value) {
  const decoded = new URLSearchParams(`value=${value}`).get('value');
  return value.replaceAll('+', ' ') === decoded ? value : decoded;
}

export function parseM3uPlaylist(value) {
  const source = lines(value);
  if (!source.length) throw Object.assign(new RangeError('Index was out of range.'), { nativeException: 'ArgumentOutOfRangeException' });
  if (source[0] !== '#EXTM3U') return source.filter(line => !line.startsWith('#'));
  source.shift();
  if (source.some(line => /^#EXT-X-VERSION:\d$/u.test(line))) {
    throw Object.assign(new Error('Playlist appears to be a HLS playlist. Use the HLS parser instead.'), { nativeException: 'FormatException' });
  }
  const result = [];
  let custom = new Set();
  for (const line of source) {
    if (/^#EXTINF:(-?\d*),(.*)$/u.test(line) || /^#(EXTALB|EXTART):(.*)$/u.test(line)) continue;
    const property = /^#(EXT.*):(.*)$/u.exec(line);
    if (property) {
      if (custom.has(property[1])) throw Object.assign(new Error('An item with the same key has already been added.'), { nativeException: 'ArgumentException' });
      custom.add(property[1]); continue;
    }
    if (/^#(?!EXT)/u.test(line)) continue;
    result.push(decodeUrlPath(line));
    custom = new Set();
  }
  return result;
}

function plsNumber(line, prefix) {
  const equals = line.indexOf('=');
  if (equals < prefix.length) return -1;
  const value = line.slice(prefix.length, equals);
  return /^[+-]?\d+$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : -1;
}

export function parsePlsPlaylist(value) {
  const source = lines(value);
  if (!source.length || source[0] !== '[playlist]') return [];
  const entries = new Map();
  for (const line of source) {
    let prefix;
    if (line.startsWith('File')) prefix = 'File';
    else if (line.startsWith('Title')) prefix = 'Title';
    else if (line.startsWith('Length')) prefix = 'Length';
    else continue;
    const equals = line.indexOf('='), contents = line.slice(equals + 1);
    if (prefix === 'Title' && !contents) continue;
    const number = plsNumber(line, prefix);
    let entry = entries.get(number);
    if (!entry) entries.set(number, entry = { number, path: null });
    if (prefix === 'File') entry.path = contents;
  }
  return [...entries.values()].sort((left, right) => left.number - right.number).map(entry => entry.path);
}

function unescapePlaylistXml(value) {
  if (value == null) return value;
  return value.replaceAll('&amp;', '&').replaceAll('&apos;', "'").replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>').replaceAll('&lt;', '<');
}

const nullReference = () => { throw Object.assign(new TypeError('Object reference not set to an instance of an object.'), { nativeException: 'NullReferenceException' }); };

function readPlaylistXml(value) {
  // XDocument.Parse accepts internal entities. Keep that observable behavior
  // without enabling external entity resolution in the shared NFO parser.
  const declaration = /<!DOCTYPE\s+[^\s>]+\s*\[([\s\S]*?)\]\s*>/iu.exec(value);
  if (!declaration) return readXml(value);
  const entities = new Map();
  let remainder = declaration[1];
  const entity = /<!ENTITY\s+([A-Za-z_][\w.:-]*)\s+(?:"([^"]*)"|'([^']*)')\s*>/giu;
  remainder = remainder.replace(entity, (_, name, doubleQuoted, singleQuoted) => {
    entities.set(name, doubleQuoted ?? singleQuoted ?? ''); return '';
  });
  if (remainder.trim() || /\b(?:SYSTEM|PUBLIC)\b/iu.test(declaration[0])) throw new Error('Unsupported XML document type declaration.');
  let expanded = value.slice(0, declaration.index) + value.slice(declaration.index + declaration[0].length);
  for (let pass = 0; pass <= entities.size; pass++) {
    let changed = false;
    expanded = expanded.replace(/&([A-Za-z_][\w.:-]*);/gu, (match, name) => {
      if (!entities.has(name)) return match;
      changed = true; return entities.get(name);
    });
    if (!changed) break;
    if (expanded.length > 10_000_000) throw new Error('The XML entity expansion limit was exceeded.');
  }
  return readXml(expanded);
}

export function parseWplPlaylist(value) {
  const root = readPlaylistXml(value);
  if (root.name !== 'smil' || root.attributes.xmlns) return nullReference();
  if (!child(root, 'head')) return nullReference();
  const result = [];
  for (const body of root.children.filter(node => node.name === 'body')) {
    for (const sequence of body.children.filter(node => node.name === 'seq')) {
      for (const media of sequence.children.filter(node => node.name === 'media')) {
        result.push(unescapePlaylistXml(media.attributes.src));
      }
    }
  }
  return result;
}

export function decodePlaylistText(bytes, playlistExtension) {
  if (['.wpl', '.zpl'].includes(playlistExtension)) return decodeNativeText(bytes);
  const detected = detectNativeCharset(bytes, { stream: true }).details?.[0];
  const encoding = detected?.encoding && detected.confidence >= Math.fround(0.5) ? detected.encoding : 'utf-8';
  return decodeNativeTextEncoding(bytes, encoding);
}

export function parsePlaylist(bytes, playlistExtension) {
  const value = decodePlaylistText(bytes, playlistExtension);
  if (['.m3u', '.m3u8'].includes(playlistExtension)) return parseM3uPlaylist(value);
  if (playlistExtension === '.pls') return parsePlsPlaylist(value);
  if (['.wpl', '.zpl'].includes(playlistExtension)) return parseWplPlaylist(value);
  return [];
}

export function makeNativeAbsolutePath(folderPath, filePath) {
  if (filePath == null || String(filePath).trim() === '') return filePath;
  const windows = windowsPath(folderPath) || windowsPath(filePath), api = windows ? path.win32 : path.posix;
  if (api.isAbsolute(filePath) && (!windows || filePath[0] !== '\\')) return filePath;
  if (filePath.startsWith('\\\\')) return filePath;
  const relative = filePath[0] === '\\' ? filePath.slice(1) : filePath;
  try { return api.resolve(folderPath, relative); }
  catch { return filePath; }
}

async function resolvePlaylistPath(itemPath, playlistPath, roots, context) {
  let candidate = makeNativeAbsolutePath(nativeDirectoryName(playlistPath, { windows: windowsPath(playlistPath) }), itemPath);
  if (!await context.playlistFileExists(candidate)) {
    if (candidate == null) return nullReference();
    let found = false;
    for (const form of ['NFC', 'NFD']) {
      let normalized;
      try {
        if (candidate.normalize(form) === candidate) continue;
        normalized = candidate.normalize(form);
      } catch { return null; }
      if (await context.playlistFileExists(normalized)) { candidate = normalized; found = true; break; }
    }
    if (!found) return null;
  }
  const candidateKey = ordinalIgnoreCaseKey(candidate);
  if (!roots.some(root => candidateKey.startsWith(ordinalIgnoreCaseKey(root)))) return null;
  const found = await context.findMetadataItemByPath(candidate, null);
  return found ? { ItemId: found.Id, Type: 'Manual' } : null;
}

export function createPlaylistItemsPlugin({ fileSystem, vfs,linkedChildren,spoolRoot } = {}) {
  const media = () => { if (!vfs) throw new StorageError('unmapped-path', 'External playlist metadata requires mapped media storage.'); return vfs; };
  const localAssets = context => {
    if (!context.localRoot) throw new TypeError('State-local playlists require an authorized state root.');
    return new MetadataImageAssets({ fileSystem, stateRoots: [context.localRoot] });
  };
  const stat = (item, context) => context.localPath ? localAssets(context).stat(context.localPath)
    : media().stat(context.accessPath ?? item.Path);
  const getMetadata = async (item, context = {}) => {
    const resultItem = newNativeItemEntity(playlistNativeType);
    resultItem.Path = item.Path;
    const itemExtension = extension(item.Path).toLowerCase();
    if (!itemExtension) return { Item: resultItem, HasMetadata: false };
    const accessPath = context.accessPath ?? item.Path;
    let directory = false;
    try { directory = (await stat(item, context)).kind === 'directory'; }
    catch (error) { if (!['not-found', 'ENOENT', 'ENOTDIR'].includes(error.code)) directory = false; }
    if (directory || !supported.has(itemExtension)) return { Item: resultItem, HasMetadata: false };
    if (typeof context.playlistLibraryRoots !== 'function' || typeof context.playlistFileExists !== 'function'
      || typeof context.findMetadataItemByPath !== 'function') throw new TypeError('Playlist item metadata requires authoritative library path context.');
    const roots=await context.playlistLibraryRoots();
    const handle=await(context.localPath?localAssets(context).openRead(context.localPath):media().openRead(accessPath));
    try{return await linkedChildren.withSession(async session=>{
      const parsed=await parsePlaylistMemberRelation(handle.stream,{extension:itemExtension,linkedChildren,session,parentId:resultItem.Id,spoolRoot:context.spoolRoot??spoolRoot,fileSystem:context.fileSystem??fileSystem});
      const writer=await linkedChildren.createWriter({session,parentId:resultItem.Id});
      try{for await(const page of linkedChildren.pages(parsed,{session}))for(const row of page){const linked=await resolvePlaylistPath(row.Path,item.Path,roots,context);if(linked)await writer.append(linked);}
        const count=writer.count;if(count){resultItem.LinkedChildren=await writer.finish();return{Item:resultItem,HasMetadata:true};}await writer.abort();
      }catch(error){await writer.abort();releaseNativeItemLinks(resultItem);throw error;}finally{await linkedChildren.release(parsed,{session});}
      return{Item:resultItem,HasMetadata:false};
    });}finally{await handle.close();await linkedChildren.flushReleases();}
  };
  const provider = {
    id: 'PlaylistItemsProvider', name: 'Playlist Item Provider', kind: 'local', itemTypes: ['Playlist'],
    order: 100, forced: true, getMetadata,
    async hasChanged(item, context = {}) {
      if (!item.Path || !item.IsFileProtocol) return false;
      try {
        const info = await stat(item, context);
        return info.kind === 'file' && probeFileChanged(item, info.modified);
      } catch (error) { if (['not-found', 'ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
    }
  };
  return { id: 'playlist-items', name: 'Playlist Item Provider', providers: [provider], getMetadata };
}
