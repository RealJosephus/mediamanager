import { lowerInvariant, md5Guid } from '../core/identity.js';
import { loadLocalizationData } from '../core/localization-data.js';
import { withNativeFloats } from '../core/json.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';

const subtitleTypes = ['Movie', 'Episode'];
const resultFields = ['ThreeLetterISOLanguageName', 'Name', 'Format', 'Author', 'Comment', 'DateCreated',
  'CommunityRating', 'FrameRate', 'DownloadCount', 'IsHashMatch', 'AiTranslated', 'MachineTranslated', 'Forced', 'HearingImpaired'];
const providerId = name => md5Guid(lowerInvariant(name));
export const subtitleSignalPositions = Object.freeze({ search: 1, getSubtitles: 1 });

export function validateSubtitleExtension(provider) {
  if (!provider?.name?.trim?.() || typeof provider.search !== 'function' || typeof provider.getSubtitles !== 'function'
    || !Array.isArray(provider.supportedMediaTypes) || !provider.supportedMediaTypes.every(type => subtitleTypes.includes(type))
    || provider.order != null && (!Number.isInteger(provider.order) || provider.order < -2147483648 || provider.order > 2147483647)) {
    throw new TypeError('A subtitle extension requires a name, supported media types, search and getSubtitles.');
  }
}

export function copySubtitleProviderResult(method, result) {
  if (method === 'search') {
    if (!Array.isArray(result)) throw new TypeError('Subtitle search must return an array.');
    return result.map(entry => {
      if (typeof entry?.id !== 'string' || !entry.id) throw new TypeError('A subtitle search result requires an identifier.');
      return { id: entry.id, ...structuredClone(Object.fromEntries(resultFields
        .filter(field => entry[field] != null).map(field => [field, entry[field]]))) };
    });
  }
  if (!(result?.bytes instanceof Uint8Array) || typeof result.format !== 'string' || typeof result.language !== 'string') {
    throw new TypeError('A subtitle response requires detached bytes, a format and a language.');
  }
  return { bytes: Buffer.from(result.bytes), format: result.format, language: result.language,
    forced: result.forced === true, hearingImpaired: result.hearingImpaired === true };
}

export async function searchRemoteSubtitles(providers, item, input, options, { signal, onError }) {
  if (!subtitleTypes.includes(item.Type) || ![undefined, null, 'VideoFile'].includes(item.VideoType)) return [];
  const disabled = options.DisabledSubtitleFetchers ?? [], configuredOrder = options.SubtitleFetcherOrder ?? [];
  const order = provider => {
    const index = configuredOrder.indexOf(provider.name);
    return index < 0 ? Infinity : index;
  };
  const eligible = providers.filter(provider => provider.supportedMediaTypes.includes(item.Type)
    && !disabled.some(name => ordinalIgnoreCaseEquals(name, provider.name)))
    .sort((left, right) => (order(left) - order(right) || 0) || (left.order ?? 0) - (right.order ?? 0));
  if (!eligible.length) return [];
  const localization = await loadLocalizationData();
  const request = {
    ContentType: item.Type, Name: item.Name, Language: input.language,
    TwoLetterISOLanguageName: localization.findLanguage(input.language)?.TwoLetterISOLanguageName,
    IndexNumber: item.IndexNumber, ParentIndexNumber: item.ParentIndexNumber, ProductionYear: item.ProductionYear,
    MediaPath: item.Path, ProviderIds: item.ProviderIds instanceof Map ? Object.fromEntries(item.ProviderIds) : { ...item.ProviderIds },
    RuntimeTicks: item.RunTimeTicks, IsPerfectMatch: input.isPerfectMatch ?? false, IsAutomated: input.isAutomated ?? false,
    ...(item.Type === 'Episode' ? { IndexNumberEnd: item.IndexNumberEnd, SeriesName: item.SeriesName } : {}),
  };
  for (const provider of eligible) {
    try {
      const found = await provider.search({ ...request, ProviderIds: { ...request.ProviderIds } }, { signal });
      if (found.length) return found.map(({ id, ...entry }) => withNativeFloats({
        ...entry, Id: providerId(provider.name) + '_' + id, ProviderName: provider.name,
      }, ['CommunityRating', 'FrameRate']));
    } catch (error) {
      signal?.throwIfAborted();
      onError(error);
    }
  }
  return [];
}

export function readRemoteSubtitle(providers, identifier, signal) {
  const separator = identifier.indexOf('_');
  const key = separator < 0 ? identifier : identifier.slice(0, separator);
  const provider = providers.find(entry => providerId(entry.name) === key);
  if (!provider) throw new Error('The subtitle provider was not found.');
  return provider.getSubtitles(identifier.slice(separator + 1), { signal });
}
