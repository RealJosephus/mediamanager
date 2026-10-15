import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CompleteLibraryVerificationError,
  runNativeCompleteLibraryScan,
  validateCompleteLibraryDeclaration,
  verifyNativeCompleteLibrary,
} from '../../src/migration/complete-library-verifier.js';

const movieType = 'MediaBrowser.Controller.Entities.Movies.Movie';
const ids = Object.freeze({
  movieLibrary: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  musicLibrary: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  movie: '11111111-1111-1111-1111-111111111111',
  audio: '22222222-2222-2222-2222-222222222222',
  extra: '33333333-3333-3333-3333-333333333333',
});
const compact = value => value.replaceAll('-', '');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const expectation = (value, range = false) => ({
  bytes: String(value.length),
  sha256: sha256(value),
  ...(range ? { range: { start: '1', end: '4', sha256: sha256(value.subarray(1, 5)) } } : {}),
});

function sendJson(response, value, status = 200) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
  response.end(body);
}

function sendBytes(request, response, value) {
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/u);
  if (!range) {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(value.length) });
    response.end(value);
    return;
  }
  const start = Number(range[1]), end = Number(range[2]);
  const body = value.subarray(start, end + 1);
  response.writeHead(206, {
    'content-type': 'application/octet-stream',
    'content-length': String(body.length),
    'content-range': `bytes ${start}-${end}/${value.length}`,
  });
  response.end(body);
}

