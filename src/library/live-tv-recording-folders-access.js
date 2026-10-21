import path from 'node:path';
import { libraryError } from './records.js';
import { visibleLibrary } from './permissions.js';
import { nativeContainsSubPath } from './native-path.js';

const missingReference = () => Object.assign(libraryError(500, 'Object reference not set to an instance of an object.'),
  { nativeException: 'NullReferenceException' });

/** Only the native recording-folder consumer invokes IsVisibleStandalone(null).
 * Keep its virtual-method short circuits separate from userless public reads. */
export function recordingSourceVisibleWithoutUser(item, options = {}) {
  // CollectionFolder reads Enabled before Folder reads user preferences.
  if (item.Type === 'CollectionFolder' && !visibleLibrary(item, null, options.libraryOptions)) return false;
  const dataPath = options.dataPath ?? (options.programDataPath && path.join(options.programDataPath, 'data'));
  // Channel and enabled CollectionFolder access user preferences first. A
  // shared Playlist reads user.Id or MaxParentalRatingScore even when open.
  if (['Channel', 'CollectionFolder'].includes(item.Type)
    || item.Type === 'Playlist' && item.Path && dataPath && nativeContainsSubPath(item.Path, dataPath)) throw missingReference();
  // UserView does not implement ICollectionFolder. Both legacy and modern
  // BoxSet reach BaseItem's explicit parental-user guard before linked items.
  throw Object.assign(libraryError(400, "Value cannot be null. (Parameter 'user')"),
    { nativeException: 'ArgumentNullException', parameterName: 'user' });
}

export function recordingFoldersMissingUser() { throw missingReference(); }
