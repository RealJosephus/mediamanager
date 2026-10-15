import { PROVIDER_NAME } from './utils.js';
import { ordinalIgnoreCaseEquals } from '@mediamanager/plugin-sdk/storage/ordinal-comparer';

export function createExternalProviders() {
  const providers = ['Movie', 'Series', 'Season', 'Episode', 'Person'].map((type) => ({
    id: `Tmdb${type}ExternalId`, name: PROVIDER_NAME, kind: 'externalId', itemTypes: type === 'Movie' ? ['Movie', 'LiveTvProgram'] : [type],
    supports: (item) => item.Type === type || type === 'Movie' && item.Type === 'LiveTvProgram' && item.IsMovie === true,
    getExternalIdInfo: () => ({ Name: PROVIDER_NAME, Key: 'Tmdb', Type: type }),
  }));
  providers.push({ id: 'TmdbBoxSetExternalId', name: PROVIDER_NAME, kind: 'externalId', itemTypes: ['Movie', 'MusicVideo', 'Trailer'],
    getExternalIdInfo: () => ({ Name: PROVIDER_NAME, Key: 'TmdbCollection', Type: 'BoxSet' }) });
  providers.push({ id: 'TmdbExternalUrlProvider', name: 'TMDB', kind: 'externalUrl', itemTypes: ['Movie', 'Series', 'Season', 'Episode', 'Person', 'BoxSet'], getExternalUrls: tmdbExternalUrls });
  return providers;
}

export function tmdbExternalUrls(item) {
  const base = 'https://www.themoviedb.org/';
  const tmdbId = ids => Object.entries(ids ?? {}).find(([key]) => ordinalIgnoreCaseEquals(key, 'Tmdb'))?.[1];
  const id = tmdbId(item.ProviderIds), seriesId = tmdbId(item.SeriesProviderIds);
  const category = { Movie: 'movie', Series: 'tv', Person: 'person', BoxSet: 'collection' }[item.Type];
  if (category) return id ? [base + category + '/' + id] : [];
  if (!['Season', 'Episode'].includes(item.Type) || !seriesId) return [];
  // Enum.TryParse in the source is case-sensitive. Display orders used by metadata lookup differ.
  const order = item.SeriesDisplayOrder;
  if (order) {
    const names = [null, 'OriginalAirDate', 'Absolute', 'DVD', 'Digital', 'StoryArc', 'Production', 'TV'];
    const normalized = order.trim();
    const parts = normalized.split(',').map((part) => names.indexOf(part.trim()));
    const parsed = /^[+-]?\d+$/.test(normalized) ? Number(normalized)
      : parts.every((part) => part >= 0) ? parts.reduce((a, b) => a | b, 0) : null;
    if (parsed !== 1) return [];
  }
  const season = item.Type === 'Season' ? item.IndexNumber : item.SeasonIndexNumber;
  if (season == null || item.Type === 'Episode' && item.IndexNumber == null) return [];
  return [base + `tv/${seriesId}/season/${season}` + (item.Type === 'Episode' ? `/episode/${item.IndexNumber}` : '')];
}
