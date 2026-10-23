export const userId = 'ce200000000000000000000000000001';
export const fields = ['Path', 'Overview', 'Genres', 'Tags', 'ProviderIds', 'DateCreated', 'ParentId'];
const media = (Id, ordinal, extra = {}) => ({ Id, Name: 'Latest ' + Id, MediaType: 'Video', ContentType: 'Movie',
  DateCreated: `2026-10-02T03:04:${String(ordinal).padStart(2, '0')}.1234567Z`,
  DateModified: '2026-10-03T03:04:05.1234567Z', ...extra });
const folder = (Id, FolderType, extra = {}) => media(Id, 1, { Type: 'Folder', FolderType, ...extra });
const result = (...Items) => ({ Items });
const provider = (responses, extra = {}) => ({ name: 'Only', type: 'LatestProvider', dataVersion: 'current',
  cacheKey: '', latest: true, responses, ...extra });
const latest = (name, query = {}) => ({ kind: 'parent-latest', name, provider: 'Only', query });
const persisted = (Type, ExternalId, ParentExternalId, ordinal, extra = {}) => ({ Type, ExternalId, ParentExternalId,
  Name: 'Latest ' + ExternalId, DateCreated: media(ExternalId, ordinal).DateCreated,
  PresentationUniqueKey: 'persisted-channel:' + ExternalId, ...extra });

