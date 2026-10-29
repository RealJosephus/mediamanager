export const userId = 'cf100000000000000000000000000001';
export const orphanId = 'cf100000000000000000000000000002';
export const missingId = 'cf100000000000000000000000000003';
export const dtoFields = ['Id', 'Name', 'SortName', 'Type', 'SourceType', 'ChannelId', 'ChannelName', 'CanDelete', 'EnableMediaSourceDisplay', 'Overview', 'OfficialRating', 'ChildCount', 'RecursiveItemCount', 'MediaSourceCount', 'ImageTags'];
const providers = [
  { name: 'Zulu', kind: 'all', description: 'Registered Zulu', parentalRating: 'UsPG13', attributes: ['rEcOrDiNgS'], features: { ContentTypes: ['Movie'], MediaTypes: ['Video'], DefaultSortFields: ['Name'], SupportsSortOrderToggle: true, SupportsContentDownloading: true, AutoRefreshLevels: 2 } },
  { name: 'Alpha', kind: 'plain', description: 'Registered Alpha', features: {} },
  { name: 'Éclair', kind: 'latest', enabled: false, features: { MaxPageSize: 0 } },
];
const seeds = providers.map((provider, index) => ({ providerName: provider.name, Name: 'Saved ' + provider.name, ForcedSortName: ['b', 'á', 'a'][index], Overview: 'Retained overview' }));
const sample = (name, options = {}) => ({ name, providers: structuredClone(providers), seeds: structuredClone(seeds), query: {}, user: true, ...options });
export function makeInput() {
  const bulk = Array.from({ length: 129 }, (_, index) => ({ name: 'Network ' + String(index).padStart(3, '0'), kind: index % 2 ? 'plain' : 'latest', enabled: index % 3 !== 0, features: {} }));
  return { userId, orphanId, missingId, dtoFields, cases: [
    sample('empty registered inventory', { providers: [], seeds: [] }),
    sample('orphan is absent from catalog and Views but participates in Features', { providers: [], seeds: [{ Id: orphanId, Name: 'Orphan', ForcedSortName: 'orphan' }], featureId: orphanId, featuresFail: 404, scalarFail: 404 }),
    sample('empty inventory positive offset validates count', { providers: [], seeds: [], query: { StartIndex: 1 }, catalogFail: 400 }),
    sample('empty inventory negative offset validates index', { providers: [], seeds: [], query: { StartIndex: -1, Limit: -9 }, catalogFail: 400 }),
    sample('empty inventory favorite has no user dereference', { providers: [], seeds: [], user: false, query: { IsFavorite: true } }),
    sample('installed roots are created before markers remove every favorite candidate', {
      providers: [structuredClone(providers[1])], seeds: [], user: false,
      query: { SupportsLatestItems: true, IsFavorite: true },
    }),
    sample('installed roots preserve live SortName and retained fields'),
    sample('unsaved warm name and image remain the actual catalog and Views entity', { seeds: seeds.map(seed => seed.providerName === 'Alpha' ? { ...seed, WarmName: 'Warm unsaved Alpha', WarmImage: true } : seed) }),
    sample('userless catalog does not invoke enablement', { user: false }),
    sample('positive page counts after enablement', { query: { StartIndex: 1, Limit: 1 } }),
    sample('zero limit means remaining items', { query: { Limit: 0 } }),
    sample('negative limit means remaining items', { query: { Limit: -20 } }),
    sample('latest marker true', { query: { SupportsLatestItems: true } }),
    sample('latest marker false', { query: { SupportsLatestItems: false } }),
    sample('deletion marker true', { query: { SupportsMediaDeletion: true } }),
    sample('recordings attributes without case', { query: { IsRecordingsFolder: true } }),
    sample('all marker filters precede favorite', { user: false, query: { SupportsMediaDeletion: false, SupportsLatestItems: true, IsFavorite: true }, catalogFail: 400 }),
    sample('favorite userless fails only on a surviving candidate', { user: false, query: { IsFavorite: false }, catalogFail: 400 }),
    sample('favorite selected by SQL current user key', { favoriteProvider: 'Alpha', query: { IsFavorite: true } }),
    sample('blocked channels preference overrides enabled channels', { policy: { EnableAllChannels: false, EnabledProviderNames: [], BlockedProviderNames: ['Zulu'] } }),
    sample('explicit enabled channels', { policy: { EnableAllChannels: false, EnabledProviderNames: ['Zulu'] } }),
    sample('blocked tag applies before provider enablement', { seeds: seeds.map(seed => ({ ...seed, Tags: seed.providerName === 'Zulu' ? ['blocked'] : [] })), policy: { BlockedTags: ['blocked'] } }),
    sample('missing root is created before enablement excludes it', { seeds: [], query: { SupportsLatestItems: false } }),
    sample('provider exception excludes candidate', { providers: providers.map(value => ({ ...value, failEnabled: value.name === 'Alpha' })) }),
    sample('129 installed providers retain SQL count/page and bounded typed hydration', { providers: bulk,
      seeds: bulk.map((provider, index) => ({ providerName: provider.name, Name: provider.name, ForcedSortName: 'stable ' + String(129 - index).padStart(3, '0') })), query: { StartIndex: 64, Limit: 2 } }),
    sample('culture-equal provider names preserve registration ties', { providers: [{ name: 'a\ufeff', kind: 'all', features: {} }, { name: 'a', kind: 'plain', features: {} }], seeds: [
      { providerName: 'a\ufeff', Name: 'First', ForcedSortName: 'same' }, { providerName: 'a', Name: 'Second', ForcedSortName: 'same' }] }),
    sample('missing scalar feature', { featureId: missingId, scalarFail: 400 }),
    sample('zero scalar feature', { featureId: '00000000000000000000000000000000', scalarFail: 400 }),
    sample('late orphan Features failure preserves earlier actual provider calls', { seeds: [...seeds, { Id: orphanId, Name: 'Late orphan', ForcedSortName: 'zzzz' }], featuresFail: 404 }),
    ...['ContentTypes', 'DefaultSortFields', 'MediaTypes'].map(field => sample('explicit null feature collection: ' + field, {
      providers: [{ name: 'Only', kind: 'all', features: { [field]: null } }], seeds: [{ providerName: 'Only', Name: 'Only' }], featuresFail: 500, scalarFail: 500 })),
    sample('full DTO empty ChannelId fails after successful internal catalog', { seeds: [{ providerName: 'Alpha', Name: 'Alpha', ChannelId: '00000000000000000000000000000000' }], providers: [providers[1]], catalogFail: 400, viewFail: 400 }),
  ], httpCases: [
    { name: 'authenticated empty catalog', path: '/Channels' },
    { name: 'regular default authenticated user', path: '/Channels', identity: 'regular' },
    { name: 'api key userless catalog', path: '/Channels', identity: 'apiKey' },
    { name: 'empty user Guid resolves authenticated user', path: '/Channels?userId=00000000-0000-0000-0000-000000000000' },
    { name: 'unknown Fields are unbound and ignored', path: '/Channels?Fields=NotAField&EnableImages=bad' },
    { name: 'case-insensitive query names and quoted whitespace boolean', path: '/Channels?SuPpOrTsLaTeStItEmS=%20TrUe%20&limit=0' },
    { name: 'repeated simple values bind their first entry', path: '/Channels?limit=0&limit=2' },
    { name: 'all query binding errors aggregate', path: '/Channels?userId=no-guid&startIndex=no-int&limit=2147483648&supportsLatestItems=bad&supportsMediaDeletion=1&isFavorite=0' },
    { name: 'anonymous authentication precedes binding', path: '/Channels?userId=no-guid&limit=no-int', identity: 'anonymous' },
    { name: 'regular cross-user is forbidden', path: '/Channels?userId=' + missingId, identity: 'regular' },
    { name: 'admin unknown user becomes userless', path: '/Channels?userId=' + missingId },
    { name: 'positive offset exact GetRange error', path: '/Channels?startIndex=1' },
    { name: 'Features ignores unrelated broken query', path: '/Channels/Features?userId=bad&startIndex=bad' },
    { name: 'Features route Guid binding', path: '/Channels/bad/Features' },
    { name: 'Features empty Guid actual lookup', path: '/Channels/00000000000000000000000000000000/Features' },
    { name: 'Features retained missing Guid', path: '/Channels/' + missingId + '/Features' },
  ], imageCases: [
    { name: 'no supported images', supportedImages: [], existing: [] },
    { name: 'missing supported images', supportedImages: ['Primary', 'Thumb'], existing: [] },
    { name: 'one supported image remains missing', supportedImages: ['Primary', 'Thumb'], existing: ['Primary'] },
    { name: 'all supported image identities already present', supportedImages: ['Primary', 'Thumb'], existing: ['Primary', 'Thumb'] },
  ], displayCases: [
    { name: 'empty inventory missing referent', providers: [], reference: 'missing', value: true },
    { name: 'nonempty inventory missing referent', providers: [{ name: 'Only', kind: 'display', features: {} }], reference: 'missing', failure: 500 },
    { name: 'display disabled by marker', providers: [{ name: 'Only', kind: 'display', features: {} }], reference: 'provider', value: false },
    { name: 'display lookup does not use provider name fallback', providers: [{ name: 'Only', kind: 'display', features: {} }], reference: 'wrongIdentity', value: true },
    { name: 'display registration order survives equal identity', providers: [{ name: 'Only', kind: 'plain', features: {} }, { name: 'Only', kind: 'display', features: {} }], reference: 'provider', value: true },
    { name: 'empty channel identity fails before empty inventory', providers: [], reference: 'empty', failure: 400 },
  ] };
}
