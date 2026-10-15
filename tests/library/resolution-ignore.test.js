import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesCoreResolutionIgnorePattern,
  shouldIgnoreResolutionCandidate
} from '../../src/library/resolution-ignore.js';

const genericParent = Object.freeze({
  Id: '10000000-0000-0000-0000-000000000001',
  Type: 'MediaBrowser.Controller.Entities.Folder'
});

function candidate(identityPath, kind = 'file', name = identityPath.split(/[\\/]/u).at(-1)) {
  return { identityPath, entry: { name, kind } };
}

test('fixed leaf and recursive directory patterns are case-insensitive', () => {
  for (const path of [
    '/media/SMALL.JPG',
    '/media/AlbumArt.jpg',
    'THUMBS.DB',
    '/media/METADATA/movie.xml',
    '/media/PS3_UPDATE',
    '/media/extraFanArt/image.jpg',
    '/media/subs/en.srt',
    '/media/lost+found/movie.mkv'
  ]) assert.equal(matchesCoreResolutionIgnorePattern(path), true, path);

  assert.equal(matchesCoreResolutionIgnorePattern('/media/big.jpg'), false);
  assert.equal(matchesCoreResolutionIgnorePattern('/media/metadata-like/movie.xml'), false);
});

test('NAS, temporary recording and ZFS directory trees are ignored', () => {
  for (const path of [
    '/volume1/video/Series/@eaDir',
    '/volume1/video/Series/@EADIR/file.txt',
    '/directory/@Recycle/file.mp3',
    '/directory/#RECYCLE',
    String.raw`C:\media\$RECYCLE.BIN\desktop.ini`,
    '/media/System Volume Information/index',
    '/media/.@__thumb/poster.png',
    '/recordings/TempRec/live.ts',
    '/recordings/TEMPSBE',
    '/movies/.zfs/snapshot/AutoM-2023-09/movie.mkv'
  ]) assert.equal(matchesCoreResolutionIgnorePattern(path), true, path);

  assert.equal(matchesCoreResolutionIgnorePattern('/media/foo\\metadata/movie.mkv'), false);
});

test('sample and minta filename extensions are restricted to one through five characters', () => {
  for (const path of [
    '/media/sample.a',
    '/media/SAMPLE.mp4',
    '/media/sample.webm',
    '/media/movie.sample.MKV',
    '/media/minta.a',
    '/media/Movie.MINTA.webm'
  ]) assert.equal(matchesCoreResolutionIgnorePattern(path), true, path);

  for (const path of [
    '/media/sample.',
    '/media/sample.abcdef',
    '/media/movie.sample.abcdef',
    '/media/the sample.mkv',
    '/media/sampler.mkv'
  ]) assert.equal(matchesCoreResolutionIgnorePattern(path), false, path);
});

test('sample and minta folders match only their immediate children', () => {
  assert.equal(matchesCoreResolutionIgnorePattern('/movie/sample/movie.mp4'), true);
  assert.equal(matchesCoreResolutionIgnorePattern(String.raw`C:\movie\MINTA\movie.mkv`), true);
  assert.equal(matchesCoreResolutionIgnorePattern('/foo/sample/bar/baz.mkv'), false);
  assert.equal(matchesCoreResolutionIgnorePattern('/movie/sample'), false);
});

test('trickplay directories are recursive while the generic hidden glob is leaf-only', () => {
  assert.equal(matchesCoreResolutionIgnorePattern('/movies/title.trickplay'), true);
  assert.equal(matchesCoreResolutionIgnorePattern('/movies/TITLE.TRICKPLAY/0/1.jpg'), true);
  assert.equal(matchesCoreResolutionIgnorePattern('/media/dir/.hiddenfile.mp4'), true);
  assert.equal(matchesCoreResolutionIgnorePattern('/media/dir/._macjunk.mp4'), true);
  assert.equal(matchesCoreResolutionIgnorePattern('/media/.hiddendir/file.mp4'), false);
  assert.equal(matchesCoreResolutionIgnorePattern('/media/music/Foo B.A.R./epic.flac'), false);
  assert.equal(matchesCoreResolutionIgnorePattern('/media/movie.bts'), true);
  assert.equal(matchesCoreResolutionIgnorePattern('/media/movie.SYNC'), true);
  assert.equal(matchesCoreResolutionIgnorePattern('/media/folder\\metadata/movie.mkv'), false,
    'a backslash is a literal POSIX filename character, not a directory separator');
});

