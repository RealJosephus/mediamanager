export const sourceId = 'a7b10000-0000-0000-0000-000000000001';
export const rockId = 'a7b10000-0000-0000-0000-000000000011';
export const jazzId = 'a7b10000-0000-0000-0000-000000000012';
export const emptyId = '00000000-0000-0000-0000-000000000000';

export const samples = [
  { name: 'warm album retains original genre after replacement', type: 'MusicAlbum', warm: true, mutation: 'replace' },
  { name: 'warm album remains after persistence deletion', type: 'MusicAlbum', warm: true, mutation: 'delete' },
  { name: 'warm artist retains type after movie replacement', type: 'MusicArtist', warm: true, mutation: 'movie' },
  { name: 'warm playlist retains genre after movie replacement', type: 'Playlist', warm: true, mutation: 'movie' },
  { name: 'warm movie remains a movie after album replacement', type: 'Movie', warm: true, mutation: 'replace' },
  { name: 'cold album consumes replacement genre', type: 'MusicAlbum', mutation: 'replace' },
  { name: 'cold deleted album contributes no items', type: 'MusicAlbum', mutation: 'delete' },
  { name: 'audio lookup consumes current row without caching', type: 'Audio', warm: true, mutation: 'replace-audio', sourceFirst: true },
  { name: 'deleted audio book contributes no cached item', type: 'AudioBook', warm: true, mutation: 'delete' },
  { name: 'duplicate warm album keeps each input contribution', type: 'MusicAlbum', warm: true, mutation: 'delete', requests: ['source', 'source'] },
  { name: 'earlier source creates the later genre source', type: 'MusicAlbum', requests: ['source', 'genre'] },
  { name: 'missing earlier genre is not resolved after later creation', type: 'MusicAlbum', requests: ['genre', 'source'] },
  { name: 'later empty id keeps prior creation and rejects delivery', type: 'MusicAlbum', requests: ['source', 'empty'], expectedStatus: 400 },
];

export const requestedIds = (sample, genreId) => (sample.requests ?? ['source']).map(value => ({
  source: sourceId, genre: genreId, empty: emptyId,
})[value]);
