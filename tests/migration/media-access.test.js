import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { tableDefinition } from '../../src/database/model.js';
import { validateMediaAccessPlan, verifyNativeMediaAccess } from '../../src/migration/media-access.js';

const id = '91919191-9191-9191-9191-919191919191';
const media = Buffer.from('Isolated original synthetic media bytes');
const assSubtitle = Buffer.from('[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:00.10,Default,,0,0,0,,Migration ASS\n');
const srtSubtitle = Buffer.from('1\n00:00:00,000 --> 00:00:00,100\nMigration subtitle\n');
const ssaSubtitle = Buffer.from('[Script Info]\nScriptType: v4.00\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:00.00,0:00:00.10,Default,,0,0,0,,Migration SSA\n');
const vttSubtitle = Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:00.100\nMigration WebVTT\n');
const nfo = Buffer.from('<?xml version="1.0" encoding="utf-8"?>\n<movie><title>Migration NFO</title><plot>Exact native sidecar bytes</plot><uniqueid type="tmdb" default="true">919191</uniqueid></movie>\n');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const emptyRow = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
const plan = () => ({ scope: 'explicit-items', items: [{ itemId: id, identityRoot: 'Z:\\Media', identityPath: 'Z:\\Media\\movie.mkv',
  enumeration: { kind: 'native-filesystem', root: 'Z:\\Media' }, read: { kind: 'native-local-media-proxy' },
  expected: { bytes: String(media.length), sha256: sha(media), range: { start: '1', end: '7', sha256: sha(media.subarray(1, 8)) } },
  sidecars: [
    { kind: 'subtitle', identityPath: 'Z:\\Media\\movie.de.ass', streamIndex: 0, read: { kind: 'native-subtitle-original' }, expected: { bytes: String(assSubtitle.length), sha256: sha(assSubtitle) } },
    { kind: 'subtitle', identityPath: 'Z:\\Media\\movie.en.srt', streamIndex: 1, read: { kind: 'native-subtitle-original' }, expected: { bytes: String(srtSubtitle.length), sha256: sha(srtSubtitle) } },
    { kind: 'subtitle', identityPath: 'Z:\\Media\\movie.ja.ssa', streamIndex: 2, read: { kind: 'native-subtitle-original' }, expected: { bytes: String(ssaSubtitle.length), sha256: sha(ssaSubtitle) } },
    { kind: 'subtitle', identityPath: 'Z:\\Media\\movie.fr.vtt', streamIndex: 3, read: { kind: 'native-subtitle-original' }, expected: { bytes: String(vttSubtitle.length), sha256: sha(vttSubtitle) } },
  ] }] });
function database(t, root = 'Z:\\Media', { filename = 'movie.mkv', mixed = true } = {}) {
  const db = new SqliteDatabase(':memory:', { create: true }); t.after(() => db.close());
  const identityPath = /^[A-Za-z]:[\\/]|^\\\\/u.test(root) ? path.win32 : path;
  db.insert('BaseItems', { ...emptyRow('BaseItems'), Id: id, Path: identityPath.join(root, filename), Type: 'MediaBrowser.Controller.Entities.Movies.Movie', MediaType: 'Video',
    IsInMixedFolder: mixed, Data: '{"VideoType":"VideoFile"}' });
  db.insert('MediaStreamInfos', { ...emptyRow('MediaStreamInfos'), ItemId: id, StreamIndex: 0, StreamType: 2, IsExternal: true, Codec: 'ass', Path: identityPath.join(root, 'movie.de.ass') });
  db.insert('MediaStreamInfos', { ...emptyRow('MediaStreamInfos'), ItemId: id, StreamIndex: 1, StreamType: 2, IsExternal: true, Codec: 'subrip', Path: identityPath.join(root, 'movie.en.srt') });
  db.insert('MediaStreamInfos', { ...emptyRow('MediaStreamInfos'), ItemId: id, StreamIndex: 2, StreamType: 2, IsExternal: true, Codec: 'ass', Path: identityPath.join(root, 'movie.ja.ssa') });
  db.insert('MediaStreamInfos', { ...emptyRow('MediaStreamInfos'), ItemId: id, StreamIndex: 3, StreamType: 2, IsExternal: true, Codec: 'webvtt', Path: identityPath.join(root, 'movie.fr.vtt') });
  return db;
}

