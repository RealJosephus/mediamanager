import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lowerInvariant } from '../core/identity.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';

const REMOTE_BATCH_SIZE = 20;
const MAX_REMOTE_REFERENCES = 500;
const INVALID_SINGLE = Symbol('invalid-single');
const RAW_SINGLE = Symbol('raw-single');
const SINGLE_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const SINGLE_PARTS = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u;
const SINGLE_ONE = Math.fround(1);
const POSITION_STEP = Math.fround(0.02);
const PROVIDER_BOOST_STEP = Math.fround(0.005);
const MAX_FINITE_SINGLE_BITS = 0x7f7fffff;
const SINGLE_SCALE = 1n << 149n;
const SINGLE_OVERFLOW_UNITS = 1n << 277n;

const ordinalKey = value => ordinalIgnoreCaseKey(String(value));

function abortError(error, signal) {
  return signal?.aborted || error?.name === 'AbortError';
}

function providerOrder(order, name) {
  if (!order?.length) return Number.MAX_SAFE_INTEGER;
  const key = ordinalKey(name);
  const index = order.findIndex(value => ordinalKey(value) === key);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function providerSupports(provider, itemType) {
  return !provider.itemTypes || provider.itemTypes.some(value => ordinalKey(value) === ordinalKey(itemType));
}

function isRemoteEnabled(provider, configured) {
  const name = ordinalKey(provider.name);
  return configured?.some(value => ordinalKey(value) === name) ?? false;
}

function singleFromBits(bits) {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setUint32(0, bits >>> 0, true);
  return view.getFloat32(0, true);
}

function singleUnits(bits) {
  const exponent = bits >>> 23 & 0xff;
  const fraction = bits & 0x7fffff;
  return exponent === 0 ? BigInt(fraction)
    : BigInt(0x800000 + fraction) << BigInt(exponent - 1);
}

function decimalSingle(value) {
  if (!SINGLE_NUMBER.test(value)) return INVALID_SINGLE;
  const parts = SINGLE_PARTS.exec(value);
  const negative = parts[1] === '-';
  const fraction = parts[3] ?? parts[4] ?? '';
  let digits = `${parts[2] ?? ''}${fraction}`.replace(/^0+/u, '');
  if (!digits) return negative ? singleFromBits(0x80000000) : 0;
  let decimalExponent = Number(parts[5] ?? 0) - fraction.length;
  if (!Number.isSafeInteger(decimalExponent)) return decimalExponent < 0
    ? negative ? singleFromBits(0x80000000) : 0
    : INVALID_SINGLE;
  const trailing = /0+$/u.exec(digits)?.[0].length ?? 0;
  if (trailing) {
    digits = digits.slice(0, -trailing);
    decimalExponent += trailing;
  }
  const adjustedExponent = decimalExponent + digits.length - 1;
  if (adjustedExponent > 39) return INVALID_SINGLE;
  if (adjustedExponent < -46) return negative ? singleFromBits(0x80000000) : 0;
  let numerator = BigInt(digits), denominator = 1n;
  if (decimalExponent >= 0) numerator *= 10n ** BigInt(decimalExponent);
  else denominator = 10n ** BigInt(-decimalExponent);
  const scaledNumerator = numerator * SINGLE_SCALE;
  let low = 0, high = MAX_FINITE_SINGLE_BITS, floor = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (singleUnits(middle) * denominator <= scaledNumerator) {
      floor = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  const floorUnits = singleUnits(floor);
  let rounded = floor;
  if (floorUnits * denominator !== scaledNumerator) {
    const upperUnits = floor === MAX_FINITE_SINGLE_BITS
      ? SINGLE_OVERFLOW_UNITS : singleUnits(floor + 1);
    const midpoint = (floorUnits + upperUnits) * denominator;
    const comparison = scaledNumerator * 2n - midpoint;
    if (comparison > 0n || comparison === 0n && (floor & 1) === 1) rounded = floor + 1;
  }
  if (rounded > MAX_FINITE_SINGLE_BITS) return INVALID_SINGLE;
  return singleFromBits(negative ? rounded | 0x80000000 : rounded);
}

function parseCacheJson(value) {
  return JSON.parse(value, (key, parsed, context) => key === 'Score' && typeof parsed === 'number'
    ? { [RAW_SINGLE]: context.source }
    : parsed);
}

function single(value, allowString = false) {
  if (value == null) return null;
  if (allowString && typeof value === 'object' && typeof value[RAW_SINGLE] === 'string') {
    return decimalSingle(value[RAW_SINGLE]);
  }
  let numeric = value;
  if (typeof value === 'string') {
    return allowString ? decimalSingle(value) : INVALID_SINGLE;
  } else if (typeof value !== 'number') return INVALID_SINGLE;
  if (!Number.isFinite(numeric)) return INVALID_SINGLE;
  const rounded = Math.fround(numeric);
  return Number.isFinite(rounded) ? rounded : INVALID_SINGLE;
}

function similarReference(reference, allowStringScore = false) {
  if (!reference || typeof reference.ProviderName !== 'string' || typeof reference.ProviderId !== 'string') return null;
  const parsedScore = single(reference.Score, allowStringScore);
  if (parsedScore === INVALID_SINGLE) return null;
  return { ProviderName: reference.ProviderName, ProviderId: reference.ProviderId, Score: parsedScore };
}

export function calculateSimilarScore(matchScore, order, position) {
  const parsedScore = single(matchScore);
  if (parsedScore === INVALID_SINGLE) throw new TypeError('Similar item score must be a finite Single value.');
  const positionProduct = Math.fround(Math.fround(position) * POSITION_STEP);
  const base = parsedScore ?? Math.fround(SINGLE_ONE - positionProduct);
  const boost = Math.fround(Math.fround(Math.max(0, 10 - order)) * PROVIDER_BOOST_STEP);
  const combined = Math.fround(base + boost);
  return combined < 0 ? Math.fround(0) : combined > 1 ? SINGLE_ONE : combined;
}

function referenceKey(name, id) {
  // Native uses an OrdinalIgnoreCase tuple comparer. JSON encoding keeps the
  // two arbitrary string components unambiguous even when either contains a
  // delimiter character.
  return JSON.stringify([ordinalKey(name), ordinalKey(id)]);
}

function providerId(item, name) {
  const key = ordinalKey(name);
  const entry = Object.entries(item.ProviderIds ?? {}).find(([candidate]) => ordinalKey(candidate) === key);
  return entry?.[1];
}

function cacheDocument(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.References)
    || typeof value.ExpiresAt !== 'string' || !Number.isFinite(Date.parse(value.ExpiresAt))) return null;
  const references = [];
  for (const reference of value.References) {
    const parsed = similarReference(reference, true);
    if (!parsed) return null;
    references.push(parsed);
  }
  return { References: references, ExpiresAt: value.ExpiresAt };
}

