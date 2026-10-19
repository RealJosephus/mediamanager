import { PROVIDER_NAME, parseTmdbId } from './utils.js';

export function createImageProviders(client) {
  const definitions = [
    ['Movie', ['Movie', 'Trailer'], 0, ['Primary', 'Backdrop', 'Logo', 'Thumb']],
    ['Series', ['Series'], 2, ['Primary', 'Backdrop', 'Logo', 'Thumb']],
    ['Season', ['Season'], 1, ['Primary']], ['Episode', ['Episode'], 1, ['Primary']],
    ['Person', ['Person'], 0, ['Primary']], ['BoxSet', ['BoxSet'], 0, ['Primary', 'Backdrop', 'Thumb']],
  ];
  return definitions.map(([type, itemTypes, order, imageTypes]) => ({
    id: `Tmdb${type}ImageProvider`, name: PROVIDER_NAME, kind: 'image', imageSource: 'remote', itemTypes, order, imageTypes,
    async getImages(item, options = {}) {
      const language = item.MetadataLanguage; const country = item.MetadataCountryCode;
      let id = parseTmdbId(item.ProviderIds?.Tmdb); let remote;
      if (type === 'Movie') {
        if (!id && item.ProviderIds?.Imdb) id = (await client.find(item.ProviderIds.Imdb, 'imdb_id', language, country, options))?.movie_results?.[0]?.id;
        if (id > 0) remote = await client.movie(id, null, null, null, options);
      } else if (type === 'Series') {
        if (id) remote = await client.series(id, null, null, null, options);
      } else if (type === 'BoxSet') {
        if (id) remote = await client.collection(id, null, null, null, options);
      } else if (type === 'Person') {
        if (id) remote = await client.person(id, language, country, options);
      } else {
        id = parseTmdbId(item.SeriesProviderIds?.Tmdb);
        if (id == null || item.IndexNumber == null) return [];
        remote = type === 'Season' ? await client.season(id, item.IndexNumber, null, null, null, options)
          : await client.episode(id, item.ParentIndexNumber ?? 1, item.IndexNumber, item.SeriesDisplayOrder, null, null, null, options);
      }
      if (!remote?.images) return [];
      const groups = type === 'Person' ? [['profiles', 'Profile']] : type === 'Episode' ? [['stills', 'Still']]
        : type === 'Season' ? [['posters', 'Poster']] : [['posters', 'Poster'], ['backdrops', 'Backdrop'], ...(type === 'BoxSet' ? [] : [['logos', 'Logo']])];
      return groups.flatMap(([key, kind]) => client.convertImages(remote.images[key] ?? [], kind, language));
    },
    getImageResponse: (url, options = {}) => client.fetch(url, { signal: options.signal }),
  }));
}
