import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Readable } from 'node:stream';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { nativeGuid } from '../../src/users/native.js';
import { rawHttp } from './http-client.js';
import { imageHeaderProjection } from './header-projection.js';
import { observeComparison } from '../comparison-observations.js';
import sharp from 'sharp';

const fixture = new URL('./fixtures/http/', import.meta.url);
const input = parseLosslessJson(await readFile(new URL('input.json', fixture), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', fixture), 'utf8'));
const canonicalBody = value => Array.isArray(value) ? value.map(canonicalBody) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId').map(([key, value]) => [key, canonicalBody(value)])) : value;
const significantHeaders = ['content-type', 'content-length', 'content-language', 'content-disposition', 'etag', 'cache-control', 'pragma', 'last-modified', 'vary', 'transfermode.dlna.org', 'realtimeinfo.dlna.org'];

test('PostgreSQL image HTTP reproduces native originals, conditions, binding, chapters, profiles and info', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'image-http-'));
  const schema = `image_http_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const registry = new StorageRegistry(); registry.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await registry.createInstance('images', 'memory', {});
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/images', instanceId: 'images', capabilities: { create: true, replace: true, delete: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: path.win32.join(input.reference, 'media'), accessRoot: '/images', style: 'windows', returnAccess: 'isolated image test' });
  const runtime = await createRuntime({ database, vfs, identityMap, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: 'image-http', imageOptions: { cachePath: temporary } });
  t.after(async () => { await registry.close(); await database.client.query(`DROP SCHEMA "${schema}" CASCADE`); await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`); await runtime.close(); await rm(temporary, { recursive: true, force: true }); });
  for (const name of ['poster.png', 'backdrop.jpg', 'animation.gif', 'vector.svg']) await adapter.write('/' + name, await readFile(new URL(name, fixture)), { modified: input.fsDate });
  for (const item of input.items) await database.insert('BaseItems', item);
  for (const image of input.imageRows) await database.insert('BaseItemImageInfos', image);
  for (const chapter of input.chapters) await database.insert('Chapters', chapter);
  const user = await runtime.users.createUser({ Name: 'Image test', Password: 'isolated-image-password' });
  await runtime.users.updatePolicy(user.Id, { ...(await runtime.users.getUser(user.Id)).Policy, IsAdministrator: true });
  await database.insert('ImageInfos', { UserId: nativeGuid(user.Id), Path: path.win32.join(input.reference, 'media/poster.png'), LastModified: '2024-04-03 04:13:14' });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  const authBase = 'MediaBrowser Client="Images", Device="Test", DeviceId="image-test", Version="1"';
  const login = await rawHttp(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { Authorization: authBase, 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: 'Image test', Pw: 'isolated-image-password' }) });
  const token = JSON.parse(login.bytes).AccessToken; assert.ok(token);
  const blocked = await runtime.users.createUser({ Name: 'Image blocked', Password: 'isolated-blocked-password' });
  await runtime.users.updatePolicy(blocked.Id, { ...(await runtime.users.getUser(blocked.Id)).Policy, BlockedTags: ['hidden-image'] });
  const blockedLogin = await rawHttp(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { Authorization: authBase, 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: 'Image blocked', Pw: 'isolated-blocked-password' }) });
  const blockedToken = JSON.parse(blockedLogin.bytes).AccessToken; assert.ok(blockedToken);
  let opens = 0;
  const originalOpen = vfs.openRead.bind(vfs);
  vfs.openRead = (...args) => { opens++; return originalOpen(...args); };
  const records = [], failures = [];
  for (const expected of native) {
    const pathname = expected.request.pathname.replaceAll(input.userId, user.Id);
    const previousOpens = opens;
    const selectedToken = expected.request.authRole === 'blocked' ? blockedToken : expected.request.authenticated ? token : undefined;
    const actual = await rawHttp(origin + pathname, { method: expected.request.method, headers: { ...expected.request.headers, ...(selectedToken ? { Authorization: `${authBase}, Token="${selectedToken}"` } : {}) } });
    let body;
    if (!actual.headers['content-type']?.startsWith('image/')) { body = actual.bytes.toString(); try { body = JSON.parse(body); } catch {} }
    const comparable = response => ({ status: response.status, headers: Object.fromEntries(significantHeaders.filter(key => response.headers[key] != null).map(key => [key, response.headers[key]])),
      ...(response.body === undefined ? { length: response.length, sha256: response.sha256 } : { body: canonicalBody(response.body) }) });
    const record = { name: expected.name, status: actual.status, headers: actual.headers, body, length: actual.bytes.length, sha256: createHash('sha256').update(actual.bytes).digest('hex') };
    const left = comparable(expected), right = comparable(record);
    const completeLeft = { ...left, headers: imageHeaderProjection(left.headers) },
      completeRight = { ...right, headers: imageHeaderProjection(right.headers) };
    if (expected.name === 'type-composite') { delete completeLeft.headers['last-modified']; delete completeRight.headers['last-modified']; }
    record.compatible = isDeepStrictEqual(completeLeft, completeRight);
    record.expected = completeLeft; record.actual = completeRight; records.push(record);
    observeComparison(t, expected.name + ' image response headers', actual.headers, expected.headers);
    if (expected.request.method !== 'HEAD' && actual.status !== 304 && actual.headers['content-length'] != null)
      assert.equal(Number(actual.headers['content-length']), actual.bytes.length, 'Content-Length matches the delivered body');
    // Processed-file creation time differs between isolated runs; bytes remain compared.
    try { assert.deepEqual(completeRight, completeLeft, expected.name); } catch (error) { failures.push(error); }
    if (expected.name === 'head' || actual.status === 304) assert.equal(opens, previousOpens, `${expected.name} must not read original bytes`);
    if (actual.headers.age != null && expected.name !== 'type-composite') assert.ok(Math.abs(Number(actual.headers.age) - (Date.now() - Date.parse(input.fsDate)) / 1000) < 3, expected.name);
  }
  const images = await database.rows('BaseItemImageInfos', { where: { ItemId: input.id } });
  assert.equal(images.some(image => image.ImageType === 4), false, 'native image info removes missing files');
  assert.ok(images.every(image => image.Blurhash != null));
  if (process.env.MEDIAMANAGER_IMAGE_HTTP_EVIDENCE) await writeFile(path.join(process.env.MEDIAMANAGER_IMAGE_HTTP_EVIDENCE, 'postgres-report.json'), JSON.stringify({ compatible: records.every(record => record.compatible), matched: records.filter(record => record.compatible).length, total: records.length, records }, null, 2));
  assert.equal(failures.length, 0, failures.map(error => error.message).join('\n'));
  const headerLayouts = [];
  let alternateLayout = false;
  const rewriteHeaders = (_request, response) => {
    const originalSet = response.setHeader.bind(response);
    response.setHeader = (name, value) => {
      if (alternateLayout && name.toLowerCase() === 'cache-control') value = String(value).split(',')
        .map(directive => directive.trim().toUpperCase().replace('=', ' = ')).reverse().join(',  ');
      if (alternateLayout && name.toLowerCase() === 'content-disposition' && value === 'attachment') value = 'ATTACHMENT';
      return originalSet(name, value);
    };
  };
  runtime.server.prependListener('request', rewriteHeaders);
  for (const [name, requestHeaders] of [['tag', {}], ['no-cache', { 'Cache-Control': 'no-cache' }],
    ['mixed-case-request', { 'Cache-Control': 'No-Cache' }], ['combined-request', { 'Cache-Control': 'no-cache, max-age=0' }]]) {
    const url = origin + `/Items/${input.id}/Images/Primary?tag=provided`;
    alternateLayout = false;
    const normal = await rawHttp(url, { headers: requestHeaders });
    alternateLayout = true;
    const alternate = await rawHttp(url, { headers: requestHeaders });
    const select = response => Object.fromEntries(significantHeaders.filter(key => response.headers[key] != null)
      .map(key => [key, response.headers[key]]));
    headerLayouts.push({ name, normal: { status: normal.status, headers: normal.headers, body: normal.bytes.toString('base64') },
      alternate: { status: alternate.status, headers: alternate.headers, body: alternate.bytes.toString('base64') } });
    observeComparison(t, name + ' delivered header layouts', select(alternate), select(normal));
    assert.equal(alternate.status, normal.status);
    assert.deepEqual(imageHeaderProjection(select(alternate)), imageHeaderProjection(select(normal)));
    assert.deepEqual(alternate.bytes, normal.bytes);
    assert.equal(Number(alternate.headers['content-length']), alternate.bytes.length);
    assert.equal(alternate.headers['content-disposition'].trim().toLowerCase(), 'attachment');
    const saved = path.join(temporary, name + '-download.png');
    await writeFile(saved, alternate.bytes);
    const decoded = await sharp(await readFile(saved)).raw().toBuffer({ resolveWithObject: true });
    assert.ok(decoded.info.width > 0 && decoded.info.height > 0);
    if (name === 'no-cache') {
      assert.deepEqual(imageHeaderProjection(select(alternate))['cache-control'],
        [['must-revalidate', null], ['no-cache', null], ['no-store', null]]);
      assert.equal(alternate.headers.pragma, normal.headers.pragma);
    } else {
      assert.equal(alternate.headers.etag, '"provided"');
      const previousOpens = opens;
      const conditional = await rawHttp(url, { headers: { ...requestHeaders, 'If-None-Match': alternate.headers.etag } });
      assert.equal(conditional.status, 304); assert.equal(conditional.bytes.length, 0);
      assert.equal(conditional.headers.etag, '"provided"'); assert.equal(opens, previousOpens);
      const weak = await rawHttp(url, { headers: { ...requestHeaders, 'If-None-Match': 'W/"provided"' } });
      assert.equal(weak.status, 200); assert.deepEqual(weak.bytes, normal.bytes);
    }
  }
  alternateLayout = false;
  runtime.server.removeListener('request', rewriteHeaders);
  runtime.configuration.CorsHosts = ['https://app.emby.media', 'https://another-client.invalid'];
  const corsImage = await rawHttp(origin + `/Items/${input.id}/Images/Primary?tag=provided`, {
    headers: { Origin: 'https://app.emby.media' }
  });
  assert.equal(corsImage.status, 200);
  assert.equal(corsImage.headers['access-control-allow-origin'], 'https://app.emby.media');
  assert.equal(corsImage.headers['access-control-allow-credentials'], 'true');
  assert.deepEqual(corsImage.headers.vary.split(',').map(value => value.trim()).sort(), ['Accept', 'Origin']);
  const corsUnchanged = await rawHttp(origin + `/Items/${input.id}/Images/Primary?tag=provided`, {
    headers: { Origin: 'https://app.emby.media', 'If-None-Match': corsImage.headers.etag }
  });
  assert.equal(corsUnchanged.status, 304);
  assert.equal(corsUnchanged.bytes.length, 0);
  assert.equal(corsUnchanged.headers['access-control-allow-origin'], 'https://app.emby.media');
  assert.deepEqual(corsUnchanged.headers.vary.split(',').map(value => value.trim()).sort(), ['Accept', 'Origin']);
  runtime.configuration.CorsHosts = ['*'];
  for (const value of ['public, private', 'max-age=1, max-age=2', 'public, extension=1', 'no-cache="field"'])
    assert.equal(imageHeaderProjection({ 'cache-control': value })['cache-control'], value);
  const filename = 'Attachment; filename="Case.png"';
  assert.equal(imageHeaderProjection({ 'content-disposition': filename })['content-disposition'], filename);
  if (process.env.MEDIAMANAGER_IMAGE_HTTP_EVIDENCE) await writeFile(path.join(process.env.MEDIAMANAGER_IMAGE_HTTP_EVIDENCE, 'header-layouts.json'),
    JSON.stringify({ compatible: true, records: headerLayouts }, null, 2), { flag: 'wx' });
  for (const stop of ['disconnect', 'shutdown']) {
    const closed = Promise.withResolvers();
    let aborted = false;
    vfs.openRead = async (_, { signal }) => ({
      stream: Readable.from((async function* () {
        yield Buffer.alloc(16);
        await new Promise((_, reject) => {
          const abort = () => { aborted = true; reject(signal.reason); };
          if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        });
      })()),
      close: async () => { closed.resolve(); },
    });
    const started = Promise.withResolvers();
    const req = request(origin + `/Items/${input.id}/Images/Primary`, response => {
      response.on('error', () => {}); response.once('data', () => started.resolve(response));
    }); req.on('error', () => {}); req.end();
    const response = await started.promise;
    if (stop === 'disconnect') response.destroy(); else await runtime.images.close();
    await Promise.race([closed.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`${stop} left an image read active`)), 2000); timer.unref(); })]);
    assert.equal(aborted, true, `${stop} cancels the VFS read`);
    req.destroy();
  }
});