async function fixture(t, scenario = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-complete-library-'));
  const movieRoot = path.join(root, 'Movies'), musicRoot = path.join(root, 'Music');
  await Promise.all([mkdir(movieRoot), mkdir(musicRoot)]);
  const media = Buffer.from('complete-library-video-bytes');
  const audio = Buffer.from('complete-library-audio-bytes');
  const subtitle = Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nExact subtitle\n');
  const nfo = Buffer.from('<?xml version="1.0"?><movie><title>Exact movie</title></movie>');
  const moviePath = path.join(movieRoot, 'feature.mkv');
  const audioPath = path.join(musicRoot, 'track.flac');
  const subtitlePath = path.join(movieRoot, 'feature.en.srt');
  const nfoPath = path.join(movieRoot, 'movie.nfo');
  await Promise.all([
    writeFile(moviePath, media), writeFile(audioPath, audio), writeFile(subtitlePath, subtitle), writeFile(nfoPath, nfo),
  ]);
  const movieRow = { Id: ids.movie, Path: moviePath, Type: movieType, MediaType: 'Video', IsFolder: false,
    IsVirtualItem: false, IsInMixedFolder: false, Data: JSON.stringify({ VideoType: 'VideoFile' }) };
  const audioRow = { Id: ids.audio, Path: audioPath, Type: 'MediaBrowser.Controller.Entities.Audio.Audio', MediaType: 'Audio',
    IsFolder: false, IsVirtualItem: false, IsInMixedFolder: false, Data: '{}' };
  const rows = new Map([[ids.movie, movieRow], [ids.audio, audioRow]]);
  const database = {
    async rows(table, { where } = {}) {
      if (table === 'BaseItems') return rows.has(where?.Id) ? [rows.get(where.Id)] : [];
      if (table === 'MediaStreamInfos' && where?.ItemId === ids.movie) {
        return [{ ItemId: ids.movie, StreamType: 2, IsExternal: true, StreamIndex: 3, Path: subtitlePath, Codec: 'subrip' }];
      }
      if (table === 'MediaStreamInfos') return [];
      throw new Error(`Unexpected table ${table}`);
    },
  };
  const items = [
    {
      itemId: ids.movie,
      identityPath: moviePath,
      identityRoot: movieRoot,
      enumeration: { kind: 'native-filesystem', root: movieRoot },
      read: { kind: 'native-local-media-proxy' },
      expected: expectation(media, true),
      sidecars: [
        { kind: 'subtitle', identityPath: subtitlePath, streamIndex: 3, read: { kind: 'native-subtitle-original' }, expected: expectation(subtitle) },
        { kind: 'nfo', identityPath: nfoPath, read: { kind: 'native-filesystem-sidecar' }, expected: expectation(nfo), stateAssetId: 'movie-nfo' },
      ],
    },
    {
      itemId: ids.audio,
      identityPath: audioPath,
      identityRoot: musicRoot,
      enumeration: { kind: 'native-filesystem', root: musicRoot },
      read: { kind: 'native-local-media-proxy' },
      expected: expectation(audio, true),
      sidecars: [],
    },
  ];
  const declaration = {
    scope: 'complete-library',
    libraries: [
      { itemId: ids.movieLibrary, name: 'Movies', collectionType: 'movies', locations: [movieRoot], itemIds: [ids.movie] },
      { itemId: ids.musicLibrary, name: 'Music', collectionType: 'music', locations: [musicRoot], itemIds: [ids.audio] },
    ],
    items,
  };
  const previousResult = {
    Id: compact(ids.movieLibrary), Key: 'RefreshLibrary', Status: 'Completed',
    StartTimeUtc: '2026-10-03T00:00:00.000Z', EndTimeUtc: '2026-10-03T00:00:01.000Z',
  };
  const staleChangedResult = {
    Id: compact(ids.movieLibrary), Key: 'RefreshLibrary', Status: scenario.scanStatus ?? 'Completed',
    StartTimeUtc: '2020-01-02T00:00:00.000Z', EndTimeUtc: '2020-01-02T00:00:01.000Z',
  };
  let scanStarted = false, taskPolls = 0, completedResult;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/ScheduledTasks') {
      const task = { Id: compact(ids.movieLibrary), Key: 'RefreshLibrary', State: scenario.initialTaskState ?? 'Idle', LastExecutionResult: previousResult };
      sendJson(response, scenario.duplicateTasks ? [task, { ...task }] : [task]);
      return;
    }
    if (request.method === 'POST' && url.pathname === `/ScheduledTasks/Running/${compact(ids.movieLibrary)}`) {
      const started = new Date();
      completedResult = {
        Id: compact(ids.movieLibrary), Key: 'RefreshLibrary', Status: scenario.scanStatus ?? 'Completed',
        StartTimeUtc: started.toISOString(), EndTimeUtc: new Date(started.getTime() + 1).toISOString(),
      };
      scanStarted = true; response.writeHead(204); response.end(); return;
    }
    if (request.method === 'GET' && url.pathname === `/ScheduledTasks/${compact(ids.movieLibrary)}`) {
      taskPolls++;
      if (scenario.hangingScan) {
        sendJson(response, { Id: compact(ids.movieLibrary), Key: 'RefreshLibrary', State: 'Running', LastExecutionResult: previousResult });
      } else if (scenario.unknownTaskState) {
        sendJson(response, { Id: compact(ids.movieLibrary), Key: 'RefreshLibrary', State: 'Unknown', LastExecutionResult: previousResult });
      } else if (scenario.staleChangedReceipt || scenario.instantCompletion) {
        sendJson(response, { Id: compact(ids.movieLibrary), Key: 'RefreshLibrary', State: 'Idle',
          LastExecutionResult: scenario.staleChangedReceipt ? staleChangedResult : completedResult });
      } else if (taskPolls === 1) {
        sendJson(response, { Id: compact(ids.movieLibrary), Key: 'RefreshLibrary', State: 'Running', LastExecutionResult: previousResult });
      } else {
        sendJson(response, { Id: compact(ids.movieLibrary), Key: 'RefreshLibrary', State: 'Idle', LastExecutionResult: completedResult });
      }
      return;
    }
    if (!scanStarted) { sendJson(response, { error: 'scan-required' }, 409); return; }
    if (request.method === 'GET' && url.pathname === '/Library/VirtualFolders') {
      const folders = [
        { ItemId: compact(ids.movieLibrary), Name: 'Movies', CollectionType: 'movies', Locations: [movieRoot] },
        { ItemId: compact(ids.musicLibrary), Name: 'Music', CollectionType: 'music', Locations: [musicRoot] },
      ];
      if (scenario.missingLibrary) folders.pop();
      if (scenario.extraLibrary) folders.push({ ItemId: compact(ids.extra), Name: 'Extra', CollectionType: 'movies', Locations: [root] });
      sendJson(response, folders); return;
    }
    if (request.method === 'GET' && url.pathname === '/Items') {
      const parentId = url.searchParams.get('ParentId');
      let listed = parentId === compact(ids.movieLibrary)
        ? [{ Id: compact(ids.movie), Path: moviePath, IsFolder: false, MediaType: 'Video', LocationType: 'FileSystem' }]
        : [{ Id: compact(ids.audio), Path: audioPath, IsFolder: false, MediaType: 'Audio', LocationType: 'FileSystem' }];
      if (parentId === compact(ids.movieLibrary) && scenario.inventory === 'missing') listed = [];
      if (parentId === compact(ids.movieLibrary) && scenario.inventory === 'extra') {
        listed.push({ Id: compact(ids.extra), Path: path.join(movieRoot, 'extra.mkv'), IsFolder: false, MediaType: 'Video', LocationType: 'FileSystem' });
      }
      if (parentId === compact(ids.movieLibrary) && scenario.inventory === 'duplicate') listed.push({ ...listed[0] });
      if (parentId === compact(ids.movieLibrary) && scenario.inventory === 'unknown') listed[0] = { ...listed[0], LocationType: 'Virtual' };
      if (parentId === compact(ids.movieLibrary) && scenario.hiddenUnsupported
        && !url.searchParams.has('LocationTypes') && !url.searchParams.has('MediaTypes')) {
        listed.push({ Id: compact(ids.extra), Path: path.join(movieRoot, 'hidden.remote'), IsFolder: false,
          MediaType: 'Photo', LocationType: 'Remote' });
      }
      const startIndex = Number(url.searchParams.get('StartIndex')), limit = Number(url.searchParams.get('Limit'));
      sendJson(response, { Items: listed.slice(startIndex, startIndex + limit), TotalRecordCount: listed.length, StartIndex: startIndex });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/System/Info') {
      sendJson(response, { Id: 'native-test-server', Version: 'test', ProductName: 'Jellyfin' }); return;
    }
    if (request.method === 'GET' && url.pathname === '/Environment/DirectoryContents') {
      const directory = url.searchParams.get('path');
      const entries = directory === movieRoot
        ? [moviePath, subtitlePath, nfoPath].map(filename => ({ Name: path.basename(filename), Path: filename, Type: 'File' }))
        : [{ Name: path.basename(audioPath), Path: audioPath, Type: 'File' }];
      sendJson(response, entries); return;
    }
    const playback = url.pathname.match(/^\/Items\/([0-9a-f]{32})\/PlaybackInfo$/u);
    if (request.method === 'GET' && playback) {
      const itemId = playback[1], identityPath = itemId === compact(ids.movie) ? moviePath : audioPath;
      sendJson(response, { MediaSources: [{ Id: itemId, Path: identityPath, Protocol: 'File' }] }); return;
    }
    const original = url.pathname.match(/^\/Items\/([0-9a-f]{32})\/File$/u);
    if (request.method === 'GET' && original) {
      const value = original[1] === compact(ids.movie) ? (scenario.badMedia ? Buffer.from('wrong') : media) : audio;
      sendBytes(request, response, value); return;
    }
    if (request.method === 'GET' && /^\/Videos\/[0-9a-f]{32}\/[0-9a-f]{32}\/Subtitles\/3\/Stream\.srt$/u.test(url.pathname)) {
      sendBytes(request, response, subtitle); return;
    }
    sendJson(response, { error: 'not-found', path: url.pathname }, 404);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, database, declaration, baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 'isolated-token' };
}

