const id = number => `da710000-0000-0000-0000-${String(number).padStart(12, '0')}`;
export const rootLinkId = id;

/** Neutral persisted/warm inputs. Every selection and failure is observed. */
export function rootLinkInput(root) {
  const permissions = { EnableAllFolders: true, EnableAllChannels: true, EnableAllDevices: true,
    EnableRemoteAccess: true, EnableMediaPlayback: true, EnableContentDownloading: true };
  const users = [
    { key: 'all', id: id(900), name: 'Root links all', permissions },
    { key: 'rating', id: id(901), name: 'Root links rating', permissions, maxRating: 5 },
    { key: 'tags', id: id(902), name: 'Root links tags', permissions, preferences: { BlockedTags: ['BLOCKED'] } },
    { key: 'library', id: id(903), name: 'Root links selected', permissions: { ...permissions, EnableAllFolders: false }, preferences: { EnabledFolders: [id(11)] } },
  ];
  const item = (number, kind, relative, parent, values = {}) => ({ id: id(number), kind, name: kind + ' ' + number,
    path: '{root}/' + relative, parent, rating: 'G', ...values });
  const items = [
    item(10, 'CollectionFolder', 'root/default/A', 'user-root', { physicalLocations: ['{root}/media/A'], collectionType: 'movies' }),
    item(11, 'CollectionFolder', 'root/default/B', 'user-root', { physicalLocations: ['{root}/media/B'], collectionType: 'movies' }),
    item(12, 'Folder', 'media/A', 'aggregate'), item(13, 'Folder', 'media/B', 'aggregate'),
    item(14, 'Folder', 'neutral', 'aggregate'), item(15, 'Folder', 'data/collections', 'aggregate'),
    item(16, 'Folder', 'neutral/rated-parent', 'aggregate', { rating: 'R' }),
    item(19, 'Movie', 'neutral/direct.mkv', 'user-root', { name: 'Stored direct movie' }),
    item(400, 'MusicArtist', 'metadata/artist', 'none', { name: 'By name artist' }),
    item(500, 'Movie', 'neutral/rated-parent/own-g.mkv', id(16), { name: 'G child of R parent' }),
    item(600, 'BoxSet', 'data/collections/cached-linked', id(15), { libraryFolderIds: [id(20)] }),
    item(601, 'BoxSet', 'data/collections/cached-direct', id(15), { libraryFolderIds: [id(19)] }),
  ];
  for (let index = 0; index < 140; index++) items.push(item(20 + index, 'Movie', `media/A/member-${index}.mkv`, id(12), {
    name: 'Linked movie ' + String(index).padStart(3, '0'), rating: index % 11 === 0 ? 'R' : 'G',
    tags: index % 7 === 0 ? ['blocked'] : ['allowed'],
  }));
  const links = items.filter(value => Number(value.id.slice(-12)) >= 20 && Number(value.id.slice(-12)) < 160)
    .map((value, order) => ({ parent: 'user-root', child: value.id, type: order % 4, order }));
  links.push({ parent: id(600), child: id(20), type: 0, order: 0 }, { parent: id(601), child: id(20), type: 0, order: 0 });
  const link = (itemId, extra = {}) => ({ ItemId: itemId, Type: 0, Path: null, LibraryItemId: null, ...extra });
  const dtoFields = ['Overview', 'Genres', 'Tags', 'Taglines', 'ProviderIds'];
  const unsaved = (number, prefix) => ({ id: id(number), name: prefix + ' name', overview: prefix + ' overview',
    genres: [prefix + ' genre', ''], tags: [prefix + ' tag', ''], tagline: prefix + ' tagline',
    providerIds: { Tmdb: prefix + '-tmdb', Imdb: prefix + '-imdb' } });
  const cases = [], add = (name, lane = 'root', user = 'all', changes = {}) => cases.push({ name, lane, user, ...changes });
  for (const user of users) add('cold full root ' + user.key, 'root', user.key);
  add('raw collection folders before warm', 'raw');
  add('cached linked identity grants BoxSet membership', 'collections');
  add('cold menu omits Movie links', 'views');
  add('positive repository batch ignores registered warm Name', 'root', 'all', { warm: { id: id(20), name: 'Warm lookup-only name' } });
  add('direct virtual linked same Guid keeps first slot and last positive object', 'root', 'all', {
    direct: [{ id: id(19), name: 'Direct warm occurrence' }],
    virtual: [{ id: id(19), name: 'Virtual warm occurrence' }, { id: id(14) }],
    replaceLinks: [link(id(19)), link(id(20))],
  });
  add('raw folders consume exact warm Children only', 'raw');
  add('explicit empty root handle clears persisted links', 'root', 'all', { direct: 'stored', virtual: [], replaceLinks: [] });
  add('cleared linked membership hides only linked BoxSet', 'collections');
  add('relative Path fallback wins conflicting LibraryItemId', 'root', 'all', {
    replaceLinks: [link(null, { Path: '../../neutral/rated-parent/own-g.mkv', LibraryItemId: id(21) })],
  });
  add('fallback ItemId publication survives a later read', 'root');
  add('root IsVisible allows own G through R parent', 'root', 'rating');
  add('Guid.Empty never retries a valid Path', 'root', 'all', { replaceLinks: [link('0'.repeat(32), { Path: '../../neutral/direct.mkv', LibraryItemId: id(20) })] });
  add('missing positive falls through Path before LibraryItemId', 'root', 'all', { replaceLinks: [link(id(999), { Path: '../../neutral/direct.mkv', LibraryItemId: id(20) })] });
  add('nullable LibraryItemId resolves actual item', 'root', 'all', { replaceLinks: [link(null, { LibraryItemId: id(21) })] });
  add('missing target caches Guid.Empty', 'root', 'all', { replaceLinks: [link(null, { LibraryItemId: id(999) })] });
  add('missing cache remains Empty', 'root');
  add('malformed LibraryItemId fails without caching', 'root', 'all', {
    replaceLinks: [link(null, { LibraryItemId: 'invalid-guid' })],
  });
  add('malformed LibraryItemId fails again', 'root');
  add('malformed LibraryItemId keeps an earlier successful cache', 'root', 'all', {
    replaceLinks: [link(null, { LibraryItemId: id(21) }), link(null, { LibraryItemId: 'invalid-guid' })],
  });
  add('typed MusicArtist is Folder although IsFolder is false', 'root', 'all', { replaceLinks: [link(id(400))] });
  add('actual menu retains typed by-name MusicArtist', 'views');
  add('raw folders exclude linked MusicArtist', 'raw');
  add('typed null is consumed as native failure', 'root', 'all', { replaceLinks: null });
  add('raw Children remains usable with null link relation', 'raw');
  add('new empty handle recovers after null', 'root', 'all', { replaceLinks: [] });
  add('plain root complete DTO uses all 140 positive links', 'dto', 'all', { direct: 'stored', virtual: [],
    replaceLinks: links.filter(value => value.parent === 'user-root').map(value => link(value.child, { Type: value.type })) });
  add('plain root DTO retains independent unsaved direct and virtual media', 'dto', 'all', {
    direct: [unsaved(19, 'Direct unsaved')], virtual: [unsaved(500, 'Virtual unsaved')], replaceLinks: [],
  });
  add('plain root DTO keeps first Guid position and last unsaved virtual value', 'dto', 'all', {
    direct: [unsaved(19, 'First direct'), unsaved(500, 'Second direct')],
    virtual: [{ ...unsaved(19, 'Last virtual'), overview: null, tagline: '' }], replaceLinks: [],
  });
  add('plain root positive repository DTO replaces same Guid unsaved occurrences', 'dto', 'all', {
    direct: [unsaved(19, 'Direct loser')], virtual: [unsaved(19, 'Virtual loser'), unsaved(20, 'Linked loser')],
    replaceLinks: [link(id(19)), link(id(20))],
  });
  add('plain root positive DTO ignores complete registered warm metadata', 'dto', 'all', {
    warm: unsaved(20, 'Registered loser'), direct: [], virtual: [], replaceLinks: [link(id(20)), link(id(21))],
  });
  add('restored positive link is independent of disposed frames', 'root', 'all', { replaceLinks: [link(id(20)), link(id(21))] });
  add('linked cached membership returns after replacement', 'collections');
  return { schemaVersion: 1, root, serverId: 'da710000000000000000000000009999', rootTags: [], users, items, links, userData: [], target: id(20), dtoFields, cases,
    scope: 'Current actual UserRoot.GetChildren, complete plain-root DtoService output, raw GetCollectionFolders, cached BoxSet user-root membership and UserViewManager, independently captured; production PG runtime/navigation/queryItems consumers. No media execution.' };
}
