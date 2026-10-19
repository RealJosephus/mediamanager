import { HttpResult, guidValue, httpError, noContent, notFound, commaGuidValues } from './binding.js';

const emptyId = id => !id || /^0{32}$/.test(id.replaceAll('-', ''));

export function registerItemDeletionRoutes(add, { library, playlists, users }) {
  const userById = async id => {
    if (!users) throw httpError(501, 'Item deletion requires the authoritative user service.');
    return users.getUser(id || '00000000000000000000000000000000');
  };
  async function deleteItem(id, user) {
    if (!library) throw httpError(501, 'Item deletion requires the native library lifecycle.');
    const target = await library.getDeletionItem(id, { user });
    if (!target) throw notFound();
    if (user && !target.canDelete) throw new HttpResult(401, 'Unauthorized access');
    if (target.item.Type === 'Playlist') {
      if (!playlists) throw httpError(501, 'Playlist deletion requires its serialized mutation lifecycle.');
      await playlists.delete(id, { user, isApiKey: user === null });
    } else await library.deleteItem(target.item, { DeleteFileLocation: true, DeleteFromExternalProvider: true }, undefined, true);
  }
  add('DELETE', '/Items/{itemId}', async context => {
    const id = guidValue(context.params.itemId, 'itemId');
    const user = emptyId(context.auth.UserId) && context.auth.IsApiKey ? null : await userById(context.auth.UserId);
    if (!user && !context.auth.IsApiKey) throw notFound();
    await deleteItem(id, user);
    return noContent();
  });
  add('DELETE', '/Items', async context => {
    const ids = commaGuidValues(context.query, 'ids');
    const user = !context.auth.IsApiKey && !emptyId(context.auth.UserId) ? await userById(context.auth.UserId) : null;
    if (!context.auth.IsApiKey && !emptyId(context.auth.UserId) && !user) throw httpError(404, 'User not found.');
    if (!context.auth.IsApiKey && !user) throw new HttpResult(401, 'Unauthorized access');
    // Native commits each DeleteItem before looking up the next requested ID.
    // Preserve duplicates and all earlier prefixes; never preflight the batch.
    for (const id of ids) await deleteItem(id, user);
    return noContent();
  });
}
