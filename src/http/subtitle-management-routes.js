import { BindingError, booleanValue, guidValue, integerValue, httpError, noContent, notFound, queryValue } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';
import { decodeBase64Body } from './base64-body.js';
import { withCleanup } from '../core/operation-failure.js';
import { lowerInvariant } from '../core/identity.js';
import { VIDEO_TYPES, idKey, nonemptyId } from '../library/records.js';
import { nativeContainingFolderPath, nativeFileNameWithoutExtension } from '../library/native-path.js';
import { defaultLibraryOptions } from '../library/options.js';
import { internalImagePath } from '../metadata/image-paths.js';
import { imagePathApi } from '../metadata/image-assets.js';
import { StorageFileSystem } from '../storage/files.js';
import { clrTrim } from '../metadata/whitespace.js';
import { searchRemoteSubtitles, readRemoteSubtitle } from '../playback/remote-subtitles.js';
import { BinaryResult } from './binary-result.js';
import { getMimeType } from './mime-types.js';

const formats = new Set(['ass', 'mks', 'sami', 'smi', 'srt', 'ssa', 'sub', 'sup', 'vtt']);
const dto = 'Jellyfin.Api.Models.SubtitleDtos.UploadSubtitleDto';
const strings = ['Language', 'Format', 'Data'];
const flags = ['IsForced', 'IsHearingImpaired'];
const root = { type: 'object', reference: 'UploadSubtitle', clrType: dto };
const schema = { definitions: { UploadSubtitle: {
  defaults: Object.fromEntries([...strings.map(name => [name, '']), ...flags.map(name => [name, false])]),
  fields: Object.fromEntries([
    ...strings.map(name => [name, { type: 'string', clrType: 'System.String', nullable: true }]),
    ...flags.map(name => [name, { type: 'boolean', clrType: 'System.Boolean' }]),
  ]),
  required: strings, nonEmpty: strings,
} } };
const refreshOptions = { MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', IsAutomated: true };

function bindUpload(body, source) {
  if (body == null) throw new BindingError('', 'A non-empty request body is required.');
  return validateJsonModel(bindJsonModel(body, { schema, root, source }), { schema, root });
}

async function withVisibleItem(library, itemId, auth, operation, { video = false } = {}) {
  if (!nonemptyId(itemId)) throw httpError(400, "Guid can't be empty. (Parameter 'id')");
  let entered = false;
  try {
    return await library.withItemRecord(itemId, { user: auth.User }, async item => {
      entered = true;
      return video && !VIDEO_TYPES.has(item.Type) ? notFound() : operation(item);
    });
  } catch (error) {
    if (!entered && error?.status === 404) return notFound();
    throw error;
  }
}

async function libraryOptions(library, item) {
  const collection = (await library.getCollectionFolders(item)).find(folder => folder.Type === 'CollectionFolder');
  const configured = library.options.libraryOptions;
  return (configured instanceof Map ? configured.get(idKey(collection?.Id)) ?? configured.get(collection?.Id)
    : configured?.[idKey(collection?.Id)] ?? configured?.[collection?.Id]) ?? defaultLibraryOptions();
}

async function saveSubtitle({ library, fileSystem, libraryMonitor, libraryMonitorHost }, item, subtitle, format, bytes, signal) {
  const options = await libraryOptions(library, item);
  const folder = options.SaveSubtitlesWithMedia
    ? nativeContainingFolderPath(item) : internalImagePath(item, library.options.metadataPath);
  if (!folder) throw httpError(400, 'The subtitle destination is invalid.');
  const api = imagePathApi(folder);
  const language = lowerInvariant(subtitle.Language);
  if (language.includes('/') || language.includes('\0') || api.sep === '\\' && language.includes('\\')) {
    throw httpError(400, 'Language contains invalid characters.');
  }
  const base = nativeFileNameWithoutExtension(item.Path, { windows: api.sep === '\\' }) + '.' + language
    + (subtitle.IsForced ? '.forced' : '') + (subtitle.IsHearingImpaired ? '.sdh' : '');
  let target = api.join(folder, base + '.' + format);
  // Use exclusive creation on the actual mount. The numbered filenames also
  // cover two uploads which select the same initial name concurrently.
  for (let index = 0; ; index++) {
    signal?.throwIfAborted();
    fileSystem.vfs.resolveFileHandle(fileSystem.accessPath(target), 'wx');
    libraryMonitor?.reportFileSystemChangeBeginning(target);
    const written = await withCleanup(async () => {
      await fileSystem.mkdir(folder, { recursive: true });
      try {
        await fileSystem.writeFile(target, bytes, { flag: 'wx', signal });
      } catch (error) {
        if (!(error instanceof AggregateError) && ['EEXIST', 'already-exists'].includes(error?.code)) return false;
        throw error;
      }
      await libraryMonitorHost?.invalidate(target);
      return true;
    }, [() => libraryMonitor?.reportFileSystemChangeComplete(target, false)], 'Subtitle save and monitor completion failed.');
    if (written) return;
    target = api.join(folder, base + '.' + index + '.' + format);
  }
}

function queueRefresh(metadata, item, onError) {
  void metadata.queue(item.Id, refreshOptions, 0).catch(onError);
}

function requiredRouteValue(value, name) {
  if (!value || !clrTrim(value)) throw new BindingError(name, 'The ' + name + ' field is required.');
  return value;
}

export function registerSubtitleManagementRoutes(add, services) {
  const { store, library, metadata, playback, storage, libraryMonitor, libraryMonitorHost, onError = () => {} } = services;
  if (!library) return;
  const vfs = playback?.vfs ?? storage?.vfs, identityMap = playback?.identityMap ?? storage?.identityMap;
  const fileSystem = vfs && identityMap ? new StorageFileSystem({ vfs, identityMap }) : services.fileSystem;
  const path = '/Videos/{itemId}/Subtitles', policy = 'SubtitleManagement';
  const itemId = (_query, params) => guidValue(params.itemId, 'itemId');
  const providers = () => services.plugins?.entries('subtitle') ?? [];
  add('POST', path, context => withVisibleItem(library, context.queryInput, context.auth, async item => {
    if (!fileSystem || !metadata) throw httpError(503, 'Subtitle storage is unavailable.');
    const upload = context.body, format = lowerInvariant(upload.Format);
    if (!formats.has(format)) throw httpError(400, "Unsupported subtitle format: '" + upload.Format + "'");
    const bytes = decodeBase64Body(upload.Data);
    await saveSubtitle({ library, fileSystem, libraryMonitor, libraryMonitorHost }, item, upload, format, bytes, context.signal);
    queueRefresh(metadata, item, onError);
    return noContent();
  }, { video: true }), { policy, body: true, bindBody: bindUpload, bodyParameter: 'body', bodyType: dto, bindQuery: itemId });

  add('DELETE', path + '/{index}', context => withVisibleItem(library, context.queryInput.itemId, context.auth, async item => {
    if (!fileSystem || !metadata || !store) throw httpError(503, 'Subtitle storage is unavailable.');
    const stream = await store.run(async db => (await db.rows('MediaStreamInfos', {
      where: { ItemId: item.Id, StreamType: 2, StreamIndex: context.queryInput.index }, limit: 1,
    }))[0]);
    if (!stream) throw new RangeError('The subtitle stream was not found.');
    const identity = library.options.expandPath?.(stream.Path) ?? stream.Path;
    if (!identity) throw httpError(400, 'A subtitle path is required.');
    libraryMonitor?.reportFileSystemChangeBeginning(identity);
    await withCleanup(async () => {
      try { await fileSystem.unlink(identity); }
      catch (error) { if (error instanceof AggregateError || !['ENOENT', 'not-found'].includes(error?.code)) throw error; }
    }, [() => libraryMonitor?.reportFileSystemChangeComplete(identity, false)], 'Subtitle deletion and monitor completion failed.');
    await libraryMonitorHost?.invalidate(identity);
    await metadata.refreshLiveItem(item, refreshOptions);
    return noContent();
  }), { policy: 'RequiresElevation', bindQuery: (query, params) => ({
    itemId: itemId(query, params), index: integerValue(params.index, 'index'),
  }) });

  const remote = '/Items/{itemId}/RemoteSearch/Subtitles';
  add('GET', remote + '/{language}', context => withVisibleItem(library, context.queryInput.itemId, context.auth, async item => {
    const active = providers();
    if (!active.length) return [];
    return searchRemoteSubtitles(active, item, context.queryInput, await libraryOptions(library, item),
      { signal: context.signal, onError });
  }, { video: true }), { policy, bindQuery: (query, params) => ({ itemId: itemId(query, params),
    language: requiredRouteValue(params.language, 'language'), isPerfectMatch: booleanValue(queryValue(query, 'isPerfectMatch'), 'isPerfectMatch'),
  }) });
  add('POST', remote + '/{subtitleId}', context => withVisibleItem(library, context.queryInput.itemId, context.auth, async item => {
    try {
      const subtitle = await readRemoteSubtitle(providers(), context.queryInput.subtitleId, context.signal);
      const format = lowerInvariant(subtitle.format);
      if (!formats.has(format)) throw new Error('Invalid subtitle format: ' + format);
      await saveSubtitle({ library, fileSystem, libraryMonitor, libraryMonitorHost }, item, {
        Language: subtitle.language, IsForced: subtitle.forced, IsHearingImpaired: subtitle.hearingImpaired,
      }, format, subtitle.bytes, context.signal);
      queueRefresh(metadata, item, onError);
    } catch (error) { onError(error); }
    return noContent();
  }, { video: true }), { policy, bindQuery: (query, params) => ({ itemId: itemId(query, params),
    subtitleId: requiredRouteValue(params.subtitleId, 'subtitleId'),
  }) });
  add('GET', '/Providers/Subtitles/Subtitles/{subtitleId}', async context => {
    const result = await readRemoteSubtitle(providers(), context.queryInput, context.signal);
    return BinaryResult.bytes(result.bytes, getMimeType('file.' + result.format));
  }, { policy, bindQuery: (_query, params) => requiredRouteValue(params.subtitleId, 'subtitleId') });
}
