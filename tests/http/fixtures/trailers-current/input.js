export const userId = 'cf200000000000000000000000000001';
export const otherId = 'cf200000000000000000000000000002';
export const parentId = 'cf200000000000000000000000000003';
export const arrayParameters = ['locationTypes', 'excludeLocationTypes', 'excludeItemIds', 'sortOrder', 'fields',
  'excludeItemTypes', 'filters', 'mediaTypes', 'imageTypes', 'sortBy', 'genres', 'officialRatings', 'tags', 'years',
  'enableImageTypes', 'personIds', 'personTypes', 'studios', 'artists', 'excludeArtistIds', 'artistIds', 'albumArtistIds',
  'contributingArtistIds', 'albums', 'albumIds', 'ids', 'videoTypes', 'seriesStatus', 'studioIds', 'genreIds',
  'audioLanguages', 'subtitleLanguages'];
export const booleanParameters = ['hasThemeSong', 'hasThemeVideo', 'hasSubtitles', 'hasSpecialFeature', 'hasTrailer',
  'hasParentalRating', 'isHd', 'is4K', 'isMissing', 'isUnaired', 'hasOverview', 'hasImdbId', 'hasTmdbId', 'hasTvdbId',
  'isMovie', 'isSeries', 'isNews', 'isKids', 'isSports', 'recursive', 'isFavorite', 'isPlayed', 'enableUserData',
  'isLocked', 'isPlaceHolder', 'hasOfficialRating', 'collapseBoxSetItems', 'is3D', 'enableTotalRecordCount', 'enableImages'];
