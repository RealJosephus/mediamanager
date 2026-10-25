import { PROVIDER_NAME, parseTmdbId, imageLanguages, cleanName } from './utils.js';

export function createCollectionProvider({ client, parseName }) {
  const search = async (info, options = {}) => {
    const id = parseTmdbId(info.ProviderIds?.Tmdb);
    const map = (remote) => ({ Name: remote.name, SearchProviderName: PROVIDER_NAME,
      ImageUrl: client.imageUrl(remote.poster_path, client.configuration.PosterSize), ProviderIds: { Tmdb: String(remote.id) } });
    if (id) {
      const remote = await client.collection(id, info.MetadataLanguage, imageLanguages(info.MetadataLanguage, info.MetadataCountryCode), info.MetadataCountryCode, options);
      if (!remote) return [];
      const result = map(remote); if (remote.images == null) delete result.ImageUrl;
      return [result];
    }
    return (await client.search('BoxSet', info.Name, null, info.MetadataLanguage, info.MetadataCountryCode, options) ?? []).map(map);
  };
  const getMetadata = async (info, options = {}) => {
    let id = parseTmdbId(info.ProviderIds?.Tmdb);
    if (!id) {
      if (!parseName) throw new Error('Collection name identification requires the host baseline ParseName implementation.');
      id = (await client.search('BoxSet', cleanName(parseName(info.Name).Name), null, info.MetadataLanguage, info.MetadataCountryCode, options))?.[0]?.id;
    }
    const result = { HasMetadata: false, ResultLanguage: info.MetadataLanguage };
    if (!(id > 0)) return result;
    const remote = await client.collection(id, info.MetadataLanguage, imageLanguages(info.MetadataLanguage, info.MetadataCountryCode), info.MetadataCountryCode, options);
    return remote ? { ...result, HasMetadata: true, Item: { Type: 'BoxSet', Name: remote.name, Overview: remote.overview, ProviderIds: { Tmdb: String(remote.id) } } } : result;
  };
  return { id: 'TmdbBoxSetProvider', name: PROVIDER_NAME, kind: 'remote', itemTypes: ['BoxSet'], search, getMetadata };
}
