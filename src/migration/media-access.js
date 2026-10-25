import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseLosslessJson } from '../core/json.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';

const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const digest = /^[0-9a-f]{64}$/u;
const integer = /^(?:0|[1-9][0-9]*)$/u;
const stateAssetId = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const originalTextSubtitleCodecs = {
  ass: new Set(['ass']),
  srt: new Set(['srt', 'subrip']),
  // FFmpeg reports SSA files as the ASS codec; Jellyfin selects the parser from the external filename.
  ssa: new Set(['ass', 'ssa']),
  vtt: new Set(['vtt', 'webvtt']),
};
const fail = message => { throw new TypeError(`Invalid media access plan: ${message}`); };
const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('unknown or missing declaration object');
};
const pathApi = value => /^[A-Za-z]:[\\/]|^\\\\/u.test(value) ? path.win32 : path.posix;
const pathKey = value => {
  const api = pathApi(value); let normalized = api.normalize(value);
  if (normalized.length > api.parse(normalized).root.length) normalized = normalized.replace(/[\\/]+$/u, '');
  return api === path.win32 ? ordinalIgnoreCaseKey(normalized) : normalized;
};
function absolute(value) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value) || /(^|[\\/])\.\.?([\\/]|$)/u.test(value)
    || !pathApi(value).isAbsolute(value) || value.includes('://') || /^\/(?:[\\/])/u.test(value)) fail('identity paths must be absolute filesystem paths without traversal');
  if (pathApi(value) === path.win32 && !/^[A-Za-z]:[\\/]|^\\\\[^\\/]+[\\/][^\\/]+/u.test(value)) fail('Windows identities require a drive or UNC share');
  return value;
}
function contains(root, filename) {
  const api = pathApi(root), relative = api.relative(pathKey(root), pathKey(filename));
  return pathApi(filename) === api && relative && relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}
function originalTextSubtitleFormat(filename) {
  const extension = pathApi(filename).extname(filename).slice(1).toLowerCase();
  return originalTextSubtitleCodecs[extension] ? extension : undefined;
}
const movieType = 'MediaBrowser.Controller.Entities.Movies.Movie';

function changeExtension(filename, extension) {
  const api = pathApi(filename);
  const separator = api === path.win32 ? Math.max(filename.lastIndexOf('\\'), filename.lastIndexOf('/')) : filename.lastIndexOf('/');
  const dot = filename.lastIndexOf('.');
  return `${dot > separator ? filename.slice(0, dot) : filename}${extension}`;
}
function nativeNfoPaths(row) {
  const api = pathApi(row.Path);
  const paths = [];
  if (row.IsInMixedFolder === false && row.Type === movieType) paths.push(api.join(api.dirname(row.Path), 'movie.nfo'));
  paths.push(changeExtension(row.Path, '.nfo'));
  return paths.filter((candidate, index) => paths.findIndex(value => pathKey(value) === pathKey(candidate)) === index);
}
function nativeNfoPath(row, filename) {
  return nativeNfoPaths(row).some(candidate => pathKey(candidate) === pathKey(filename));
}
function expectation(value, requireRange = false) {
  keys(value, ['bytes', 'sha256', 'range']);
  if (typeof value.bytes !== 'string' || !integer.test(value.bytes) || BigInt(value.bytes) > 9223372036854775807n || !digest.test(value.sha256)) fail('byte counts and SHA-256 are required');
  if (requireRange && !value.range) fail('media requires an explicit range expectation');
  if (value.range) {
    keys(value.range, ['start', 'end', 'sha256']);
    if (![value.range.start, value.range.end].every(number => typeof number === 'string' && integer.test(number)) || !digest.test(value.range.sha256)
      || BigInt(value.range.start) > BigInt(value.range.end) || BigInt(value.range.end) >= BigInt(value.bytes)) fail('invalid byte range expectation');
  }
}

