import { idKey, repositoryTopParentId, sameId } from '../library/records.js';

export const refreshProgressThrottleMs = 1000;

const excludedTypes = new Set(['AggregateFolder', 'UserRootFolder', 'UserView', 'Channel']);
const itemType = item => String(item?.Type ?? item?.NativeType ?? '').split('.').at(-1);

export function isRefreshProgressItem(item) {
  const type = itemType(item);
  if (!item?.IsFolder || item.IsRoot || excludedTypes.has(type)) return false;
  if (typeof item.IsTopParent === 'boolean') return item.IsTopParent;
  if (type === 'BasePluginFolder' || String(item.CollectionType ?? '').toLowerCase() === 'livetv') return true;
  if (sameId(item.Id, repositoryTopParentId(item))) return true;
  return itemType(item.Parent) === 'AggregateFolder' || itemType({ Type: item.ParentType }) === 'AggregateFolder';
}

function invariantDouble(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  const [coefficient, exponentText] = value.toExponential().split('e');
  const exponent = Number(exponentText);
  if (exponent >= -4 && exponent < 17) return String(value);
  return `${coefficient}E${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

function folderProgress(folder, active) {
  const ids = itemType(folder) === 'CollectionFolder'
    ? folder.PhysicalFolderIds ?? []
    : [folder.Id];
  const values = ids.map(id => active.get(idKey(id))).filter(value => value !== undefined);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export class RefreshProgressNotifier {
  #last = new Map();
  #active = new Set();
  #started = false;
  #closed = false;

  constructor({ refreshes, sessions, library, onError = () => {}, clock = () => Date.now(), throttleMs = refreshProgressThrottleMs }) {
    if (!refreshes || !sessions?.sendMessageToAdminSessions || !library?.getCollectionFolders) {
      throw new TypeError('Provider refresh, session and library services are required.');
    }
    if (!Number.isFinite(throttleMs) || throttleMs < 0) throw new RangeError('The refresh progress throttle must be non-negative.');
    Object.assign(this, { refreshes, sessions, library, onError, clock, throttleMs });
  }

  start() {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.refreshes.on('RefreshStarted', this.#onStarted);
    this.refreshes.on('RefreshProgress', this.#onProgress);
    this.refreshes.on('RefreshCompleted', this.#onCompleted);
  }

  #report(error) {
    try { this.onError(error); } catch { /* Error reporting must not reject the notifier lifetime. */ }
  }

  #queue(item, progress, active) {
    const task = this.#send(item, progress, active).catch(error => this.#report(error));
    this.#active.add(task);
    task.finally(() => this.#active.delete(task));
  }

  #notify(item, progress) {
    if (this.#closed || !isRefreshProgressItem(item)) return;
    const key = idKey(item.Id);
    const nowValue = this.clock();
    const now = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
    const last = this.#last.get(key);
    if (last !== undefined && progress > 0 && progress < 100 && now - last < this.throttleMs) return;
    this.#last.set(key, now);
    this.#queue(item, progress, this.refreshes.snapshot?.() ?? new Map());
  }

  #onStarted = event => this.#notify(event?.Item, 0);
  #onProgress = event => this.#notify(event?.Item, event?.Progress);
  #onCompleted = event => {
    this.#notify(event?.Item, 100);
    if (event?.Item?.Id != null) this.#last.delete(idKey(event.Item.Id));
  };

  async #sendMessage(data) {
    try { await this.sessions.sendMessageToAdminSessions('RefreshProgress', data); }
    catch (error) { this.#report(error); }
  }

  async #send(item, progress, active) {
    const itemSend = this.#sendMessage({ ItemId: idKey(item.Id), Progress: invariantDouble(progress) });
    let folderLookup;
    try { folderLookup = Promise.resolve(this.library.getCollectionFolders(item)); }
    catch (error) { this.#report(error); await itemSend; return; }
    const collectionSends = (async () => {
      let folders;
      try { folders = await folderLookup; }
      catch (error) { this.#report(error); return; }
      await Promise.all(folders.map(folder => this.#sendMessage({
        ItemId: idKey(folder.Id),
        Progress: invariantDouble(folderProgress(folder, active))
      })));
    })();
    await Promise.all([itemSend, collectionSends]);
  }

  async drain() { while (this.#active.size) await Promise.allSettled(this.#active); }

  async close() {
    if (this.#closed) { await this.drain(); return; }
    this.#closed = true;
    if (this.#started) {
      this.refreshes.off('RefreshStarted', this.#onStarted);
      this.refreshes.off('RefreshProgress', this.#onProgress);
      this.refreshes.off('RefreshCompleted', this.#onCompleted);
    }
    this.#started = false;
    await this.drain();
    this.#last.clear();
  }
}