const verificationOptions = value => ({ ...value, requestTimeoutMs: 2000, scanTimeoutMs: 1000, pollIntervalMs: 1, pageSize: 1 });
const rejectsCode = code => error => error instanceof CompleteLibraryVerificationError && error.code === code;

test('complete library verifier keeps scan, exact inventory and per-item byte access as independent checks', async t => {
  const value = await fixture(t);
  const result = await verifyNativeCompleteLibrary(value.declaration, verificationOptions(value));
  assert.deepEqual(result.checks, { scanCompleted: true, libraryInventoryExact: true, declaredItemsPlayable: true });
  assert.equal(result.scan.status, 'Completed');
  assert.equal(result.scan.observedRunning, true);
  assert.equal(result.inventory.virtualLibraryCount, 2);
  assert.equal(result.inventory.itemCount, 2);
  assert.equal(result.access.items.every(item => item.verified), true);
  assert.equal(result.access.items[0].sidecars.find(sidecar => sidecar.kind === 'subtitle').verified, true);
  assert.equal(result.access.items[0].sidecars.find(sidecar => sidecar.kind === 'nfo').verified, true);
  assert.equal(result.acceptancePromotionRequired, true);
  assert.equal(Object.hasOwn(result, 'completeLibraryVerified'), false);
  assert.equal(result.access.completeLibraryVerified, false);
});