/** Validate declarations against current native rows. This performs no access and never verifies a migration. */
export async function validateMediaAccessPlan(plan, database) {
  keys(plan, ['scope', 'items']);
  if (plan.scope !== 'explicit-items' || !Array.isArray(plan.items)) fail('scope must be explicit-items with an items array');
  const seen = new Set(), references = [];
  for (const item of plan.items) {
    keys(item, ['itemId', 'identityPath', 'identityRoot', 'enumeration', 'read', 'expected', 'sidecars']);
    if (!guid.test(item.itemId ?? '') || seen.has(item.itemId.toLowerCase())) fail('invalid or duplicate item ID');
    seen.add(item.itemId.toLowerCase());
    absolute(item.identityPath); absolute(item.identityRoot);
    if (!contains(item.identityRoot, item.identityPath)) fail('media is outside its identity root');
    keys(item.enumeration, ['kind', 'root']); keys(item.read, ['kind']);
    if (item.enumeration.kind !== 'native-filesystem' || item.enumeration.root !== item.identityRoot || item.read.kind !== 'native-local-media-proxy') fail('unsupported enumeration or read scheme');
    expectation(item.expected, true);
    if (!Array.isArray(item.sidecars)) fail('sidecars must be explicit, including an empty array');
    const row = (await database.rows('BaseItems', { where: { Id: item.itemId } }))[0];
    if (!row || row.Id !== item.itemId || row.Path !== item.identityPath) fail('original item ID or Path differs from current native state');
    const data = row.Data ? parseLosslessJson(row.Data) : {};
    if (row.IsFolder || row.IsVirtualItem || !['Audio', 'Video'].includes(row.MediaType) || data.IsShortcut || data.VideoType && !['VideoFile', 0].includes(data.VideoType)) fail('only concrete filesystem audio/video files are supported');
    const streams = await database.rows('MediaStreamInfos', { where: { ItemId: item.itemId } });
    const sidecarPaths = new Set();
    for (const sidecar of item.sidecars) {
      if (sidecar?.kind === 'subtitle') keys(sidecar, ['kind', 'identityPath', 'streamIndex', 'read', 'expected']);
      else if (sidecar?.kind === 'nfo') keys(sidecar, ['kind', 'identityPath', 'read', 'expected', 'stateAssetId']);
      else fail('unsupported sidecar scheme');
      absolute(sidecar.identityPath); keys(sidecar.read, ['kind']); expectation(sidecar.expected);
      if (!contains(item.identityRoot, sidecar.identityPath) || sidecarPaths.has(pathKey(sidecar.identityPath)) || pathKey(sidecar.identityPath) === pathKey(item.identityPath)) fail('duplicate or out-of-root sidecar');
      sidecarPaths.add(pathKey(sidecar.identityPath));
      if (sidecar.kind === 'subtitle') {
        const format = originalTextSubtitleFormat(sidecar.identityPath);
        if (row.MediaType !== 'Video' || sidecar.read.kind !== 'native-subtitle-original' || !format
          || !Number.isInteger(sidecar.streamIndex) || sidecar.streamIndex < 0) fail('unsupported sidecar scheme');
        if (!streams.some(stream => stream.StreamType === 2 && stream.IsExternal && stream.StreamIndex === sidecar.streamIndex && pathKey(stream.Path) === pathKey(sidecar.identityPath)
          && originalTextSubtitleCodecs[format].has(stream.Codec?.toLowerCase()))) fail('subtitle is not the saved external stream');
      } else if (row.MediaType !== 'Video' || sidecar.read.kind !== 'native-filesystem-sidecar'
        || (sidecar.stateAssetId != null && !stateAssetId.test(sidecar.stateAssetId)) || !nativeNfoPath(row, sidecar.identityPath)) {
        fail('unsupported sidecar scheme');
      }
    }
    references.push({ itemId: row.Id, identityPath: row.Path, sidecars: item.sidecars.length });
  }
  return { declarationValid: true, accessVerified: false, scope: plan.scope, references };
}

async function readDigest(response, expected, signal) {
  const hash = createHash('sha256'); let bytes = 0n;
  try {
    for await (const chunk of response.body ?? []) {
      signal?.throwIfAborted(); bytes += BigInt(chunk.length);
      if (bytes > BigInt(expected.bytes)) throw new Error('Response exceeds the declared byte count');
      hash.update(chunk);
    }
    const sha256 = hash.digest('hex');
    return { bytes: bytes.toString(), sha256, matched: bytes === BigInt(expected.bytes) && sha256 === expected.sha256 };
  } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
}