test('media access declarations validate current original identity and sidecar relationships without asserting access', async t => {
  const db = database(t), input = plan();
  assert.deepEqual(await validateMediaAccessPlan(input, db), { declarationValid: true, accessVerified: false, scope: 'explicit-items', references: [{ itemId: id, identityPath: input.items[0].identityPath, sidecars: 4 }] });
  const withNfo = plan(); withNfo.items[0].sidecars.push({ kind: 'nfo', identityPath: 'Z:\\Media\\movie.nfo', read: { kind: 'native-filesystem-sidecar' }, expected: { bytes: String(nfo.length), sha256: sha(nfo) } });
  assert.equal((await validateMediaAccessPlan(withNfo, db)).references[0].sidecars, 5);
  assert.equal((await validateMediaAccessPlan({ scope: 'explicit-items', items: [] }, db)).accessVerified, false);
  await assert.rejects(validateMediaAccessPlan([], db), /Invalid media access plan/);
  for (const [name, change] of [
    ['asserted proof', value => value.verified = true],
    ['unknown item', value => value.items[0].itemId = '81818181-8181-8181-8181-818181818181'],
    ['changed identity', value => value.items[0].identityPath = 'Z:\\Media\\changed.mkv'],
    ['directory boundary', value => value.items[0].identityRoot = value.items[0].enumeration.root = 'Z:\\Med'],
    ['relative identity', value => value.items[0].identityPath = 'movie.mkv'],
    ['path traversal', value => value.items[0].identityPath = 'Z:\\Media\\..\\movie.mkv'],
    ['undeclared enumeration scheme', value => value.items[0].enumeration.kind = 'alist-list'],
    ['arbitrary read URI', value => value.items[0].read.url = 'http://unrelated.invalid'],
    ['invalid digest', value => value.items[0].expected.sha256 = '123'],
    ['invalid range', value => value.items[0].expected.range.end = '99999'],
    ['unknown sidecar', value => value.items[0].sidecars[0].streamIndex = 5],
    ['unsupported subtitle format', value => value.items[0].sidecars[1].identityPath = 'Z:\\Media\\movie.fr.ttml'],
    ['duplicate item', value => value.items.push(structuredClone(value.items[0]))],
  ]) await t.test(name, async () => { const value = plan(); change(value); await assert.rejects(validateMediaAccessPlan(value, db), /Invalid media access plan/); });
  for (const [name, identityPath] of [['out of root NFO', 'Z:\\outside.nfo'], ['unrelated NFO', 'Z:\\Media\\other.nfo']]) await t.test(name, async () => {
    const value = plan(); value.items[0].sidecars.push({ kind: 'nfo', identityPath, read: { kind: 'native-filesystem-sidecar' }, expected: { bytes: String(nfo.length), sha256: sha(nfo) } });
    await assert.rejects(validateMediaAccessPlan(value, db), /Invalid media access plan/);
  });
});

