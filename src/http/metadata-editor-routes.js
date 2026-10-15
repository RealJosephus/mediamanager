import { guidValue, httpError, notFound, noContent, queryValue } from './binding.js';
import { bindItemUpdate } from './item-update-binding.js';

export function registerMetadataEditorRoutes(add, { metadataEditor, itemUpdates } = {}) {
  add('POST', '/Items/{itemId}/ContentType', async context => {
    if (!metadataEditor?.updateContentType) throw httpError(501, 'Content-type editing is not configured.');
    try {
      await metadataEditor.updateContentType(guidValue(context.params.itemId, 'itemId'), queryValue(context.query, 'contentType'), { user: context.auth.User });
      return noContent();
    } catch (error) { if (error?.status === 404) return notFound(); throw error; }
  }, { policy: 'RequiresElevation' });
  add('POST', '/Items/{itemId}', async context => {
    if (!itemUpdates?.update) throw httpError(501, 'Metadata editing is not configured.');
    try {
      await itemUpdates.update(guidValue(context.params.itemId, 'itemId'), context.body, { user: context.auth.User });
      return noContent();
    } catch (error) { if (error?.status === 404) return notFound(); throw error; }
  }, { policy: 'RequiresElevation', body: true, bodyParameter: 'request', bindBody: bindItemUpdate });
  add('GET', '/Items/{itemId}/MetadataEditor', async context => {
    if (!metadataEditor?.get) throw httpError(501, 'Metadata editor information is not configured.');
    const itemId = guidValue(context.params.itemId, 'itemId');
    try {
      return await metadataEditor.get(itemId, { user: context.auth.User });
    } catch (error) {
      if (error?.status === 404) return notFound();
      throw error;
    }
  }, { policy: 'RequiresElevation' });
}
