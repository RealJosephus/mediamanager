import { rootLinkInput, rootLinkId as id } from './input.js';

/** Persisted membership and explicit live assignments, without expected output. */
export function folderLinkInput(root) {
  const input = rootLinkInput(root), folder = id(14);
  input.items.push({ id: id(700), kind: 'Movie', name: 'Physical child',
    path: '{root}/neutral/physical.mkv', parent: folder, rating: 'G' });
  input.links.push({ parent: folder, child: id(21), type: 0, order: 0 });
  const link = (ItemId, extra = {}) => ({ ItemId, Type: 0, Path: null, LibraryItemId: null, ...extra });
  // A single public query occurrence is pipe-delimited. Repeated occurrences
  // pass each value intact through the actual native collection binder.
  const literal = value => [value, value];
  const cases = [], add = (name, changes = {}) => cases.push({ name, folder, lane: 'folder', user: 'all',
    query: { SortBy: ['SortName'] }, ...changes });
  add('cold persisted direct and linked children');
  add('warm replacement overrides persisted membership', { replaceLinks: [link(id(22)), link(id(23))] });
  add('duplicate warm links keep one item', { replaceLinks: [link(id(22)), link(id(22))] });
  add('explicit empty handle retains only physical children', { replaceLinks: [] });
  add('relative Path precedes conflicting LibraryItemId', {
    replaceLinks: [link(null, { Path: '../media/A/member-0.mkv', LibraryItemId: id(21) })] });
  add('resolved Path cache survives another query');
  add('missing positive ID falls back to Path', {
    replaceLinks: [link(id(999), { Path: '../media/A/member-1.mkv', LibraryItemId: id(22) })] });
  add('nullable LibraryItemId resolves', { replaceLinks: [link(null, { LibraryItemId: id(22) })] });
  add('malformed LibraryItemId propagates without caching', { replaceLinks: [link(null, { LibraryItemId: 'invalid-guid' })] });
  add('malformed identity fails again without a negative cache');
  add('malformed identity preserves earlier cache publication', {
    replaceLinks: [link(null, { LibraryItemId: id(22) }), link(null, { LibraryItemId: 'invalid-guid' })] });
  add('missing valid LibraryItemId caches Empty', { replaceLinks: [link(null, { LibraryItemId: id(999) })] });
  add('negative cache persists without retry');
  add('Empty cached identity skips a valid Path', {
    replaceLinks: [link('0'.repeat(32), { Path: '../media/A/member-3.mkv' })] });
  add('warm parent Path controls relative fallback', { folderPath: '{root}/media/A',
    replaceLinks: [link(null, { Path: 'member-2.mkv', LibraryItemId: id(23) })] });
  add('warm parent Path stays live', { replaceLinks: [link(null, { Path: 'member-3.mkv' })] });
  add('typed null links fail before filtering', { replaceLinks: null });
  add('empty replacement recovers after null', { replaceLinks: [] });
  const all = Array.from({ length: 140 }, (_, index) => link(id(20 + index)));
  add('complete positive batch exceeds one page', { replaceLinks: all });
  add('SQL count and page follow resolved membership', { query: { SortBy: ['SortName'], StartIndex: 125, Limit: 5 } });
  add('rating filters apply to resolved targets', { user: 'rating', query: { SortBy: ['SortName'], Limit: 8 } });
  add('tags filter resolved targets', { user: 'tags', query: { SortBy: ['SortName'], Limit: 8 } });
  add('name filter and paging use resolved membership', { query: { SortBy: ['SortName'], NameStartsWith: 'linked', Limit: 3 } });
  add('explicit warm empty Children overrides persisted physical rows', { direct: [], replaceLinks: [] });
  add('warm Children preserve source order without sorting', { direct: [
    { id: id(23), name: 'Warm third' }, { id: id(21), name: 'Warm first' }, { id: id(22), name: 'Warm second' }
  ], query: {} });
  add('fresh unpersisted child participates without writes', { direct: [
    { id: id(800), kind: 'Movie', name: 'Unsaved movie', path: '{root}/neutral/unsaved.mkv', parentId: folder,
      overview: 'Unsaved overview', genres: ['Warm|Genre', '音樂'], tags: ['Warm|Tag', 'ß'], tagline: 'Unsaved tagline',
      providerIds: { Imdb: 'unsaved-provider' }, rating: 'G', year: 2025 }
  ] });
  add('single genre occurrence uses the native pipe binder', { query: { Genres: ['warm|genre'] } });
  add('warm typed genres retain literal separators', { query: { Genres: literal('warm|genre') } });
  add('single tag occurrence uses the native pipe binder', { query: { Tags: ['warm|tag'] } });
  add('warm typed tags retain literal separators', { query: { Tags: literal('warm|tag') } });
  add('warm providers and year participate in full filtering', { query: { HasImdbId: true, Years: [2025] } });
  add('warm duplicate winner keeps first position and last eligible instance', { direct: [
    { id: id(22), name: 'First occurrence' }, { id: id(21), name: 'Middle occurrence' }, { id: id(22), name: 'Last occurrence' }
  ], query: {} });
  add('visibility precedes duplicate winner selection', { user: 'rating', direct: [
    { id: id(22), name: 'Visible first', rating: 'G' }, { id: id(21), name: 'Visible middle', rating: 'G' },
    { id: id(22), name: 'Hidden last', rating: 'R' }
  ], query: {} });
  add('name eligibility precedes duplicate winner selection', { direct: [
    { id: id(22), name: 'Eligible first' }, { id: id(21), name: 'Eligible middle' }, { id: id(22), name: 'Excluded last' }
  ], query: { NameStartsWith: 'Eligible' } });
  add('full filter follows winner without falling back to earlier instance', { direct: [
    { id: id(22), name: 'First with overview', overview: 'Present' }, { id: id(21), name: 'Middle with overview', overview: 'Present' },
    { id: id(22), name: 'Last without overview', overview: '' }
  ], query: { HasOverview: true } });
  add('positive batch supplies a fresh linked instance after warm direct', { direct: [
    { id: id(22), name: 'Unsaved direct duplicate', tags: ['warm-only'] }
  ], replaceLinks: [link(id(22))], query: {} });
  add('fallback target uses the current unsaved cached entity', { direct: [],
    warm: { id: id(24), name: 'Cached unsaved target', overview: 'Live target overview', genres: ['Live|Genre'], tags: ['Live|Tag'],
      tagline: 'Live tagline', providerIds: { Imdb: 'live-id' }, year: 2024 },
    replaceLinks: [link(null, { LibraryItemId: id(24) })], query: { Genres: literal('live|genre'), Tags: literal('live|tag'), Years: [2024], HasImdbId: true }
  });
  add('published positive cache switches the next read to repository batch', { query: {} });
  const sorted = [
    { id: id(23), name: 'The Zebra', sort: 'same', year: 2026, communityRating: 6, index: 3, created: '2026-10-01T01:02:03.0000002Z' },
    { id: id(22), name: '!Alpha', sort: 'same', year: 2025, communityRating: 9, index: 2, created: '2026-10-01T01:02:03.0000001Z' },
    { id: id(21), name: 'Beta', sort: 'same', year: 2025, communityRating: 9, index: 1, created: '2026-10-01T01:02:03.0000001Z' }
  ];
  add('equal SortName is stable in first occurrence order', { direct: sorted, replaceLinks: [], query: { SortBy: ['SortName'] } });
  add('Name sorting reads raw warm Name', { query: { SortBy: ['Name'] } });
  add('warm multi-key sorting and SQL page retain stable ties', { query: { SortBy: ['ProductionYear', 'CommunityRating'], SortOrder: ['Ascending', 'Descending'], StartIndex: 1, Limit: 1 } });
  add('warm creation time sorting retains seventh fractional digit', { query: { SortBy: ['DateCreated'], Limit: 2 } });
  add('descending warm index order ignores an unbound minimum selector', { query: { MinIndexNumber: 2, SortBy: ['IndexNumber'], SortOrder: ['Descending'] } });
  add('NaN rating outside the selected page is not serialized early', { direct: [
    { id: id(21), name: 'Alpha finite', communityRating: 8 }, { id: id(22), name: 'Zulu NaN', communityRating: 'NaN' }
  ], query: { SortBy: ['Name'], Limit: 1 } });
  add('NaN fails native minimum rating comparison', { query: { MinCommunityRating: 1 } });
  add('warm scalar filters use unsaved state', { direct: [
    { id: id(22), name: 'Included scalar', year: 2024, locked: true, index: 5, parentIndex: 2,
      rating: '', customRating: 'G', premiere: '2024-01-01T00:00:00.0000002Z', providerIds: { Tmdb: 'warm-id' } },
    { id: id(21), name: 'Excluded scalar', year: 2020, locked: false, index: 1, parentIndex: 1 }
  ], query: { Years: [2024], IsLocked: true, MinIndexNumber: 3, ParentIndexNumber: 2, HasTmdbId: true,
    HasParentalRating: true, MinPremiereDate: '2024-01-01T00:00:00.0000002Z' } });
  add('warm Children cross bounded pages before full SQL pagination', { direct: Array.from({ length: 140 }, (_, index) => ({
    id: id(20 + index), name: 'Warm ordered ' + String(139 - index).padStart(3, '0'), sort: 'same',
    overview: index % 2 ? '' : 'Even overview', genres: ['Warm|Genre'], tags: ['Warm|Tag']
  })), query: { HasOverview: true, Genres: literal('warm|genre'), SortBy: ['SortName'], StartIndex: 63, Limit: 5 } });
  add('movie grouping introduces collections outside the source folder', { configuration: {
    EnableGroupingMoviesIntoCollections: true, EnableGroupingShowsIntoCollections: false
  }, direct: [{ id: id(20) }, { id: id(22), name: 'Remaining warm movie' }], replaceLinks: [], query: {} });
  add('grouped collections count and page use replacement rows', { query: { SortBy: ['SortName'], StartIndex: 1, Limit: 1 } });
  add('grouped name filtering reads each collection name', { direct: [{ id: id(20) }],
    query: { NameStartsWith: 'linked', SortBy: ['SortName'] } });
  add('warm rating filtering precedes collection replacement', { direct: [
    { id: id(20), name: 'Low warm member', communityRating: 2 },
    { id: id(22), name: 'High warm nonmember', communityRating: 8 }
  ], query: { MinCommunityRating: 5 } });
  add('a collection replaces repeated source members once', { direct: [{ id: id(20) }, { id: id(20) }], query: {} });
  add('single configured type keeps remaining items after grouped members', { direct: [
    { id: id(805), kind: 'Folder', name: 'Unsaved remaining folder', path: '{root}/neutral/remaining', parentId: folder },
    { id: id(20) }, { id: id(22), name: 'Uncollected movie' }
  ], query: {} });
  add('both configured types preserve unsaved remaining folder rows', { configuration: {
    EnableGroupingMoviesIntoCollections: true, EnableGroupingShowsIntoCollections: true
  }, query: {} });
  add('warm empty collections Children prevent collection replacement', { collectionsChildren: [],
    configuration: { EnableGroupingMoviesIntoCollections: true, EnableGroupingShowsIntoCollections: false },
    direct: [{ id: id(20), rating: 'G', tags: ['allowed'] }, { id: id(22), rating: 'G', tags: ['allowed'] }], query: {} });
  add('warm empty collections Children remain authoritative on another read', { query: {} });
  add('warm collections Children restrict the replacement catalogue', { collectionsChildren: [{ id: id(600), cached: true }], query: {} });
  add('a replacement DTO reads the current unsaved collection object', { collectionsChildren: [
    { id: id(600), cached: true, name: 'Unsaved collection title', sort: 'Warm collection sort', overview: 'Live collection overview' }
  ], query: {} });
  add('collection visibility precedes replacement membership', { user: 'tags', collectionsChildren: [
    { id: id(600), cached: true, tags: ['blocked'] }
  ], query: {} });
  add('a visible warm replacement uses live sorting and paging', { collectionsChildren: [
    { id: id(600), cached: true, tags: ['allowed'] }
  ], query: { SortBy: ['SortName'], StartIndex: 1, Limit: 1 } });
  add('reset collections Children reload the physical catalogue', { collectionsChildren: 'stored', query: {} });
  const collectionCase = (name, changes = {}) => add(name, { observeCollections: true, query: {}, ...changes });
  collectionCase('warm collection links replace persisted membership', { collectionsChildren: [
    { id: id(600), cached: true, track: 'cached', links: [link(id(22))] }
  ] });
  collectionCase('positive collection membership stops before malformed fallback', { direct: [{ id: id(20) }], collectionsChildren: [
    { id: id(600), cached: true, track: 'cached', links: [link(id(20), { LibraryItemId: 'invalid-guid' }), link(null, { LibraryItemId: 'invalid-guid' })] }
  ] });
  collectionCase('a later source reaches malformed collection fallback', { direct: [{ id: id(22) }] });
  collectionCase('malformed collection fallback fails again without negative caching');
  collectionCase('collection Path cache publication precedes malformed fallback', { collectionsChildren: [
    { id: id(600), cached: true, track: 'cached', links: [link(null, { Path: '{root}/media/A/member-0.mkv', LibraryItemId: id(22) }),
      link(null, { LibraryItemId: 'invalid-guid' })] }
  ] });
  collectionCase('complete source filtering precedes a null collection handle', { direct: [
    { id: id(20), communityRating: 2 }
  ], collectionsChildren: [{ id: id(600), cached: true, track: 'cached', links: null }], query: { MinCommunityRating: 5 } });
  collectionCase('collection visibility consumes null links before tag rejection', { user: 'tags', direct: [
    { id: id(20), tags: ['allowed'], rating: 'G' }
  ], collectionsChildren: [{ id: id(600), cached: true, track: 'cached', tags: ['blocked'], links: null }] });
  collectionCase('last visible same-ID collection supplies the exact replacement', { direct: [{ id: id(22) }], collectionsChildren: [
    { id: id(600), name: 'First collection copy', tags: ['allowed'], track: 'first', links: [link(id(20))] },
    { id: id(600), name: 'Last collection copy', tags: ['allowed'], track: 'last', links: [link(id(22))] }
  ] });
  collectionCase('an invisible last collection preserves the earlier eligible copy', { user: 'tags', direct: [{ id: id(20) }], collectionsChildren: [
    { id: id(600), name: 'Visible earlier collection', tags: ['allowed'], track: 'first', links: [link(id(20))] },
    { id: id(600), name: 'Invisible later collection', tags: ['blocked'], track: 'last', links: [link(id(22))] }
  ] });
  collectionCase('a collection without a repository row remains a live replacement', { collectionsChildren: [
    { id: id(942), kind: 'BoxSet', name: 'Unsaved replacement collection', path: '{root}/data/collections/unsaved',
      parentId: id(15), track: 'unsaved', links: [link(id(20))] }
  ] });
  collectionCase('collection traversal order sets first replacement positions', { collectionsChildren: [
    { id: id(601), name: 'First catalogue occurrence', track: 'first', links: [link(id(20))] },
    { id: id(600), name: 'Second catalogue occurrence', track: 'last', links: [link(id(20))] }
  ] });
  collectionCase('reset collection catalogue leaves detached observed handles unchanged', { collectionsChildren: 'stored' });
  add('userless empty Children ignores an invalid loaded link branch', { user: null, direct: [], replaceLinks: null, query: {} });
  add('userless repeated read keeps the invalid links unconsumed', { user: null, query: {} });
  add('userless warm Children retain repeated identities and unsaved fields', { user: null, direct: [
    { id: id(21), name: 'First userless copy', sort: 'same', rating: 'R', tags: ['blocked'], communityRating: 9 },
    { id: id(21), name: 'Second userless copy', sort: 'same', rating: 'G', overview: 'Live second overview', communityRating: 2 },
    { id: id(22), name: 'Third userless item', sort: 'same', communityRating: 7 }
  ], query: {} });
  add('userless stable sort and page preserve each repeated occurrence', { user: null,
    query: { SortBy: ['SortName'], StartIndex: 1, Limit: 1 } });
  add('userless rating sort compares exact repeated occurrences', { user: null,
    query: { SortBy: ['CommunityRating'], Limit: 2 } });
  add('userless filters use warm values and ignore IsPlayed', { user: null,
    query: { HasOverview: true, IsPlayed: true } });
  add('userless explicit empty links still do not add linked rows', { user: null, replaceLinks: [link(id(23))], query: {} });
  add('userless cold Children use physical rows only', { user: null, direct: 'stored', query: { SortBy: ['SortName'] } });
  const episodes = [
    { id: id(900), kind: 'Episode', name: 'Regular second', parentIndex: 1, index: 2 },
    { id: id(900), kind: 'Episode', name: 'Special before second', parentIndex: 0, index: 1,
      airsBeforeSeason: 1, airsBeforeEpisode: 2 },
    { id: id(901), kind: 'Episode', name: 'Special after season', parentIndex: 0, index: 2, airsAfterSeason: 1 },
    { id: id(902), kind: 'Episode', name: 'Regular first', parentIndex: 1, index: 1 },
    { id: id(903), kind: 'Movie', name: 'Non episode' }
  ].map(value => ({ ...value, parentId: folder, path: `{root}/neutral/${value.name}.mkv` }));
  add('userless aired ordering reads each repeated Episode object', { user: null, direct: episodes,
    query: { SortBy: ['AiredEpisodeOrder'] } });
  add('userless descending aired ordering retains special positions', { user: null,
    query: { SortBy: ['AiredEpisodeOrder'], SortOrder: ['Descending'] } });
  add('userless aired ordering counts before paging', { user: null,
    query: { SortBy: ['AiredEpisodeOrder'], StartIndex: 1, Limit: 2 } });
  add('userless aired ordering supports a secondary live key', { user: null,
    query: { SortBy: ['AiredEpisodeOrder', 'Name'], SortOrder: ['Ascending', 'Descending'] } });
  add('user aired ordering preserves unsaved Episode special fields', {
    direct: episodes.map((value, index) => ({ ...value, id: id(910 + index) })), replaceLinks: [],
    configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
    query: { SortBy: ['AiredEpisodeOrder'] } });
  add('userless disabled images do not consume a null image list', { user: null, direct: [
    { id: id(940), kind: 'Movie', name: 'Null image list', parentId: folder, images: null }
  ], query: { EnableImages: false } });
  const image = (type, tick, blurHash) => ({ type, path: `{root}/neutral/${blurHash}.jpg`,
    modified: `2026-10-01T01:02:03.000000${tick}Z`, width: 40, height: 20, blurHash });
  add('userless repeated identities retain their own image tags and blur hashes', { user: null, direct: [
    { id: id(941), kind: 'Movie', name: 'First image occurrence', parentId: folder, path: '{root}/neutral/images.mkv',
      images: [image('Primary', 1, 'FirstPrimary'), image('Backdrop', 3, 'FirstBackdrop')] },
    { id: id(941), kind: 'Movie', name: 'Second image occurrence', parentId: folder, path: '{root}/neutral/images.mkv',
      images: [image('Primary', 2, 'SecondPrimary'), image('Backdrop', 4, 'SecondBackdrop'), image('Backdrop', 5, 'SecondBackdropTwo')] }
  ], query: { EnableImages: true, EnableImageTypes: ['Primary', 'Backdrop'], ImageTypeLimit: 2 } });
  add('userless image DTOs follow the selected exact occurrence page', { user: null,
    query: { SortBy: ['Name'], EnableImages: true, EnableImageTypes: ['Primary', 'Backdrop'], ImageTypeLimit: 2, StartIndex: 1, Limit: 1 } });
  add('userless image type limits apply to both repeated objects', { user: null,
    query: { EnableImages: true, EnableImageTypes: ['Primary'], ImageTypeLimit: 1 } });
  const catalogueChild = (number, name) => ({ id: id(number), kind: 'BoxSet', name,
    parentId: id(15), path: '{root}/data/collections/' + number, links: [link(id(20))], track: 'root-child-' + number });
  add('warm root catalogue alias keeps its own empty Children', { observeCollections: true,
    configuration: { EnableGroupingMoviesIntoCollections: true, EnableGroupingShowsIntoCollections: false },
    direct: [{ id: id(20) }], replaceLinks: [], query: {},
    aggregateChildren: [{ id: id(15), children: [], track: 'empty-root-parent' }] });
  add('warm root catalogue alias supplies its unsaved collection child', { observeCollections: true, query: {},
    aggregateChildren: [{ id: id(15), children: [catalogueChild(944, 'Root alias collection')], track: 'live-root-parent' }] });
  add('first same-ID root catalogue parent controls its private Children', { observeCollections: true, query: {},
    aggregateChildren: [
      { id: id(15), children: [catalogueChild(945, 'First root parent collection')], track: 'first-root-parent' },
      { id: id(15), children: [catalogueChild(946, 'Second root parent collection')], track: 'second-root-parent' }
    ] });
  add('warm root parent path selects an unsaved catalogue owner', { observeCollections: true, query: {},
    aggregateChildren: [
      { id: id(15), path: '{root}/neutral/not-a-collection-parent', children: [], track: 'moved-root-parent' },
      { id: id(949), kind: 'Folder', path: '{root}/data/collections', children: [catalogueChild(947, 'Unsaved root parent collection')],
        track: 'unsaved-root-parent' }
    ] });
  add('reset root Children restores the stored collection catalogue', { observeCollections: true, query: {},
    aggregateChildren: 'stored', collectionsChildren: 'stored' });
  add('final full membership remains independently owned', { direct: 'stored', replaceLinks: all, configuration: {
    EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false
  } });
  return { ...input, cases, dtoFields: [...input.dtoFields, 'DateCreated', 'SortName'],
    scope: 'Actual Folder.GetItems, raw cache, warm Children and unsaved query fields, complete selected DtoService output and formal PostgreSQL queryItems with SQL visibility, winners, filtering, count, ordering and paging.' };
}