test('application-root exemption precedes every ignore pattern', () => {
  const applicationRootPath = '/server/root';
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/server/root/small.jpg'), {
    parent: null,
    applicationRootPath
  }), false);
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/prefix/server/root/.hidden'), {
    parent: genericParent,
    applicationRootPath
  }), false);
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/SERVER/root/small.jpg'), {
    parent: genericParent,
    applicationRootPath
  }), true);
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/media/small.jpg'), {
    parent: null,
    applicationRootPath
  }), true);
});

test('top-parent and root directories preserve extras folders', () => {
  const aggregate = { Type: 'MediaBrowser.Controller.Entities.AggregateFolder' };
  const markedTopParent = { ...genericParent, IsTopParent: true };
  const root = { ...genericParent, Id: '20000000-0000-0000-0000-000000000002',
    TopParentId: '20000000000000000000000000000002' };
  const extras = candidate('/movies/extras', 'directory');

  assert.equal(shouldIgnoreResolutionCandidate(extras, { parent: aggregate }), false);
  assert.equal(shouldIgnoreResolutionCandidate(extras, { parent: markedTopParent }), false);
  assert.equal(shouldIgnoreResolutionCandidate(extras, { parent: root, root }), false);
  assert.equal(shouldIgnoreResolutionCandidate(extras, { parent: null }), false);
});

test('extras folders are ignored below ordinary parents but not a user root', () => {
  for (const name of ['extras', 'TRAILERS', 'behind the scenes', 'theme-music', 'clips']) {
    assert.equal(shouldIgnoreResolutionCandidate(candidate(`/movies/Up/${name}`, 'directory', name), {
      parent: genericParent
    }), true, name);
  }

  assert.equal(shouldIgnoreResolutionCandidate(candidate('/movies/Up/extras', 'directory'), {
    parent: { Type: 'MediaBrowser.Controller.Entities.UserRootFolder' }
  }), false);
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/movies/Up/features', 'directory'), {
    parent: genericParent
  }), false);
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/movies/Up/extras', 'file'), {
    parent: genericParent
  }), false);
});

test('only a lowercase theme stem with a recognized audio extension is ignored', () => {
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/Movies/Up/theme.mp3'), {
    parent: genericParent
  }), true);
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/Movies/Up/theme.FLAC'), {
    parent: genericParent
  }), true);
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/Movies/Up/THEME.mp3'), {
    parent: genericParent
  }), false);
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/Movies/Up/theme.mkv'), {
    parent: genericParent
  }), false);
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/Movies/Up/intro.mp3'), {
    parent: genericParent
  }), false);
});

test('a missing parent is exempt after global patterns for files and directories', () => {
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/Movies/Up/theme.mp3'), {
    parent: null
  }), false);
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/Movies/Up/extras', 'directory'), {
    parent: null
  }), false);
  assert.equal(shouldIgnoreResolutionCandidate(candidate('/Movies/Up/small.jpg'), {
    parent: null
  }), true);
});

test('malformed observations are not classified as ignored', () => {
  assert.equal(shouldIgnoreResolutionCandidate(null), false);
  assert.equal(shouldIgnoreResolutionCandidate({ identityPath: '/media/small.jpg' }), false);
  assert.equal(shouldIgnoreResolutionCandidate({
    identityPath: '/media/small.jpg',
    entry: { name: 'small.jpg', kind: 'symlink' }
  }), false);
});
