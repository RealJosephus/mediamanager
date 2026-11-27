import { BindingError, booleanValue, guidValue, integerValue, httpError, noContent, notFound, queryValue } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';
import { decodeBase64Body } from './base64-body.js';
import { withCleanup } from '../core/operation-failure.js';
import { lowerInvariant } from '../core/identity.js';
import { VIDEO_TYPES, nonemptyId } from '../library/records.js';
import { nativePathWithin } from '../library/native-path.js';
import { itemLibraryOptions } from '../library/options.js';
import { internalImagePath } from '../metadata/image-paths.js';
import { subtitleDestinations, saveSubtitle, downloadSubtitle, subtitleFormats } from '../playback/subtitle-storage.js';
import { clrTrim } from '../metadata/whitespace.js';
import { searchRemoteSubtitles, readRemoteSubtitle } from '../playback/remote-subtitles.js';
import { BinaryResult } from './binary-result.js';
import { getMimeType } from './mime-types.js';

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

function queueRefresh(metadata, item, onError) {
  void metadata.queue(item.Id, refreshOptions, 0).catch(onError);
}

function requiredRouteValue(value, name) {
  if (!value || !clrTrim(value)) throw new BindingError(name, 'The ' + name + ' field is required.');
  return value;
}

export function registerSubtitleManagementRoutes(add, services) {
  const { store, library, metadata, libraryMonitor, libraryMonitorHost, onError = () => {} } = services;
  if (!library) return;
  const destinations = subtitleDestinations(services);
  const { metadataFiles, mediaFiles } = destinations;
  const path = '/Videos/{itemId}/Subtitles', policy = 'SubtitleManagement';
  const itemId = (_query, params) => guidValue(params.itemId, 'itemId');
  const providers = () => services.plugins?.entries('subtitle') ?? [];
  add('POST', path, context => withVisibleItem(library, context.queryInput, context.auth, async item => {
    if (!metadata) throw httpError(503, 'Subtitle storage is unavailable.');
    const upload = context.body, format = lowerInvariant(upload.Format);
    if (!subtitleFormats.has(format)) throw httpError(400, "Unsupported subtitle format: '" + upload.Format + "'");
    const bytes = decodeBase64Body(upload.Data);
    await saveSubtitle(destinations, item, upload, format, bytes, context.signal);
    queueRefresh(metadata, item, onError);
    return noContent();
  }, { video: true }), { policy, body: true, bindBody: bindUpload, bodyParameter: 'body', bodyType: dto, bindQuery: itemId });

  add('DELETE', path + '/{index}', context => withVisibleItem(library, context.queryInput.itemId, context.auth, async item => {
    if (!metadata || !store) throw httpError(503, 'Subtitle storage is unavailable.');
    const stream = await store.run(async db => (await db.rows('MediaStreamInfos', {
      where: { ItemId: item.Id, StreamType: 2, StreamIndex: context.queryInput.index }, limit: 1,
    }))[0]);
    if (!stream) throw new RangeError('The subtitle stream was not found.');
    const identity = library.options.expandPath?.(stream.Path) ?? stream.Path;
    if (!identity) throw httpError(400, 'A subtitle path is required.');
    const metadataPath = library.options.metadataPath;
    const fileSystem = metadataPath && nativePathWithin(identity, internalImagePath(item, metadataPath)) ? metadataFiles : mediaFiles;
    if (!fileSystem) throw httpError(503, 'Subtitle storage is unavailable.');
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
    return searchRemoteSubtitles(active, item, context.queryInput, await itemLibraryOptions(library, item),
      { signal: context.signal, onError });
  }, { video: true }), { policy, bindQuery: (query, params) => ({ itemId: itemId(query, params),
    language: requiredRouteValue(params.language, 'language'), isPerfectMatch: booleanValue(queryValue(query, 'isPerfectMatch'), 'isPerfectMatch'),
  }) });
  add('POST', remote + '/{subtitleId}', context => withVisibleItem(library, context.queryInput.itemId, context.auth, async item => {
    try {
      await downloadSubtitle(destinations, providers(), item, context.queryInput.subtitleId, context.signal);
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
