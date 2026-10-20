const movieId = '22222222-2222-2222-2222-222222222222';
const folderId = '11111111-1111-1111-1111-111111111111';

/** Original controlled names, request multiplicities and order; no observed results. */
export function identitySideEffectInput(kind, mode) {
  if (!['artist', 'studio'].includes(kind)) throw new Error(`Unknown identity kind: ${kind}.`);
  const queryName = kind === 'artist' ? 'Artists' : 'Studios';
  const itemType = kind === 'artist' ? 'MusicArtist' : 'Studio';
  const query = name => `${queryName}=${encodeURIComponent(name)}`;
  const request = (name, value, extra = {}) => ({ name, query: query(value), scope: ['movie'],
    omitParentId: true, recursive: null, omitSortBy: true, endpoints: ['items'], ...extra });
  let names, cases;
  if (mode === 'concurrency') {
    names = ['Concurrent Alpha'];
    cases = [request('parallel', names[0], { parallelRequests: 8 }), request('followup', names[0])];
  } else if (mode === 'unicode') {
    names = ['東京', 'ｶﾞ'];
    cases = names.map((name, index) => request(`create-${index + 1}`, name));
    cases.push({ name: 'list', query: `IncludeItemTypes=${itemType}`, scope: [], omitScope: true, endpoints: ['items'] },
      request('followup', names[0]));
  } else if (['conflict-discovery', 'conflicts'].includes(mode)) {
    names = ['Mirror/A', 'Mirror:A', 'Blocked', 'Shadow'];
    cases = names.map((name, index) => request(['create-1', 'create-2', 'blocked-file', 'wrong-type-id'][index], name));
    if (mode === 'conflicts') cases = [request('blocked-file', 'Blocked'), request('first-normalized-name', 'Mirror/A'),
      request('same-path-name', 'Mirror:A'), request('wrong-type-id', 'Shadow')];
  } else if (['control-first', 'control-second'].includes(mode)) {
    names = [mode === 'control-first' ? 'Mirror/A' : 'Mirror:A'];
    cases = [request('create', names[0])];
  } else if (['race', 'race-repeat', 'race-reverse', 'race-eight', 'race-eight-reverse'].includes(mode)) {
    names = ['Mirror/A', 'Mirror:A'];
    const order = mode.endsWith('reverse') ? [...names].reverse() : names;
    const queries = Array.from({ length: mode.includes('eight') ? 8 : 2 }, (_, index) => query(order[index % 2]));
    cases = [request('parallel', names[0], { parallelQueries: queries }),
      ...names.map((name, index) => request(`followup-${index + 1}`, name))];
  } else throw new Error(`Unknown identity mode: ${mode}.`);
  return { kind, mode, names, itemType, expectedCreatedRows: mode === 'unicode' ? 2 : mode === 'conflict-discovery' ? 3 : 1,
    metadataDirectory: kind === 'artist' ? 'artists' : 'Studio',
    entityType: kind === 'artist' ? 'MediaBrowser.Controller.Entities.Audio.MusicArtist' : 'MediaBrowser.Controller.Entities.Studio',
    fixture: { schemaVersion: 1, userId: '79000000-0000-0000-0000-000000000001', rootId: folderId,
      items: [{ key: 'root', id: folderId, name: 'Identity Root', type: 'Folder' },
        { key: 'movie', id: movieId, name: 'Synthetic Movie', type: 'Movie', parentId: folderId }], cases },
  };
}

export function identitySideEffectRoute(input, testCase, query = testCase.query) {
  const parameters = ['Fields=SortName', 'EnableImages=false', 'EnableUserData=false'];
  if (!testCase.omitScope) parameters.push(`Ids=${movieId}`);
  if (!testCase.omitSortBy) parameters.push('SortBy=SortName');
  parameters.push(query);
  return '/Items?' + parameters.join('&');
}
