import path from 'node:path';
import * as fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { md5Guid } from '@mediamanager/plugin-sdk/core/identity';
import { decodeNativeTextEncoding } from '@mediamanager/plugin-sdk/core/native-text';
import { XmlError } from '@mediamanager/plugin-sdk/core/xml';
import { clrTrim } from '@mediamanager/plugin-sdk/metadata/whitespace';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '@mediamanager/plugin-sdk/storage/ordinal-comparer';
import { dateTicks } from '@mediamanager/plugin-sdk/library/records';
import { hasXmlTvRoot, indexXmlTv } from './reader.js';
import { nativeXmlTvProgramEtag } from './program-etag.js';

const age = 3600000, timeoutMilliseconds = 900000;
const indexLimit = 8;
// Installed packages have distinct module URLs but can share an explicit cache root.
const activeTemporaryFiles = globalThis[Symbol.for('mediamanager.xmltv.temporaryFiles')] ??= new Set();
const defaults = { KidsCategories: ['kids', 'family', 'children', 'childrens', 'disney'],
  MovieCategories: ['movie'], NewsCategories: ['news', 'journalism', 'documentary', 'current affairs'],
  SportsCategories: ['sports', 'basketball', 'baseball', 'football'] };
const error = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const invalidXmlTvDocument = () => Object.assign(new XmlError('The downloaded XMLTV file has no tv root element.'), {
  code: 'invalid-xmltv-document'
});
const aborted = cause => cause?.code === 'ABORT_ERR' || ['AbortError', 'TimeoutError'].includes(cause?.name);
// The designated runtime's array FirstOrDefault returns the default for null
// icon/rating arrays, as observed through its actual listings provider.
const first = value => value?.[0];
const missingCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'not-found', 'not-directory', 'permission-denied', 'unmapped-path', 'invalid-path']);
const fileVersion = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs].join(':');

function xmlText(bytes, validateEncoding = true) {
  const value = Buffer.from(bytes);
  const utf32le = value.length >= 4 && (value[0] === 0xff && value[1] === 0xfe && value[2] === 0 && value[3] === 0
    || value[0] === 60 && value[1] === 0 && value[2] === 0 && value[3] === 0);
  const utf32be = value.length >= 4 && (value[0] === 0 && value[1] === 0 && value[2] === 0xfe && value[3] === 0xff
    || value[0] === 0 && value[1] === 0 && value[2] === 0 && value[3] === 60);
  let encoding = utf32le ? 'utf-32le' : utf32be ? 'utf-32be'
    : value[0] === 0xff && value[1] === 0xfe || value[0] === 60 && value[1] === 0 ? 'utf-16le'
      : value[0] === 0xfe && value[1] === 0xff || value[0] === 0 && value[1] === 60 ? 'utf-16be' : 'utf-8';
  const declaration = decodeNativeTextEncoding(value.subarray(0, Math.min(value.length, 1024)), encoding).match(/^\uFEFF?<\?xml\s+[^?]*encoding\s*=\s*['"]([^'"]+)['"]/u);
  if (declaration) encoding = declaration[1].toLowerCase();
  if (!validateEncoding) return decodeNativeTextEncoding(value, encoding);
  try {
    if (['utf-32', 'utf-32le', 'utf-32be'].includes(encoding)) {
      const littleEndian = utf32le || !utf32be && encoding !== 'utf-32be';
      const offset = value.length >= 4 && (value[0] === 0xff && value[1] === 0xfe || value[2] === 0xfe && value[3] === 0xff) ? 4 : 0;
      if ((value.length - offset) % 4) throw new Error('An XML UTF-32 code unit is incomplete.');
      for (let index = offset; index < value.length; index += 4) {
        const scalar = littleEndian ? value.readUInt32LE(index) : value.readUInt32BE(index);
        if (scalar > 0x10ffff || scalar >= 0xd800 && scalar <= 0xdfff) throw new Error('An XML UTF-32 scalar is invalid.');
      }
    } else if (/^utf-?(?:8|16(?:le|be)?)$/u.test(encoding)) {
      // XmlReader uses throwing decoders. StreamReader's replacement fallback
      // in the general text helper must not silently repair malformed XML.
      new TextDecoder(encoding, { fatal: true }).decode(value);
    }
    return decodeNativeTextEncoding(value, encoding);
  } catch (cause) { throw new XmlError('The XML byte encoding is invalid: ' + cause.message); }
}

