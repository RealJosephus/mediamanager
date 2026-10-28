import { BindingError, HttpResult, badRequest, noContent, guidValue, queryValue, notFound, httpError } from '../http/binding.js';
import { clrTrim } from '../metadata/whitespace.js';
import { nativeFileName } from '../library/native-path.js';
import { LyricService } from './service.js';

export function bindLyricQuery(query, params, upload = false) {
  let itemId, fileName, failure;
  try { itemId = guidValue(params.itemId, 'itemId'); } catch (error) { if (!(error instanceof BindingError)) throw error; failure = error; }
  if (upload) {
    fileName = queryValue(query, 'fileName');
    if (fileName === undefined || clrTrim(fileName) === '') {
      const error = new BindingError('fileName', 'The fileName field is required.');
      if (failure) failure.errors.fileName = error.errors.fileName; else failure = error;
    }
  }
  if (failure) throw failure;
  return { itemId, ...(upload ? { fileName } : {}) };
}

function bindRemoteLyricQuery(query, params) {
  let result, failure;
  try { result = params.itemId === undefined ? {} : bindLyricQuery(query, params); }
  catch (error) { if (!(error instanceof BindingError)) throw error; failure = error; result = {}; }
  if (params.lyricId === undefined || clrTrim(params.lyricId) === '') {
    const error = new BindingError('lyricId', 'The lyricId field is required.');
    if (failure) failure.errors.lyricId = error.errors.lyricId; else failure = error;
  }
  if (failure) throw failure;
  return { ...result, lyricId: params.lyricId };
}

async function uploadBytes(context) {
  const chunks = []; let size = 0;
  const abort = () => context.request.destroy();
  context.signal.addEventListener('abort', abort, { once: true });
  try {
    context.signal.throwIfAborted();
    for await (const chunk of context.request) {
      size += chunk.length;
      if (size > 30000000) throw httpError(413, 'Request body too large.');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally { context.signal.removeEventListener('abort', abort); }
}

export function registerLyricRoutes(add, services) {
  const lyrics = services.lyrics ?? new LyricService({ store: services.store, library: services.library,
    vfs: services.storage?.vfs ?? services.playback?.vfs,
    identityMap: services.storage?.identityMap ?? services.playback?.identityMap,
    metadataIdentityMap: services.storage?.metadataIdentityMap, fileSystem: services.fileSystem,
    monitor: services.libraryMonitor, directoryService: services.libraryMonitorHost, metadata: services.metadata,
    providers: () => services.plugins?.entries('lyric') ?? [], logger: { error: services.onError ?? (() => {}) } });
  add('GET', '/Audio/{itemId}/Lyrics', async context => {
    const result = await lyrics.read(context.queryInput.itemId, { user: context.auth.User, signal: context.signal });
    return result ?? notFound();
  }, { bindQuery: bindLyricQuery });
  const policy = 'LyricManagement';
  add('POST', '/Audio/{itemId}/Lyrics', async context => {
    const result = await lyrics.withAudio(context.queryInput.itemId, { user: context.auth.User }, async item => {
      if (!(Number(context.request.headers['content-length']) > 0)) return new HttpResult(400, 'No lyrics uploaded', { text: true });
      const filename = nativeFileName(context.queryInput.fileName, { windows: process.platform === 'win32' }), dot = filename.lastIndexOf('.'),
        format = dot < 0 ? '' : filename.slice(dot + 1);
      if (!format) return new HttpResult(400, 'Extension is required on filename', { text: true });
      const uploaded = await lyrics.save(item, format, await uploadBytes(context));
      if (uploaded === null) return badRequest();
      lyrics.queueRefresh(item); return uploaded;
    });
    return result ?? notFound();
  }, { policy, bindQuery: (query, params) => bindLyricQuery(query, params, true) });
  add('DELETE', '/Audio/{itemId}/Lyrics', async context => (await lyrics.withAudio(context.queryInput.itemId,
    { user: context.auth.User }, async item => { await lyrics.delete(item); return noContent(); })) ?? notFound(),
  { policy, bindQuery: bindLyricQuery });
  add('GET', '/Audio/{itemId}/RemoteSearch/Lyrics', async context => (await lyrics.withAudio(context.queryInput.itemId,
    { user: context.auth.User }, item => lyrics.search(item, { signal: context.signal }))) ?? notFound(),
  { policy, bindQuery: bindLyricQuery });
  add('POST', '/Audio/{itemId}/RemoteSearch/Lyrics/{lyricId}', async context => (await lyrics.withAudio(context.queryInput.itemId,
    { user: context.auth.User }, async item => {
      const result = await lyrics.download(item, context.queryInput.lyricId, { signal: context.signal });
      if (result !== null) lyrics.queueRefresh(item);
      return result;
    })) ?? notFound(), { policy, bindQuery: bindRemoteLyricQuery });
  add('GET', '/Providers/Lyrics/{lyricId}', async context =>
    (await lyrics.readRemote(context.queryInput.lyricId, { signal: context.signal })) ?? notFound(),
  { policy, bindQuery: bindRemoteLyricQuery });
}
