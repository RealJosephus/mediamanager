import { BindingError, booleanValue, guidValue, httpError, noContent, notFound, queryValue } from './binding.js';
import { remoteSearchBinding, bindSearchResult, remoteSearchTypes } from './item-lookup-binding.js';
import { remoteMetadataSearch } from '../metadata/remote-lookup.js';
import { nonemptyId } from '../library/records.js';
import { clrTrim } from '../metadata/whitespace.js';

function bindApplyQuery(query, params) {
  const itemId = guidValue(params.itemId, 'itemId'), raw = queryValue(query, 'replaceAllImages');
  if (raw !== undefined && clrTrim(raw) === '') throw new BindingError('replaceAllImages', `The value '${raw}' is invalid.`);
  return { itemId, replaceAllImages: booleanValue(raw, 'replaceAllImages', true) };
}

export function registerItemLookupRoutes(add, services) {
  const { library, metadata, metadataEditor } = services;
  if (!library) return;
  const policy = 'RequiresElevation';
  const withItem = async (id, context, action) => {
    if (!nonemptyId(id)) throw httpError(400, "Guid can't be empty");
    let item;
    try { item = await library.getItemRecord(id, { user: context.auth.User }); }
    catch (error) { if (error?.status === 404) return notFound(); throw error; }
    return action(item);
  };
  add('GET', '/Items/{itemId}/ExternalIdInfos', context => withItem(guidValue(context.params.itemId, 'itemId'), context, item => {
    if (!metadataEditor) throw httpError(501, 'External metadata identities are not configured.');
    return metadataEditor.externalIdInfos(item).map(({ Name, Key, Type }) => ({ Name, Key, Type: Type ?? undefined }));
  }), { policy });
  for (const type of remoteSearchTypes) {
    add('POST', '/Items/RemoteSearch/' + type, ({ body, signal }) => remoteMetadataSearch(type, body,
      { library, metadata, configuration: services.configuration, signal }),
    { ...(type === 'Person' ? { policy } : {}), body: true, bodyParameter: 'query', abortOnDisconnect: true, ...remoteSearchBinding(type) });
  }
  add('POST', '/Items/RemoteSearch/Apply/{itemId}', context => {
    const { itemId, replaceAllImages } = context.queryInput;
    return withItem(itemId, context, async item => {
      if (!metadata) throw httpError(501, 'Metadata identification requires configured storage.');
      await metadata.applySearchResult(item.Id, context.body, { replaceAllImages, signal: context.signal });
      return noContent();
    });
  }, { policy, body: true, bodyParameter: 'searchResult', bodyType: 'MediaBrowser.Model.Providers.RemoteSearchResult',
    bindBody: bindSearchResult, bindQuery: bindApplyQuery });
}
