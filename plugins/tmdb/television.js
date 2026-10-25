import { parseTmdbId, imageLanguages, cleanName, findBestMatch, parentalRating, mapCast, crewType, isTrailer, PROVIDER_NAME } from './utils.js';
import { addPerson } from '@mediamanager/plugin-sdk/metadata/people';
import { trySetProviderId } from '@mediamanager/plugin-sdk/metadata/provider-ids';
import { parseSeriesStatus } from '@mediamanager/plugin-sdk/metadata/television';

const year = (value) => value ? Number(value.slice(0, 4)) : null;
// TMDbLib dates are unspecified DateTimes. The providers explicitly convert selected dates from local time.
const date = (value, local = false) => value ? local ? new Date(value + 'T00:00:00').toISOString() : value + 'T00:00:00' : null;
const putIds = (item, source = {}) => {
  for (const [key, value] of [['Imdb', source.imdb_id], ['Tvdb', source.tvdb_id], ['TvRage', source.tvrage_id]]) {
    if (value != null) trySetProviderId(item, key, String(value));
  }
};
const unique = (values) => values.reduce((result, value) => {
  if (value?.trim() && !result.some((entry) => entry.toLowerCase() === value.trim().toLowerCase())) result.push(value.trim());
  return result;
}, []);

function addCrew(people, crew, client) {
  const config = client.configuration;
  for (const entry of (crew ?? []).map((member) => ({ member, type: crewType(member) }))
    .filter(({ type, member }) => type !== 'Unknown' && (!config.HideMissingCrewMembers || member.profile_path))
    .slice(0, Math.max(0, config.MaxCrewMembers))) {
    const member = entry.member;
    if (!member.name?.trim()) continue;
    addPerson(people, { Name: member.name.trim(), Role: member.job?.trim() ?? '', Type: entry.type,
      ImageUrl: client.imageUrl(member.profile_path, config.ProfileSize), ProviderIds: member.id > 0 ? { Tmdb: String(member.id) } : {} });
  }
}

function episodePeople(remote, client) {
  const people = []; const config = client.configuration;
  for (const [key, type] of [['cast', 'Actor'], ['guest_stars', 'GuestStar']]) {
    for (const member of (remote.credits?.[key] ?? []).filter((member) => !config.HideMissingCastMembers || member.profile_path)
      .sort((a, b) => (a.order ?? -Infinity) - (b.order ?? -Infinity)).slice(0, Math.max(0, config.MaxCastMembers))) {
      if (!member.name?.trim()) continue;
      addPerson(people, { Name: member.name.trim(), Role: member.character?.trim() ?? '', Type: type, SortOrder: member.order ?? null,
        ImageUrl: client.imageUrl(member.profile_path, config.ProfileSize), ProviderIds: member.id > 0 ? { Tmdb: String(member.id) } : {} });
    }
  }
  addCrew(people, remote.credits?.crew, client);
  return people;
}