export const integerParameters = ['parentIndexNumber', 'startIndex', 'limit', 'imageTypeLimit', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight'];
export const dateParameters = ['minPremiereDate', 'minDateLastSaved', 'minDateLastSavedForUser', 'maxPremiereDate'];
export const guidParameters = ['userId', 'adjacentTo', 'parentId'];
export const guidArrays = ['excludeItemIds', 'personIds', 'excludeArtistIds', 'artistIds', 'albumArtistIds',
  'contributingArtistIds', 'albumIds', 'ids', 'studioIds', 'genreIds'];

export function makeInput() {
  const requests = [];
  const dashed = value => value.replace(/^(........)(....)(....)(....)(............)$/u, '$1-$2-$3-$4-$5');
  const add = (name, values = [], extra = {}) => requests.push({ name,
    path: '/Trailers' + (values.length ? '?' + new URLSearchParams(values).toString() : ''),
    compare: [...new Set(values.map(([key]) => key))], expectedStatus: 500, ...extra });
  add('default authenticated trailer query');
  add('API key remains userless', [], { identity: 'apiKey' });
  add('regular current user', [], { identity: 'regular' });
  add('explicit current user', [['userId', userId]]);
  add('empty user Guid falls back to authenticated user', [['userId', '0'.repeat(32)]]);
  add('admin unknown user', [['userId', otherId]]);
  add('regular selected user never reaches the item query', [['userId', otherId]], { identity: 'regular' });
  add('anonymous rejection precedes invalid query', [['userId', 'invalid'], ['limit', 'invalid']], { identity: 'anonymous', expectedStatus: 401 });
  add('forced Trailer type ignores unsupported public query members', [
    ['includeItemTypes', 'Movie,Audio'], ['IncludeItemTypes', 'Playlist'], ['indexNumber', 'invalid'],
    ['linkedChildAncestorIds', 'invalid'], ['wasSearched', 'invalid'], ['hasChapterImages', 'invalid'], ['notAParameter', 'invalid'],
  ], { compare: [], ignored: ['indexnumber', 'linkedchildancestorids', 'wassearched', 'haschapterimages', 'notaparameter'] });
  add('every supported nullable boolean reaches the real action', booleanParameters.map((key, index) => [key, index % 2 ? 'false' : 'true']));
  add('every supported integer reaches the real action', integerParameters.map((key, index) => [key, String(index + 1)]));
  add('signed paging survives controller binding', [['startIndex', '-2'], ['limit', '-1']]);
  add('scalar repeated values use the first occurrence', [['limit', '2'], ['limit', '9'], ['recursive', 'true'], ['recursive', 'false']]);
  add('query parameter names are case insensitive', [['LiMiT', '2'], ['FiElDs', 'Path,Overview'], ['SoRtBy', 'Name']]);
  add('all nullable scalar errors retain their public parameter names', [
    ['hasThemeSong', 'not-bool'], ['minWidth', '2147483648'], ['minCommunityRating', 'not-double'], ['minPremiereDate', 'not-date'],
  ], { expectedStatus: 400 });
  add('invalid explicit user Guid', [['userId', 'invalid']], { expectedStatus: 400 });
  add('non-nullable total count rejects empty query input', [['enableTotalRecordCount', '']], { expectedStatus: 400 });
  add('nullable whitespace and empty values', [['recursive', ' '], ['startIndex', ''], ['parentId', ' '], ['enableImages', '']]);
  add('text and rating filters preserve the actual bound values', [
    ['searchTerm', 'trailer search'], ['person', 'A person'], ['minOfficialRating', 'PG'], ['maxOfficialRating', 'PG-13'],
    ['nameStartsWithOrGreater', 'A'], ['nameStartsWith', '中文'], ['nameLessThan', 'Z'],
  ]);
  add('double rating filters', [['minCommunityRating', '2.5'], ['minCriticRating', '6.25']]);
  add('all DateTime filters use the actual UTC values', dateParameters.map((key, index) => [key, `2024-01-0${index + 1}T00:00:00Z`]));
  add('parent and sibling selectors bind Guid forms', [['parentId', '{' + dashed(parentId) + '}'], ['adjacentTo', '(' + dashed(otherId) + ')']]);
  const collections = {
    locationTypes: 'FileSystem,Virtual', excludeLocationTypes: 'Remote', excludeItemIds: userId + ',' + otherId,
    sortOrder: 'Descending,Ascending', fields: 'Path,Overview', excludeItemTypes: 'Movie,Audio',
    filters: 'IsFavorite,IsPlayed', mediaTypes: 'Video,Audio', imageTypes: 'Primary,Backdrop', sortBy: 'Name,SortName',
    genres: 'Drama|Comedy', officialRatings: 'PG|PG-13', tags: 'one|two', years: '2024,1999',
    enableImageTypes: 'Primary,Backdrop', personIds: userId + ',' + otherId, personTypes: 'Actor,Director',
    studios: 'First studio,Second studio', artists: 'First artist,Second artist', excludeArtistIds: userId + ',' + otherId,
    artistIds: userId + ',' + otherId, albumArtistIds: userId + ',' + otherId, contributingArtistIds: userId + ',' + otherId,
    albums: 'First album,Second album', albumIds: userId + ',' + otherId, ids: userId + ',' + otherId,
    videoTypes: 'VideoFile,BluRay', seriesStatus: 'Continuing,Ended', studioIds: userId + ',' + otherId,
    genreIds: userId + ',' + otherId, audioLanguages: 'eng,zho', subtitleLanguages: 'eng,zho',
  };
  // Separate requests expose the real binder for every array without allowing
  // a later conflicting filter to hide an earlier binding observation.
  for (const key of arrayParameters) add('actual array binding: ' + key, [[key, collections[key]]]);
  for (const key of ['studios', 'artists', 'albums']) {
    add('comma-named selector keeps a literal pipe: ' + key, [[key, 'First|Second']]);
    add('repeated named selectors preserve comma-bearing occurrences: ' + key, [[key, 'First,Second'], [key, 'Third']]);
  }
  add('unknown enum field is dropped by the native collection binder', [['fields', 'NotAField,Overview']]);
  add('empty collections retain defaults', arrayParameters.map(key => [key, '']));
  add('conflicting filters never reach the item query', [['filters', 'IsFolder,IsNotFolder']]);
  add('excess sort orders never reach the item query', [['sortBy', 'Name'], ['sortOrder', 'Ascending,Descending']]);
  add('GET ignores a malformed JSON body', [['limit', '1']], { body: '{invalid json', contentType: 'application/json' });
  add('GET ignores an unrelated body media type', [['limit', '1']], { body: 'unbound body', contentType: 'text/plain' });
  add('an unused integer collection can fail before the action', [['years', 'not-a-year']], { expectedStatus: 400 });
  add('integer collection overflow preserves its public failure', [['years', '2147483648']], { expectedStatus: 400 });
  add('collection failure is not erased by a separate scalar error', [['years', 'not-a-year'], ['limit', 'not-an-integer']], { expectedStatus: 400 });
  add('a valid hexadecimal integer collection still reaches the action', [['years', '0x000007e8']]);
  add('alternate hexadecimal prefixes still reach the action', [['years', '#000007e8,&h000007e9']]);
  add('a hexadecimal signed integer still reaches the action', [['years', '0xffffffff']]);
  add('whitespace integer collection has a public conversion failure', [['years', ' ']], { expectedStatus: 400 });
  add('repeated integer occurrences are not split again', [['years', '2024,1999'], ['years', '2026']], { expectedStatus: 400 });
  add('anonymous rejection still precedes collection conversion', [['years', 'not-a-year']], { identity: 'anonymous', expectedStatus: 401 });
  requests.push({ name: 'actual ItemsController MVC activation control', path: '/Items?includeItemTypes=Trailer',
    compare: ['includeItemTypes'], expectedStatus: 200 });
  requests.push({ name: 'actual ItemsController pipe-selector control',
    path: '/Items?' + new URLSearchParams({ includeItemTypes: 'Trailer', studios: 'First studio|Second studio', artists: 'First artist|Second artist',
      albums: 'First album|Second album' }).toString(), compare: ['includeItemTypes', 'studios', 'artists', 'albums'], expectedStatus: 200 });
  const unbound = { notAParameter: 'invalid', isFolder: 'invalid', minIndexNumber: 'invalid', linkedChildAncestorIds: 'invalid' };
  requests.push({ name: 'Items ignores arbitrary and internal query members before repository parsing',
    path: '/Items?' + new URLSearchParams({ includeItemTypes: 'Trailer', limit: '1', ...unbound }).toString(),
    compare: ['includeItemTypes', 'limit'], ignored: Object.keys(unbound).map(name => name.toLowerCase()), expectedStatus: 200 });
  requests.push({ name: 'Items continues to validate a bound scalar with unknown members present',
    path: '/Items?' + new URLSearchParams({ includeItemTypes: 'Trailer', indexNumber: 'invalid', ...unbound }).toString(),
    compare: [], expectedStatus: 400 });
  requests.push({ name: 'user scoped Items ignores its unbound index and language parameters',
    path: '/Users/' + userId + '/Items?' + new URLSearchParams({ includeItemTypes: 'Trailer', indexNumber: 'invalid',
      audioLanguages: 'eng', subtitleLanguages: 'zho', ...unbound }).toString(),
    compare: ['includeItemTypes'], ignored: ['indexnumber', 'audiolanguages', 'subtitlelanguages', ...Object.keys(unbound).map(name => name.toLowerCase())], expectedStatus: 200 });
  for (const route of ['/UserItems/Resume', '/Users/' + userId + '/Items/Resume']) {
    const ignored = { ...unbound, recursive: 'invalid', indexNumber: 'invalid', isFavorite: 'invalid', sortBy: 'invalid', years: 'invalid' };
    requests.push({ name: route + ' ignores parameters absent from its public action',
      path: route + '?' + new URLSearchParams({ includeItemTypes: 'Trailer', limit: '1', ...ignored }).toString(),
      compare: ['includeItemTypes', 'limit'], ignored: Object.keys(ignored).map(name => name.toLowerCase()), expectedStatus: 200 });
  }
  return { userId, parentId, requests };
}
