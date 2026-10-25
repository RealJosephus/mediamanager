export const countId = number => `9f750000-0000-0000-0000-${String(number).padStart(12, '0')}`;
export function mergedCountInput(root) {
  const item = (number, kind, presentationKey, values = {}) => ({ id: countId(number), kind,
    name: `${kind} ${number}`, presentationKey, rating: 0, virtual: false, ...values });
  const child = (number, parent, key, values = {}) => item(number, 'Movie', key,
    { parent: countId(parent), topParent: countId(parent), ...values });
  const items = [
    item(1, 'UserRootFolder', 'root'), item(10, 'Series', 'shared-show'), item(11, 'Series', 'shared-show'),
    item(12, 'Folder', 'shared-show'), item(13, 'Movie', 'shared-show'), item(14, 'Series', 'SHARED-show'),
    item(15, 'Series', 'single-show'), item(16, 'Season', 'empty-group'), item(17, 'Season', 'empty-group'),
    item(18, 'CollectionFolder', 'proxy', { physicalIds: [10, 10, 11].map(countId) }),
    item(19, 'Folder', ''), item(30, 'Season', 'shared-season'), item(31, 'Season', 'shared-season'),
    child(20, 10, 'same-child'), child(21, 11, 'same-child'), child(22, 12, 'case'), child(23, 10, 'CASE'),
    child(24, 11, null), child(25, 10, ''), child(26, 11, countId(25).replaceAll('-', '')),
    child(27, 11, 'virtual-child', { virtual: true }), child(28, 10, 'restricted', { rating: 21 }),
    child(29, 13, 'not-a-folder-member'),
    item(40, 'Episode', 'same-episode', { parent: countId(10), season: countId(30) }),
    item(41, 'Episode', 'same-episode', { parent: countId(11), season: countId(31) }),
    item(42, 'Episode', 'other-episode', { parent: countId(10), season: countId(31) }),
    item(43, 'Episode', null, { parent: countId(30) }),
    item(44, 'Episode', 'virtual-episode', { parent: countId(11), season: countId(30), virtual: true }),
    child(60, 10, 'owned', { owner: countId(20) }),
    child(61, 11, 'extra', { owner: countId(20), extra: 1 }),
    child(62, 10, 'same-library-alternate', { primary: countId(20) }),
    child(63, 11, 'other-library-alternate', { primary: countId(20) }),
    child(64, 14, 'ordinal-key-case-sensitive'), child(65, 19, 'empty-folder-key-child'),
    child(66, 10, 'Å'), child(67, 11, 'A\u030a'), child(68, 10, 'ß'), child(69, 11, 'SS'),
    item(70, 'Folder', ''), child(71, 70, 'another-empty-parent'),
    item(72, 'Folder', null), item(73, 'Folder', null), child(74, 72, 'null-parent-key'),
    // SeasonId has no native FK; the real ParentId still satisfies its FK.
    // ItemCountService must count this source even without a Season row.
    item(75, 'Episode', 'absent-season-row', { parent: countId(10), season: countId(999) }),
    ...Array.from({ length: 150 }, (_, index) => child(1000 + index, index % 2 ? 10 : 11, 'bounded-' + index)),
  ];
  const parents = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 30, 31, 70, 72, 73, 999].map(countId);
  const folders = [10, 11, 12, 14, 15, 16, 17, 18, 19, 30, 31, 70, 72, 73].map(countId);
  return { schemaVersion: 1, root, serverId: countId(800).replaceAll('-', ''), items,
    links: [10, 15, 16].flatMap(parent => [0, 1, 2].map(order => ({ parent: countId(parent), child: countId(20), type: order === 2 ? 3 : 0, order }))),
    users: [
      { id: countId(900), name: 'all', displayMissing: true, maxRating: null },
      { id: countId(901), name: 'limited', displayMissing: false, maxRating: 5 },
    ],
    cases: [
      ...['all', 'limited', 'anonymous'].map(user => ({ name: 'actual repository batch ' + user, lane: 'repository', user, ids: parents })),
      ...['all', 'limited', 'anonymous'].map(user => ({ name: 'actual DTO source batch ' + user, lane: 'dtoBatch', user, ids: folders })),
      { name: 'single DTO batch fallback uses persisted key despite unsaved key', lane: 'singleDto', user: 'all', ids: [countId(10)],
        warm: { id: countId(10), presentationKey: 'unsaved-key-is-not-a-persisted-group' } },
      { name: 'single Season batch counts flat SeasonId rather than series ParentId', lane: 'singleDto', user: 'limited', ids: [countId(30)] },
      { name: 'repeated input IDs remain one repository dictionary entry', lane: 'repository', user: 'limited', ids: [10, 10, 11].map(countId) },
      { name: 'empty source request is an actual empty dictionary', lane: 'repository', user: 'anonymous', ids: [] },
    ] };
}
