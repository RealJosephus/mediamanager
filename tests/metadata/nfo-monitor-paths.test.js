import test from 'node:test';
import assert from 'node:assert/strict';
import * as fileSystem from 'node:fs/promises';
import { nfoPaths, nfoMonitorPath } from '../../plugins/nfo/paths.js';
import { createLocalXmlPlugin } from '../../src/metadata/local-xml.js';

test('NFO monitoring retains Windows identity paths while access stays in the VFS namespace', () => {
  const cases = [
    [{ Type: 'Series', Path: 'Z:\\Shows\\Series' }, '/media/series', '/media/series/tvshow.nfo', 'Z:\\Shows\\Series\\tvshow.nfo'],
    [{ Type: 'Episode', Path: 'Z:\\Shows\\Series\\episode.mkv' }, '/media/episode.mkv', '/media/episode.nfo', 'Z:\\Shows\\Series\\episode.nfo'],
    [{ Type: 'Movie', Path: '\\\\server\\movies\\Film\\video.mkv' }, '/media/video.mkv', '/media/movie.nfo', '\\\\server\\movies\\Film\\movie.nfo'],
    [{ Type: 'Movie', VideoType: 'Dvd', Path: 'Z:\\Movies\\Disc' }, '/disc', '/disc/VIDEO_TS/VIDEO_TS.nfo', 'Z:\\Movies\\Disc\\VIDEO_TS\\VIDEO_TS.nfo']
  ];
  for (const [item, accessPath, access, identity] of cases) {
    assert.equal(nfoPaths(item, { accessPath })[0], access);
    assert.equal(nfoMonitorPath(item, { accessPath }), identity);
  }
});

test('NFO monitoring preserves POSIX identity and distinct containing-directory locations', () => {
  const item = { Type: 'Movie', Path: '/identity/movies/disc/VIDEO_TS', VideoType: 'Dvd' };
  const context = { accessPath: '/storage/disc/VIDEO_TS', containingFolderPath: '/storage/disc' };
  assert.equal(nfoPaths(item, context)[0], '/storage/disc/VIDEO_TS/VIDEO_TS.nfo');
  assert.equal(nfoMonitorPath(item, context), '/identity/movies/disc/VIDEO_TS/VIDEO_TS.nfo');
  assert.equal(nfoMonitorPath({ Type: 'MusicAlbum', Path: '/identity/album' }, { accessPath: '/storage/album' }), '/identity/album/album.nfo');
});

test('network XML savers report the item identity separately from their actual VFS destination', () => {
  const plugin = createLocalXmlPlugin({ vfs: {}, fileSystem });
  const saver = plugin.providers.find(provider => provider.id === 'BoxSetXmlSaver');
  const item = { Type: 'BoxSet', Path: 'Z:\\Collections\\Box' }, context = { accessPath: '/metadata/box' };
  assert.equal(saver.getSavePath(item, context), '/metadata/box/collection.xml');
  assert.equal(saver.getMonitorPath(item, context), 'Z:\\Collections\\Box\\collection.xml');
});
