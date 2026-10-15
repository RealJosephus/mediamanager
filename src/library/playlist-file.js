import path from 'node:path';
import {randomUUID} from 'node:crypto';
import { nativeDirectoryName, nativeFileName, nativePlaylistIsFile } from './native-path.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { clrTrim } from '../metadata/whitespace.js';
import { StorageError, requireCapability } from '../storage/errors.js';

const extensions = new Set(['.m3u', '.m3u8', '.pls', '.wpl', '.zpl']);
const albumArtistTypes = new Set(['Audio', 'AudioBook', 'MusicAlbum']);
const artistTypes = new Set([...albumArtistTypes, 'MusicVideo']);
const windowsPath = value => process.platform === 'win32' || /^[A-Za-z]:|^\\\\/u.test(value ?? '');
const typeOf = item => String(item.Type ?? item.NativeType ?? '').split('.').at(-1);
const notEmpty = value => value != null && value !== '';

function nativeError(type, parameter = null) {
  return Object.assign(new Error(`Playlist file ${type}${parameter == null ? '' : `: ${parameter}`}`), {
    nativeException: type, parameter,
  });
}

function requireText(value, parameter) {
  if (value == null) throw nativeError('ArgumentNullException', parameter);
  if (value === '') throw nativeError('ArgumentException', parameter);
}

function unescapeUri(value) {
  // Uri.UnescapeDataString retains invalid percent escapes and malformed UTF-8.
  return value.replace(/(?:%[\da-f]{2})+/giu, sequence => {
    let decoded = '';
    for (let offset = 0; offset < sequence.length;) {
      const byte = Number.parseInt(sequence.slice(offset + 1, offset + 3), 16);
      const length = byte < 128 ? 1 : byte >= 0xc2 && byte <= 0xdf ? 2
        : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 0;
      if (length && offset + length * 3 <= sequence.length) {
        try {
          decoded += decodeURIComponent(sequence.slice(offset, offset + length * 3));
          offset += length * 3;
          continue;
        } catch { /* Retain only the malformed byte; later valid escapes still decode. */ }
      }
      decoded += sequence.slice(offset, offset + 3);
      offset += 3;
    }
    return decoded;
  });
}

function absoluteUri(value, windows) {
  try {
    const slashes = value.replaceAll('\\', '/');
    if (/^[A-Za-z]:\//u.test(slashes) || slashes.startsWith('//') || !windows && slashes.startsWith('/')) {
      // Implicit file paths preserve escapes for reserved ASCII characters.
      // Explicit file: URIs interpret those same escapes as URI syntax/data.
      const escaped = slashes.replace(/%([\da-f]{2})/giu, (escape, code) => {
        const byte = Number.parseInt(code, 16);
        return byte < 128 && byte !== 32 && !/^[A-Za-z\d._~-]$/u.test(String.fromCharCode(byte))
          ? `%25${code}` : escape;
      }).replaceAll('#', '%23').replaceAll('?', '%3F');
      const uri = new URL(slashes.startsWith('//') ? `file:${escaped}` : `file:///${escaped.replace(/^\//u, '')}`);
      return { uri, implicitFile: true };
    }
    if (!/^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)) throw new Error('Relative URI');
    if (/^(?:https?|ftp|wss?):/iu.test(value) && !/^[A-Za-z]+:\/\//u.test(value)) throw new Error('Invalid authority');
    return { uri: new URL(value), implicitFile: false };
  } catch { throw nativeError('UriFormatException'); }
}

/** Pinned PlaylistManager.NormalizeItemPath uses Uri.MakeRelativeUri, including
 * implicit file URI escapes, DOS drive handling and UNC authorities. */
