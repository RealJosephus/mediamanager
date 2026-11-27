import { lowerInvariant, md5Guid } from '../core/identity.js';
import { decodeNativeText } from '../core/native-text.js';
import { itemLibraryOptions } from '../library/options.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { writeLyricBytes } from './mutations.js';
import { parseLyrics } from './parser.js';

export const lyricProviderId = name => md5Guid(lowerInvariant(name));
const enabledProviders = service => service.providers().toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0));
const parse = response => response === null ? null : parseLyrics('lyric.' + response.format, decodeNativeText(response.bytes));
const copiedNames = value => value == null ? value : [...value];

export async function searchRemoteLyrics(service, item, { signal, isAutomated = false, libraryOptions = {} } = {}) {
  const request = { mediaPath: item.Path, songName: item.Name, albumName: item.Album,
    albumArtistsNames: copiedNames(item.AlbumArtists), artistNames: copiedNames(item.Artists),
    duration: item.RunTimeTicks, isAutomated, providerIds: new Map() };
  const disabled = libraryOptions.DisabledLyricFetchers ?? [], order = libraryOptions.LyricFetcherOrder ?? [];
  const rank = provider => order.includes(provider.name) ? order.indexOf(provider.name) : Infinity;
  const providers = enabledProviders(service).filter(provider => !disabled.some(name => ordinalIgnoreCaseEquals(name, provider.name)))
    .sort((a, b) => rank(a) - rank(b));
  const results = await Promise.all(providers.map(async provider => {
    try {
      const id = lyricProviderId(provider.name), results = await provider.search(request, { signal }), parsed = [];
      for (const entry of results) {
        const lyrics = parse(entry.lyrics);
        if (lyrics === null) continue;
        lyrics.Metadata = entry.metadata;
        parsed.push({ Id: id + '_' + entry.id, ProviderName: entry.providerName, Lyrics: lyrics });
      }
      return parsed;
    } catch (error) {
      try { void Promise.resolve(service.logger?.error?.(error, 'Error downloading lyrics from ' + provider.name)).catch(() => {}); } catch { }
      return [];
    }
  }));
  return results.flat();
}

function selectedProvider(service, id) {
  const split = id.indexOf('_'), prefix = split < 0 ? id : id.slice(0, split);
  return { provider: enabledProviders(service).find(provider => lyricProviderId(provider.name) === prefix),
    id: split < 0 ? id : id.slice(split + 1) };
}

export async function readRemoteLyrics(service, lyricId, { signal } = {}) {
  const { provider, id } = selectedProvider(service, lyricId);
  if (!provider) return null;
  return parse(await provider.getLyrics(id, { signal }));
}

export async function downloadRemoteLyrics(service, item, lyricId, { signal } = {}) {
  const options = await itemLibraryOptions(service.library, item), { provider, id } = selectedProvider(service, lyricId);
  if (!provider) return null;
  const response = await provider.getLyrics(id, { signal }), parsed = parse(response);
  if (parsed === null) return null;
  await writeLyricBytes(service, item, response.format, response.bytes, options);
  return parsed;
}
