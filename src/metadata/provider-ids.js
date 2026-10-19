import { clrTrim } from './whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
const names = 'Custom Imdb Tmdb Tvdb Tvcom TmdbCollection MusicBrainzAlbum MusicBrainzAlbumArtist MusicBrainzArtist MusicBrainzReleaseGroup Zap2It TvRage AudioDbArtist AudioDbAlbum MusicBrainzTrack TvMaze MusicBrainzRecording'.split(' ');
const positive = new Set(['Tmdb', 'TmdbCollection', 'AudioDbArtist', 'AudioDbAlbum']);

export function isValidProviderId(name, value) {
  if (!name?.trim() || !value?.trim()) return false;
  const canonical = names.find(entry => entry.toLowerCase() === name.toLowerCase());
  if (positive.has(canonical)) return /^[0-9]+$/.test(value) && Number(value) > 0 && Number(value) <= 2147483647;
  if (canonical === 'Imdb') return /^(tt|nm|co|ev|ch|ni)?[0-9]+$/i.test(value);
  if (canonical?.startsWith('MusicBrainz')) {
    const unwrapped = value.trim().replace(/^[{(]|[})]$/g, '');
    return /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(unwrapped);
  }
  return true;
}

export function trySetProviderId(item, name, value, { ignoreCase = true } = {}) {
  if (name == null || value == null || !clrTrim(name) || !clrTrim(value) || name.includes('=')) return false;
  name = clrTrim(name); value = clrTrim(value);
  const canonical = names.find((entry) => entry.toLowerCase() === name.toLowerCase()) ?? name;
  if (positive.has(canonical) && (!/^[0-9]+$/.test(value) || Number(value) <= 0 || Number(value) > 2147483647)) return false;
  if (canonical === 'Imdb' && !/^(tt|nm|co|ev|ch|ni)?[0-9]+$/i.test(value)) return false;
  if (canonical.startsWith('MusicBrainz')) {
    const unwrapped = value.replace(/^[{(]|[})]$/g, '');
    if (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(unwrapped)) return false;
  }
  const existing = Object.keys(item.ProviderIds ?? {}).find(key => ignoreCase ? ordinalIgnoreCaseEquals(key, canonical) : key === canonical);
  Object.defineProperty(item.ProviderIds ??= {}, existing ?? canonical, {
    value, enumerable: true, writable: true, configurable: true
  });
  return true;
}
