import { PROVIDER_NAME, providerId } from './utils.js';

export function createExternalProviders() {
  const providers = ['Movie', 'Series', 'Season', 'Episode', 'Person'].map((type) => ({
    id: `Tmdb${type}ExternalId`, name: PROVIDER_NAME, kind: 'externalId', itemTypes: type === 'Movie' ? ['Movie', 'LiveTvProgram'] : [type],
    supports: (item) => item.Type === type || type === 'Movie' && item.Type === 'LiveTvProgram' && item.IsMovie === true,
    getExternalIdInfo: () => ({ Name: PROVIDER_NAME, Key: 'Tmdb', Type: type }),
  }));
  providers.push({ id: 'TmdbBoxSetExternalId', name: PROVIDER_NAME, kind: 'externalId', itemTypes: ['Movie', 'MusicVideo', 'Trailer'],
    getExternalIdInfo: () => ({ Name: PROVIDER_NAME, Key: 'TmdbCollection', Type: 'BoxSet' }) });
  providers.push({ id: 'TmdbEpisodeGroupId', name: PROVIDER_NAME, kind: 'externalId', itemTypes: ['Series', 'Season'],
    getExternalIdInfo: () => ({ Name: PROVIDER_NAME, Key: 'TmdbEpisodeGroup', Type: 'ReleaseGroup' }) });
  providers.push({ id: 'TmdbExternalUrlProvider', name: 'TMDB', kind: 'externalUrl', itemTypes: ['Movie', 'Series', 'Season', 'Episode', 'Person', 'BoxSet'], getExternalUrls: tmdbExternalUrls });
  return providers;
}

export function tmdbExternalUrls(item) {
  const base = 'https://www.themoviedb.org/';
  const id = providerId(item.ProviderIds, 'Tmdb'), seriesId = providerId(item.SeriesProviderIds, 'Tmdb');
  const group = providerId(item.ProviderIds, 'TmdbEpisodeGroup');
  if (item.Type === 'Series' && id) {
    const series = base + 'tv/' + id;
    return group ? [series, series + '/episode_group/' + group] : [series];
  }
  const category = { Movie: 'movie', Series: 'tv', Person: 'person', BoxSet: 'collection' }[item.Type];
  if (category) return id ? [base + category + '/' + id] : [];
  if (!['Season', 'Episode'].includes(item.Type) || !seriesId) return [];
  // Enum.TryParse in the source is case-sensitive. Display orders used by metadata lookup differ.
  const order = item.SeriesDisplayOrder;
  let airDateOrder = true;
  if (order) {
    const names = [null, 'OriginalAirDate', 'Absolute', 'DVD', 'Digital', 'StoryArc', 'Production', 'TV'];
    const normalized = order.trim();
    const parts = normalized.split(',').map((part) => names.indexOf(part.trim()));
    const parsed = /^[+-]?\d+$/.test(normalized) ? Number(normalized)
      : parts.every((part) => part >= 0) ? parts.reduce((a, b) => a | b, 0) : null;
    airDateOrder = parsed === 1;
  }
  const season = item.Type === 'Season' ? item.IndexNumber : item.SeasonIndexNumber;
  const urls = [];
  if (airDateOrder && season != null && (item.Type === 'Season' || item.IndexNumber != null)) {
    urls.push(base + `tv/${seriesId}/season/${season}` + (item.Type === 'Episode' ? `/episode/${item.IndexNumber}` : ''));
  }
  const seriesGroup = providerId(item.SeriesProviderIds, 'TmdbEpisodeGroup');
  if (item.Type === 'Season' && seriesGroup && group) urls.push(base + `tv/${seriesId}/episode_group/${seriesGroup}/group/${group}`);
  return urls;
}
