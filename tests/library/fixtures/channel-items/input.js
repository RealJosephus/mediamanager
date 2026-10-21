export const userId = 'ce100000000000000000000000000001';
export const fields = ['Path', 'Overview', 'Genres', 'Tags', 'ProviderIds', 'DateCreated', 'MediaSources', 'MediaStreams', 'MediaSourceCount'];
const item = (Id, extra = {}) => ({ Id, Name: 'Item ' + Id, MediaType: 'Video', ContentType: 'Movie',
  DateCreated: '2026-10-02T03:04:05.1234567Z', DateModified: '2026-10-03T03:04:05.1234567Z', ...extra });
const source = (Path, extra = {}) => ({ mode: 'native', mediaSource: { Path, Protocol: 'Http', ...extra } });
const result = (...Items) => ({ Items });
const provider = (responses, extra = {}) => ({ name: 'Only', type: 'ControlledProvider', dataVersion: 'v1', cacheKey: '', responses, ...extra });
export function makeInput() {
  const path = 'https://channel.invalid/original.mkv';
  const folder = item('folder', { Type: 'Folder', FolderType: 'Container', Name: 'Root folder' });
  return { userId, fields, cases: [
    { name: 'typed classes, original source defaults and cache hit', providers: [provider({ root: [result(
      item('movie', { MediaSources: [source(path)], Genres: ['Drama'], ProviderIds: { Imdb: 'tt123' } }),
      item('audio', { MediaType: 'Audio', ContentType: 'Song', Artists: ['A'], AlbumArtists: ['AA'], RunTimeTicks: '9007199254740993' }),
      item('podcast', { MediaType: 'Audio', ContentType: 'Podcast' }), folder,
      item('series', { Type: 'Folder', FolderType: 'Series' }), item('season', { Type: 'Folder', FolderType: 'Season', IndexNumber: 1 }),
      item('album', { Type: 'Folder', FolderType: 'MusicAlbum' }), item('artist', { Type: 'Folder', FolderType: 'MusicArtist' }),
      item('photos', { Type: 'Folder', FolderType: 'PhotoAlbum' }), item('episode', { ContentType: 'Episode', SeriesName: 'Series' }),
      item('trailer', { ContentType: 'Trailer', TrailerTypes: ['ComingSoonToTheaters'] }), item('photo-media', { MediaType: 'Photo', ContentType: 'Clip' }))] })],
      steps: [{ kind: 'items', http: true, provider: 'Only', query: { OrderBy: [['Name', 'Ascending']], Limit: 5 } }, { kind: 'items', provider: 'Only', query: { IsFolder: false, StartIndex: 1, Limit: 2 } }] },
    { name: 'filtered paged dead selection is fixed before deletion', providers: [provider({ root: [result(item('a'), item('b'), item('c')), result(item('a'))] })],
      steps: [{ kind: 'items', provider: 'Only' }, { kind: 'expire' }, { kind: 'items', provider: 'Only', query: { OrderBy: [['Name', 'Ascending']], StartIndex: 1, Limit: 1 } }, { kind: 'items', provider: 'Only' }] },
    { name: 'warm media mutations stay unsaved without force', providers: [provider({ root: [result(item('same', { MediaSources: [source(path)], RunTimeTicks: 20 })),
      result(item('same', { Name: 'Unpersisted replacement', MediaSources: [source('https://channel.invalid/changed.mkv')], RunTimeTicks: 40 }))] })],
      steps: [{ kind: 'items', provider: 'Only' }, { kind: 'expire' }, { kind: 'items', provider: 'Only' }] },
    { name: 'late null genres leaves cache and committed first item', providers: [provider({ root: [result(item('first'), item('bad', { Genres: null }))] })],
      steps: [{ kind: 'items', provider: 'Only', failure: 500 }, { kind: 'items', provider: 'Only' }] },
    { name: 'null Items is cached before failure then fresh hit skips it', providers: [provider({ root: [{ Items: null }] })],
      steps: [{ kind: 'items', provider: 'Only', failure: 500 }, { kind: 'items', provider: 'Only' }] },
    { name: 'null source list uses the native nullable first-item overload', providers: [provider({ root: [result(item('bad', { MediaSources: null }))] })],
      steps: [{ kind: 'items', http: true, provider: 'Only' }, { kind: 'items', provider: 'Only' }] },
    { name: 'null provider result is not a typed cache hit', providers: [provider({ root: [null] })], steps: [{ kind: 'items', provider: 'Only', failure: 500 }] },
    { name: 'malformed cache propagates while null cache is a miss', providers: [provider({ root: [result(item('after-null'))] })],
      steps: [{ kind: 'cache', provider: 'Only', content: '{broken' }, { kind: 'items', http: true, provider: 'Only', failure: 500 },
        { kind: 'cache', provider: 'Only', content: 'null' }, { kind: 'items', provider: 'Only' }] },
    { name: 'probe marker, livestream runtime and source invalidation', providers: [provider({ root: [result(item('probe', { MediaSources: [source(path)], RunTimeTicks: 20 }),
      item('live', { MediaSources: [source(path)], RunTimeTicks: 99, IsLiveStream: true, Tags: ['one'] }))] }, { probe: true })], steps: [{ kind: 'items', provider: 'Only' }] },
    { name: 'latest uses root and one folder level, never marker callback', providers: [provider({ root: [result(folder, item('root-media'))], folder: [result(item('child-media'), item('deep', { Type: 'Folder' }))] }, { latest: true })],
      steps: [{ kind: 'latest', http: true, providers: ['Only'] }, { kind: 'latest', providers: ['Only'], query: { Limit: 1, StartIndex: -2 } }] },
    { name: 'latest provider name ordering and empty inventory', providers: [provider({ root: [result(item('z'))] }, { name: 'Zulu', latest: true }), provider({ root: [result(item('a'))] }, { name: 'Alpha', latest: true })],
      steps: [{ kind: 'latest', providers: ['missing'] }, { kind: 'latest', providers: ['Zulu', 'Alpha'] }] },
    { name: 'Trailer implementation latest ordering', providers: [provider({ root: [result(item('old', { PremiereDate: '2024-01-01T00:00:00Z' }), item('new', { PremiereDate: '2025-01-01T00:00:00Z' }))] }, { latest: true, type: 'ControlledTrailerProvider' })], steps: [{ kind: 'latest', providers: ['Only'] }] },
    { name: 'Latest presentation grouping requires a user', providers: [provider({ root: [result()] }, { latest: true })],
      seeds: [{ Id: 'ce100000000000000000000000000021', Name: 'First version' }, { Id: 'ce100000000000000000000000000022', Name: 'Second version' }],
      steps: [{ kind: 'cache', provider: 'Only', content: '{}' }, { kind: 'latest', providers: ['Only'], fields: [] },
        { kind: 'latest', providers: ['Only'], user: true, fields: [] }] },
    { name: 'empty Latest channel filter retains the native all-library query', providers: [provider({ root: [result(item('channel-media'))] }, { latest: true })],
      seeds: [{ Id: 'ce100000000000000000000000000031', Name: 'Retained ordinary media', library: true }],
      steps: [{ kind: 'latest', providers: [], fields: [] }] },
    { name: 'request paging does not reach provider and root cache key keeps nullable user', providers: [provider({ root: [result(item('a'), item('b'))] }, { cacheKey: 'separate' })],
      steps: [{ kind: 'items', provider: 'Only', user: true, query: { Limit: 0, StartIndex: -1 } }, { kind: 'items', provider: 'Only', query: { Limit: -1 } }] },
  ] };
}
