// Input identities belong to fixture roles, not to arbitrary matching strings.
// This deliberately does not use the candidate HTTP/model binder as an oracle.
const guid = /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/iu;
const guidKey = value => typeof value === 'string' && guid.test(value)
  ? value.replaceAll('-', '').toLowerCase() : null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function identities(bindings) {
  const values = new Map();
  for (const { fixtureId, actualId } of bindings) {
    const key = guidKey(fixtureId);
    if (!key || !guidKey(actualId)) throw new TypeError('Fixture identity bindings require complete Guid values.');
    if (values.has(key) && values.get(key) !== actualId) throw new TypeError('Conflicting fixture identity binding.');
    values.set(key, actualId);
  }
  return value => values.get(guidKey(value)) ?? value;
}

function decode(value) {
  try { return decodeURIComponent(value.replaceAll('+', ' ')); }
  catch { return null; }
}

function rawQuery(query, fields) {
  if (typeof query !== 'string') return query;
  return query.split('&').map(pair => {
    const equals = pair.indexOf('=');
    if (equals === -1) return pair;
    const key = decode(pair.slice(0, equals));
    const role = key === null ? undefined : fields.get(key.toLowerCase());
    if (!role) return pair;
    const replace = token => {
      const value = decode(token);
      if (value === null) return token;
      const bound = role.identity(value);
      return bound === value ? token : encodeURIComponent(bound);
    };
    const value = pair.slice(equals + 1);
    // Keep the raw delimiters, escapes, empty values, duplicate parameters and
    // every non-identity token. An invalid Guid is still the original input.
    const bound = role.list ? value.split(/(,|%2c)/iu).map((token, index) => index % 2 ? token : replace(token)).join('')
      : replace(value);
    return pair.slice(0, equals + 1) + bound;
  }).join('&');
}

export function bindFixtureUserQuery(query, user) {
  return rawQuery(query, new Map([['userid', { identity: identities([user]) }]]));
}

function fields(source, names, identity) {
  if (!object(source)) return source;
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key,
    names.includes(key) ? identity(value) : value]));
}

function arrays(source, names, identity) {
  if (!object(source)) return source;
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key,
    names.includes(key) && Array.isArray(value) ? value.map(identity) : value]));
}

function programsBody(testCase, user, item) {
  const body = testCase.body;
  if (testCase.action !== 'live-tv-programs' || testCase.method !== 'POST' || !object(body)) return body;
  // GetProgramsDto root roles only. Unknown properties and all nested content
  // remain literal; even a property name containing the Guid is untouched.
  return Object.fromEntries(Object.entries(body).map(([key, value]) => {
    if (key.toLowerCase() === 'userid') return [key, user(value)];
    if (key.toLowerCase() === 'libraryseriesid') return [key, item(value)];
    if (['channelids', 'genreids'].includes(key.toLowerCase())) {
      if (Array.isArray(value)) return [key, value.map(item)];
      // The designated DTO also admits a comma-delimited string collection.
      if (typeof value === 'string') return [key, value.split(',').map(item).join(',')];
    }
    return [key, value];
  }));
}

export function bindFixtureRequestBody(testCase, { user, items = [] }) {
  return programsBody(testCase, identities([user]), identities(items));
}

const itemFields = ['id', 'parentId', 'topParentId', 'ownerId', 'primaryVersionId', 'seriesId', 'seasonId', 'channelId'];
const configurationArrays = ['GroupedFolders', 'OrderedViews', 'LatestItemsExcludes', 'MyMediaExcludes'];
const policyArrays = ['EnabledFolders', 'BlockedMediaFolders', 'EnableContentDeletionFromFolders', 'EnabledChannels', 'BlockedChannels'];
const videoTypes = new Set(['Video', 'Movie', 'Episode', 'MusicVideo']);

