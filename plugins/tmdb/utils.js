import { lowerInvariant } from '@mediamanager/plugin-sdk/core/identity';
export const TMDB_ID = 'b8715ed1-6c47-4528-9ad3-f72deb539cd4';
export const PROVIDER_NAME = 'TheMovieDb';

export function parseTmdbId(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;
  const id = Number(value);
  return id > 0 && id <= 2147483647 ? id : null;
}

export const cleanName = (name) => name.replace(/[^\p{L}\p{N}\p{M}·]+/gu, ' ').trim();
export const normalizeTitle = (title) => lowerInvariant((title ?? '').replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim());

export function findBestMatch(results, name, year, kind = 'Movie') {
  if (!results?.length) return null;
  const normalized = normalizeTitle(name);
  if (!normalized) return results[0];
  let best = results[0];
  let score = 0;
  const titleScore = (value) => {
    const title = normalizeTitle(value);
    return title === normalized ? 8 : title.startsWith(normalized + ' ') ? 4 : 0;
  };
  for (const result of results) {
    const title = kind === 'Series' ? result.name : result.title;
    const original = kind === 'Series' ? result.original_name : result.original_title;
    const date = kind === 'Series' ? result.first_air_date : result.release_date;
    const distance = year > 0 && date ? Math.abs(Number(date.slice(0, 4)) - year) : Infinity;
    const candidate = Math.max(titleScore(title), titleScore(original)) + (distance === 0 ? 2 : distance === 1 ? 1 : 0);
    if (candidate > score) { best = result; score = candidate; }
  }
  return best;
}

export function normalizeLanguage(language, countryCode) {
  if (!language) return language;
  if (language.toLowerCase() === 'es-419' && countryCode) language = countryCode.toLowerCase() === 'ar' ? 'es-AR' : 'es-MX';
  const parts = language.split('-');
  if (parts.length !== 2) return language;
  return parts[1].toLowerCase() === 'ch' ? parts[0] : parts[0] + '-' + parts[1].toUpperCase();
}

export function imageLanguages(language, countryCode) {
  const normalized = normalizeLanguage(language, countryCode);
  return [...(normalized ? [normalized] : []), 'null', ...(normalized?.toLowerCase() === 'en' ? [] : ['en'])].join(',');
}

export function adjustImageLanguage(imageLanguage, requestLanguage) {
  if (!imageLanguage) return '';
  if (requestLanguage?.length > 2 && imageLanguage.length === 2 && requestLanguage.toLowerCase().startsWith(imageLanguage.toLowerCase())) return requestLanguage;
  return imageLanguage.toLowerCase() === 'xx' ? '' : imageLanguage;
}

export const isOriginalImageSize = (size) => !size || size.toLowerCase() === 'original';
export const parentalRating = (country, value) => ((country.toLowerCase() === 'us' ? '' : country + '-') + value).replace(/DE-/gi, 'FSK-');
export const isTrailer = (video) => video.site?.toLowerCase() === 'youtube' && ['trailer', 'teaser'].includes(video.type?.toLowerCase());

export function crewType(crew) {
  const department = crew.department?.toLowerCase();
  const job = crew.job?.toLowerCase();
  if (department === 'directing' && job === 'director') return 'Director';
  if (department === 'production' && job === 'producer') return 'Producer';
  if (department === 'writing' && ['writer', 'screenplay', 'novel'].includes(job)) return 'Writer';
  return 'Unknown';
}

export function mapCast(cast, config, getProfileUrl, aggregate = false) {
  return (cast ?? []).filter((entry) => entry.name?.trim())
    .filter((entry) => !config.HideMissingCastMembers || entry.profile_path)
    .sort((a, b) => (a.order ?? -Infinity) - (b.order ?? -Infinity))
    .slice(0, Math.max(0, config.MaxCastMembers))
    .flatMap((member) => {
      let roles = aggregate ? member.roles?.filter((role) => role.character?.trim()).sort((a, b) => b.episode_count - a.episode_count).map((role) => role.character.trim()) : [member.character?.trim() ?? ''];
      if (!roles?.length) roles = [''];
      return roles.map((role) => ({ Name: member.name.trim(), Role: role, Type: 'Actor', SortOrder: member.order ?? null, ImageUrl: getProfileUrl(member.profile_path), ProviderIds: member.id > 0 ? { Tmdb: String(member.id) } : {} }));
    });
}
