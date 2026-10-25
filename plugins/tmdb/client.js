import { normalizeLanguage, adjustImageLanguage, isOriginalImageSize, PROVIDER_NAME } from './utils.js';
import { tmdbConfiguration, validateImagePreferences } from './configuration.js';
import { defaultTmdbApiKey } from './default-key.js';
import { setTimeout as delay } from 'node:timers/promises';

function parseTmdbResponse(text) {
  if (!text.trim()) return null;
  return JSON.parse(text, (key, value, context) => {
    // TMDbLib exposes TvSeasonEpisode.EpisodeNumber as Int64 and the missing
    // episode provider later performs an unchecked cast to Int32. Preserve the
    // raw JSON integer until that cast instead of first rounding it through a
    // JavaScript Number. Other TMDB numeric properties retain their declared
    // client-model behavior.
    if (key === 'episode_number' && typeof value === 'number' && Number.isInteger(value)
      && !Number.isSafeInteger(value) && /^-?\d+$/u.test(context.source)) {
      return BigInt(context.source);
    }
    return value;
  });
}

export class TmdbHttpError extends Error {
  constructor(status, retryAfter) {
    super(`TMDB request failed with HTTP ${status}.`);
    this.name = 'TmdbHttpError'; this.status = status; this.retryAfter = retryAfter;
  }
}

export class TmdbClient {
  #cache = new Map();
  #cacheWeight = 0;
  #remoteConfiguration;
  #lifetime = new AbortController();

  constructor({ configuration, apiKey, defaultApiKey = defaultTmdbApiKey, fetch: fetchImpl = globalThis.fetch, baseUrl = 'https://api.themoviedb.org/3/', now = Date.now } = {}) {
    this.configuration = tmdbConfiguration(configuration);
    this.apiKey = apiKey ?? (this.configuration.TmdbApiKey || defaultApiKey);
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.now = now;
  }

