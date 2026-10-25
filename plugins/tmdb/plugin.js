import { TMDB_ID, PROVIDER_NAME, parseTmdbId, imageLanguages, cleanName, findBestMatch, parentalRating, crewType, isTrailer } from './utils.js';
import { addPerson } from '@mediamanager/plugin-sdk/metadata/people';
import { createTelevisionProviders } from './television.js';
import { createCollectionProvider } from './collections.js';
import { createImageProviders } from './images.js';
import { createExternalProviders } from './external.js';
import { createTmdbMissingEpisodeProvider } from './missing-episodes.js';
import { parseMetadataName } from '@mediamanager/plugin-sdk/metadata/naming';

const ids = (tmdb, imdb) => ({ Tmdb: String(tmdb), ...(imdb ? { Imdb: String(imdb) } : {}) });
const date = (value) => value ? value + 'T00:00:00.000Z' : null;
const year = (value) => value ? Number(value.slice(0, 4)) : null;
const unique = (values) => [...new Map(values.filter((value) => value?.trim()).map((value) => [value.trim().toLowerCase(), value.trim()])).values()];

function credits(remote, client) {
  const config = client.configuration; const people = [];
  // Movie and season limit billing before skipping blank names; shared MapCast has a different order.
  const cast = (remote.cast ?? []).filter((entry) => !config.HideMissingCastMembers || entry.profile_path)
    .sort((a, b) => (a.order ?? -Infinity) - (b.order ?? -Infinity)).slice(0, Math.max(0, config.MaxCastMembers));
  for (const actor of cast) if (actor.name?.trim()) addPerson(people, { Name: actor.name, Role: actor.character?.trim() ?? '', Type: 'Actor', SortOrder: actor.order ?? null, ImageUrl: client.imageUrl(actor.profile_path, config.ProfileSize), ProviderIds: actor.id > 0 ? ids(actor.id) : {} });
  const crew = (remote.crew ?? []).map((entry) => ({ entry, type: crewType(entry) })).filter(({ type }) => type !== 'Unknown')
    .filter(({ entry }) => !config.HideMissingCrewMembers || entry.profile_path).slice(0, Math.max(0, config.MaxCrewMembers));
  for (const { entry, type } of crew) if (entry.name?.trim()) addPerson(people, { Name: entry.name, Role: entry.job?.trim() ?? '', Type: type, ImageUrl: client.imageUrl(entry.profile_path, config.ProfileSize), ProviderIds: entry.id > 0 ? ids(entry.id) : {} });
  return people;
}