function itemData(source, type, user, item) {
  if (!object(source)) return source;
  let data = source;
  if (type === 'CollectionFolder') data = arrays(data, ['PhysicalFolderIds'], item);
  if (type === 'UserView') data = fields(fields(data, ['UserId'], user), ['DisplayParentId'], item);
  if (type === 'BoxSet') data = arrays(data, ['LibraryFolderIds'], item);
  if (type === 'Playlist') {
    data = fields(data, ['OwnerUserId'], user);
    if (Array.isArray(data.Shares)) data = { ...data, Shares: data.Shares.map(value => fields(value, ['UserId'], user)) };
  }
  if (videoTypes.has(type) && Array.isArray(data.LinkedAlternateVersions)) {
    // Only the declared Guid relationship is rebound. Legacy string members
    // (LibraryItemId and Path) have no required binding in these inputs.
    data = { ...data, LinkedAlternateVersions: data.LinkedAlternateVersions
      .map(value => fields(value, ['ItemId'], item)) };
  }
  return data;
}

function caseQuery(query, testCase, user, item) {
  const { action } = testCase;
  const roles = new Map([['userid', { identity: user }]]);
  const add = (names, list = false) => {
    for (const name of names) roles.set(name, { identity: item, list });
  };
  if (['filters', 'filters2', 'latest', 'studios'].includes(action)) add(['parentid']);
  if (action === 'named-list' && ['Artists', 'Artists/AlbumArtists', 'Genres', 'MusicGenres', 'Studios'].includes(testCase.namedRoute)) add(['parentid']);
  if (action === undefined) {
    add(['parentid', 'adjacentto']);
    add(['ids', 'excludeitemids', 'artistids', 'albumartistids', 'genreids', 'studioids'], true);
  }
  if (action === 'live-tv-programs') {
    add(['libraryseriesid']);
    add(['channelids', 'genreids'], true);
  }
  if (action === 'shows-episodes') add(['seasonid', 'adjacentto']);
  return rawQuery(query, roles);
}

/** Bind Native preparation inputs without rewriting opaque fixture content. */
export function bindFixtureInput(fixture, { user: userBinding, items }) {
  const user = identities([userBinding]), item = identities(items);
  const preferences = source => !object(source) ? source : { ...source,
    ...(Object.hasOwn(source, 'configuration') ? { configuration: arrays(source.configuration, configurationArrays, item) } : {}),
    ...(Object.hasOwn(source, 'policy') ? { policy: arrays(source.policy, policyArrays, item) } : {}),
  };
  const testCase = source => {
    let result = preferences(source);
    const userFields = source.action === 'suggestions' ? ['suggestionUserId'] : source.action === 'intros' ? ['introUserId'] : [];
    const itemFields = { intros: ['introItemId'], theme: ['themeItemId'], 'live-tv-program': ['programId'],
      'live-tv-channel': ['channelId'], 'shows-episodes': ['seriesId'] }[source.action] ?? [];
    result = fields(fields(result, userFields, user), itemFields, item);
    if (Object.hasOwn(source, 'query')) result = { ...result, query: caseQuery(source.query, source, user, item) };
    if (Array.isArray(source.parallelQueries)) result = { ...result,
      parallelQueries: source.parallelQueries.map(query => caseQuery(query, source, user, item)) };
    if (Object.hasOwn(source, 'body')) result = { ...result, body: programsBody(source, user, item) };
    return result;
  };
  return { ...fixture, userId: user(fixture.userId), rootId: item(fixture.rootId),
    items: fixture.items.map(source => ({ ...fields(source, itemFields, item),
      ...(Array.isArray(source.ancestorIds) ? { ancestorIds: source.ancestorIds.map(item) } : {}),
      ...(Array.isArray(source.streams) ? { streams: source.streams.map(stream => fields(stream, ['itemId'], item)) } : {}),
      ...(Object.hasOwn(source, 'data') ? { data: itemData(source.data, source.type, user, item) } : {}),
    })),
    ...(Array.isArray(fixture.links) ? { links: fixture.links.map(link => fields(link, ['parentId', 'childId'], item)) } : {}),
    ...(Array.isArray(fixture.mediaStreams) ? { mediaStreams: fixture.mediaStreams.map(stream => fields(stream, ['itemId'], item)) } : {}),
    ...(Object.hasOwn(fixture, 'warmUserViews') ? { warmUserViews: preferences(fixture.warmUserViews) } : {}),
    cases: fixture.cases.map(testCase),
  };
}