test('declared NFO sidecars use direct native filesystem bytes and reject missing or mismatched content', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-native-nfo-'));
  t.after(() => rm(root, { recursive: true }));
  const nfoPath = path.join(root, 'movie.nfo'); await writeFile(nfoPath, nfo);
  const db = database(t, root);
  const input = { scope: 'explicit-items', items: [{ itemId: id, identityRoot: root, identityPath: path.join(root, 'movie.mkv'),
    enumeration: { kind: 'native-filesystem', root }, read: { kind: 'native-local-media-proxy' },
    expected: { bytes: String(media.length), sha256: sha(media), range: { start: '1', end: '7', sha256: sha(media.subarray(1, 8)) } },
    sidecars: [{ kind: 'nfo', identityPath: nfoPath, read: { kind: 'native-filesystem-sidecar' }, expected: { bytes: String(nfo.length), sha256: sha(nfo) } }] }] };
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'MediaBrowser Token="isolated-token"');
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/System/Info') response.end(JSON.stringify({ Id: 'isolated', Version: 'test', ProductName: 'protocol fixture' }));
    else if (url.pathname === '/Environment/DirectoryContents') response.end(JSON.stringify([
      { Name: 'movie.mkv', Path: input.items[0].identityPath, Type: 'File' }, { Name: 'movie.nfo', Path: nfoPath, Type: 'File' }]));
    else if (url.pathname.endsWith('/PlaybackInfo')) response.end(JSON.stringify({ MediaSources: [{ Id: id.replaceAll('-', ''), Path: input.items[0].identityPath, Protocol: 'File' }] }));
    else {
      response.setHeader('Content-Type', 'application/octet-stream'); let body = media;
      if (request.headers.range) { response.statusCode = 206; response.setHeader('Content-Range', `bytes 1-7/${media.length}`); body = media.subarray(1, 8); }
      response.setHeader('Content-Length', body.length); response.end(body);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { database: db, baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 'isolated-token' };
  const success = await verifyNativeMediaAccess(input, options);
  assert.equal(success.declaredItemsVerified, true); assert.deepEqual(success.items[0].sidecars[0], {
    kind: 'nfo', identityPath: nfoPath, format: 'nfo', access: 'native-filesystem', regularFile: true, resolvedWithinRoot: true,
    bytes: String(nfo.length), sha256: sha(nfo), matched: true, verified: true,
  });
  await writeFile(nfoPath, Buffer.alloc(nfo.length));
  const mismatch = await verifyNativeMediaAccess(input, options);
  assert.equal(mismatch.declaredItemsVerified, false); assert.equal(mismatch.items[0].sidecars[0].verified, false);
  await rm(nfoPath);
  const missing = await verifyNativeMediaAccess(input, options);
  assert.equal(missing.declaredItemsVerified, false); assert.match(missing.items[0].sidecars[0].error, /ENOENT/u);
  await mkdir(nfoPath);
  const nonRegular = await verifyNativeMediaAccess(input, options);
  assert.equal(nonRegular.declaredItemsVerified, false); assert.match(nonRegular.items[0].sidecars[0].error, /not a regular file/u);
  await rm(nfoPath, { recursive: true });

  const outside = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-native-nfo-outside-'));
  t.after(() => rm(outside, { recursive: true }));
  await writeFile(path.join(outside, 'movie.nfo'), nfo);
  const junction = path.join(root, 'linked'); await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const junctionDb = database(t, junction);
  const junctionPlan = structuredClone(input); junctionPlan.items[0].identityRoot = root;
  junctionPlan.items[0].enumeration.root = root; junctionPlan.items[0].identityPath = path.join(junction, 'movie.mkv');
  junctionPlan.items[0].sidecars[0].identityPath = path.join(junction, 'movie.nfo');
  const escaped = await verifyNativeMediaAccess(junctionPlan, { ...options, database: junctionDb });
  assert.equal(escaped.declaredItemsVerified, false); assert.match(escaped.items[0].sidecars[0].error, /outside its declared root/u);
});

