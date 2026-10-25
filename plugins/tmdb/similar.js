import { ordinalIgnoreCaseKey } from '@mediamanager/plugin-sdk/storage/ordinal-comparer';
const ordinalKey = value => ordinalIgnoreCaseKey(String(value));
function createTmdbSimilarProvider(itemType, { client, logger = {} } = {}) {
  return {
    name: 'TheMovieDb',
    kind: 'remote',
    itemTypes: [itemType],
    cacheDuration() {
      const days = Number(client?.configuration?.SimilarItemsCacheDays ?? 0);
      return days > 0 ? days * 86_400_000 : null;
    },
    async *getReferences(item, _query, signal) {
      const value = Object.entries(item.ProviderIds ?? {})
        .find(([name]) => ordinalKey(name) === ordinalKey('Tmdb'))?.[1];
      const text = String(value ?? '').trim();
      if (!/^[+-]?\d+$/u.test(text)) return;
      const tmdbId = Number(text);
      if (!Number.isSafeInteger(tmdbId) || tmdbId < -2_147_483_648 || tmdbId > 2_147_483_647) return;
      let page = 1, totalPages = 1;
      while (page <= totalPages && !signal?.aborted) {
        let response;
        try { response = await client.recommendations(itemType, tmdbId, page, 'null,en', { signal }); }
        catch (error) {
          const label = itemType === 'Movie' ? 'movies' : 'TV shows';
          logger.warn?.(error, `Failed to get recommended ${label} from TMDb for ${tmdbId} page ${page}`); return;
        }
        const results = response?.Results ?? [];
        totalPages = response?.TotalPages ?? 0;
        if (!results.length) return;
        for (const recommendation of results) {
          yield { ProviderName: 'Tmdb', ProviderId: String(recommendation.id), Score: null };
        }
        page++;
      }
    },
  };
}

export const createTmdbSeriesSimilarProvider = options => createTmdbSimilarProvider('Series', options);
export const createTmdbMovieSimilarProvider = options => createTmdbSimilarProvider('Movie', options);
