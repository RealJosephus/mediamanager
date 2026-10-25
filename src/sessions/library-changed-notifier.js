import { NAME_TYPES, idKey } from '../library/records.js';
import { emptyGuid, guidN } from './user-data.js';

export const libraryChangedDefaultDelayMs = 30000;
export const libraryChangedMaxBatchSize = 2000;

const itemType = item => String(item?.Type ?? item?.NativeType ?? '').split('.').at(-1);
const librarySource = value => value == null || value === 0 || value === 'Library';
const hasId = value => value != null && guidN(value) !== emptyGuid;
const itemByNameTypes = new Set([...NAME_TYPES, 'Year']);

export function isLibraryChangedItem(item) {
  if (!item || !hasId(item.Id)) return false;
  if (!item.IsFolder && !item.Path) return false;
  const type = itemType(item);
  if (itemByNameTypes.has(type) && type !== 'MusicArtist') return false;
  return librarySource(item.SourceType);
}

function isEmpty(info) {
  return !info.ItemsAdded.length && !info.ItemsUpdated.length && !info.ItemsRemoved.length
    && !info.FoldersAddedTo.length && !info.FoldersRemovedFrom.length && !info.CollectionFolders.length;
}

export class LibraryChangedNotifier {
  #itemsAdded = new Map();
  #itemsUpdated = new Map();
  #itemsRemoved = new Map();
  #foldersAddedTo = new Map();
  #foldersRemovedFrom = new Map();
  #timer = null;
  #active = new Set();
  #started = false;
  #closed = false;

  constructor(options) {
    const { events, sessions, users, library, configuration = {}, onError = () => {},
      runBackground = operation => operation(),
      delayMs,
      maxBatchSize = libraryChangedMaxBatchSize,
      schedule = (callback, delay) => setTimeout(callback, delay), cancel = timer => clearTimeout(timer) } = options;
    if (!events || !sessions || !users || !library) throw new TypeError('Library events, sessions, users and library services are required.');
    const initialDelay = delayMs ?? Number(configuration.LibraryUpdateDuration ?? libraryChangedDefaultDelayMs / 1000) * 1000;
    if (!Number.isFinite(initialDelay) || initialDelay < 0) throw new RangeError('The library change delay must be non-negative.');
    if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) throw new RangeError('The library change batch size must be a positive integer.');
    Object.assign(this, { options, events, sessions, users, library, onError, runBackground, delayMs, maxBatchSize, schedule, cancel });
  }

  get configuration() { const { configuration = {} } = this.options; return configuration; }

  start() {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.events.on('ItemAdded', this.#onItemAdded);
    this.events.on('ItemUpdated', this.#onItemUpdated);
    this.events.on('ItemRemoved', this.#onItemRemoved);
  }

  #schedule() {
    const delay = this.delayMs ?? Number(this.configuration.LibraryUpdateDuration ?? libraryChangedDefaultDelayMs / 1000) * 1000;
    this.#timer = this.schedule(this.#onTimer, delay);
    this.#timer?.unref?.();
  }

  #onItemAdded = event => this.#onChange(event, this.#itemsAdded, this.#foldersAddedTo);
  #onItemUpdated = event => this.#onChange(event, this.#itemsUpdated);
  #onItemRemoved = event => this.#onChange(event, this.#itemsRemoved, this.#foldersRemovedFrom);

  #onChange(event, items, folders) {
    if (this.#closed || !isLibraryChangedItem(event?.Item)) return;
    if (this.#timer == null) this.#schedule();
    if (folders && event.Parent?.IsFolder && hasId(event.Parent.Id)) folders.set(idKey(event.Parent.Id), event.Parent);
    items.set(idKey(event.Item.Id), event.Item);
    if (this.#itemsAdded.size + this.#itemsUpdated.size + this.#itemsRemoved.size >= this.maxBatchSize) {
      if (this.#timer != null) this.cancel(this.#timer);
      this.#timer = null;
      this.#rotate();
    }
  }

  #onTimer = () => {
    this.#timer = null;
    return this.#rotate();
  };

  #rotate() {
    const addedKeys = new Set(this.#itemsAdded.keys());
    const changes = {
      itemsAdded: [...this.#itemsAdded.values()],
      itemsUpdated: [...this.#itemsUpdated].filter(([key]) => !addedKeys.has(key)).map(([, item]) => item),
      itemsRemoved: [...this.#itemsRemoved.values()],
      foldersAddedTo: [...this.#foldersAddedTo.values()],
      foldersRemovedFrom: [...this.#foldersRemovedFrom.values()]
    };
    this.#itemsAdded = new Map();
    this.#itemsUpdated = new Map();
    this.#itemsRemoved = new Map();
    this.#foldersAddedTo = new Map();
    this.#foldersRemovedFrom = new Map();
    if (!Object.values(changes).some(values => values.length)) return Promise.resolve();
    const task = (async () => this.runBackground(() => this.#send(changes)))().catch(error => this.#report(error));
    this.#active.add(task);
    task.finally(() => this.#active.delete(task));
    return task;
  }

  #report(error) {
    try { this.onError(error); } catch { /* Error reporting must not reject the notifier lifetime. */ }
  }

  async #send(changes) {
    for (const userId of this.sessions.getPrimaryUserIds()) {
      let info;
      try {
        const user = await this.users.getUser(userId);
        if (!user) throw new TypeError(`Library change user ${userId} was not found.`);
        info = await this.library.getLibraryUpdateInfo(changes, { user });
      } catch (error) {
        this.#report(error);
        return;
      }
      if (isEmpty(info)) continue;
      try { await this.sessions.sendMessageToUserSessions([userId], 'LibraryChanged', info); }
      catch (error) { this.#report(error); }
    }
  }

  async drain() { while (this.#active.size) await Promise.all(this.#active); }

  async close() {
    if (this.#closed) { await this.drain(); return; }
    this.#closed = true;
    if (this.#started) {
      this.events.off('ItemAdded', this.#onItemAdded);
      this.events.off('ItemUpdated', this.#onItemUpdated);
      this.events.off('ItemRemoved', this.#onItemRemoved);
    }
    this.#started = false;
    if (this.#timer != null) this.cancel(this.#timer);
    this.#timer = null;
    this.#itemsAdded.clear();
    this.#itemsUpdated.clear();
    this.#itemsRemoved.clear();
    this.#foldersAddedTo.clear();
    this.#foldersRemovedFrom.clear();
    await this.drain();
  }
}