test('declared NFO follows the native mixed-folder field and first-existing movie candidate order', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-native-nfo-order-'));
  t.after(() => rm(root, { recursive: true }));
  const basenameNfo = path.join(root, 'feature.nfo');
  const movieNfo = path.join(root, 'movie.nfo');
  await writeFile(basenameNfo, nfo); await writeFile(movieNfo, nfo);
  const makePlan = nfoPath => ({ scope: 'explicit-items', items: [{ itemId: id, identityRoot: root, identityPath: path.join(root, 'feature.mkv'),
    enumeration: { kind: 'native-filesystem', root }, read: { kind: 'native-local-media-proxy' },
    expected: { bytes: String(media.length), sha256: sha(media), range: { start: '1', end: '7', sha256: sha(media.subarray(1, 8)) } },
    sidecars: [{ kind: 'nfo', identityPath: nfoPath, read: { kind: 'native-filesystem-sidecar' }, expected: { bytes: String(nfo.length), sha256: sha(nfo) } }] }] });
  const nonMixed = database(t, root, { filename: 'feature.mkv', mixed: false });
  const mixed = database(t, root, { filename: 'feature.mkv', mixed: true });
  assert.equal((await validateMediaAccessPlan(makePlan(movieNfo), nonMixed)).declarationValid, true);
  assert.equal((await validateMediaAccessPlan(makePlan(basenameNfo), nonMixed)).declarationValid, true);
  assert.equal((await validateMediaAccessPlan(makePlan(basenameNfo), mixed)).declarationValid, true);
  await assert.rejects(validateMediaAccessPlan(makePlan(movieNfo), mixed), /Invalid media access plan/u);

  let active = makePlan(movieNfo);
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'MediaBrowser Token="isolated-token"');
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/System/Info') response.end(JSON.stringify({ Id: 'isolated', Version: 'test', ProductName: 'protocol fixture' }));
    else if (url.pathname === '/Environment/DirectoryContents') response.end(JSON.stringify([
      { Name: 'feature.mkv', Path: active.items[0].identityPath, Type: 'File' },
      { Name: path.basename(active.items[0].sidecars[0].identityPath), Path: active.items[0].sidecars[0].identityPath, Type: 'File' },
    ]));
    else if (url.pathname.endsWith('/PlaybackInfo')) response.end(JSON.stringify({ MediaSources: [{ Id: id.replaceAll('-', ''), Path: active.items[0].identityPath, Protocol: 'File' }] }));
    else {
      response.setHeader('Content-Type', 'application/octet-stream'); let body = media;
      if (request.headers.range) { response.statusCode = 206; response.setHeader('Content-Range', `bytes 1-7/${media.length}`); body = media.subarray(1, 8); }
      response.setHeader('Content-Length', body.length); response.end(body);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { database: nonMixed, baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 'isolated-token' };
  const preferred = await verifyNativeMediaAccess(active, options);
  assert.equal(preferred.items[0].sidecars[0].verified, true);
  active = makePlan(basenameNfo);
  const shadowed = await verifyNativeMediaAccess(active, options);
  assert.equal(shadowed.items[0].sidecars[0].verified, false);
  assert.match(shadowed.items[0].sidecars[0].error, /shadowed by Jellyfin's earlier candidate/u);
  await rm(movieNfo);
  const fallback = await verifyNativeMediaAccess(active, options);
  assert.equal(fallback.items[0].sidecars[0].verified, true);

  const unrelated = makePlan(path.join(root, 'other.nfo'));
  await assert.rejects(validateMediaAccessPlan(unrelated, nonMixed), /Invalid media access plan/u);
  const nonCanonicalStateAsset = makePlan(movieNfo); nonCanonicalStateAsset.items[0].sidecars[0].stateAssetId = 'Movie-Nfo';
  await assert.rejects(validateMediaAccessPlan(nonCanonicalStateAsset, nonMixed), /Invalid media access plan/u);
  const dotfile = database(t, root, { filename: '.feature', mixed: true });
  const dotfilePlan = structuredClone(makePlan(path.join(root, '.nfo')));
  dotfilePlan.items[0].identityPath = path.join(root, '.feature');
  assert.equal((await validateMediaAccessPlan(dotfilePlan, dotfile)).declarationValid, true);
  dotfilePlan.items[0].sidecars[0].identityPath = path.join(root, '.feature.nfo');
  await assert.rejects(validateMediaAccessPlan(dotfilePlan, dotfile), /Invalid media access plan/u);
});