export function normalizePlaylistItemPath(playlistPath, itemPath, { windows = windowsPath(playlistPath) } = {}) {
  let folder = nativeDirectoryName(playlistPath, { windows });
  requireText(folder, 'folderPath');
  requireText(itemPath, 'fileAbsolutePath');
  const separator = windows ? '\\' : '/';
  if (!folder.endsWith(separator)) folder += separator;
  const source = absoluteUri(folder, windows).uri;
  const target = absoluteUri(itemPath, windows).uri;
  if (source.protocol !== target.protocol) return itemPath;
  let relative;
  const file = target.protocol === 'file:';
  const sourceDrive = source.pathname.match(/^\/([A-Za-z]):\//u)?.[1];
  const targetDrive = target.pathname.match(/^\/([A-Za-z]):\//u)?.[1];
  if (source.host !== target.host || source.port !== target.port) relative = target.href;
  else if (file && sourceDrive && targetDrive && sourceDrive.toUpperCase() !== targetDrive.toUpperCase()) {
    relative = target.pathname.slice(1) + target.search + target.hash;
  } else {
    const sourceParts = source.pathname.split('/'), targetParts = target.pathname.split('/');
    let common = 0;
    const same = (left, right) => file && (sourceDrive || source.host)
      ? ordinalIgnoreCaseKey(unescapeUri(left)) === ordinalIgnoreCaseKey(unescapeUri(right)) : left === right;
    while (common < sourceParts.length && common < targetParts.length && same(sourceParts[common], targetParts[common])) common++;
    const parents = sourceParts.slice(common, -1).map(() => '..');
    relative = [...parents, ...targetParts.slice(common)].join('/') + target.search + target.hash;
  }
  relative = unescapeUri(relative);
  return file && windows ? relative.replaceAll('/', '\\') : relative;
}

export function playlistFileExtension(value) {
  const filename = nativeFileName(value ?? '') ?? '';
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
}

function firstArtist(item, property) {
  const values = item[property] === undefined ? [] : item[property];
  if (values == null) throw nativeError('NullReferenceException');
  return values.length ? values[0] : null;
}

function durationInt(ticks, divisor) {
  const number = Math.trunc(Number(ticks ?? 0) / divisor);
  return Math.max(-2147483648, Math.min(2147483647, number));
}

function xmlAttribute(value) {
  if (value == null) throw nativeError('ArgumentNullException', 'value');
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    if (!(code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0xd7ff
      || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) {
      throw nativeError('ArgumentException');
    }
  }
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll('\r', '&#xD;').replaceAll('\n', '&#xA;').replaceAll('\t', '&#x9;');
}

/** UTF-8 without BOM, native line endings and PlaylistsNET 1.4.1 field order. */
export function serializePlaylistFile(playlistPath, children, { windows = windowsPath(playlistPath) } = {}) {
  const extension = playlistFileExtension(playlistPath);
  if (!extensions.has(extension)) return null;
  if (children == null) throw nativeError('NullReferenceException');
  const eol = windows ? '\r\n' : '\n';
  const entries = children.map(item => {
    const itemPath = normalizePlaylistItemPath(playlistPath, item.Path, { windows });
    const type = typeOf(item);
    const albumArtist = extension !== '.pls' && albumArtistTypes.has(type) ? firstArtist(item, 'AlbumArtists') : null;
    const trackArtist = ['.wpl', '.zpl'].includes(extension) && artistTypes.has(type) ? firstArtist(item, 'Artists') : null;
    return { item, path: itemPath, albumArtist, trackArtist };
  });
  let text;
  if (extension === '.m3u' || extension === '.m3u8') {
    const lines = ['#EXTM3U'];
    for (const { item, path: itemPath, albumArtist } of entries) {
      if (notEmpty(item.Album)) lines.push(`#EXTALB:${item.Album}`);
      if (notEmpty(albumArtist)) lines.push(`#EXTART:${albumArtist}`);
      lines.push(`#EXTINF:${durationInt(item.RunTimeTicks, 10000000)},${item.Name ?? ''}`, itemPath);
    }
    text = clrTrim(lines.join(eol) + eol);
  } else if (extension === '.pls') {
    const lines = ['[playlist]', ''];
    for (const [index, { item, path: itemPath }] of entries.entries()) {
      const number = index + 1;
      lines.push(`File${number}=${itemPath}`);
      if (notEmpty(item.Name)) lines.push(`Title${number}=${item.Name}`);
      if (BigInt(item.RunTimeTicks ?? 0) !== 0n) lines.push(`Length${number}=${durationInt(item.RunTimeTicks, 10000000)}`);
      lines.push('');
    }
    text = [...lines, `NumberOfEntries=${entries.length}`, '', 'Version=2'].join(eol);
  } else {
    const lines = [`<?${extension.slice(1)} version="${extension === '.wpl' ? '1.0' : '2.0'}"?>`,
      '<smil>', '  <head>', '    <title />', '  </head>', '  <body>'];
    if (entries.length) {
      lines.push('    <seq>');
      for (const { item, path: itemPath, albumArtist, trackArtist } of entries) {
        const attributes = [['src', itemPath]];
        // The pinned library gates albumTitle by AlbumArtist, even when Album is null.
        if (notEmpty(albumArtist)) attributes.push(['albumTitle', item.Album], ['albumArtist', albumArtist]);
        if (notEmpty(item.Name)) attributes.push(['trackTitle', item.Name]);
        if (notEmpty(trackArtist)) attributes.push(['trackArtist', trackArtist]);
        if (BigInt(item.RunTimeTicks ?? 0) !== 0n) attributes.push(['duration', durationInt(item.RunTimeTicks, 10000)]);
        lines.push(`      <media ${attributes.map(([name, value]) => `${name}="${xmlAttribute(value)}"`).join(' ')} />`);
      }
      lines.push('    </seq>');
    } else lines.push('    <seq />');
    text = [...lines, '  </body>', '</smil>'].join(eol);
  }
  return Buffer.from(text, 'utf8');
}

export class PlaylistFileWriter {
  constructor({ fileSystem, vfs, identityMap,spoolRoot } = {}) { this.fileSystem = fileSystem; this.vfs = vfs; this.identityMap = identityMap;this.spoolRoot=spoolRoot; }

  async prepare(item) {
    if (!this.vfs || !this.identityMap) throw new StorageError('not-supported', 'External playlist access requires network storage.');
    const style = /^(?:[A-Za-z]:|\\\\)/u.test(item.Path ?? '') ? 'windows' : 'posix';
    const accessPath = this.identityMap.resolve({ itemId: item.Id, identityPath: item.Path, style });
    const resolved = this.vfs.resolve(accessPath);
    const info = await this.vfs.stat(accessPath).catch(error => {
      if (error.code === 'not-found') return null;
      throw error;
    });
    if (info?.kind === 'directory' || !nativePlaylistIsFile(item)) return { accessPath, identityPath: item.Path, metadataOnly: true };
    if (accessPath === resolved.mount.path || accessPath === '/') throw new StorageError('is-directory', 'The external playlist path is a storage root.');
    requireCapability(resolved, 'create');
    requireCapability(resolved, 'replace');
    return { accessPath, identityPath: item.Path };
  }

  async write(plan, children) {
    if (plan.metadataOnly) return;
    const prepared=await preparePlaylistFile(plan.identityPath,children,{spoolRoot:this.spoolRoot,fileSystem:this.fileSystem});
    if(!prepared)return;
    try{await this.vfs.write(plan.accessPath,prepared.stream(),{overwrite:true,size:prepared.size});}
    finally{await prepared.close();}
  }
}

/** The native formatter validates its whole captured selection before opening
 * the destination. A state-owned spool keeps that prefix without a member array. */
export async function preparePlaylistFile(playlistPath,cohort,{fileSystem,spoolRoot,windows=windowsPath(playlistPath)}={}) {
  const extension=playlistFileExtension(playlistPath);if(!extensions.has(extension))return null;
  if(cohort==null)throw nativeError('NullReferenceException');
  if(typeof cohort.page!=='function'||typeof cohort.count!=='function')throw new TypeError('Playlist file serialization requires a typed SQL cohort.');
  if(typeof spoolRoot!=='string'||!path.isAbsolute(spoolRoot))throw new TypeError('A state-owned playlist spool directory is required.');
  const filename=path.join(spoolRoot,`playlist-${randomUUID()}.tmp`),file=await fileSystem.open(filename,'wx');
  const eol=windows?'\r\n':'\n';let size=0n,closed=false,trailing='';
  const emit=async text=>{const bytes=Buffer.from(text);for(let offset=0;offset<bytes.length;){const written=await file.write(bytes,offset,bytes.length-offset);if(!written.bytesWritten)throw new Error('The playlist spool write made no progress.');offset+=written.bytesWritten;}size+=BigInt(bytes.length);};
  const text=async value=>{
    if(!['.m3u','.m3u8'].includes(extension))return emit(value);
    const combined=trailing+value,trimmed=combined.replace(/[\u0009-\u000D\u0085\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/u,'');
    trailing=combined.slice(trimmed.length);if(trimmed)await emit(trimmed);
  };
  try {
    const count=await cohort.count();
    if(extension==='.m3u'||extension==='.m3u8')await text('#EXTM3U'+eol);
    else if(extension==='.pls')await text('[playlist]'+eol+eol);
    else await text(`<?${extension.slice(1)} version="${extension==='.wpl'?'1.0':'2.0'}"?>`+eol+'<smil>'+eol+'  <head>'+eol+'    <title />'+eol+'  </head>'+eol+'  <body>'+eol+(count?'    <seq>':'    <seq />'));
    let index=0n;
    for(let after=0n;;){const page=await cohort.page({after,limit:128});try{
      if(!page.entries.length)break;
      for(const row of page.entries){const item=row.item,itemPath=normalizePlaylistItemPath(playlistPath,item.Path,{windows}),type=typeOf(item);
        const albumArtist=extension!=='.pls'&&albumArtistTypes.has(type)?firstArtist(item,'AlbumArtists'):null;
        const trackArtist=['.wpl','.zpl'].includes(extension)&&artistTypes.has(type)?firstArtist(item,'Artists'):null;++index;
        if(extension==='.m3u'||extension==='.m3u8'){
          if(notEmpty(item.Album))await text(`#EXTALB:${item.Album}`+eol);if(notEmpty(albumArtist))await text(`#EXTART:${albumArtist}`+eol);
          await text(`#EXTINF:${durationInt(item.RunTimeTicks,10000000)},${item.Name??''}`+eol+itemPath+eol);
        }else if(extension==='.pls'){
          await text(`File${index}=${itemPath}`+eol);if(notEmpty(item.Name))await text(`Title${index}=${item.Name}`+eol);
          if(BigInt(item.RunTimeTicks??0)!==0n)await text(`Length${index}=${durationInt(item.RunTimeTicks,10000000)}`+eol);await text(eol);
        }else{
          const attributes=[['src',itemPath]];if(notEmpty(albumArtist))attributes.push(['albumTitle',item.Album],['albumArtist',albumArtist]);
          if(notEmpty(item.Name))attributes.push(['trackTitle',item.Name]);if(notEmpty(trackArtist))attributes.push(['trackArtist',trackArtist]);
          if(BigInt(item.RunTimeTicks??0)!==0n)attributes.push(['duration',durationInt(item.RunTimeTicks,10000)]);
          await text(eol+`      <media ${attributes.map(([name,value])=>`${name}="${xmlAttribute(value)}"`).join(' ')} />`);
        }
      }after=page.entries.at(-1).Ordinal;
    }finally{await page.release();}}
    if(extension==='.pls')await text(`NumberOfEntries=${count}`+eol+eol+'Version=2');
    else if(['.wpl','.zpl'].includes(extension))await text((count?eol+'    </seq>':'')+eol+'  </body>'+eol+'</smil>');
    await file.close();closed=true;let disposed=false;
    return Object.freeze({size,stream:()=>{if(disposed)throw new Error('The playlist spool has been released.');return fileSystem.createReadStream(filename);},close:async()=>{if(disposed)return;disposed=true;await fileSystem.rm(filename,{force:true});}});
  }catch(error){if(!closed)await file.close();await fileSystem.rm(filename,{force:true});throw error;}
}
