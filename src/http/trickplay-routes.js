import { guidValue, integerValue, queryValue } from './binding.js';
import { trickplayPlaylist, trickplayTile } from '../playback/trickplay.js';

export function registerTrickplayRoutes(add, { library, store, fileSystem }) {
  if (!library || !store || !fileSystem) return;
  const bind = context => {
    const itemId = guidValue(context.params.itemId, 'itemId');
    return [guidValue(queryValue(context.query, 'mediaSourceId'), 'mediaSourceId', itemId),
      integerValue(context.params.width, 'width')];
  };
  add('GET', '/Videos/{itemId}/Trickplay/{width}/tiles.m3u8', context => trickplayPlaylist(store,
    ...bind(context), { token: context.auth.Token, signal: context.signal }));
  add('GET', '/Videos/{itemId}/Trickplay/{width}/{index}.jpg', context => trickplayTile({ library, store, fileSystem },
    ...bind(context), integerValue(context.params.index, 'index'), { user: context.auth.User, signal: context.signal }));
}
