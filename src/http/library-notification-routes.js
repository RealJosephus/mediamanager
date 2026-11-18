import { BindingError, httpError, noContent, queryValue } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';
import { visitLibraryProviderPaths } from '../library/postgres-library-notifications.js';
import { clrTrim } from '../metadata/whitespace.js';

const string = { type: 'string', clrType: 'System.String', nullable: true };
const root = { type: 'object', clrType: 'Jellyfin.Api.Models.LibraryDtos.MediaUpdateInfoDto', reference: 'MediaUpdateInfo' };
const update = { type: 'object', clrType: 'Jellyfin.Api.Models.LibraryDtos.MediaUpdateInfoPathDto', reference: 'MediaUpdatePath', nullable: true };
const schema = { definitions: {
  MediaUpdateInfo: { defaults: { Updates: [] }, required: ['Updates'], fields: {
    Updates: { type: 'array', clrType: 'System.Collections.Generic.IReadOnlyList`1[' + update.clrType + ']', item: update, nullable: true },
  } },
  MediaUpdatePath: { defaults: { Path: null, UpdateType: null }, fields: { Path: string, UpdateType: string } },
} };

const queryString = (query, name) => {
  const value = queryValue(query, name);
  return value == null || clrTrim(value) === '' ? null : value;
};

export function registerLibraryNotificationRoutes(add, { store, library, libraryMonitor }) {
  const report = path => {
    if (!path) throw httpError(400, 'Item path cannot be empty.');
    if (!libraryMonitor) throw httpError(501, 'Library change reporting requires the directory monitor.');
    return libraryMonitor.reportFileSystemChanged(path);
  };
  const visits = (kind, provider, value, signal) => {
    if (!store) throw httpError(501, 'Library change reporting requires PostgreSQL.');
    return store.run(session => visitLibraryProviderPaths(session, { kind, provider, value, signal },
      path => report(library?.options?.expandPath?.(path) ?? path)), { signal });
  };

  add('POST', ['/Library/Series/Added', '/Library/Series/Updated'], async ({ query, signal }) => {
    await visits('Series', 'Tvdb', queryString(query, 'tvdbId'), signal);
    return noContent();
  });
  add('POST', ['/Library/Movies/Added', '/Library/Movies/Updated'], async ({ query, signal }) => {
    const imdb = queryString(query, 'imdbId'), tmdb = queryString(query, 'tmdbId');
    if (imdb !== null || tmdb !== null) await visits('Movie', imdb !== null ? 'Imdb' : 'Tmdb', imdb ?? tmdb, signal);
    return noContent();
  });
  add('POST', '/Library/Media/Updated', async ({ body }) => {
    for (const item of body.Updates) await report(item.Path);
    return noContent();
  }, { body: true, bodyType: root.clrType, bodyParameter: 'dto', bindBody: (value, source) => {
    if (value === null) throw new BindingError('', 'A non-empty request body is required.');
    return validateJsonModel(bindJsonModel(value, { schema, root, source }), { schema, root });
  } });
}
