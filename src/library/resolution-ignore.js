import { checkAbort } from '../storage/errors.js';
import { repositoryTopParentId } from './records.js';

const ignoredLeafNames = Object.freeze(['small.jpg', 'albumart.jpg', 'thumbs.db']);

const ignoredTreeNames = Object.freeze([
  'metadata',
  'ps3_update',
  'ps3_vprm',
  'extrafanart',
  'extrathumbs',
  '.actors',
  '.wd_tv',
  'lost+found',
  'subs',
  '.snapshots',
  '.snapshot',
  'temprec',
  'tempsbe',
  'eadir',
  '@eadir',
  '#recycle',
  '@recycle',
  '.@__thumb',
  '$recycle.bin',
  'system volume information',
  '.grab',
  '.zfs'
]);

const extrasFolderNames = Object.freeze([
  'trailers',
  'backdrops',
  'theme-music',
  'behind the scenes',
  'deleted scenes',
  'interviews',
  'scenes',
  'samples',
  'shorts',
  'featurettes',
  'extras',
  'extra',
  'other',
  'clips'
]);

const audioFileExtensions = Object.freeze([
  '.669', '.3gp', '.aa', '.aac', '.aax', '.ac3', '.act', '.adp', '.adplug', '.adx', '.afc', '.amf',
  '.aif', '.aifc', '.aiff', '.alac', '.amr', '.ape', '.ast', '.au', '.awb', '.cda', '.cue', '.dmf',
  '.dsf', '.dsm', '.dsp', '.dts', '.dvf', '.eac3', '.ec3', '.far', '.flac', '.gdm', '.gsm', '.gym',
  '.hps', '.imf', '.it', '.m15', '.m4a', '.m4b', '.mac', '.med', '.mka', '.mmf', '.mod', '.mogg',
  '.mp2', '.mp3', '.mpa', '.mpc', '.mpp', '.mp+', '.msv', '.nmf', '.nsf', '.nsv', '.oga', '.ogg',
  '.okt', '.opus', '.pls', '.ra', '.rf64', '.rm', '.s3m', '.sfx', '.shn', '.sid', '.stm', '.strm',
  '.ult', '.uni', '.vox', '.wav', '.wma', '.wv', '.xm', '.xsp', '.ymf'
]);

export async function filterResolutionCandidates(candidates, { ignoreRule, signal, ...coreOptions }) {
  const result = [];
  for (const candidate of candidates) {
    checkAbort(signal);
    if (shouldIgnoreResolutionCandidate(candidate, coreOptions)) continue;
    const ignored = await ignoreRule.shouldIgnore(candidate.identityPath, { isDirectory: candidate.entry.kind === 'directory', signal });
    checkAbort(signal);
    if (ignored) continue;
    result.push(candidate);
  }
  return result;
}

function pathComponents(value) {
  if (typeof value !== 'string' || !value) return [];
  const windows = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(value);
  return (windows ? value.replaceAll('\\', '/') : value).split('/').filter(Boolean);
}

function sampleName(name, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^(?:${escaped}|.*\\.${escaped})\\.[^/]{1,5}$`, 'iu').test(name);
}

function itemType(item) {
  return String(item?.NativeType ?? item?.Type ?? item?.type ?? '').split('.').at(-1);
}

function sameItem(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.Id == null || right.Id == null) return false;
  return String(left.Id).replaceAll('-', '').toLowerCase() === String(right.Id).replaceAll('-', '').toLowerCase();
}

function sameId(left, right) {
  if (left == null || right == null) return false;
  return String(left).replaceAll('-', '').toLowerCase() === String(right).replaceAll('-', '').toLowerCase();
}

function isTopParent(parent, root) {
  return itemType(parent) === 'AggregateFolder'
    || parent?.IsTopParent === true
    || sameItem(parent, root) && (root?.IsTopParent === true || sameId(root?.Id, repositoryTopParentId(root)));
}

function isAudioFile(name) {
  if (typeof name !== 'string') return false;
  const dot = name.lastIndexOf('.');
  return dot >= 0 && audioFileExtensions.includes(name.slice(dot).toLowerCase());
}

/**
 * Implements the case-insensitive IgnorePatterns glob surface without doing I/O.
 * As in DotNet.Globbing, the generic hidden pattern applies to the final path
 * component only; named ignored directories and *.trickplay apply recursively.
 */
export function matchesCoreResolutionIgnorePattern(identityPath) {
  const components = pathComponents(identityPath);
  if (!components.length) return false;
  const folded = components.map(value => value.toLowerCase());
  const leaf = folded.at(-1);

  if (ignoredLeafNames.includes(leaf)) return true;
  if (sampleName(leaf, 'sample') || sampleName(leaf, 'minta')) return true;
  if (components.length >= 2
    && ['sample', 'minta'].includes(folded.at(-2))) return true;
  if (folded.some(value => ignoredTreeNames.includes(value))) return true;
  if (folded.some(value => value.endsWith('.trickplay'))) return true;
  if (leaf.startsWith('.')) return true;
  return leaf.endsWith('.bts') || leaf.endsWith('.sync');
}

/**
 * Decides whether a directory resolver candidate must be withheld from
 * resolution. The objects are observations only; this function never mutates
 * them and performs no filesystem or persistence access.
 */
export function shouldIgnoreResolutionCandidate(candidate, {
  parent = null,
  root = null,
  applicationRootPath = null
} = {}) {
  const identityPath = candidate?.identityPath;
  const entry = candidate?.entry;
  if (typeof identityPath !== 'string' || !entry || typeof entry.name !== 'string'
    || !['file', 'directory'].includes(entry.kind)) return false;

  // Jellyfin deliberately gives its own application folders precedence over
  // every global pattern, using case-sensitive substring containment.
  if (typeof applicationRootPath === 'string' && applicationRootPath
    && identityPath.includes(applicationRootPath)) return false;

  if (matchesCoreResolutionIgnorePattern(identityPath)) return true;
  if (parent == null) return false;

  if (entry.kind === 'directory') {
    if (isTopParent(parent, root)) return false;
    return extrasFolderNames.includes(entry.name.toLowerCase())
      && itemType(parent) !== 'UserRootFolder';
  }

  const dot = entry.name.lastIndexOf('.');
  const stem = dot < 0 ? entry.name : entry.name.slice(0, dot);
  return stem === 'theme' && isAudioFile(entry.name);
}
