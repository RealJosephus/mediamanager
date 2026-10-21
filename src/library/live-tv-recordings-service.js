import path from 'node:path';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';

const absent = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'not-found', 'not-directory',
  'unmapped-path', 'invalid-path', 'permission-denied', 'authentication-required']);
const nonempty = value => typeof value === 'string' && clrTrim(value) !== '';
const empty = startIndex => ({ Items: [], TotalRecordCount: 0, StartIndex: startIndex ?? 0 });

/** Read and remove existing media without admitting a recording executor. */
export class LiveTvRecordingsService {
  constructor({ liveTv, library, mediaAssets, dataPath } = {}) {
    if (typeof liveTv?.admitRead !== 'function' || !library || typeof mediaAssets?.stat !== 'function'
      || !path.isAbsolute(dataPath ?? '')) {
      throw new TypeError('Recording reads require live configuration, a library and mapped directory access.');
    }
    Object.assign(this, { liveTv, library, mediaAssets, dataPath });
  }

  async #exists(identity) {
    if (!nonempty(identity) || identity.includes('\0')) return false;
    try { return (await this.mediaAssets.stat(identity)).kind === 'directory'; }
    catch (error) { if (absent.has(error.code)) return false; throw error; }
  }

  async #paths() {
    const read = this.liveTv.admitRead();
    try {
      const defaultPath = async () => {
        const configuration = await read.getConfiguration();
        return nonempty(configuration.RecordingPath) ? configuration.RecordingPath : path.join(this.dataPath, 'livetv', 'recordings');
      };
      const result = [];
      if (await this.#exists(await defaultPath())) result.push(await defaultPath());
      for (const name of ['MovieRecordingPath', 'SeriesRecordingPath']) {
        const candidate = (await read.getConfiguration())[name];
        if (nonempty(candidate) && !ordinalIgnoreCaseEquals(candidate, await defaultPath()) && await this.#exists(candidate)) result.push(candidate);
      }
      return [...new Set(result)];
    } finally { read.release(); }
  }

  async getRecordings(input = {}, { user = null } = {}) {
    if (!user) return empty(input.startindex);
    const { folderIds } = await this.library.resolveLiveTvRecordingFolders(await this.#paths(), { user });
    if (!folderIds.length) return empty(input.startindex);
    return this.library.queryLiveTvRecordings(input, { user, folderIds });
  }

  async getFolders({ user = null } = {}) {
    const { Items } = await this.library.resolveLiveTvRecordingFolders(await this.#paths(), { user, includeDtos: true });
    return { Items, TotalRecordCount: Items.length, StartIndex: 0 };
  }

  getRecording(id, { user = null } = {}) { return this.library.getItem(id, { user }); }

  async deleteRecording(id, { user = null } = {}) {
    const target = await this.library.getDeletionItem(id, { user });
    if (!target) return false;
    // LiveTvManagement authorizes this action. Its native controller does not
    // consult CanDelete and always retains the source media file.
    await this.library.deleteItem(target.item, { DeleteFileLocation: false });
    return true;
  }
}