function dotnetUtc(value) {
  // Jellyfin's JsonDateTimeConverter forces seven fractional digits when the
  // millisecond is zero; otherwise Utf8JsonWriter emits the available
  // precision. JavaScript has millisecond precision, so its normal ISO form is
  // already the latter case.
  const date = new Date(value), iso = date.toISOString();
  return date.getUTCMilliseconds() === 0 ? iso.replace('.000Z', '.0000000Z') : iso;
}

export function similarCachePath(cachePath, providerName, itemType, itemId) {
  if (!cachePath) return null;
  // Cache-directory casing is ToLowerInvariant in Jellyfin and is distinct
  // from the OrdinalIgnoreCase equality used to match provider identities.
  return path.join(cachePath, `${lowerInvariant(String(providerName))}-similar-${lowerInvariant(String(itemType))}`,
    `${lowerInvariant(String(itemId).replaceAll('-', ''))}.json`);
}

export class SimilarItemsManager {
  constructor(options = {}) {
    const { fileSystem, providers = [], extensions = () => [], logger = {}, now = () => Date.now() } = options;
    this.pathOptions = options;
    this.fileSystem = fileSystem;
    this.providers = [...providers];
    this.extensions = extensions;
    this.logger = logger;
    this.now = now;
  }
  get cachePath() { return this.pathOptions.cachePath; }

  addParts(providers) { this.providers = [...providers]; }

  matchingProviders(itemType, typeOptions, additionalProviders = []) {
    const all = [...additionalProviders, ...this.providers, ...this.extensions()];
    const local = all.filter(provider => provider.kind === 'local' && providerSupports(provider, itemType));
    const enabled = typeOptions?.SimilarItemProviders ?? [];
    const remote = enabled.length ? all.filter(provider => provider.kind === 'remote'
      && providerSupports(provider, itemType) && isRemoteEnabled(provider, enabled)) : [];
    const matching = [...local, ...remote];
    const order = typeOptions?.SimilarItemProviderOrder?.length
      ? typeOptions.SimilarItemProviderOrder : typeOptions?.SimilarItemProviders;
    return matching.map((provider, index) => ({ provider, index,
      configured: providerOrder(order, provider.name) }))
      .sort((left, right) => left.configured - right.configured || left.index - right.index)
      .map(entry => entry.provider);
  }