async function readNativeFile(filename, root, expected, signal) {
  signal?.throwIfAborted();
  const before = await lstat(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Native sidecar is not a regular file');
  const [resolvedRoot, resolvedBefore] = await Promise.all([realpath(root), realpath(filename)]);
  if (!contains(resolvedRoot, resolvedBefore)) throw new Error('Native sidecar resolves outside its declared root');
  const handle = await open(filename, 'r');
  try {
    const [opened, afterOpen, resolvedAfterOpen] = await Promise.all([handle.stat({ bigint: true }), lstat(filename, { bigint: true }), realpath(filename)]);
    if (!opened.isFile() || !afterOpen.isFile() || afterOpen.isSymbolicLink()) throw new Error('Native sidecar is not a regular file');
    if (!contains(resolvedRoot, resolvedAfterOpen) || pathKey(resolvedBefore) !== pathKey(resolvedAfterOpen)) throw new Error('Native sidecar path changed or resolves outside its declared root');
    if (before.dev != null && before.ino != null && opened.dev != null && opened.ino != null
      && (before.dev !== opened.dev || before.ino !== opened.ino || opened.dev !== afterOpen.dev || opened.ino !== afterOpen.ino)) {
      throw new Error('Native sidecar identity changed while it was opened');
    }
    const hash = createHash('sha256'); let bytes = 0n, position = 0;
    for (;;) {
      signal?.throwIfAborted();
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead; bytes += BigInt(bytesRead);
      if (bytes > BigInt(expected.bytes)) throw new Error('Native sidecar exceeds the declared byte count');
      hash.update(buffer.subarray(0, bytesRead));
    }
    const [afterRead, pathAfterRead, resolvedAfterRead] = await Promise.all([handle.stat({ bigint: true }), lstat(filename, { bigint: true }), realpath(filename)]);
    if (!pathAfterRead.isFile() || pathAfterRead.isSymbolicLink() || !contains(resolvedRoot, resolvedAfterRead)
      || pathKey(resolvedAfterOpen) !== pathKey(resolvedAfterRead)) throw new Error('Native sidecar path changed during verification');
    if (opened.dev != null && opened.ino != null && (opened.dev !== afterRead.dev || opened.ino !== afterRead.ino
      || opened.dev !== pathAfterRead.dev || opened.ino !== pathAfterRead.ino)) throw new Error('Native sidecar identity changed during verification');
    const sha256 = hash.digest('hex');
    return { access: 'native-filesystem', regularFile: true, resolvedWithinRoot: true, bytes: bytes.toString(), sha256,
      matched: bytes === BigInt(expected.bytes) && sha256 === expected.sha256,
      verified: bytes === BigInt(expected.bytes) && sha256 === expected.sha256 };
  } finally { await handle.close(); }
}

async function requireFirstNativeNfoCandidate(filename, candidates, signal) {
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    if (pathKey(candidate) === pathKey(filename)) return;
    let metadata;
    try { metadata = await lstat(candidate, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // Jellyfin's DirectoryService.GetFile ignores directories. Other existing entries occupy the earlier candidate path.
    if (metadata.isDirectory()) continue;
    throw new Error(`Declared native NFO is shadowed by Jellyfin's earlier candidate: ${candidate}`);
  }
  throw new Error('Declared native NFO is not a Jellyfin NFO candidate');
}

/** Observe the supplied restored Jellyfin endpoint. Results apply only to the explicit paths at this time. */
export async function verifyNativeMediaAccess(plan, { database, baseUrl, accessToken, signal, timeoutMs = 30000 } = {}) {
  plan = structuredClone(plan);
  const declaration = await validateMediaAccessPlan(plan, database);
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new TypeError('An explicit Jellyfin HTTP origin is required');
  if (typeof accessToken !== 'string' || !accessToken || /[\r\n"]/u.test(accessToken)) throw new TypeError('A Jellyfin access token is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('A positive request timeout is required');
  const records = [], items = [];
  const call = async (route, headers = {}) => {
    signal?.throwIfAborted();
    const response = await fetch(new URL(route, base), { headers: { Authorization: `MediaBrowser Token="${accessToken}"`, ...headers }, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    records.push({ route, status: response.status, ...(headers.Range ? { range: headers.Range } : {}), contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'), contentRange: response.headers.get('content-range') });
    return response;
  };
  const observe = async work => { try { return await work(); } catch (error) { signal?.throwIfAborted(); return { verified: false, error: error.message }; } };
  const bytes = async (route, expected, range) => observe(async () => {
    const response = await call(route, range ? { Range: `bytes=${range.start}-${range.end}` } : {});
    const status = range ? 206 : 200;
    if (response.status !== status) { await response.body?.cancel(); return { verified: false, status: response.status }; }
    const actual = await readDigest(response, range ? { bytes: (BigInt(range.end) - BigInt(range.start) + 1n).toString(), sha256: range.sha256 } : expected, signal);
    const rangeMatched = !range || response.headers.get('content-range') === `bytes ${range.start}-${range.end}/${expected.bytes}`;
    return { ...actual, status, verified: actual.matched && rangeMatched };
  });
  const server = await observe(async () => { const response = await call('/System/Info'); if (!response.ok) { await response.body?.cancel(); throw new Error(`System/Info returned ${response.status}`); }
    const info = await response.json(); return { verified: true, Id: info.Id, Version: info.Version, ProductName: info.ProductName }; });
  for (const item of plan.items) {
    const id = item.itemId.replaceAll('-', '');
    const row = (await database.rows('BaseItems', { where: { Id: item.itemId } }))[0];
    const files = [item.identityPath, ...item.sidecars.map(sidecar => sidecar.identityPath)];
    const directories = new Map();
    for (const filename of files) {
      const api = pathApi(filename); let entry = filename, type = 'File';
      for (;;) {
        const directory = api.dirname(entry);
        const existing = directories.get(pathKey(directory)) ?? { directory, required: [] };
        existing.required.push({ path: entry, type }); directories.set(pathKey(directory), existing);
        if (pathKey(directory) === pathKey(item.identityRoot)) break;
        entry = directory; type = 'Directory';
      }
    }
    const enumeration = [];
    for (const { directory, required } of directories.values()) enumeration.push(await observe(async () => {
      const response = await call(`/Environment/DirectoryContents?path=${encodeURIComponent(directory)}&includeFiles=true&includeDirectories=true`);
      if (!response.ok) { await response.body?.cancel(); return { directory, verified: false, status: response.status }; }
      const entries = await response.json();
      return { directory, status: response.status, entries: entries.map(entry => ({ Name: entry.Name, Path: entry.Path, Type: entry.Type })),
        verified: required.every(expected => entries.some(entry => entry.Type === expected.type && pathKey(entry.Path) === pathKey(expected.path))) };
    }));
    const playbackInfo = await observe(async () => {
      const response = await call(`/Items/${id}/PlaybackInfo`);
      if (!response.ok) { await response.body?.cancel(); return { verified: false, status: response.status }; }
      const info = await response.json();
      const source = info.MediaSources?.find(source => source.Id.toLowerCase() === id.toLowerCase());
      return { verified: Boolean(source && source.Path === item.identityPath && source.Protocol === 'File'), status: response.status, body: info };
    });
    const original = await bytes(`/Items/${id}/File`, item.expected);
    const range = await bytes(`/Items/${id}/File`, item.expected, item.expected.range);
    const sidecars = [];
    for (const sidecar of item.sidecars) {
      if (sidecar.kind === 'nfo') {
        sidecars.push({ kind: sidecar.kind, identityPath: sidecar.identityPath, format: 'nfo',
          ...await observe(async () => {
            await requireFirstNativeNfoCandidate(sidecar.identityPath, nativeNfoPaths(row), signal);
            const result = await readNativeFile(sidecar.identityPath, item.identityRoot, sidecar.expected, signal);
            await requireFirstNativeNfoCandidate(sidecar.identityPath, nativeNfoPaths(row), signal);
            return result;
          }) });
      } else {
        const format = originalTextSubtitleFormat(sidecar.identityPath);
        sidecars.push({ kind: sidecar.kind, identityPath: sidecar.identityPath, format,
          ...await bytes(`/Videos/${id}/${id}/Subtitles/${sidecar.streamIndex}/Stream.${format}`, sidecar.expected) });
      }
    }
    items.push({ itemId: item.itemId, identityPath: item.identityPath, enumeration, playbackInfo, original, range, sidecars,
      verified: enumeration.every(result => result.verified) && playbackInfo.verified && original.verified && range.verified && sidecars.every(result => result.verified) });
  }
  return { checkedAt: new Date().toISOString(), origin: base.origin, scope: plan.scope, declaration, server, items, requests: records,
    declaredItemsVerified: plan.items.length > 0 && server.verified && items.every(item => item.verified), completeLibraryVerified: false,
    limitations: ['Only explicitly declared items, original-byte ASS, SSA, SRT/SubRip or VTT/WebVTT text subtitle routes, and declared native NFO files were checked.',
      'Graphical subtitles and subtitle conversion were not checked.', 'Endpoint identity is self-reported; binary provenance must be checked separately.',
      'NFO byte access is a direct native filesystem observation; parsed metadata must be checked through a real Jellyfin refresh.',
      'DirectoryContents uses the native filesystem; this does not run the full library scanner.', 'No write, deletion, decoding or client playback verification.'] };
}
