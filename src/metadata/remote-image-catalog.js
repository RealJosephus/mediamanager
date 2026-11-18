import { orderRemoteImages } from './images.js';
import { clrTrim } from './whitespace.js';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';

const imageFields = ['ProviderName', 'Url', 'ThumbnailUrl', 'Height', 'Width', 'CommunityRating', 'VoteCount', 'Language', 'Type', 'RatingType'];

export async function remoteImageProviders(registry, loaded, { signal, logger }) {
  const providers = registry?.discover({ ...loaded, kind: 'image', includeDisabled: true,
    onSupportError: (provider, error) => logger.error(error, `Error checking whether ${provider.name} supports the image item`) }) ?? [];
  return Promise.all(providers.filter(provider => provider.imageSource === 'remote').map(async provider => ({ provider,
    info: { Name: provider.name, SupportedImages: [...(provider.imageTypesFor
      ? await provider.imageTypesFor(loaded.item, { ...loaded.context, signal }) : provider.imageTypes ?? [])] },
  })));
}

export async function listRemoteImages(registry, loaded, { signal, logger, type, startIndex = 0, limit, providerName, includeAllLanguages }) {
  const entries = (await remoteImageProviders(registry, loaded, { signal, logger }))
    .filter(({ info }) => type == null || info.SupportedImages.includes(type));
  const language = loaded.item.MetadataLanguage;
  const filterLanguage = !includeAllLanguages && language && clrTrim(language);
  const ordered = await Promise.all(entries.filter(({ provider }) => !providerName || ordinalIgnoreCaseEquals(provider.name, providerName))
    .map(async ({ provider }) => {
      try {
        const result = await provider.getImages(loaded.item, { ...loaded.context, signal }) ?? [];
        const selected = result.filter(image => (type == null || image.Type === type)
          && (!filterLanguage || !image.Language || !clrTrim(image.Language)
            || ordinalIgnoreCaseEquals(language, image.Language) || ordinalIgnoreCaseEquals('en', image.Language)));
        return orderRemoteImages(selected, language);
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.name !== 'AbortError') logger.error(error, `${provider.name} failed while listing remote images`);
        return [];
      }
    }));
  const images = ordered.flat(), available = new Map();
  for (const { info } of entries) {
    const key = ordinalIgnoreCaseKey(info.Name);
    if (!available.has(key)) available.set(key, info.Name);
  }
  const end = limit == null ? undefined : Math.max(0, startIndex) + Math.max(0, limit);
  return { TotalRecordCount: images.length, Providers: [...available.values()],
    Images: images.slice(Math.max(0, startIndex), end).map(image => {
      const values = { ...image, RatingType: image.RatingType ?? 'Score', Type: image.Type ?? 'Primary' };
      return Object.fromEntries(imageFields.filter(name => values[name] != null).map(name => [name, values[name]]));
    }) };
}
