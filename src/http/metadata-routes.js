import { BindingError, noContent, notFound, queryValue, guidValue, booleanValue, httpError } from './binding.js';
import { enumName } from '../sessions/binding.js';
import { refreshLibraryTaskId } from '../tasks/index.js';

const refreshModes = ['None', 'ValidationOnly', 'Default', 'FullRefresh'];

function refreshMode(value, name) {
  if (value === undefined) return 'None';
  if (!value.trim()) throw new BindingError(name, `The value '${value}' is invalid.`);
  let mode;
  try { mode = enumName(value,refreshModes); }
  catch { throw new BindingError(name, `The value '${value}' is not valid.`); }
  if (typeof mode === 'number') throw new BindingError(name, `The value '${value}' is invalid.`);
  return mode;
}

export function registerMetadataRoutes(add, { library, libraryScanner, tasks, metadata, onError = () => {} }) {
  const report = error => {
    try { void Promise.resolve(onError(error)).catch(() => {}); }
    catch { /* Background reporting cannot change the HTTP response. */ }
  };
  add('POST', '/Library/Refresh', () => {
    if (!libraryScanner) throw httpError(501, 'Library scanning requires configured storage.');
    if (libraryScanner.capabilities?.completeLibraryScan !== true) {
      throw httpError(501, 'Complete library scanning is not implemented.');
    }
    if (!tasks?.cancelIfRunningAndQueue) throw httpError(501, 'The RefreshLibrary task is not configured.');
    try { void Promise.resolve(tasks.cancelIfRunningAndQueue(refreshLibraryTaskId)).catch(report); }
    catch (error) { report(error); }
    return noContent();
  }, { policy: 'RequiresElevation' });

  add('POST', '/Items/{itemId}/Refresh', async context => {
    const itemId = guidValue(context.params.itemId,'itemId');
    const query = name => queryValue(context.query,name);
    const boolean = name => {
      const value = query(name);
      if (value !== undefined && !value.trim()) throw new BindingError(name, `The value '${value}' is invalid.`);
      return booleanValue(value,name,false);
    };
    const options = {
      MetadataRefreshMode: refreshMode(query('metadataRefreshMode'),'metadataRefreshMode'),
      ImageRefreshMode: refreshMode(query('imageRefreshMode'),'imageRefreshMode'),
      ReplaceAllMetadata: boolean('replaceAllMetadata'),
      ReplaceAllImages: boolean('replaceAllImages'),
      RegenerateTrickplay: boolean('regenerateTrickplay'),
      IsAutomated: false,
    };
    let item;
    try { item = await library.getItemRecord(itemId,{user:context.auth.User}); }
    catch (error) { if (error.status === 404) return notFound(); throw error; }
    options.ForceSave = options.MetadataRefreshMode === 'FullRefresh' || options.ImageRefreshMode === 'FullRefresh' || options.ReplaceAllMetadata || options.ReplaceAllImages;
    options.RemoveOldMetadata = options.ReplaceAllMetadata;
    if (!metadata) throw httpError(501,'Metadata refresh requires configured storage.');
    if (options.RegenerateTrickplay) throw httpError(501,'Trickplay generation is not implemented.');
    metadata.validateRefresh(item,options);
    // The native endpoint acknowledges a queued operation. Runtime shutdown drains it.
    try { void Promise.resolve(metadata.queue(itemId,options,0)).catch(report); }
    catch (error) { report(error); }
    return noContent();
  }, {policy:'RequiresElevation'});
}