export function makeInput() {
  return { userId, fields, cases: [
    { name: 'Channel refresh before metadata completion, typed filters and user state', providers: [provider({
      root: [result(folder('album', 'MusicAlbum'), folder('series', 'Series', { Tags: ['BlockedContainer'] }),
        folder('ordinary-folder', 'Container'), media('root-movie', 8), media('restricted-movie', 7, { Tags: ['BlockedLeaf'] }))],
      album: [result(media('song-one', 14, { MediaType: 'Audio', ContentType: 'Song', Artists: ['Original Artist'], AlbumArtists: ['Original Artist'] }),
        media('song-two', 13, { MediaType: 'Audio', ContentType: 'Song', Artists: ['Original Artist'], AlbumArtists: ['Original Artist'] }))],
      series: [result(media('episode-one', 12, { ContentType: 'Episode', SeriesName: 'Original Series', IndexNumber: 1, Tags: ['AllowedLeaf'] }),
        media('episode-two', 11, { ContentType: 'Episode', SeriesName: 'Original Series', IndexNumber: 2, Tags: ['AllowedLeaf'] }))],
      'ordinary-folder': [result(media('nested-movie', 10), folder('unrefreshed-deep', 'Container'))],
      'unrefreshed-deep': [result(media('too-deep', 59))],
    })], steps: [
      latest('initial refresh with unpopulated presentation identities'), latest('cache hit retains candidate identity collapse'),
      latest('ungrouped bounded candidates', { Limit: 4, GroupItems: false }),
      latest('single audio returns its channel album DTO', { Limit: 1, IncludeItemTypes: ['Audio'] }),
      latest('two audio tracks count within candidate cap', { Limit: 2, IncludeItemTypes: ['Audio'] }),
      latest('single episode stays leaf', { Limit: 1, IncludeItemTypes: ['Episode'] }),
      latest('unpopulated episode identities retain one leaf', { Limit: 2, IncludeItemTypes: ['Episode'] }),
      latest('folder type cannot evade IsFolder false', { IncludeItemTypes: ['MusicAlbum'] }),
      latest('zero limit', { Limit: 0 }), latest('negative limit keeps first group only', { Limit: -1 }),
      { kind: 'played', externalIds: ['song-one', 'episode-two'] },
      { kind: 'policy', hidePlayed: true, blockedTags: ['BlockedLeaf'] },
      latest('HidePlayedInLatest default and blocked leaf'),
      latest('explicit played true overrides preference', { IsPlayed: true }),
      latest('explicit played false and audio types', { IsPlayed: false, IncludeItemTypes: ['Audio'] }),
      latest('single unplayed episode remains leaf', { IsPlayed: false, IncludeItemTypes: ['Episode'] }),
      { kind: 'policy', hidePlayed: false, blockedTags: ['BlockedLeaf', 'BlockedContainer'] },
      latest('blocked channel series tags also block episodes', { IncludeItemTypes: ['Episode'] }),
      { kind: 'policy', blockedTags: ['BlockedLeaf'], allowedTags: ['AllowedLeaf'] },
      latest('allowed episode tags retain the collapsed leaf', { IncludeItemTypes: ['Episode'] }),
      { kind: 'policy', allowedTags: [] },
      { kind: 'channel-latest-types', provider: 'Only', query: { IncludeItemTypes: ['Audio'], Limit: 1 } },
      { kind: 'channel-items-types', provider: 'Only', query: { IncludeItemTypes: ['Movie'], Limit: 20 } },
      { kind: 'policy', enableAllChannels: false }, latest('explicit parent remains selected without enabled channels'),
      { kind: 'policy', enableAllChannels: true }, latest('channel permission restored'),
    ] },
    { name: 'Trailer provider ordering survives Channel parent Latest', providers: [provider({ root: [result(
      media('older-release-newer-created', 20, { PremiereDate: '2024-01-01T00:00:00Z', ProductionYear: 2024 }),
      media('newer-release-older-created', 10, { PremiereDate: '2025-01-01T00:00:00Z', ProductionYear: 2025 }))] },
      { type: 'ControlledTrailerProvider' })], steps: [latest('trailer release order', { GroupItems: false }), latest('trailer first release', { Limit: 1 })] },
    { name: 'Provider without Latest marker returns empty after ordinary refresh', providers: [provider({ root: [result(media('retained', 10))] },
      { latest: false, type: 'ControlledProvider' })], steps: [{ kind: 'channel-items-types', provider: 'Only', query: { IncludeItemTypes: ['Movie'] } }, latest('no latest marker')] },
    { name: 'Retained Channel without installed provider has empty Latest', providers: [], orphan: true,
      steps: [{ ...latest('no installed provider'), provider: 'Absent' }] },
    { name: 'Persisted channel albums and series group distinct media identities', providers: [provider({
      root: [result(folder('typed-album', 'MusicAlbum'), folder('typed-series', 'Series', { Tags: ['BlockedContainer'] }))],
      'typed-album': [result(media('typed-song-one', 24, { MediaType: 'Audio', ContentType: 'Song' }),
        media('typed-song-two', 23, { MediaType: 'Audio', ContentType: 'Song' }))],
      'typed-series': [result(media('typed-episode-one', 22, { ContentType: 'Episode', SeriesName: 'Latest typed-series', IndexNumber: 1, Tags: ['AllowedLeaf'] }),
        media('typed-episode-two', 21, { ContentType: 'Episode', SeriesName: 'Latest typed-series', IndexNumber: 2, Tags: ['AllowedLeaf'] }))],
    })], persistedProvider: 'Only', persistedItems: [
      persisted('MusicAlbum', 'typed-album', null, 1),
      persisted('Series', 'typed-series', null, 1, { Tags: ['BlockedContainer'] }),
      persisted('Audio', 'typed-song-one', 'typed-album', 24),
      persisted('Audio', 'typed-song-two', 'typed-album', 23),
      persisted('Episode', 'typed-episode-one', 'typed-series', 22, { IndexNumber: 1, Tags: ['AllowedLeaf'] }),
      persisted('Episode', 'typed-episode-two', 'typed-series', 21, { IndexNumber: 2, Tags: ['AllowedLeaf'] }),
    ], steps: [
      latest('persisted single audio returns its channel album DTO', { Limit: 1, IncludeItemTypes: ['Audio'] }),
      latest('persisted audio group counts both candidates', { Limit: 2, IncludeItemTypes: ['Audio'] }),
      latest('persisted audio remains two leaves without grouping', { Limit: 2, IncludeItemTypes: ['Audio'], GroupItems: false }),
      latest('persisted single episode remains a leaf', { Limit: 1, IncludeItemTypes: ['Episode'] }),
      latest('persisted distinct episodes return their series', { Limit: 2, IncludeItemTypes: ['Episode'] }),
      latest('persisted episodes remain two leaves without grouping', { Limit: 2, IncludeItemTypes: ['Episode'], GroupItems: false }),
      { kind: 'policy', blockedTags: ['BlockedContainer'] },
      latest('blocked persisted series tags block its episodes', { IncludeItemTypes: ['Episode'] }),
      { kind: 'policy', blockedTags: [], allowedTags: ['AllowedLeaf'] },
      latest('persisted grouped series skips a second visibility pass', { IncludeItemTypes: ['Episode'] }),
      { kind: 'played', externalIds: ['typed-episode-two'] },
      latest('persisted unplayed episode remains a leaf', { IsPlayed: false, IncludeItemTypes: ['Episode'] }),
      latest('persisted played episode remains a leaf', { IsPlayed: true, IncludeItemTypes: ['Episode'] }),
    ] },
  ] };
}
