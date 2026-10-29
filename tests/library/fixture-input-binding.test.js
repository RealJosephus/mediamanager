import test from 'node:test';
import assert from 'node:assert/strict';
import { bindFixtureInput, bindFixtureRequestBody, bindFixtureUserQuery } from '../helpers/fixture-input-binding.js';

const fixtureId = '5c6b5f77-bea9-4a9a-98aa-fae5909892b7';
const otherId = '22222222-2222-4222-8222-222222222222';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const itemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const user = { fixtureId, actualId: userId };
const bindings = { user, items: [{ fixtureId, actualId: itemId }] };

test('raw query binding changes only complete UserId values and preserves other raw pairs', () => {
  const pairs = [
    [`SearchTerm=${fixtureId}`, `SearchTerm=${fixtureId}`],
    [`UserId=${fixtureId}`, `UserId=${userId}`],
    [`Name=prefix${fixtureId}suffix`, `Name=prefix${fixtureId}suffix`],
    ['%55serId=%35c6b5f77-bea9-4a9a-98aa-fae5909892b7', `%55serId=${userId}`],
    ['uSeRiD=5C6B5F77BEA94A9A98AAFAE5909892B7', `uSeRiD=${userId}`],
    [`UserId=${fixtureId}%ZZ`, `UserId=${fixtureId}%ZZ`],
    [`UserId=x${fixtureId}`, `UserId=x${fixtureId}`],
    [`UserId=${otherId}`, `UserId=${otherId}`],
    [`%ZZUserId=${fixtureId}`, `%ZZUserId=${fixtureId}`],
    [`${fixtureId}=${fixtureId}`, `${fixtureId}=${fixtureId}`],
    ['opaque=%2f%2F+a%20b%ZZ', 'opaque=%2f%2F+a%20b%ZZ'],
    ['UserId', 'UserId'], ['UserId=', 'UserId='], ['', ''], ['flag', 'flag'],
  ];
  const query = pairs.map(([before]) => before).join('&');
  const expected = pairs.map(([, after]) => after).join('&');
  assert.equal(bindFixtureUserQuery(query, user), expected);
  assert.notEqual(bindFixtureUserQuery(query.replace('SearchTerm=', 'Name='), user), expected);
  assert.notEqual(bindFixtureUserQuery(query.replace(`SearchTerm=${fixtureId}`, `SearchTerm=${otherId}`), user), expected);
});

test('Programs POST binds root DTO roles without changing opaque fields, keys or invalid user values', () => {
  const body = { UserId: fixtureId, LibrarySeriesId: fixtureId, ChannelIds: [fixtureId, otherId],
    GenreIds: `${fixtureId},${otherId}`, Name: fixtureId, SearchTerm: `prefix${fixtureId}`,
    Unknown: { UserId: fixtureId, ChannelIds: [fixtureId] }, [fixtureId]: fixtureId };
  const request = { action: 'live-tv-programs', method: 'POST', body };
  const expected = { ...body, UserId: userId, LibrarySeriesId: itemId, ChannelIds: [itemId, otherId],
    GenreIds: `${itemId},${otherId}` };
  assert.deepEqual(bindFixtureRequestBody(request, bindings), expected);
  assert.deepEqual(body.UserId, fixtureId);
  assert.deepEqual(bindFixtureRequestBody(request, { user }), { ...body, UserId: userId });
  assert.notDeepEqual(bindFixtureRequestBody({ ...request, body: { ...body, Name: otherId } }, bindings), expected);
  for (const action of ['items', 'live-tv-program', undefined]) {
    assert.deepEqual(bindFixtureRequestBody({ ...request, action }, bindings), body);
  }
  assert.deepEqual(bindFixtureRequestBody({ ...request, method: 'GET' }, bindings), body);
  for (const value of [null, 4, '', 'not-a-guid', `${fixtureId}suffix`, otherId]) {
    assert.deepEqual(bindFixtureRequestBody({ ...request, body: { UserId: value, Name: fixtureId } }, bindings),
      { UserId: value, Name: fixtureId });
  }
});