test('observed byte access does not establish native directory access; verification is scoped and does not mutate declarations', async t => {
  const db = database(t), input = plan(), before = structuredClone(input);
  let enumerable = true, corrupt = false, authorize = true;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'MediaBrowser Token="isolated-token"');
    if (!authorize) { response.writeHead(401).end(); return; }
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/System/Info') response.end(JSON.stringify({ Id: 'isolated', Version: 'test', ProductName: 'protocol fixture' }));
    else if (url.pathname === '/Environment/DirectoryContents') {
      if (!enumerable) { response.writeHead(500).end(); return; }
      response.end(JSON.stringify([input.items[0].identityPath, ...input.items[0].sidecars.map(sidecar => sidecar.identityPath)].map(Path => ({ Name: Path.split('\\').at(-1), Path, Type: 'File' }))));
    } else if (url.pathname.endsWith('/PlaybackInfo')) response.end(JSON.stringify({ MediaSources: [{ Id: id.replaceAll('-', ''), Path: input.items[0].identityPath, Protocol: 'File' }] }));
    else {
      response.setHeader('Content-Type', 'application/octet-stream');
      let body = url.pathname.endsWith('/File') ? media : url.pathname.endsWith('.ass') ? assSubtitle : url.pathname.endsWith('.ssa') ? ssaSubtitle
        : url.pathname.endsWith('.vtt') ? vttSubtitle : srtSubtitle;
      if (request.headers.range) { response.statusCode = 206; response.setHeader('Content-Range', `bytes 1-7/${media.length}`); body = media.subarray(1, 8); }
      if (corrupt) body = Buffer.alloc(body.length);
      response.setHeader('Content-Length', body.length); response.end(body);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { database: db, baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 'isolated-token' };
  const success = await verifyNativeMediaAccess(input, options);
  assert.equal(success.declaredItemsVerified, true); assert.equal(success.completeLibraryVerified, false); assert.deepEqual(input, before);
  assert.deepEqual(success.items[0].sidecars.map(sidecar => sidecar.format), ['ass', 'srt', 'ssa', 'vtt']);
  assert.deepEqual(success.requests.filter(request => request.route.includes('/Subtitles/')).map(request => request.route), [
    `/Videos/${id.replaceAll('-', '')}/${id.replaceAll('-', '')}/Subtitles/0/Stream.ass`,
    `/Videos/${id.replaceAll('-', '')}/${id.replaceAll('-', '')}/Subtitles/1/Stream.srt`,
    `/Videos/${id.replaceAll('-', '')}/${id.replaceAll('-', '')}/Subtitles/2/Stream.ssa`,
    `/Videos/${id.replaceAll('-', '')}/${id.replaceAll('-', '')}/Subtitles/3/Stream.vtt`,
  ]);
  const trailing = plan(); trailing.items[0].identityRoot += '\\'; trailing.items[0].enumeration.root += '\\';
  assert.equal((await verifyNativeMediaAccess(trailing, options)).declaredItemsVerified, true);
  const nested = plan(); nested.items[0].identityRoot = nested.items[0].enumeration.root = 'Z:\\';
  const missingParent = await verifyNativeMediaAccess(nested, options);
  assert.equal(missingParent.declaredItemsVerified, false, 'A readable leaf directory does not prove it is enumerated from the declared root.');
  assert.equal(missingParent.items[0].original.verified, true);
  enumerable = false;
  const missing = await verifyNativeMediaAccess(input, options);
  assert.equal(missing.declaredItemsVerified, false); assert.equal(missing.items[0].original.verified, true); assert.equal(missing.items[0].enumeration[0].verified, false);
  enumerable = true; corrupt = true;
  assert.equal((await verifyNativeMediaAccess(input, options)).declaredItemsVerified, false);
  corrupt = false; authorize = false;
  assert.equal((await verifyNativeMediaAccess(input, options)).declaredItemsVerified, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(verifyNativeMediaAccess(input, { ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(JSON.stringify(success).includes('isolated-token'), false);
});
