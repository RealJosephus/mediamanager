const id = number => `c9550000-0000-0000-0000-${String(number).padStart(12, '0')}`;
export const itemCollectionsId = id;

/** Neutral rows/requests only. Native visibility, ordering and DTOs are observed. */
export function itemCollectionsInput(root) {
  const target = id(20), libraryA = id(10), libraryB = id(11);
  const permissions = { EnableAllFolders: true, EnableAllChannels: true, EnableAllDevices: true,
    EnableRemoteAccess: true, EnableMediaPlayback: true, EnableContentDownloading: true };
  const users = [
    { key: 'all', id: id(900), name: 'Collections all', permissions },
    { key: 'admin', id: id(901), name: 'Collections admin', permissions: { ...permissions, IsAdministrator: true } },
    { key: 'library', id: id(902), name: 'Collections selected library', permissions: { ...permissions, EnableAllFolders: false }, preferences: { EnabledFolders: [libraryB] } },
    { key: 'rating', id: id(903), name: 'Collections rating', permissions, maxRating: 5 },
    { key: 'tags', id: id(904), name: 'Collections blocked tags', permissions, preferences: { BlockedTags: ['BLOCKED'] } },
    { key: 'hidden', id: id(905), name: 'Collections hidden target', permissions, preferences: { BlockedTags: ['TARGET'] } },
    { key: 'allowed', id: id(906), name: 'Collections allowed tags', permissions, preferences: { AllowedTags: ['ALLOWED'] } },
    { key: 'blocked', id: id(907), name: 'Collections blocked library', permissions, preferences: { BlockedMediaFolders: [libraryA] } },
    { key: 'parents', id: id(908), name: 'Collections hidden parent', permissions, preferences: { BlockedTags: ['COLLECTIONS-PARENT'] } },
    { key: 'rootBlocked', id: id(909), name: 'Collections user root exception', permissions, preferences: { BlockedTags: ['ROOT-HIDDEN'] } },
  ];
  const item = (number, kind, path, parent, values = {}) => ({ id: id(number), kind, name: kind + ' ' + number, path, parent, ...values });
  const items = [
    item(10, 'CollectionFolder', '{root}/root/default/A', 'user-root', { physicalLocations: ['{root}/media/A'], collectionType: 'movies' }),
    item(11, 'CollectionFolder', '{root}/root/default/B', 'user-root', { physicalLocations: ['{root}/media/B'], collectionType: 'movies' }),
    item(12, 'Folder', '{root}/media/A', 'aggregate'), item(13, 'Folder', '{root}/media/B', 'aggregate'),
    item(14, 'Folder', '{root}/neutral', 'aggregate'), item(15, 'Folder', '{root}/data/collections', 'aggregate', { tags: ['collections-parent'] }),
    item(16, 'Folder', '{root}/data/collections-rated', 'aggregate', { rating: 'R', tags: ['collections-parent'] }),
    item(19, 'Movie', '{root}/neutral/user-root-member.mkv', 'user-root', { rating: 'G', tags: ['allowed'] }),
    item(20, 'Movie', '{root}/neutral/target.mkv', id(14), { name: 'Collection target', rating: 'G', tags: ['target', 'allowed'] }),
    item(21, 'Movie', '{root}/media/A/a.mkv', id(12), { rating: 'G', tags: ['allowed'] }),
    item(22, 'Movie', '{root}/media/B/b.mkv', id(13), { rating: 'G', tags: ['allowed'] }),
    item(23, 'Movie', '{root}/neutral/absent-links.mkv', id(14), { rating: 'G', tags: ['allowed'] }),
    item(30, 'Folder', '{root}/neutral/wrong-parent', id(14)),
    item(31, 'BoxSet', '{root}/data/collections/nonmanual', id(15), { name: 'Nonmanual only', sort: '000', rating: 'G' }),
  ];
  const links = [{ parent: id(30), child: target, type: 0, order: 0 },
    ...[1, 2, 3].map((type, order) => ({ parent: id(31), child: target, type, order }))];
  const names = ['Alpha', 'alpha', 'Éclair', 'éclair', 'I', 'i', 'İ', 'ı', 'K', 'K', 'ſ', 'S', 'ß', 'SS', 'Same', 'Same'];
  for (let index = 0; index < 270; index++) {
    const number = 1000 + index;
    items.push(item(number, 'BoxSet', `{root}/data/${index === 9 ? 'collections-rated' : 'collections'}/${number}`, id(index === 9 ? 16 : 15), {
      name: names[index] ?? `Collection ${String(index).padStart(4, '0')}`,
      sort: index < names.length ? (index < 14 ? 'same' : 'ties') : `group-${index % 4}`,
      rating: index % 7 === 0 ? 'R' : 'G', tags: index % 5 === 0 ? ['blocked'] : ['allowed'],
      overview: `Controlled collection ${index} 中文`,
      ...(index === 3 ? { libraryFolderIds: [] } : index === 4 ? { libraryFolderIds: [libraryB] }
        : index === 5 ? { libraryFolderIds: [id(19)] } : {}),
    }));
    links.push({ parent: id(number), child: target, type: 0, order: 0 },
      { parent: id(number), child: index % 3 === 0 ? id(22) : id(21), type: 0, order: 1 });
    if (index === 0) links.push({ parent: id(number), child: target, type: 0, order: 2 });
    if (index === 1) links.push({ parent: id(number), child: target, type: 1, order: 2 });
  }
  const cases = [], add = (name, suffix = '', auth = 'all', itemId = target, extra = {}) => cases.push({ name, path: `/Items/${itemId}/Collections${suffix}`, auth, ...extra });
  for (const auth of ['anonymous', 'all', 'admin', 'apiKey']) add('authorization ' + auth, '', auth);
  add('API key explicit user', '?userId=' + users[0].id, 'apiKey');
  add('ordinary explicit same user', '?userId=' + users[0].id);
  add('ordinary cross user forbidden', '?userId=' + users[3].id);
  add('admin alternate user policy', '?userId=' + users[4].id, 'admin');
  add('admin unknown user', '?userId=' + id(999), 'admin');
  add('API key empty user', '?userId=' + '0'.repeat(32), 'apiKey');
  add('empty explicit falls back', '?userId=' + '0'.repeat(32));
  add('missing target', '', 'all', id(999)); add('empty target', '', 'all', '0'.repeat(32));
  add('hidden target', '', 'hidden'); add('no manual parent', '', 'all', id(23));
  add('existing BoxSet target no manual parents', '', 'all', id(1009));
  add('modern BoxSet target bypasses R parent', '', 'rating', id(1009));
  add('modern G collection bypasses R parent', '', 'rating');
  add('cached nonfolder user-root membership', '', 'library');
  for (const auth of ['all', 'library', 'blocked', 'rating', 'tags', 'allowed', 'parents']) {
    add(auth + ' complete visible count', '', auth);
    for (const [start, limit] of [[0, 7], [7, 9], [127, 8], [260, 30], [999, 5], [-3, 5], [0, 0], [2, -1]])
      add(`${auth} page ${start}/${limit}`, `?startIndex=${start}&limit=${limit}`, auth);
  }
  add('selected full DTO fields', '?limit=8&fields=SortName,Path,Overview,DateCreated,ProviderIds,Tags,DisplayPreferencesId,ChildCount,RecursiveItemCount,CanDelete');
  add('explicit forced sort Unicode name ties', '?fields=SortName');
  add('ignored selectors and unknown field', '?limit=5&fields=SortName,Unknown&recursive=true&enableImages=false&enableUserData=false&sortBy=Name&sortOrder=Descending');
  add('aggregate binding errors', '?userId=not-guid&startIndex=no&limit=2147483648&fields=Unknown');
  add('binding before unknown item', '?startIndex=no&limit=no', 'all', id(999));
  for (const suffix of ['?userId=&startIndex=&limit=', '?userId=%20&startIndex=%20&limit=%20', '?startIndex=-2147483649&limit=2147483648'])
    add('nullable and boundary binder ' + suffix, suffix);
  add('invalid target and query binding', '?userId=bad&limit=bad', 'all', 'not-guid');
  add('comma fields ignore invalid names', '?limit=3&fields=SortName,NotAField,Path');
  add('enum fields with no DTO consumer', '?limit=3&fields=SeasonUserData,RefreshState,ExtraIds');
  add('numeric and repeated enum fields', '?limit=3&fields=999999,SortName&fields=Overview,-1');
  add('duplicate bound query uses first', '?limit=2&limit=9&startIndex=1&startIndex=7&userId=' + users[0].id + '&userId=' + users[3].id);
  add('user root target bypasses standalone visibility', '', 'rootBlocked', '$user-root');
  add('live name and sort slot', '?limit=5&fields=SortName,Overview', 'all', target,
    { warm: { id: id(1260), name: 'Warm retained collection 中文', sort: '000-live-first' } });
  const warm = (name, number, fields, auth) => add(name, '', auth, target, { warm: { id: id(number), ...fields } });
  warm('warm cached library excludes collection', 1004, { libraryFolderIds: [libraryA] }, 'library');
  warm('warm cached library empty bypass', 1004, { libraryFolderIds: [] }, 'library');
  warm('warm official G to R', 1006, { officialRating: 'R' }, 'rating');
  warm('warm official R to G', 1007, { officialRating: 'G' }, 'rating');
  warm('warm custom R hides collection', 1008, { customRating: 'R' }, 'rating');
  warm('warm custom G reveals collection', 1008, { customRating: 'G' }, 'rating');
  warm('warm custom null uses official', 1008, { customRating: null }, 'rating');
  add('after warm admitted page', '?startIndex=0&limit=7');
  return { schemaVersion: 1, root, serverId: 'c9550000000000000000000000000999', target, rootTags: ['root-hidden'], users, items, links, cases,
    userData: [{ userId: users[0].id, itemId: id(1000), playCount: 7, favorite: true }],
    scope: 'Neutral source rows and requests, actual native manual reverse relation/standalone visibility/controller DTO, real PostgreSQL runtime HTTP. No recording or media execution.' };
}