test('complete library declaration rejects duplicates, unassigned items and roots outside their declared library', async t => {
  const value = await fixture(t);
  const duplicate = structuredClone(value.declaration);
  duplicate.items.push(structuredClone(duplicate.items[0]));
  await assert.rejects(validateCompleteLibraryDeclaration(duplicate, value.database), rejectsCode('invalid-declaration'));

  const unassigned = structuredClone(value.declaration);
  unassigned.libraries[1].itemIds = [];
  await assert.rejects(validateCompleteLibraryDeclaration(unassigned, value.database), rejectsCode('invalid-declaration'));

  const wrongRoot = structuredClone(value.declaration);
  wrongRoot.libraries[0].locations = [value.root];
  await assert.rejects(validateCompleteLibraryDeclaration(wrongRoot, value.database), rejectsCode('invalid-declaration'));
});

test('native scan proof rejects cancelled, ambiguous, busy and unknown task outcomes', async t => {
  for (const [name, scenario, code] of [
    ['cancelled', { scanStatus: 'Cancelled' }, 'scan-not-completed'],
    ['ambiguous', { duplicateTasks: true }, 'scan-task-ambiguous'],
    ['busy', { initialTaskState: 'Running' }, 'scan-task-busy'],
    ['unknown', { unknownTaskState: true }, 'invalid-response'],
  ]) {
    await t.test(name, async t => {
      const value = await fixture(t, scenario);
      await assert.rejects(runNativeCompleteLibraryScan(verificationOptions(value)), rejectsCode(code));
    });
  }
});

test('native scan cancellation never becomes a completion receipt', async t => {
  const value = await fixture(t, { hangingScan: true });
  const controller = new AbortController();
  const running = runNativeCompleteLibraryScan({ ...verificationOptions(value), signal: controller.signal });
  setTimeout(() => controller.abort(new Error('cancelled by test')), 20).unref();
  await assert.rejects(running, error => error?.name === 'AbortError' || /cancelled by test/u.test(error?.message));
});

test('native scan proof rejects changed receipts that are stale or were never observed running', async t => {
  for (const [name, scenario] of [
    ['stale changed receipt', { staleChangedReceipt: true }],
    ['instant unobserved receipt', { instantCompletion: true }],
  ]) await t.test(name, async t => {
    const value = await fixture(t, scenario);
    await assert.rejects(runNativeCompleteLibraryScan(verificationOptions(value)), rejectsCode('scan-not-completed'));
  });
});

test('complete library inventory rejects missing, extra, duplicate and unknown native entries', async t => {
  for (const [name, code] of [
    ['missing', 'library-item-mismatch'],
    ['extra', 'library-item-mismatch'],
    ['duplicate', 'duplicate-native-item'],
    ['unknown', 'invalid-response'],
  ]) {
    await t.test(name, async t => {
      const value = await fixture(t, { inventory: name });
      await assert.rejects(verifyNativeCompleteLibrary(value.declaration, verificationOptions(value)), rejectsCode(code));
    });
  }
});

test('complete library inventory is bidirectional for configured native libraries', async t => {
  for (const [name, scenario] of [['missing library', { missingLibrary: true }], ['extra library', { extraLibrary: true }]]) {
    await t.test(name, async t => {
      const value = await fixture(t, scenario);
      await assert.rejects(verifyNativeCompleteLibrary(value.declaration, verificationOptions(value)), rejectsCode('library-inventory-mismatch'));
    });
  }
});

test('complete library inventory does not hide unsupported, missing or non-filesystem items with server filters', async t => {
  const value = await fixture(t, { hiddenUnsupported: true });
  await assert.rejects(verifyNativeCompleteLibrary(value.declaration, verificationOptions(value)),
    rejectsCode('invalid-response'));
});

test('a completed scan and exact inventory do not hide a byte-inexact media item', async t => {
  const value = await fixture(t, { badMedia: true });
  await assert.rejects(verifyNativeCompleteLibrary(value.declaration, verificationOptions(value)), error => {
    assert.equal(rejectsCode('item-access-failed')(error), true);
    assert.equal(error.evidence.scan.completed, true);
    assert.equal(error.evidence.inventory.exact, true);
    assert.equal(error.evidence.access.declaredItemsVerified, false);
    return true;
  });
});