export function xmlTvProgramInfo(program, supplied = {}) {
  const info = { ...defaults, ...supplied }, episode = program.Episode;
  const Genres = program.Categories.filter(value => clrTrim(value));
  const image = first(program.Icons)?.Source, rating = first(program.Ratings)?.Value;
  const episodeImage = program.Images?.find(value => value.Type === 'Still')?.Path;
  const backdrop = program.Images?.find(value => value.Type === 'Backdrop')?.Path;
  const result = { Id: program.ChannelId + '_' + program.StartDate.offsetDate, ChannelId: program.ChannelId,
    StartDate: program.StartDate.utc, EndDate: program.EndDate.utc, Name: program.Title, Overview: program.Description,
    EpisodeNumber: episode?.Episode ?? null, EpisodeTitle: episode?.Title ?? null, Genres,
    ProductionYear: program.CopyrightDate ? Number(program.CopyrightDate.offsetDate.slice(0, 4)) : null,
    SeasonNumber: episode?.Series ?? null, IsSeries: episode?.Episode != null,
    IsRepeat: program.IsPreviouslyShown && !program.IsNew, IsPremiere: program.Premiere !== null, IsLive: program.IsLive,
    IsKids: false, IsMovie: false, IsNews: false, IsSports: false, IsSubjectToBlackout: false, IsEducational: false,
    ImageUrl: image || null, HasImage: !!image, BackdropImageUrl: backdrop || null, ThumbImageUrl: episodeImage || null,
    OfficialRating: rating || null, CommunityRating: program.StarRatings?.[0]?.StarRating == null ? null : Math.fround(program.StarRatings[0].StarRating),
    SeriesId: episode?.Episode == null || program.Title === null ? null : md5Guid(program.Title),
    ProviderIds: {}, SeriesProviderIds: {} };
  for (const name of ['Kids', 'Movie', 'News', 'Sports']) {
    const categories = info[name + 'Categories'];
    if (categories === null && Genres.length) throw new TypeError("Value cannot be null. (Parameter 'source')");
    result['Is' + name] = Genres.some(genre => categories.some(value => ordinalIgnoreCaseEquals(genre, value)));
  }
  if (!program.ProgramId || !clrTrim(program.ProgramId)) {
    let unique = (program.Title ?? '') + (episode?.Title ?? '');
    if (result.SeasonNumber !== null) unique = '-' + result.SeasonNumber;
    if (result.EpisodeNumber !== null) unique = '-' + result.EpisodeNumber;
    result.ShowId = md5Guid(unique);
    if (result.IsSeries && !result.IsRepeat && (result.EpisodeNumber ?? 0) === 0) result.ShowId += String(dateTicks(result.StartDate));
  } else result.ShowId = program.ProgramId;
  if (result.IsMovie) { result.IsSeries = false; result.EpisodeNumber = null; result.EpisodeTitle = null; }
  const fingerprint = nativeXmlTvProgramEtag(result); if (fingerprint.etag !== null) result.Etag = fingerprint.etag;
  return result;
}

export function xmlTvCacheFile(root, id) {
  const identity = id ?? '';
  if (!path.isAbsolute(root) || typeof identity !== 'string' || /[\\/:\0]/u.test(identity)) {
    throw error('invalid-path', 'The XMLTV cache identity must name an owned child file.');
  }
  return path.join(root, identity + '.xml');
}

