import { emptyGuid, guidN } from './user-data.js';

export const userDataChangeDelayMs = 500;
export const userDataChangeMaxBatchSize = 2000;

const hasId = value => value != null && guidN(value) !== emptyGuid;

export class UserDataChangeNotifier {
  #changes = new Map();
  #changedItemCount = 0;
  #timer = null;
  #active = new Set();
  #started = false;
  #closed = false;

  constructor({ userData, sessions, onError = () => {}, delayMs = userDataChangeDelayMs, maxBatchSize = userDataChangeMaxBatchSize,
    schedule = (callback, delay) => setTimeout(callback, delay), cancel = timer => clearTimeout(timer) }) {
    if (!userData || !sessions) throw new TypeError('User data and session services are required.');
    if (!Number.isInteger(delayMs) || delayMs < 0) throw new RangeError('The user data change delay must be a non-negative integer.');
    if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) throw new RangeError('The user data change batch size must be a positive integer.');
    Object.assign(this, { userData, sessions, onError, delayMs, maxBatchSize, schedule, cancel });
  }

  start() {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.userData.on('UserDataSaved', this.#onUserDataSaved);
  }

  #track(items, id, fallbackId = null, reference = null) {
    if (!hasId(id)) return;
    const key = guidN(id);
    const existed = items.has(key);
    items.set(key, reference ?? { id, fallbackId: hasId(fallbackId) ? fallbackId : null });
    if (!existed) this.#changedItemCount++;
  }

  #schedule(delay) {
    this.#timer = this.schedule(this.#onTimer, delay);
    this.#timer?.unref?.();
  }

  #onUserDataSaved = event => {
    if (this.#closed || event?.SaveReason === 'PlaybackProgress') return;
    const userId = guidN(event?.UserId);
    let items = this.#changes.get(userId);
    if (!items) { items = new Map(); this.#changes.set(userId, items); }
    if (this.#timer == null) this.#schedule(this.delayMs);

    const item = event?.Item;
    if (item) {
      const references = event.ChangeReferences ?? this.userData.getChangeReferences?.(item);
      if (references) for (const reference of references) this.#track(items, reference.id, reference.fallbackId, reference);
      else {
        this.#track(items, item.Id);
        if (hasId(item.OwnerId)) this.#track(items, item.OwnerId, item.ParentId);
        else this.#track(items, item.ParentId);
      }
    }

    if (this.#changedItemCount >= this.maxBatchSize && this.#timer != null) {
      this.cancel(this.#timer);
      this.#timer = null;
      this.#onTimer();
    }
  };

  #onTimer = () => {
    this.#timer = null;
    const changes = this.#changes;
    this.#changes = new Map();
    this.#changedItemCount = 0;
    const task = this.#send(changes).catch(error => {
      try { this.onError(error); } catch { /* Error reporting must not reject the notifier lifetime. */ }
    });
    this.#active.add(task);
    task.finally(() => this.#active.delete(task));
    return task;
  };

  async #userDataList(userId, changedItems) {
    if (typeof this.userData.getMany === 'function') return this.userData.getMany(userId, changedItems.values());
    const result = new Map();
    for (const changed of changedItems.values()) {
      let dto;
      try { dto = await this.userData.get(userId, changed.id); }
      catch (error) {
        if (error.status !== 404 || !changed.fallbackId) {
          if (error.status === 404) continue;
          throw error;
        }
        try { dto = await this.userData.get(userId, changed.fallbackId); }
        catch (fallbackError) { if (fallbackError.status === 404) continue; throw fallbackError; }
      }
      if (dto) result.set(guidN(dto.ItemId ?? changed.id), dto);
    }
    return [...result.values()];
  }

  async #send(changes) {
    for (const [userId, changedItems] of changes) {
      await this.sessions.sendMessageToUserSessions([userId], 'UserDataChanged', async () => ({
        UserId: userId,
        UserDataList: await this.#userDataList(userId, changedItems)
      }));
    }
  }

  async drain() { while (this.#active.size) await Promise.all(this.#active); }

  async close() {
    if (this.#closed) { await this.drain(); return; }
    this.#closed = true;
    if (this.#started) this.userData.off('UserDataSaved', this.#onUserDataSaved);
    this.#started = false;
    if (this.#timer != null) this.cancel(this.#timer);
    this.#timer = null;
    this.#changes.clear();
    this.#changedItemCount = 0;
    await this.drain();
  }
}