export function createTelevisionProviders({ client, parseName }) {
  const seriesSearch = async (info, options = {}) => {
    const language = info.MetadataLanguage; const country = info.MetadataCountryCode;
    const map = (remote, details = false) => {
      const result = { Name: remote.name ?? remote.original_name, SearchProviderName: PROVIDER_NAME,
        ImageUrl: client.imageUrl(remote.poster_path, client.configuration.PosterSize), Overview: remote.overview,
        PremiereDate: date(remote.first_air_date, true), ProductionYear: year(remote.first_air_date), ProviderIds: { Tmdb: String(remote.id) } };
      if (details) { putIds(result, { imdb_id: remote.external_ids?.imdb_id, tvdb_id: remote.external_ids?.tvdb_id }); }
      return result;
    };
    const id = parseTmdbId(info.ProviderIds?.Tmdb);
    if (id) { const remote = await client.series(id, language, language, country, options); if (remote) return [map(remote, true)]; }
    for (const [key, source] of [['Imdb', 'imdb_id'], ['Tvdb', 'tvdb_id']]) {
      if (!info.ProviderIds?.[key]) continue;
      const results = (await client.find(info.ProviderIds[key], source, language, country, options))?.tv_results;
      if (results != null) return results.map((remote) => { const result = map(remote); trySetProviderId(result, key, info.ProviderIds[key]); return result; });
    }
    return (await client.search('Series', info.Name, 0, language, country, options) ?? []).map((remote) => map(remote));
  };
  const seriesMetadata = async (info, options = {}) => {
    const language = info.MetadataLanguage; const country = info.MetadataCountryCode;
    let id = info.ProviderIds?.Tmdb; let queriedById = true;
    for (const [key, source] of [['Imdb', 'imdb_id'], ['Tvdb', 'tvdb_id']]) {
      if (!id && info.ProviderIds?.[key]) id = (await client.find(info.ProviderIds[key], source, language, country, options))?.tv_results?.[0]?.id?.toString();
    }
    if (!id) {
      queriedById = false;
      if (!parseName) throw new Error('Series name identification requires the host baseline ParseName implementation.');
      const parsed = parseName(info.Name); const searchYear = info.Year ?? parsed.Year ?? 0;
      id = findBestMatch(await client.search('Series', cleanName(parsed.Name), searchYear, language, country, options), parsed.Name, searchYear, 'Series')?.id?.toString();
    }
    // Unlike TryParseTmdbId, this source branch uses Int32.TryParse with integer whitespace/sign handling.
    if (!id || !/^\s*[+-]?\d+\s*$/.test(id) || Number(id) < -2147483648 || Number(id) > 2147483647) return { HasMetadata: false, QueriedById: queriedById };
    options.signal?.throwIfAborted();
    const remote = await client.series(Number(id), language, imageLanguages(language, country), country, options);
    if (!remote) return { HasMetadata: false, QueriedById: queriedById };
    const item = { Type: 'Series', Name: remote.name, OriginalTitle: remote.original_name, ProviderIds: { Tmdb: String(remote.id) },
      CommunityRating: Math.fround(remote.vote_average ?? 0), Overview: remote.overview,
      Studios: unique([...(remote.networks ?? []), ...(remote.production_companies ?? [])].map((entry) => entry.name)),
      Genres: (remote.genres ?? []).map((entry) => entry.name), Tags: unique((remote.keywords?.results ?? []).map((entry) => entry.name)),
      HomePageUrl: remote.homepage, RunTimeTicks: remote.episode_run_time == null ? null : BigInt(remote.episode_run_time[0] ?? 0) * 600000000n,
      EndDate: date(remote.last_air_date), PremiereDate: date(remote.first_air_date), ProductionYear: year(remote.first_air_date) };
    const status = parseSeriesStatus(remote.status); if (status != null) item.Status = status;
    putIds(item, remote.external_ids);
    const ratings = remote.content_ratings?.results ?? [];
    const regional = ratings.find((entry) => entry.iso_3166_1?.toLowerCase() === country?.toLowerCase());
    const us = ratings.find((entry) => entry.iso_3166_1?.toLowerCase() === 'us');
    if (regional?.rating != null) item.OfficialRating = parentalRating(country, regional.rating);
    else if (us?.rating != null) item.OfficialRating = us.rating;
    else if (ratings[0]?.rating != null) item.OfficialRating = ratings[0].rating;
    if (remote.videos?.results) item.RemoteTrailers = [...remote.videos.results].sort((a, b) => Number(b.type?.toLowerCase() === 'trailer') - Number(a.type?.toLowerCase() === 'trailer'))
      .filter(isTrailer).map((video) => ({ Url: 'https://www.youtube.com/watch?v=' + video.key, Name: video.name }));
    if (remote.original_language) item.OriginalLanguage = remote.original_language;
    const people = []; const aggregate = remote.aggregate_credits?.cast?.length > 0;
    for (const person of mapCast(aggregate ? remote.aggregate_credits.cast : remote.credits?.cast, client.configuration,
      (path) => client.imageUrl(path, client.configuration.ProfileSize), aggregate)) addPerson(people, person);
    addCrew(people, remote.credits?.crew, client);
    for (const person of remote.created_by ?? []) if (person.name?.trim()) addPerson(people, { Name: person.name.trim(), Type: 'Creator',
      ImageUrl: client.imageUrl(person.profile_path, client.configuration.ProfileSize), ProviderIds: person.id > 0 ? { Tmdb: String(person.id) } : {} });
    // The native provider replaces MetadataResult here, resetting QueriedById to its default.
    return { HasMetadata: true, QueriedById: false, ResultLanguage: language ?? remote.original_language, Item: item, People: people.length ? people : null };
  };
  const episodeMetadata = async (info, options = {}) => {
    const id = parseTmdbId(info.SeriesProviderIds?.Tmdb);
    if (info.IsMissingEpisode || id == null || info.IndexNumber == null) return { HasMetadata: false };
    const season = info.ParentIndexNumber ?? 1; const number = info.IndexNumber;
    const fetch = (index) => client.episode(id, season, index, info.SeriesDisplayOrder, info.MetadataLanguage,
      imageLanguages(info.MetadataLanguage, info.MetadataCountryCode), info.MetadataCountryCode, options);
    let remote;
    if (info.IndexNumberEnd != null) {
      const results = [];
      for (let index = number; index <= info.IndexNumberEnd; index++) { options.signal?.throwIfAborted(); const value = await fetch(index); if (value) results.push(value); }
      if (results.length) remote = results.length === 1 ? { ...results[0] }
        : { ...results[0], name: results.map((entry) => entry.name ?? '').join(' / '), overview: results.map((entry) => entry.overview ?? '').join(' / ') };
    } else remote = await fetch(number);
    if (!remote) return { HasMetadata: false };
    const item = { Type: 'Episode', IndexNumber: number, ParentIndexNumber: season, IndexNumberEnd: info.IndexNumberEnd ?? null,
      Name: remote.name, PremiereDate: date(remote.air_date, true), ProductionYear: year(remote.air_date), Overview: remote.overview,
      CommunityRating: Math.fround(remote.vote_average ?? 0), ProviderIds: {} };
    putIds(item, remote.external_ids);
    if (remote.videos?.results) item.RemoteTrailers = unique(remote.videos.results.filter(isTrailer).map((video) => 'https://www.youtube.com/watch?v=' + video.key)).map((Url) => ({ Url }));
    const people = episodePeople(remote, client);
    return { HasMetadata: true, QueriedById: true, ...(remote.overview ? { ResultLanguage: info.MetadataLanguage } : {}), Item: item, People: people.length ? people : null };
  };
  const episodeSearch = async (info, options = {}) => {
    if (info.IndexNumber == null) return [];
    const result = await episodeMetadata(info, options); if (!result.HasMetadata) return [];
    const item = result.Item;
    return [{ IndexNumber: item.IndexNumber, Name: item.Name, ParentIndexNumber: item.ParentIndexNumber, PremiereDate: item.PremiereDate,
      ProductionYear: item.ProductionYear, ProviderIds: item.ProviderIds, SearchProviderName: PROVIDER_NAME, IndexNumberEnd: item.IndexNumberEnd }];
  };
  return [
    { id: 'TmdbSeriesProvider', name: PROVIDER_NAME, kind: 'remote', itemTypes: ['Series'], order: 1, getMetadata: seriesMetadata, search: seriesSearch },
    { id: 'TmdbEpisodeProvider', name: PROVIDER_NAME, kind: 'remote', itemTypes: ['Episode'], order: 1, getMetadata: episodeMetadata, search: episodeSearch },
  ];
}
