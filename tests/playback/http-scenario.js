import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { AListAdapter } from '../../plugins/alist/adapter.js';

export const movieId = '22222222222222222222222222222222';
export const originalBytes = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256));
export const subtitleBytes = Buffer.from('1\r\n00:00:01,000 --> 00:00:03,000\r\nHello & 中文\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nSecond cue\r\n');

// A deterministic HTTP protocol fixture, not a real AList service.
export async function createMediaFixture({ port = 0, subtitleRoot } = {}) {
  const requests = [];
  let slow = false, cancelledReads = 0;
  const server = http.createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, range: request.headers.range, ifRange: request.headers['if-range'], authorization: request.headers.authorization });
    if (request.url === '/api/fs/get') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const { path } = JSON.parse(Buffer.concat(chunks));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ code: 200, data: { name: path.split('/').at(-1), is_dir: false, size: path.endsWith('.srt') ? subtitleBytes.length : originalBytes.length, raw_url: `http://127.0.0.1:${server.address().port}/d/${encodeURIComponent(path)}` } }));
      return;
    }
    const bytes = decodeURIComponent(request.url).endsWith('.srt') ? subtitleBytes : originalBytes;
    response.setHeader('Content-Type', bytes === subtitleBytes ? 'application/x-subrip' : 'video/x-matroska');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('ETag', '"fixture-v1"');
    response.setHeader('Last-Modified', 'Sat, 26 Sep 2026 00:00:00 GMT');
    if (slow) {
      response.setHeader('Content-Length', 1024 * 1024 * 1024);
      response.write(originalBytes);
      const timer = setInterval(() => response.write(originalBytes), 20);
      response.once('close', () => { clearInterval(timer); cancelledReads++; });
      return;
    }
    const range = request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === '"fixture-v1"') ? /^bytes=(\d*)-(\d*)$/.exec(request.headers.range) : null;
    let start = 0, end = bytes.length - 1;
    if (range) {
      start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
      end = range[1] && range[2] ? Math.min(end, Number(range[2])) : end;
      if (start > end) { response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}`, 'Content-Length': '0' }); response.end(); return; }
      response.statusCode = 206;
      response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
    }
    response.setHeader('Content-Length', end - start + 1);
    response.end(bytes.subarray(start, end + 1));
  });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  const registry = new StorageRegistry();
  registry.registerType('alist', config => new AListAdapter(config));
  await registry.createInstance('fixture', 'alist', { baseUrl: `http://127.0.0.1:${server.address().port}` });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/movies', instanceId: 'fixture', root: '/movies', capabilities: {} });
  vfs.mount({ path: '/subtitles', instanceId: 'fixture', root: '/subtitles', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\CoreFlow\\Movies', accessRoot: '/movies', style: 'windows', returnAccess: 'Isolated HTTP fixture only.' });
  if (subtitleRoot) identityMap.addPrefix({ identityRoot: subtitleRoot, accessRoot: '/subtitles', style: 'windows', returnAccess: 'Isolated sidecar copy only.' });
  return { requests, vfs, identityMap, server, setSlow(value) { slow = value; }, get cancelledReads() { return cancelledReads; },
    async close() { await registry.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

export async function recordPlayback(origin) {
  const authorization = token => `MediaBrowser Client="PlaybackExpansion", Device="Isolated", DeviceId="playback-http", Version="1"${token ? `, Token="${token}"` : ''}`;
  const login = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { Authorization: authorization(), 'Content-Type': 'application/json' }, body: '{"Username":"CoreFlowAdmin","Pw":"isolated-core-flow-password"}' });
  const user = await login.json();
  if (!user.AccessToken) throw new Error('Isolated playback login failed.');
  const records = [];
  async function call(name, route, { method = 'GET', body, headers = {}, authenticated = true } = {}) {
    const response = await fetch(origin + route, { method, headers: { ...(authenticated ? { Authorization: authorization(user.AccessToken) } : {}), 'Accept-Language': 'en-US', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : stringifyNativeJson(body) });
    const bytes = Buffer.from(await response.arrayBuffer());
    let value;
    try { value = parseLosslessJson(bytes.toString()); } catch { value = { base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }; }
    const selectedHeaders = Object.fromEntries(['content-type','content-length','content-range','accept-ranges','etag','last-modified','content-disposition'].filter(key => response.headers.has(key)).map(key => [key,response.headers.get(key)]));
    records.push({ name, status: response.status, headers: selectedHeaders, body: value });
  }
  const file = `/Items/${movieId}/File`;
  for (const [name, headers] of [['full',{}],['range',{Range:'bytes=7-22'}],['suffix',{Range:'bytes=-17'}],['seek',{Range:'bytes=900-'}],['if-range-match',{Range:'bytes=7-22','If-Range':'"fixture-v1"'}],['if-range-stale',{Range:'bytes=7-22','If-Range':'"old"'}],['unsatisfiable',{Range:'bytes=1024-'}]]) await call(name,file,{headers});
  await call('file-head',file,{method:'HEAD'});
  await call('file-unauthorized',file,{authenticated:false});
  await call('static-full',`/Videos/${movieId}/stream.mkv?static=true`);
  await call('static-head',`/Videos/${movieId}/stream.mkv?static=true`,{method:'HEAD'});
  await call('static-range',`/Videos/${movieId}/stream?static=true`,{headers:{Range:'bytes=10-19'}});
  const info = `/Items/${movieId}/PlaybackInfo`;
  await call('info-get',info);
  await call('info-empty-post',info,{method:'POST'});
  await call('info-null-post',info,{method:'POST',body:null});
  const DeviceProfile = { MaxStreamingBitrate: 50000000, DirectPlayProfiles: [{ Type: 'Video', Container: 'mkv', VideoCodec: 'hevc', AudioCodec: 'aac,eac3' }], SubtitleProfiles: [{ Format:'subrip',Method:'Embed' },{Format:'srt',Method:'External'}] };
  await call('info-profile',info,{method:'POST',body:{DeviceProfile,MediaSourceId:movieId,SubtitleStreamIndex:-1}});
  await call('info-query-override',info+'?enableDirectPlay=true&subtitleStreamIndex=-1',{method:'POST',body:{DeviceProfile,MediaSourceId:movieId,EnableDirectPlay:false,SubtitleStreamIndex:3}});
  await call('info-external-subtitle',info,{method:'POST',body:{DeviceProfile,MediaSourceId:movieId,SubtitleStreamIndex:5}});
  await call('info-source-missing',info,{method:'POST',body:{MediaSourceId:'missing'}});
  const sub = `/Videos/${movieId}/${movieId}/Subtitles/5`;
  for(const [name,route] of [['srt',sub+'/Stream.srt'],['vtt',sub+'/Stream.vtt'],['json',sub+'/Stream.js'],['offset',sub+'/20000000/Stream.vtt'],['copy',sub+'/20000000/Stream.vtt?copyTimestamps=true'],['time-map',sub+'/Stream.vtt?addVttTimeMap=true'],['same-format-offset',sub+'/20000000/Stream.srt'],['query-offset',sub+'/90000000/Stream.vtt?startPositionTicks=20000000']]) await call(`subtitle-${name}`,route);
  for(const [name,route] of [['subrip',sub+'/Stream.subrip'],['subrip-offset',sub+'/20000000/Stream.subrip'],['webvtt',sub+'/Stream.webvtt']]) await call(`subtitle-alias-${name}`,route);
  return { records, accessToken: user.AccessToken };
}