  async request(path, query = {}, { signal } = {}) {
    signal = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    signal?.throwIfAborted();
    if (!this.apiKey) throw new Error('A TMDB API key or baseline default API key is required.');
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) if (value != null) url.searchParams.set(key, String(value));
    url.searchParams.set('api_key', this.apiKey);
    // TMDbLib 3.0.0 applies its default retry policy to every endpoint. A 429
    // waits even on the final attempt; zero, missing and date headers use 1s.
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetch(url, { signal, headers: { Accept: 'application/json' } });
      const isJson = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json';
      if (response.ok && isJson) return parseTmdbResponse(await response.text());
      if (isJson) parseTmdbResponse(await response.text());
      else await response.body?.cancel();
      const retryAfter = response.headers.get('retry-after');
      if (response.status === 429) {
        const seconds = /^\d+$/u.test(retryAfter?.trim() ?? '') ? Number(retryAfter) : 0;
        await delay(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000, undefined, { signal });
        if (attempt === 0) continue;
      }
      if (response.status === 404) return null;
      throw new TmdbHttpError(response.status, retryAfter);
    }
  }

  close() { this.#lifetime.abort(); this.#cache.clear(); this.#remoteConfiguration = undefined; this.#cacheWeight = 0; }

  async getClientConfiguration(options) {
    if (!this.#remoteConfiguration) {
      const configuration = await this.request('configuration', {}, options);
      if (!configuration) throw new Error('TMDB client configuration is unavailable.');
      validateImagePreferences(this.configuration, configuration);
      this.#remoteConfiguration = configuration;
    }
    return this.#remoteConfiguration;
  }

  async #cached(key, factory, cacheEmpty = true) {
    const current = this.#cache.get(key);
    if (current && current.expires > this.now()) return current.value;
    if (current) { this.#cacheWeight -= current.weight; this.#cache.delete(key); }
    await this.getClientConfiguration();
    const value = await factory();
    if (value && (cacheEmpty || value.results?.length)) {
      const weight = estimateSize(value);
      // MemoryCache does not promise an eviction order. Capacity behavior needs runtime differential verification.
      if (weight + this.#cacheWeight <= 100_000) {
        this.#cache.set(key, { value, weight, expires: this.now() + 3_600_000 });
        this.#cacheWeight += weight;
      }
    }
    return value;
  }

  movie(id, language, imageLanguages, countryCode, options) {
    const append = ['credits', 'releases', 'images', 'videos', ...(!this.configuration.ExcludeTagsMovies ? ['keywords'] : [])];
    return this.#cached(`movie-${id}-${language ?? ''}`, () => this.request(`movie/${id}`, { language: normalizeLanguage(language, countryCode), include_image_language: imageLanguages, append_to_response: append.join(',') }, options));
  }

  series(id, language, imageLanguages, countryCode, options) {
    const append = ['credits', 'aggregate_credits', 'images', 'external_ids', 'videos', 'content_ratings', 'episode_groups', ...(!this.configuration.ExcludeTagsSeries ? ['keywords'] : [])];
    return this.#cached(`series-${id}-${language ?? ''}`, () => this.request(`tv/${id}`, { language: normalizeLanguage(language, countryCode), include_image_language: imageLanguages, append_to_response: append.join(',') }, options));
  }

  collection(id, language, imageLanguages, countryCode, options) {
    return this.#cached(`collection-${id}-${language ?? ''}`, () => this.request(`collection/${id}`, { language: normalizeLanguage(language, countryCode), include_image_language: imageLanguages, append_to_response: 'images' }, options));
  }

  person(id, language, countryCode, options) {
    return this.#cached(`person-${id}-${language ?? ''}`, () => this.request(`person/${id}`, { language: normalizeLanguage(language, countryCode), append_to_response: 'images,external_ids' }, options));
  }

  season(seriesId, number, language, imageLanguages, countryCode, options) {
    return this.#cached(`season-${seriesId}-s${number}-${language ?? ''}`, () => this.request(`tv/${seriesId}/season/${number}`, { language: normalizeLanguage(language, countryCode), include_image_language: imageLanguages, append_to_response: 'credits,images,external_ids,videos' }, options));
  }

  async episodeGroup(seriesId, displayOrder, language, imageLanguages, countryCode, options) {
    const groupType = { originalAirDate: 1, absolute: 2, dvd: 3, digital: 4, storyArc: 5, production: 6, tv: 7 }[displayOrder];
    if (!groupType) return null;
    return this.#cached(`group-${seriesId}-${displayOrder}-${language ?? ''}`, async () => {
      const series = await this.series(seriesId, language, imageLanguages, countryCode, options);
      const id = series?.episode_groups?.results?.find((group) => group.type === groupType)?.id;
      return id ? this.request(`tv/episode_group/${id}`, { language: normalizeLanguage(language, countryCode) }, options) : null;
    });
  }

  episode(seriesId, season, number, displayOrder, language, imageLanguages, countryCode, options) {
    return this.#cached(`episode-${seriesId}-s${season}e${number}-${displayOrder ?? ''}-${language ?? ''}`, async () => {
      const group = await this.episodeGroup(seriesId, displayOrder, language, imageLanguages, countryCode, options);
      const episode = group?.groups?.find((entry) => entry.order === season)?.episodes?.find((entry) => entry.order === number - 1);
      return this.request(`tv/${seriesId}/season/${episode?.season_number ?? season}/episode/${episode?.episode_number ?? number}`, { language: normalizeLanguage(language, countryCode), include_image_language: imageLanguages, append_to_response: 'credits,images,external_ids,videos' }, options);
    });
  }

  find(id, source, language, countryCode, options) {
    const sourceName = { imdb_id: 'Imdb', tvdb_id: 'TvDb' }[source] ?? source;
    return this.#cached(`find-${sourceName}-${id}-${language ?? ''}`, () => this.request(`find/${encodeURIComponent(id)}`, { external_source: source, language: normalizeLanguage(language, countryCode) }, options));
  }

  async search(type, name, year, language, countryCode, options) {
    const apiType = { Movie: 'movie', Series: 'tv', Person: 'person', BoxSet: 'collection' }[type];
    if (!apiType) throw new TypeError(`Unsupported TMDB search type: ${type}`);
    const key = type === 'Person' ? `searchperson-${name}` : type === 'BoxSet' ? `collectionsearch-${name}-${language ?? ''}` : `${type === 'Movie' ? 'moviesearch' : 'searchseries'}-${name}-${year ?? 0}-${language ?? ''}`;
    const query = { query: name };
    if (type !== 'Person') query.language = normalizeLanguage(language, countryCode);
    if (type !== 'BoxSet') query.include_adult = this.configuration.IncludeAdult;
    if (type === 'Movie') query.year = year ?? 0;
    if (type === 'Series' && year > 0) query.first_air_date_year = year;
    const value = await this.#cached(key, () => this.request(`search/${apiType}`, query, options), false);
    return value?.results ?? null;
  }

  async recommendations(type, id, page, language, options) {
    await this.getClientConfiguration();
    const result = await this.request(`${type === 'Movie' ? 'movie' : 'tv'}/${id}/recommendations`,
      { page, language }, options);
    return result?.results?.length ? { Results: result.results, TotalPages: result.total_pages } : { Results: [], TotalPages: 0 };
  }

  imageUrl(path, size) {
    if (!path) return null;
    const base = this.#remoteConfiguration?.images?.secure_base_url;
    if (!base) throw new Error('TMDB image configuration has not been loaded.');
    return base + (size || 'original') + path;
  }

  convertImages(images, kind, requestLanguage) {
    const type = kind === 'Backdrop' ? 'Backdrop' : kind === 'Logo' ? 'Logo' : 'Primary';
    const size = this.configuration[kind + 'Size'];
    const thumbnail = { Primary: 'w500', Backdrop: 'w780', Thumb: 'w780', Logo: 'w500' }[type];
    return images.map((image) => {
      const language = adjustImageLanguage(image.iso_639_1, requestLanguage);
      return {
        Url: this.imageUrl(image.file_path, size), ThumbnailUrl: this.imageUrl(image.file_path, thumbnail),
        CommunityRating: image.vote_average, VoteCount: image.vote_count,
        Width: isOriginalImageSize(size) ? image.width : null, Height: isOriginalImageSize(size) ? image.height : null,
        Language: language, ProviderName: PROVIDER_NAME, Type: type === 'Backdrop' && language ? 'Thumb' : type, RatingType: 'Score',
      };
    });
  }

  dispose() { this.#cache.clear(); this.#cacheWeight = 0; }
}

function estimateSize(value) {
  let count = 1;
  for (const key of ['results', 'parts', 'groups', 'seasons', 'episodes', 'movie_results', 'tv_results', 'person_results', 'tv_episode_results', 'tv_season_results']) count += value[key]?.length ?? 0;
  for (const key of ['cast', 'crew', 'guest_stars']) count += value.credits?.[key]?.length ?? 0;
  for (const key of ['cast', 'crew']) for (const entry of value.aggregate_credits?.[key] ?? []) count += 1 + (entry.roles?.length ?? entry.jobs?.length ?? 0);
  return count;
}