test('fixture entity relationships keep user and item identity domains separate from display and other tables', () => {
  const raw = '{ "UserId":"' + fixtureId + '", "Unknown":9007199254740993, "Unknown":1e0 }';
  const source = { userId: fixtureId, rootId: fixtureId, Name: fixtureId,
    Unknown: { userId: fixtureId, id: fixtureId },
    items: [{ key: fixtureId, id: fixtureId, type: 'Folder', name: fixtureId,
      cleanName: fixtureId, sortName: fixtureId, parentId: fixtureId, topParentId: fixtureId,
      ownerId: fixtureId, primaryVersionId: fixtureId, seriesId: fixtureId, seasonId: fixtureId,
      channelId: fixtureId, ancestorIds: [fixtureId, otherId], presentationUniqueKey: fixtureId,
      path: fixtureId, providerIds: { Tmdb: fixtureId }, dataText: raw,
      data: { UserId: fixtureId, PhysicalFolderIds: [fixtureId], ProviderIds: { Tmdb: fixtureId } },
      streams: [{ itemId: fixtureId, title: fixtureId, Unknown: { itemId: fixtureId } }] }],
    links: [{ parentId: fixtureId, childId: fixtureId, label: fixtureId }],
    mediaStreams: [{ itemId: fixtureId, itemKey: fixtureId, title: fixtureId }],
    people: [{ id: fixtureId, name: fixtureId }], images: [{ id: fixtureId, itemKey: fixtureId }],
    itemValues: [{ id: fixtureId, value: fixtureId }], userData: [{ itemKey: fixtureId, customDataKey: fixtureId }], cases: [] };
  const actual = bindFixtureInput(source, bindings);
  assert.equal(actual.userId, userId);
  assert.equal(actual.rootId, itemId);
  assert.deepEqual(actual.items[0], { ...source.items[0], id: itemId, parentId: itemId, topParentId: itemId,
    ownerId: itemId, primaryVersionId: itemId, seriesId: itemId, seasonId: itemId, channelId: itemId,
    ancestorIds: [itemId, otherId], streams: [{ ...source.items[0].streams[0], itemId }] });
  assert.deepEqual(actual.links, [{ parentId: itemId, childId: itemId, label: fixtureId }]);
  assert.deepEqual(actual.mediaStreams, [{ itemId, itemKey: fixtureId, title: fixtureId }]);
  for (const key of ['Name', 'Unknown', 'people', 'images', 'itemValues', 'userData']) assert.deepEqual(actual[key], source[key]);
  assert.equal(actual.items[0].dataText, raw);
  const changed = { ...source, items: [{ ...source.items[0], name: otherId }] };
  assert.notDeepEqual(bindFixtureInput(changed, bindings), actual);
});

test('fixture Data binds declared entity relationships and preserves unknown and legacy string members', () => {
  const data = [
    { type: 'CollectionFolder', data: { PhysicalFolderIds: [fixtureId, otherId], PhysicalLocationsList: [fixtureId],
      Unknown: { PhysicalFolderIds: [fixtureId] }, ProviderIds: { Tmdb: fixtureId } } },
    { type: 'UserView', data: { UserId: fixtureId, DisplayParentId: fixtureId, Name: fixtureId, Unknown: { UserId: fixtureId } } },
    { type: 'Playlist', data: { OwnerUserId: fixtureId, Shares: [{ UserId: fixtureId, Name: fixtureId,
      Unknown: { UserId: fixtureId } }], Unknown: { OwnerUserId: fixtureId } } },
    { type: 'BoxSet', data: { LibraryFolderIds: [fixtureId, otherId], Unknown: { LibraryFolderIds: [fixtureId] } } },
    { type: 'Movie', data: { LinkedAlternateVersions: [{ ItemId: fixtureId, LibraryItemId: fixtureId, Path: fixtureId,
      Unknown: { ItemId: fixtureId } }], Unknown: { LinkedAlternateVersions: [{ ItemId: fixtureId }] } } },
    { type: 'Folder', data: { UserId: fixtureId, DisplayParentId: fixtureId, OwnerUserId: fixtureId,
      Shares: [{ UserId: fixtureId }], LibraryFolderIds: [fixtureId] } },
  ];
  const source = { userId: fixtureId, rootId: otherId, items: data.map((value, index) => ({ ...value, key: String(index), id: otherId })), cases: [] };
  const actual = bindFixtureInput(source, bindings).items.map(item => item.data);
  assert.deepEqual(actual, [
    { ...data[0].data, PhysicalFolderIds: [itemId, otherId] },
    { ...data[1].data, UserId: userId, DisplayParentId: itemId },
    { ...data[2].data, OwnerUserId: userId, Shares: [{ ...data[2].data.Shares[0], UserId: userId }] },
    { ...data[3].data, LibraryFolderIds: [itemId, otherId] },
    { ...data[4].data, LinkedAlternateVersions: [{ ...data[4].data.LinkedAlternateVersions[0], ItemId: itemId }] },
    data[5].data,
  ]);
  const changed = { ...source, items: source.items.map((item, index) => index === 0
    ? { ...item, data: { ...item.data, ProviderIds: { Tmdb: otherId } } } : item) };
  assert.notDeepEqual(bindFixtureInput(changed, bindings).items.map(item => item.data), actual);
});

