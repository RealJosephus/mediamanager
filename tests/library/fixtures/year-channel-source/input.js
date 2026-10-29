export const userId = 'ce100000000000000000000000000001';
export const viewId = 'ce310000000000000000000000000111';
export const fields = ['Path', 'DateCreated', 'Overview', 'SortName', 'Etag', 'CanDelete', 'ItemCounts'];
const media = (Id, year, extra = {}) => ({ Id, Name: Id, ProductionYear: year, MediaType: 'Video', ContentType: 'Movie',
  DateCreated: '2026-10-02T03:04:05.1234567Z', DateModified: '2026-10-03T03:04:05.1234567Z', ...extra });
const folder = (Id, year) => media(Id, year, { Type: 'Folder', FolderType: 'Container' });
const result = (...Items) => ({ Items });
const provider = responses => ({ name: 'Only', type: 'ControlledProvider', dataVersion: 'year-source', cacheKey: '', responses });
const years = (name, query = {}, extra = {}) => ({ name, kind: 'years', provider: 'Only', user: true, query, ...extra });

export function makeInput() {
  return { userId, viewId, fields, cases: [
    { name: 'cold zero-limit provider source, complete cache hit and recursive filters', providers: [provider({ root: [result(
      ...Array.from({ length: 130 }, (_, index) => media('bulk-' + String(index).padStart(3, '0'), 1900 + index)),
      media('audio', 1999, { MediaType: 'Audio', ContentType: 'Song' }), folder('folder', 2000),
      media('no-year', null), media('zero-year', 0))] })], steps: [
      years('cold zero window commits all distinct years', { Recursive: false, Limit: 0 }),
      years('cached complete year list', { Recursive: false }),
      years('recursive movie count includes nonpositive year occurrences', { Recursive: true, IncludeItemTypes: ['Movie'] }),
      years('recursive audio source filter', { Recursive: true, MediaTypes: ['Audio'] }),
      years('recursive included types take precedence over exclusions', { Recursive: true, IncludeItemTypes: ['Movie', 'Audio'], ExcludeItemTypes: ['Movie'] }),
      years('userless Years does not dispatch the UserView', { Recursive: false }, { user: false }),
    ] },
    { name: 'live display-parent Guid, cached descendants and recursive stale removal', providers: [provider({
      root: [result(folder('folder', 2000), media('root-movie', 2001)), result(folder('folder', 2000))],
      folder: [result(media('child-movie', 2002))],
    })], steps: [
      years('create root provider source', { Recursive: false }),
      years('live folder display parent refreshes its own provider cache', { Recursive: false }, { parentExternalId: 'folder' }),
      years('cached recursive root includes descendants', { Recursive: true, IncludeItemTypes: ['Movie'] }),
      { name: 'expire the actual provider cache', kind: 'expire' },
      years('recursive provider miss deletes stale direct children and retains descendants', { Recursive: true, IncludeItemTypes: ['Movie'] }),
      years('retained root folder remains readable', { Recursive: false }),
    ] },
    { name: 'late materializer failure retains the real cache and committed item prefix', providers: [provider({ root: [result(
      media('first', 2020), media('bad', 2021, { Genres: null }))] })], steps: [
      years('failed source returns empty years', { Recursive: false }),
      years('cache hit exposes the earlier committed prefix', { Recursive: false }),
    ] },
    { name: 'malformed cache source is contained and a null cache can recover', providers: [provider({ root: [result(media('recovered', 2024))] })], steps: [
      { name: 'write malformed provider cache', kind: 'cache', provider: 'Only', content: '{broken' },
      years('malformed cache returns an empty year source', { Recursive: false }),
      { name: 'write nullable provider cache', kind: 'cache', provider: 'Only', content: 'null' },
      years('null cache refresh commits its year', { Recursive: false }),
    ] },
    { name: 'live metadata production year does not replace the frozen repository source', providers: [provider({ root: [
      result(media('same', 2020)), result(media('same', 2021, { Name: 'Unsaved provider replacement' })),
    ] })], steps: [
      years('initial persisted year', { Recursive: false }),
      { name: 'expire before warm replacement', kind: 'expire' },
      years('warm replacement still reads its committed year', { Recursive: false }, { warmExternalId: 'same', warmProductionYear: 2021 }),
    ] },
    { name: 'absent installed provider remains an empty source', providers: [], orphan: true,
      steps: [years('retained Channel without a provider', { Recursive: false }, { provider: 'Absent' })] },
  ] };
}
