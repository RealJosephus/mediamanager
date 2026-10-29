export const movieId = 550;
export const configuration = { MaxCastMembers: 0, MaxCrewMembers: 0 };
export const cultures = [
  { language: 'en-US', country: 'US', itemId: 'a7c20000-0000-0000-0000-000000000001' },
  { language: 'zh-TW', country: 'TW', itemId: 'a7c20000-0000-0000-0000-000000000002' },
];

export const itemFields = ['Type', 'Name', 'OriginalTitle', 'Overview', 'Tagline', 'ProductionLocations',
  'ProviderIds', 'CommunityRating', 'PremiereDate', 'ProductionYear', 'Studios', 'Genres', 'Tags',
  'TmdbCollectionName', 'OfficialRating', 'RemoteTrailers', 'OriginalLanguage'];

export function requestShape(value) {
  const url = new URL(value);
  const query = [...url.searchParams].filter(([key]) => key.toLowerCase() !== 'api_key')
    .map(([key, entry]) => [key, key === 'append_to_response' ? entry.split(',').sort().join(',') : entry])
    .toSorted(([left, a], [right, b]) => left.localeCompare(right) || a.localeCompare(b));
  return { origin: url.origin, path: url.pathname, query };
}

export function providerProjection(value) {
  const result = { HasMetadata: value.HasMetadata, ResultLanguage: value.ResultLanguage ?? null, Item: null, People: value.People ?? [] };
  if (!value.Item) return result;
  result.Item = Object.fromEntries(itemFields.map(key => [key, value.Item[key] ?? null]));
  if (result.Item.PremiereDate != null) result.Item.PremiereDate = result.Item.PremiereDate.replace(/(?:\.0+)?Z?$/u, '') + 'Z';
  if (result.Item.CommunityRating != null) result.Item.CommunityRating = Math.fround(result.Item.CommunityRating);
  for (const key of ['ProductionLocations', 'Studios', 'Genres', 'Tags', 'RemoteTrailers']) result.Item[key] ??= [];
  return result;
}
