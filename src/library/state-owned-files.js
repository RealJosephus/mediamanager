// Read-only instance directory observations. Media bytes never use this reader.
import path from 'node:path';
import { nativeDateFromUnixNanoseconds } from '../users/native.js';
import { dateText } from './records.js';

/** Instance state is owned by this runtime, unlike a remote media listing.
 * A successful complete local enumeration can reconcile owned metadata rows;
 * all missing-item cleanup still checks the persisted owner/relationship frame. */
export function stateOwnedFiles(assets) {
  return {
    async list(identityPath) {
      const location = await assets.resolve(identityPath);
      if (!location.localPath) throw new TypeError('An instance directory reader cannot enumerate media storage.');
      const entries = await assets.list(identityPath);
      await assets.resolve(identityPath);
      return { entries, deletionSafe: true };
    },
    async stat(candidate) {
      const location = await assets.resolve(candidate.identityPath);
      if (!location.localPath) throw new TypeError('An instance directory reader cannot stat media storage.');
      const info = await assets.fileSystem.stat(location.localPath, { bigint: true });
      await assets.resolve(candidate.identityPath);
      return { kind: info.isDirectory() ? 'directory' : 'file', size: info.size,
        modified: dateText(nativeDateFromUnixNanoseconds(info.mtimeNs)),
        created: dateText(nativeDateFromUnixNanoseconds(info.birthtimeNs)) };
    },
  };
}

/** Only .ignore configuration may cross from an instance directory into its
 * explicit network ancestor namespace. Unknown ancestors remain incomplete. */
export function stateIgnoreFileAccess(assets, fallback) {
  return {
    async info(identityPath, signal) {
      if (path.win32.basename(identityPath) !== '.ignore') throw new TypeError('An ignore reader only accepts .ignore files.');
      try { await assets.resolve(identityPath); }
      catch (error) {
        if (error.code !== 'unmapped-path') throw error;
        return fallback ? fallback.info(identityPath, signal) : { mapped: false, entry: null };
      }
      try { return { mapped: true, entry: await assets.stat(identityPath, { signal }), stateIdentity: identityPath }; }
      catch (error) { if (error.code !== 'not-found') throw error; return { mapped: true, entry: null, stateIdentity: identityPath }; }
    },
    openRead: (info, options) => info.stateIdentity ? assets.openRead(info.stateIdentity, options) : fallback.openRead(info, options),
  };
}