test('preparation binds declared requests and preferences without entering opaque query, configuration or timer content', () => {
  const source = { userId: fixtureId, rootId: otherId, items: [{ id: otherId, type: 'Folder' }],
    warmUserViews: { configuration: { GroupedFolders: [fixtureId], Name: fixtureId },
      policy: { EnabledFolders: [fixtureId], BlockedTags: [fixtureId], Unknown: { EnabledFolders: [fixtureId] } } },
    timerDocuments: { timers: [{ Id: fixtureId, ProgramId: fixtureId, Name: fixtureId }] },
    cases: [
      { action: 'filters', name: fixtureId, query: `ParentId=${fixtureId}&UserId=${fixtureId}&SearchTerm=${fixtureId}&bad=%ZZ`,
        parallelQueries: [`UserId=${fixtureId}&ParentId=${fixtureId}`, `ParentId=x${fixtureId}`],
        configuration: { OrderedViews: [fixtureId], CustomName: fixtureId },
        policy: { EnabledChannels: [fixtureId], EnableContentDeletionFromFolders: [fixtureId], BlockedTags: [fixtureId] },
        serverConfiguration: { Name: fixtureId, UserId: fixtureId } },
      { action: 'live-tv-programs', method: 'POST', query: `ChannelIds=${fixtureId}%2C${otherId},${fixtureId}&LibrarySeriesId=${fixtureId}`,
        body: { UserId: fixtureId, ChannelIds: [fixtureId], Name: fixtureId } },
      { action: 'theme', themeItemId: fixtureId, introItemId: fixtureId, query: `ParentId=${fixtureId}&UserId=${fixtureId}` },
      { action: 'intros', introUserId: fixtureId, introItemId: fixtureId, query: '' },
      { action: 'suggestions', suggestionUserId: fixtureId, query: '' },
      { action: 'latest', query: `ParentId=${fixtureId}&Ids=${fixtureId}` },
      { action: 'studios', query: `ParentId=${fixtureId}&AdjacentTo=${fixtureId}` },
    ] };
  const actual = bindFixtureInput(source, bindings);
  assert.deepEqual(actual.warmUserViews, { configuration: { GroupedFolders: [itemId], Name: fixtureId },
    policy: { ...source.warmUserViews.policy, EnabledFolders: [itemId] } });
  assert.deepEqual(actual.timerDocuments, source.timerDocuments);
  assert.deepEqual(actual.cases[0], { ...source.cases[0],
    query: `ParentId=${itemId}&UserId=${userId}&SearchTerm=${fixtureId}&bad=%ZZ`,
    parallelQueries: [`UserId=${userId}&ParentId=${itemId}`, `ParentId=x${fixtureId}`],
    configuration: { OrderedViews: [itemId], CustomName: fixtureId },
    policy: { EnabledChannels: [itemId], EnableContentDeletionFromFolders: [itemId], BlockedTags: [fixtureId] } });
  assert.deepEqual(actual.cases[1], { ...source.cases[1],
    query: `ChannelIds=${itemId}%2C${otherId},${itemId}&LibrarySeriesId=${itemId}`,
    body: { UserId: userId, ChannelIds: [itemId], Name: fixtureId } });
  assert.deepEqual(actual.cases[2], { ...source.cases[2], themeItemId: itemId,
    query: `ParentId=${fixtureId}&UserId=${userId}` });
  assert.deepEqual(actual.cases[3], { ...source.cases[3], introUserId: userId, introItemId: itemId });
  assert.deepEqual(actual.cases[4], { ...source.cases[4], suggestionUserId: userId });
  assert.deepEqual(actual.cases[5], { ...source.cases[5], query: `ParentId=${itemId}&Ids=${fixtureId}` });
  assert.deepEqual(actual.cases[6], { ...source.cases[6], query: `ParentId=${itemId}&AdjacentTo=${fixtureId}` });
});