export function createTmdbPlugin({ client, lifecycle, parseName = parseMetadataName }) {
  const movieSearch = async (info, options = {}) => {
    const language = info.MetadataLanguage; const country = info.MetadataCountryCode; const imageLanguage = imageLanguages(language, country);
    const map = (movie) => ({ Name: movie.title ?? movie.original_title, SearchProviderName: PROVIDER_NAME, ImageUrl: client.imageUrl(movie.poster_path, client.configuration.PosterSize), Overview: movie.overview, PremiereDate: date(movie.release_date), ProductionYear: year(movie.release_date), ProviderIds: ids(movie.id) });
    const id = parseTmdbId(info.ProviderIds?.Tmdb);
    if (id) { const movie = await client.movie(id, language, imageLanguage, country, options); if (movie) return [{ ...map(movie), ProviderIds: ids(movie.id, movie.imdb_id) }]; }
    let movies;
    // The source search entry point passes its image-language list to Find, unlike GetMetadata.
    if (info.ProviderIds?.Imdb) movies = (await client.find(info.ProviderIds.Imdb, 'imdb_id', imageLanguage, country, options))?.movie_results;
    if (movies == null && info.ProviderIds?.Tvdb) movies = (await client.find(info.ProviderIds.Tvdb, 'tvdb_id', imageLanguage, country, options))?.movie_results;
    if (movies == null) movies = await client.search('Movie', info.Name, info.Year ?? 0, language, country, options);
    return (movies ?? []).map(map);
  };
  const movieMetadata = async (info, options = {}) => {
    const language = info.MetadataLanguage; const country = info.MetadataCountryCode; let id = parseTmdbId(info.ProviderIds?.Tmdb);
    const imdb = info.ProviderIds?.Imdb;
    if (!id && !imdb) {
      if (!parseName) throw new Error('Movie name identification requires the host baseline ParseName implementation.');
      const parsed = parseName(info.Name); const searchYear = info.Year ?? parsed.Year ?? 0;
      id = findBestMatch(await client.search('Movie', cleanName(parsed.Name), searchYear, language, country, options), parsed.Name, searchYear)?.id;
    }
    if (!id && imdb) id = (await client.find(imdb, 'imdb_id', language, country, options))?.movie_results?.[0]?.id;
    if (!id) return { HasMetadata: false };
    const remote = await client.movie(id, language, imageLanguages(language, country), country, options);
    if (!remote) return { HasMetadata: false };
    const item = { Type: 'Movie', Name: remote.title ?? remote.original_title, OriginalTitle: remote.original_title,
      Overview: remote.overview?.replaceAll('\n\n', '\n'), Tagline: remote.tagline, ProductionLocations: (remote.production_countries ?? []).map((entry) => entry.name),
      ProviderIds: ids(id, remote.imdb_id), CommunityRating: Math.fround(remote.vote_average ?? 0), PremiereDate: date(remote.release_date), ProductionYear: year(remote.release_date),
      Studios: unique((remote.production_companies ?? []).map((entry) => entry.name)), Genres: unique((remote.genres ?? []).map((entry) => entry.name)), Tags: unique((remote.keywords?.keywords ?? []).map((entry) => entry.name)) };
    if (remote.belongs_to_collection) {
      item.ProviderIds.TmdbCollection = String(remote.belongs_to_collection.id);
      item.TmdbCollectionName = remote.belongs_to_collection.name;
    }
    const releases = (remote.releases?.countries ?? []).filter((entry) => entry.certification?.trim());
    const regional = releases.find((entry) => entry.iso_3166_1?.toLowerCase() === country?.toLowerCase());
    const us = releases.find((entry) => entry.iso_3166_1?.toLowerCase() === 'us');
    if (regional) item.OfficialRating = parentalRating(country, regional.certification); else if (us) item.OfficialRating = us.certification;
    if (remote.videos?.results) item.RemoteTrailers = [...remote.videos.results].sort((a, b) => Number(b.type?.toLowerCase() === 'trailer') - Number(a.type?.toLowerCase() === 'trailer')).filter(isTrailer).map((video) => ({ Url: 'https://www.youtube.com/watch?v=' + video.key, Name: video.name }));
    if (remote.original_language) item.OriginalLanguage = remote.original_language;
    return { HasMetadata: true, ResultLanguage: language, Item: item, People: credits(remote.credits ?? {}, client) };
  };
  const personMetadata = async (info, options = {}) => {
    let id = parseTmdbId(info.ProviderIds?.Tmdb);
    if (!id) id = (await client.search('Person', info.Name, null, null, null, options))?.[0]?.id;
    const result = { HasMetadata: false, ResultLanguage: info.MetadataLanguage };
    if (!id) return result;
    const person = await client.person(id, info.MetadataLanguage, info.MetadataCountryCode, options); if (!person) return result;
    return { ...result, HasMetadata: true, Item: { Type: 'Person', Name: info.Name, HomePageUrl: person.homepage, Overview: person.biography, PremiereDate: date(person.birthday), EndDate: date(person.deathday), ...(person.place_of_birth?.trim() ? { ProductionLocations: [person.place_of_birth] } : {}), ProviderIds: ids(person.id, person.imdb_id) } };
  };
  const personSearch = async (info, options = {}) => {
    const id = parseTmdbId(info.ProviderIds?.Tmdb);
    if (id) {
      const person = await client.person(id, info.MetadataLanguage, info.MetadataCountryCode, options);
      if (person) return [{ Name: person.name, SearchProviderName: PROVIDER_NAME, Overview: person.biography, ImageUrl: client.imageUrl(person.images?.profiles?.[0]?.file_path, client.configuration.ProfileSize), ProviderIds: ids(person.id, person.external_ids?.imdb_id) }];
    }
    return ((await client.search('Person', info.Name, null, null, null, options)) ?? []).map((person) => ({ Name: person.name, SearchProviderName: PROVIDER_NAME, ImageUrl: client.imageUrl(person.profile_path, client.configuration.ProfileSize), ProviderIds: ids(person.id) }));
  };
  const seasonMetadata = async (info, options = {}) => {
    const result = { HasMetadata: false, ResultLanguage: info.MetadataLanguage }; const id = parseTmdbId(info.SeriesProviderIds?.Tmdb);
    if (id == null || info.IndexNumber == null) return result;
    const remote = await client.season(id, info.IndexNumber, info.MetadataLanguage, imageLanguages(info.MetadataLanguage, info.MetadataCountryCode), info.MetadataCountryCode, options);
    if (!remote) return result;
    const item = { Type: 'Season', IndexNumber: info.IndexNumber, Overview: remote.overview, PremiereDate: date(remote.air_date), ProductionYear: year(remote.air_date), ProviderIds: {} };
    if (client.configuration.ImportSeasonName) item.Name = remote.name;
    if (remote.id != null) item.ProviderIds.Tmdb = String(remote.id);
    if (remote.external_ids?.tvdb_id != null) item.ProviderIds.Tvdb = String(remote.external_ids.tvdb_id);
    return { ...result, HasMetadata: true, Item: item, People: credits(remote.credits ?? {}, client) };
  };
  return { id: TMDB_ID, name: 'TMDb', configurationFile: 'Jellyfin.Plugin.Tmdb.xml', configuration: client.configuration,
    providers: [
      { id: 'TmdbMovieProvider', name: PROVIDER_NAME, kind: 'remote', itemTypes: ['Movie'], order: 1, getMetadata: movieMetadata, search: movieSearch },
      { id: 'TmdbPersonProvider', name: PROVIDER_NAME, kind: 'remote', itemTypes: ['Person'], getMetadata: personMetadata, search: personSearch },
      { id: 'TmdbSeasonProvider', name: PROVIDER_NAME, kind: 'remote', itemTypes: ['Season'], getMetadata: seasonMetadata, search: async () => [] },
      ...createTelevisionProviders({ client, parseName }),
      createTmdbMissingEpisodeProvider(client, lifecycle),
      createCollectionProvider({ client, parseName }),
      ...createImageProviders(client),
      ...createExternalProviders(),
    ].map((provider) => provider.kind === 'remote' ? { ...provider, getImageResponse: (url, options = {}) => client.fetch(url, { signal: options.signal }) } : provider),
  };
}
