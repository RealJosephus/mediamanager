import { nonemptyId } from '../library/records.js';
import { newNativeItemEntity } from '../library/native-item-entity.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { clrTrim } from './whitespace.js';

const types = { Movie: 'Movies.Movie', BoxSet: 'Movies.BoxSet', Series: 'TV.Series', MusicArtist: 'Audio.MusicArtist', MusicAlbum: 'Audio.MusicAlbum' };
const resultFields = ['Name', 'ProviderIds', 'ProductionYear', 'IndexNumber', 'IndexNumberEnd', 'ParentIndexNumber',
  'PremiereDate', 'ImageUrl', 'SearchProviderName', 'Overview', 'AlbumArtist', 'Artists'];

function wireResult(value) {
  const normalized = { ProviderIds: {}, Artists: [], ...value };
  if (normalized.ProviderIds) normalized.ProviderIds = new Map(Object.entries(normalized.ProviderIds));
  if (normalized.AlbumArtist) normalized.AlbumArtist = wireResult(normalized.AlbumArtist);
  if (normalized.Artists) normalized.Artists = normalized.Artists.map(wireResult);
  return Object.fromEntries(resultFields.filter(key => normalized[key] != null).map(key => [key, normalized[key]]));
}

function addSearchResult(resultList, candidate, providerName) {
  const ids = Object.entries(candidate.ProviderIds ?? {});
  const existing = resultList.find(earlier => Object.entries(earlier.ProviderIds ?? {}).some(([name, value]) =>
    ids.some(([candidateName, candidateValue]) => candidateValue && ordinalIgnoreCaseEquals(name, candidateName)
      && ordinalIgnoreCaseEquals(value, candidateValue))));
  if (!existing) {
    resultList.push({ ...candidate, ProviderIds: Object.fromEntries(ids), SearchProviderName: providerName });
    return;
  }
  for (const [name, value] of ids) {
    if (Object.keys(existing.ProviderIds).some(existingName => ordinalIgnoreCaseEquals(name, existingName))) continue;
    Object.defineProperty(existing.ProviderIds, name, { value, enumerable: true, writable: true, configurable: true });
  }
  if (!existing.ImageUrl || !clrTrim(existing.ImageUrl)) existing.ImageUrl = candidate.ImageUrl;
}

export async function remoteMetadataSearch(type, query, { library, metadata, configuration, signal }) {
  if (query.SearchInfo == null) throw new Error('Remote metadata search requires its lookup info.');
  let reference;
  if (nonemptyId(query.ItemId)) {
    try { reference = await library.getItemRecord(query.ItemId); }
    catch (error) { if (error?.status !== 404) throw error; }
  }
  const registry = metadata?.registry ?? library.options.externalUrlRegistry;
  const lookup = query.SearchInfo;
  if (!lookup.MetadataLanguage || !clrTrim(lookup.MetadataLanguage)) lookup.MetadataLanguage = configuration.PreferredMetadataLanguage;
  if (!lookup.MetadataCountryCode || !clrTrim(lookup.MetadataCountryCode)) lookup.MetadataCountryCode = configuration.MetadataCountryCode;
  const search = async loaded => {
    const providers = registry?.discover({ ...loaded, kind: 'remote', providerType: type,
      includeDisabled: query.IncludeDisabledProviders }) ?? [];
    const results = [];
    for (const provider of providers) {
      if (!provider.search || query.SearchProviderName && !ordinalIgnoreCaseEquals(query.SearchProviderName, provider.name)) continue;
      try {
        signal?.throwIfAborted();
        for (const result of await provider.search(lookup, { ...loaded.context, signal }) ?? []) addSearchResult(results, result, provider.name);
      } catch (error) {
        signal?.throwIfAborted();
        loaded.logger?.error(error, `${provider.name} failed to retrieve search results`);
      }
    }
    return results.map(wireResult);
  };
  if (reference && metadata?.loadContext) return metadata.loadContext.withContext(reference.Id, { includeChildren: false }, search);
  const item = reference ?? newNativeItemEntity('MediaBrowser.Controller.Entities.' + (types[type] ?? type));
  return search({ item, globalOptions: configuration, logger: metadata?.logger });
}
