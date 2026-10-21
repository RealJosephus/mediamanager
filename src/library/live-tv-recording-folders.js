import path from 'node:path';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { defaultLibraryOptions } from './options.js';
import { nativeFileSystemPathsEqual } from './root-folder-file-data.js';

const absent = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'not-found', 'not-directory',
  'unmapped-path', 'invalid-path', 'permission-denied', 'authentication-required']);
const nonempty = value => typeof value === 'string' && clrTrim(value) !== '';

/** Register existing recording directories as ordinary libraries. */
export class LiveTvRecordingFolders {
  #tail = Promise.resolve();
  #pending = new Set();
  #reservations = new WeakMap();
  #closed = false;
  #started = false;
  #closing;
  #binding;

  constructor({ liveTv, libraryConfiguration, mediaAssets, dataPath, queueLibraryScan,
    admitOperation = () => libraryConfiguration.admitOperation(),
    runBackground = operation => Promise.resolve().then(operation), onError = () => {} } = {}) {
    if (typeof liveTv?.bindSaveObserver !== 'function' || !libraryConfiguration || !mediaAssets || !path.isAbsolute(dataPath ?? '')
      || typeof queueLibraryScan !== 'function') {
      throw new TypeError('Recording folders require live configuration, library management and mapped directory access.');
    }
    Object.assign(this, { liveTv, libraryConfiguration, mediaAssets, dataPath, queueLibraryScan, admitOperation, runBackground, onError });
  }

  start() {
    if (this.#closed || this.#started) return;
    this.#started = true;
    this.#binding = this.liveTv.bindSaveObserver(parent => this.#reserve(parent));
  }

  #report(error) {
    try { void Promise.resolve(this.onError(error)).catch(() => {}); }
    catch { /* Observer failures cannot undo folder configuration. */ }
  }

  reconcile() {
    if (this.#closed) return Promise.resolve();
    this.start();
    return this.#binding.enqueue().catch(error => this.#report(error));
  }

  #reserve(parent) {
    const previous = parent && this.#reservations.get(parent);
    if (parent && !previous?.active || !parent && this.#closed) throw new Error('Recording-folder admission is closed.');
    const group = previous?.group ?? { admission: this.admitOperation(), pending: 0 };
    group.pending++;
    const completion = Promise.withResolvers(), record = { active: true, committed: false, group };
    this.#pending.add(completion.promise);
    const finish = () => {
      if (!record.active) return;
      record.active = false;
      this.#pending.delete(completion.promise);
      try { if (--group.pending === 0) group.admission.release(); }
      catch (error) { this.#report(error); }
      completion.resolve();
    };
    const reservation = Object.freeze({
      completion: completion.promise,
      get active() { return record.active; },
      commit: access => {
        if (!record.active || record.committed) throw new Error('Recording-folder reservation is already settled.');
        record.committed = true;
        const task = this.#tail.then(() => this.runBackground(() => this.#reconcile(group.admission, access)))
          .catch(error => this.#report(error)).finally(finish);
        this.#tail = task;
      },
      cancel: () => { if (!record.committed) finish(); },
    });
    this.#reservations.set(reservation, record);
    return reservation;
  }

  async #exists(identity) {
    if (!nonempty(identity) || identity.includes('\0')) return false;
    try { return (await this.mediaAssets.stat(identity)).kind === 'directory'; }
    catch (error) { if (absent.has(error.code)) return false; throw error; }
  }

  async #recordingFolders(access) {
    const configuration = await access.getConfiguration();
    const defaultPath = nonempty(configuration.RecordingPath) ? configuration.RecordingPath
      : path.join(this.dataPath, 'livetv', 'recordings');
    const result = [];
    if (await this.#exists(defaultPath)) result.push({ Name: 'Recordings', Locations: [defaultPath], CollectionType: null });
    for (const [field, Name, CollectionType] of [['MovieRecordingPath', 'Recorded Movies', 'movies'],
      ['SeriesRecordingPath', 'Recorded Shows', 'tvshows']]) {
      const location = (await access.getConfiguration())[field];
      if (nonempty(location) && !ordinalIgnoreCaseEquals(location, defaultPath) && await this.#exists(location)) {
        result.push({ Name, Locations: [location], CollectionType });
      }
    }
    return result;
  }

  async #reconcile(libraryConfiguration, access) {
    const recordingFolders = await this.#recordingFolders(access);
    const virtualFolders = await libraryConfiguration.getVirtualFolders();
    const existingPaths = virtualFolders.flatMap(folder => folder.Locations);
    const pathsAdded = [];
    for (const folder of recordingFolders) {
      const pathsToCreate = folder.Locations.filter(location => !existingPaths.some(existing => nativeFileSystemPathsEqual(existing, location)));
      if (!pathsToCreate.length) continue;
      const options = { ...defaultLibraryOptions(), PathInfos: pathsToCreate.map(Path => ({ Path })) };
      try { await libraryConfiguration.addVirtualFolder(folder.Name, folder.CollectionType, options, true); }
      catch (error) { this.#report(error); }
      pathsAdded.push(...pathsToCreate);
    }
    const configuration = await access.getConfiguration();
    const currentPaths = new Set(recordingFolders.flatMap(folder => folder.Locations));
    if (configuration.MediaLocationsCreated == null) throw new TypeError('The recorded media locations are null.');
    const pathsToRemove = [...new Set(configuration.MediaLocationsCreated)].filter(location => !currentPaths.has(location));
    if (pathsAdded.length || pathsToRemove.length) {
      const removed = new Set(pathsToRemove);
      configuration.MediaLocationsCreated = [...new Set([...configuration.MediaLocationsCreated, ...pathsAdded])]
        .filter(location => !removed.has(location));
      await access.saveConfiguration(configuration, 'livetv');
    }
    for (const location of pathsToRemove) await this.#removePath(libraryConfiguration, location);
  }

  async #removePath(libraryConfiguration, location) {
    let requiresRefresh = false;
    for (const folder of await libraryConfiguration.getVirtualFolders()) {
      if (!folder.Locations.some(existing => ordinalIgnoreCaseEquals(existing, location))) continue;
      if (folder.Locations.length === 1) {
        try { await libraryConfiguration.removeVirtualFolder(folder.Name, true); }
        catch (error) { this.#report(error); }
      } else {
        try { await libraryConfiguration.removeMediaPath(folder.Name, location); requiresRefresh = true; }
        catch (error) { this.#report(error); }
      }
    }
    if (requiresRefresh) await this.queueLibraryScan();
  }

  async drain() {
    while (this.#pending.size) await Promise.all(this.#pending);
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#binding?.close();
    return this.#closing = this.drain();
  }
}