  async #readCache(filename, signal) {
    if (!filename) return null;
    signal?.throwIfAborted();
    try {
      const info = await this.fileSystem.stat(filename);
      if (!info.isFile() || info.size === 0) return null;
      const document = cacheDocument(parseCacheJson(await this.fileSystem.readFile(filename, { encoding: 'utf8', signal })));
      return document && this.now() < Date.parse(document.ExpiresAt) ? document.References : null;
    } catch (error) {
      if (abortError(error, signal)) throw error;
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) this.logger.warn?.(error, `Failed to read similar items cache from ${filename}`);
      return null;
    }
  }

  async #writeCache(filename, references, duration, signal) {
    if (!filename || !references.length || duration == null) return;
    signal?.throwIfAborted();
    let temporary;
    try {
      await this.fileSystem.mkdir(path.dirname(filename), { recursive: true });
      temporary = `${filename}.${randomUUID().replaceAll('-', '')}.tmp`;
      const document = { References: references.map(reference => ({
        ProviderName: reference.ProviderName,
        ProviderId: reference.ProviderId,
        ...(reference.Score == null ? {} : { Score: reference.Score }),
      })), ExpiresAt: dotnetUtc(this.now() + duration) };
      await this.fileSystem.writeFile(temporary, JSON.stringify(document), { signal });
      try { await this.fileSystem.rename(temporary, filename); }
      catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
        await this.fileSystem.rm(filename, { force: true });
        await this.fileSystem.rename(temporary, filename);
      }
      temporary = null;
    } catch (error) {
      if (abortError(error, signal)) throw error;
      this.logger.warn?.(error, `Failed to save similar items cache to ${filename}`);
    } finally {
      if (temporary) {
        try { await this.fileSystem.rm(temporary, { force: true }); }
        catch (error) { this.logger.debug?.(error, `Failed to delete temporary similar items cache file ${temporary}`); }
      }
    }
  }

  async #resolveReferences(references, providerOrderIndex, itemType, context, excludeIds, excludeKeys,
    requestedLimit) {
    if (!references.length) return [];
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0) {
      throw new TypeError('Remote similar-items resolution limit must be a non-negative integer.');
    }
    if (requestedLimit === 0) return [];
    const lookup = new Map();
    references.forEach((reference, position) => {
      const key = referenceKey(reference.ProviderName, reference.ProviderId);
      const previous = lookup.get(key), candidate = { reference, position };
      if (!previous || reference.Score != null && previous.reference.Score != null
        && (reference.Score > previous.reference.Score
          || reference.Score === previous.reference.Score && position < previous.position)
        || reference.Score == null && previous.reference.Score == null && position < previous.position) {
        lookup.set(key, candidate);
      }
    });
    const providerNames = new Map();
    for (const { reference } of lookup.values()) {
      const key = ordinalKey(reference.ProviderName);
      if (!providerNames.has(key)) providerNames.set(key, reference.ProviderName);
    }
    const resolved = new Map();
    const lookupValues = [...lookup.values()];
    const lookupReferences = lookupValues.map(value => value.reference);
    const referencePositions = lookupValues.map(value => value.position);
    const seenCursors = new Set();
    let after;
    while (resolved.size < requestedLimit) {
      const remaining = requestedLimit - resolved.size;
      const response = await context.resolveRemote(lookupReferences,
        { itemType, providerNames: [...providerNames.values()], providerOrderIndex,
          referencePositions, limit: remaining, after });
      const paged = !Array.isArray(response);
      const items = paged ? response?.items : response;
      if (!Array.isArray(items)) throw new TypeError('Remote similar-items resolver returned an invalid page.');
      if (paged && items.length > remaining) {
        throw new Error('Remote similar-items resolver exceeded its requested page limit.');
      }
      for (const item of items) {
        if (excludeIds.has(context.idKey(item.Id))) continue;
        const presentationKey = await context.presentationKey(item);
        if (excludeKeys.has(context.presentationKeyKey(presentationKey))) continue;
        for (const name of providerNames.values()) {
          const id = providerId(item, name);
          if (id == null) continue;
          const match = lookup.get(referenceKey(name, id));
          if (!match) continue;
          const value = { item, score: calculateSimilarScore(match.reference.Score, providerOrderIndex, match.position) };
          const key = context.presentationKeyKey(presentationKey), previous = resolved.get(key);
          if (!previous || previous.score < value.score) resolved.set(key, value);
          break;
        }
      }
      // Array resolvers are the native in-memory/SQLite contract and retain
      // their original all-at-once scoring behavior. PostgreSQL returns a
      // cursor page, allowing each query and hydration to use exactly the
      // manager's still-unfilled result allowance.
      if (!paged || resolved.size >= requestedLimit || response.nextCursor == null) break;
      const cursorKey = JSON.stringify(response.nextCursor);
      if (seenCursors.has(cursorKey)) throw new Error('Remote similar-items resolver repeated its cursor.');
      seenCursors.add(cursorKey);
      after = response.nextCursor;
    }
    for (const [key, value] of resolved) {
      excludeIds.add(context.idKey(value.item.Id));
      excludeKeys.add(key);
    }
    return [...resolved.values()];
  }

  async getSimilarItems({ item, itemType, typeOptions, additionalProviders = [], excludeArtistIds = [],
    user = null, fields = [], limit, signal, idKey, presentationKey, presentationKeyKey,
    resolveRemote, filterAccess = value => value } = {}) {
    const requestedLimit = limit ?? 50;
    const context = { idKey, presentationKey, presentationKeyKey, resolveRemote };
    const orderedProviders = this.matchingProviders(itemType, typeOptions, additionalProviders);
    const allResults = [];
    const excludeIds = new Set([idKey(item.Id)]);
    const excludeKeys = new Set([presentationKeyKey(await presentationKey(item))]);

    for (const [providerOrderIndex, provider] of orderedProviders.entries()) {
      if (allResults.length >= requestedLimit || signal?.aborted) break;
      try {
        if (provider.kind === 'local') {
          const query = { user, limit: requestedLimit - allResults.length, fields,
            excludeItemIds: [...excludeIds], excludeArtistIds };
          const items = await provider.getItems(item, query, signal);
          for (const [position, result] of items.entries()) {
            const id = idKey(result.Id), key = presentationKeyKey(await presentationKey(result));
            const newId = !excludeIds.has(id), newKey = !excludeKeys.has(key);
            excludeIds.add(id); excludeKeys.add(key);
            if (newId && newKey) allResults.push({ item: result,
              score: calculateSimilarScore(null, providerOrderIndex, position) });
          }
        } else {
          const filename = similarCachePath(provider.cachePath ?? this.cachePath, provider.name, itemType, item.Id);
          const cached = await this.#readCache(filename, signal);
          if (cached !== null) {
            allResults.push(...await this.#resolveReferences(cached, providerOrderIndex, itemType,
              context, excludeIds, excludeKeys, requestedLimit - allResults.length));
            continue;
          }
          const query = { user, limit: requestedLimit - allResults.length, fields,
            excludeItemIds: [...excludeIds], excludeArtistIds };
          const collected = [], pending = [];
          let remaining = requestedLimit - allResults.length;
          for await (const rawReference of provider.getReferences(item, query, signal)) {
            const reference = similarReference(rawReference);
            if (!reference) throw new TypeError(`Similar items provider ${provider.name} returned an invalid reference.`);
            collected.push(reference); pending.push(reference);
            if (pending.length >= REMOTE_BATCH_SIZE) {
              const resolved = await this.#resolveReferences(pending, providerOrderIndex, itemType,
                context, excludeIds, excludeKeys, remaining);
              allResults.push(...resolved); remaining -= resolved.length; pending.length = 0;
              if (remaining <= 0 || collected.length >= MAX_REMOTE_REFERENCES) break;
            }
          }
          if (pending.length) allResults.push(...await this.#resolveReferences(pending, providerOrderIndex,
            itemType, context, excludeIds, excludeKeys, remaining));
          const duration = typeof provider.cacheDuration === 'function'
            ? provider.cacheDuration() : provider.cacheDuration;
          await this.#writeCache(filename, collected, duration, signal);
        }
      } catch (error) {
        if (abortError(error, signal)) break;
        this.logger.warn?.(error, `Similar items provider ${provider.name} failed for item ${item.Id}`);
      }
    }

    const ordered = allResults.sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, requestedLimit)).map(entry => entry.item);
    return await filterAccess(ordered, signal);
  }
}



export const similarItemsLimits = Object.freeze({ remoteBatchSize: REMOTE_BATCH_SIZE,
  maxRemoteReferences: MAX_REMOTE_REFERENCES });