/** XMLTV listings with owned cache files and mapped local source access. */
export function createXmlTvListingsProvider(pathOptions = {}) {
  const { source, preferredMetadataLanguage = 'en', fetch: fetchImpl = globalThis.fetch,
    fileSystem = fs, now = Date.now, logger = {}, downloadTimeoutMs = timeoutMilliseconds } = pathOptions;
  const getCachePath = () => {
    const cachePath = pathOptions.cachePath;
    if (typeof cachePath !== 'string' || !path.isAbsolute(cachePath)) throw new TypeError('XMLTV requires an absolute owned cache directory.');
    return cachePath;
  };
  getCachePath();
  const failures = new Map(), indexes = new Map(), lifetime = new AbortController(), work = new Set();
  let closing;
  const report = cause => { try { void Promise.resolve(logger.error?.(cause)).catch(() => {}); } catch { /* Diagnostics do not replace I/O. */ } };
  const exists = async filename => {
    try { const stat = await fileSystem.stat(filename, { bigint: true }); return stat.isFile() ? stat : null; }
    catch (cause) { if (missingCodes.has(cause.code)) return null; throw cause; }
  };
  const removeTemp = async filename => { try { await fileSystem.unlink(filename); } catch (cause) { if (cause.code !== 'ENOENT') report(cause); } };
  const invoke = operation => {
    if (lifetime.signal.aborted) return Promise.reject(Object.assign(new Error('The XMLTV provider is closing.'), { status: 503 }));
    const pending = Promise.resolve().then(operation); work.add(pending);
    const finished = () => work.delete(pending); pending.then(finished, finished); return pending;
  };
  const optionsSignal = signal => signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  const language = info => info.PreferredLanguage && clrTrim(info.PreferredLanguage) ? info.PreferredLanguage
    : typeof preferredMetadataLanguage === 'function' ? preferredMetadataLanguage() : preferredMetadataLanguage;
  const getXml = async (info, signal, rejectedVersion) => {
    const cacheRoot = path.resolve(getCachePath());
    const filename = xmlTvCacheFile(cacheRoot, info.Id);
    const existing = await exists(filename), current = now();
    const cached = existing && fileVersion(existing) !== rejectedVersion ? existing : null;
    const loadedFile = (stat, index) => ({ filename, version: fileVersion(stat), index });
    if (cached && Number(cached.mtimeMs) >= current - age) return loadedFile(cached);
    if (info.Path === null || info.Path === undefined) throw new TypeError('The XMLTV path is null.');
    const remote = /^http/iu.test(info.Path), failed = failures.get(info.Path);
    if (remote && failed !== undefined && current - failed < age) {
      if (cached) return loadedFile(cached);
      throw error('download-backoff', 'Skipping the XMLTV download after a recent failure: ' + info.Path);
    }
    await fileSystem.mkdir(cacheRoot, { recursive: true });
    const physicalRoot = await fileSystem.realpath(cacheRoot), temporary = filename + '.tmp';
    const physicalTemporary = path.join(physicalRoot, path.basename(temporary));
    const temporaryIdentity = process.platform === 'win32' ? ordinalIgnoreCaseKey(physicalTemporary) : physicalTemporary;
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), downloadTimeoutMs);
    timer.unref?.();
    const downloadSignal = AbortSignal.any([signal, timeout.signal]);
    let handle, input, sourceHandle, response, ownsTemporary = false;
    try {
      let original = info.Path;
      if (remote) {
        response = await fetchImpl(info.Path, { signal: downloadSignal });
        if (!response.ok) throw Object.assign(error('http-error', 'Response status code does not indicate success: ' + response.status + '.'), { httpStatus: response.status });
        original = response.url || info.Path; input = response.body;
      } else {
        if (!source?.openRead) throw Object.assign(new Error('The XMLTV source has no mapped storage access.'), { code: 'unmapped-path' });
        sourceHandle = await source.openRead(info.Path, { signal: downloadSignal }); input = sourceHandle.stream;
      }
      if (activeTemporaryFiles.has(temporaryIdentity)) throw error('EBUSY', 'The XMLTV temporary file is already in use.');
      activeTemporaryFiles.add(temporaryIdentity); ownsTemporary = true;
      handle = await fileSystem.open(temporary, 'w');
      const compressed = ['.gz', '.gzip'].includes(path.extname(original.split('?')[0]).toLowerCase());
      if (compressed) {
        await pipeline(Readable.from(input), createGunzip(), async stream => {
          for await (const chunk of stream) await handle.writeFile(chunk);
        }, { signal: downloadSignal });
      } else for await (const chunk of input) { downloadSignal.throwIfAborted(); await handle.writeFile(chunk); }
      await handle.close(); handle = undefined;
      const downloaded = await exists(temporary);
      if (!downloaded?.size) throw error('empty-download', 'Downloaded XMLTV file is empty: ' + info.Path);
      const bytes = await fileSystem.readFile(temporary, { signal: downloadSignal });
      let index;
      try { index = indexXmlTv(xmlText(bytes), downloadSignal); }
      catch (cause) {
        if (compressed || cached || !(cause instanceof XmlError)) throw cause;
        // Native can publish an incomplete plain XMLTV document on a cold
        // cache. Keep that behavior when its XMLTV root was actually read.
        if (!hasXmlTvRoot(xmlText(bytes, false))) throw invalidXmlTvDocument();
      }
      if (index && !index.hasTvRoot) throw invalidXmlTvDocument();
      if (sourceHandle) { const closingSource = sourceHandle; sourceHandle = undefined; await closingSource.close(); }
      downloadSignal.throwIfAborted();
      await fileSystem.rename(temporary, filename);
      const published = await exists(filename);
      if (!published) throw error('ENOENT', 'The published XMLTV file is unavailable.');
      failures.delete(info.Path);
      return loadedFile(published, index);
    } catch (cause) {
      if (handle) { try { await handle.close(); } catch (closeError) { report(closeError); } handle = undefined; }
      // Cleanup owns the path until unlink completes, so a writer admitted
      // during that await cannot lose its newly opened temporary file.
      if (!ownsTemporary && !activeTemporaryFiles.has(temporaryIdentity)) {
        activeTemporaryFiles.add(temporaryIdentity); ownsTemporary = true;
      }
      if (ownsTemporary) await removeTemp(temporary);
      if (signal.aborted) throw signal.reason ?? cause;
      if (cached || cause.code !== 'invalid-xmltv-document') failures.set(info.Path, now());
      report(cause);
      const retained = await exists(filename);
      if (retained && fileVersion(retained) !== rejectedVersion) return loadedFile(retained);
      if (timeout.signal.aborted || aborted(cause)) {
        throw error('ETIMEDOUT', 'Timed out downloading the XMLTV file from ' + info.Path, cause);
      }
      throw cause;
    } finally {
      clearTimeout(timer);
      if (ownsTemporary) activeTemporaryFiles.delete(temporaryIdentity);
      try { await sourceHandle?.close(); } finally { try { await response?.body?.cancel(); } catch { /* A consumed body is already released. */ } }
    }
  };
  const loadVersion = async ({ filename, version, index }, signal) => {
    signal.throwIfAborted();
    let entry = indexes.get(filename);
    if (entry?.version !== version) {
      const controller = new AbortController();
      const owned = optionsSignal(controller.signal);
      entry = { version, controller, readers: 0, settled: Boolean(index),
        pending: index ? Promise.resolve(index) : invoke(async () => {
          const bytes = await fileSystem.readFile(filename, { signal: owned });
          owned.throwIfAborted();
          return indexXmlTv(xmlText(bytes), owned);
        }) };
      entry.pending.then(() => { entry.settled = true; }, () => {
        entry.settled = true;
        if (indexes.get(filename) === entry) indexes.delete(filename);
      });
    }
    indexes.delete(filename);
    indexes.set(filename, entry);
    if (indexes.size > indexLimit) indexes.delete(indexes.keys().next().value);

    let abort;
    entry.readers++;
    try {
      const canceled = new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      });
      return await Promise.race([entry.pending, canceled]);
    } finally {
      signal.removeEventListener('abort', abort);
      if (--entry.readers === 0 && !entry.settled) {
        if (indexes.get(filename) === entry) indexes.delete(filename);
        entry.controller.abort();
      }
    }
  };
  const load = async (info, signal) => {
    signal.throwIfAborted();
    const cached = await getXml(info, signal);
    const index = await loadVersion(cached, signal);
    if (index.hasTvRoot) return index;
    // A fresh file published by an earlier version may contain a different
    // document type. Refill it without deleting a concurrent replacement.
    const replacement = await loadVersion(await getXml(info, signal, cached.version), signal);
    if (!replacement.hasTvRoot) throw invalidXmlTvDocument();
    return replacement;
  };
  const getChannels = async (info, signal) => {
    const combined = optionsSignal(signal), index = await load(info, combined);
    combined.throwIfAborted();
    return index.channels(language(info), combined);
  };
  return Object.freeze({ type: 'xmltv', name: 'XmlTV', get cachePath() { return getCachePath(); },
    getPrograms(info, channelId, startDateUtc, endDateUtc, { signal } = {}) {
      return invoke(async () => {
        if (typeof channelId !== 'string' || !clrTrim(channelId)) throw new TypeError("Value cannot be null. (Parameter 'channelId')");
        const combined = optionsSignal(signal), index = await load(info, combined);
        combined.throwIfAborted();
        return index.programs({ channelId, startDateUtc, endDateUtc, language: language(info), signal: combined }).map(program => xmlTvProgramInfo(program, info));
      });
    },
    getChannels(info, { signal } = {}) {
      return invoke(async () => (await getChannels(info, signal)).map(channel => ({
        Id: channel.Id, Name: channel.DisplayName, ImageUrl: first(channel.Icons)?.Source || null,
        Number: channel.Number && clrTrim(channel.Number) ? channel.Number : channel.Id, ChannelType: 'TV' })));
    },
    getLineups(info, _country, _location, { signal } = {}) {
      return invoke(async () => (await getChannels(info, signal)).map(channel => ({ Id: channel.Id, Name: channel.DisplayName })));
    },
    validate(info, _validateLogin, _validateListings, { signal } = {}) {
      return invoke(async () => {
        optionsSignal(signal).throwIfAborted(); if (info.Path) failures.delete(info.Path);
        if (info.Path === null || info.Path === undefined) throw new TypeError('The XMLTV path is null.');
        if (!/^http/iu.test(info.Path)) {
          let exists = false;
          try { exists = (await source?.stat(info.Path, { signal: optionsSignal(signal) }))?.kind === 'file'; }
          catch (cause) { if (!missingCodes.has(cause.code)) throw cause; }
          if (!exists) throw error('ENOENT', 'Could not find the XmlTv file specified:');
        }
      });
    },
    close() {
      lifetime.abort();
      return closing ??= (async () => { while (work.size) await Promise.allSettled([...work]); indexes.clear(); })();
    },
  });
}
