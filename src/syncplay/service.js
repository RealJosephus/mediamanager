import { cloneNativeValue } from '../core/json.js';
import { SyncPlayGroup } from './group.js';
import { emptyGuid, guidKey } from './queue.js';

export class SyncPlayService {
  #groups = new Map();
  #sessions = new Map();
  #activeUsers = new Map();
  #tail = Promise.resolve();
  #deliveries = new Map();
  #timer;
  #closed = false;
  constructor({ sessions, users, library, onError = () => {}, groupOptions } = {}) {
    Object.assign(this, { sessions, users, library, onError, groupOptions });
    this.sessionEnded = ({ SessionInfo }) => { this.leave(SessionInfo).catch(onError); };
    sessions.on('SessionEnded', this.sessionEnded);
  }
  isUserActive(userId) { return (this.#activeUsers.get(guidKey(userId)) ?? 0) > 0; }
  #run(operation) {
    if (this.#closed) return Promise.resolve();
    const task = this.#tail.then(operation);
    this.#tail = task.catch(() => {});
    return task;
  }
  #send = (sessionId, type, value) => {
    const data = cloneNativeValue(value);
    const key = sessionId.toLowerCase();
    const delivery = (this.#deliveries.get(key) ?? Promise.resolve()).then(() => this.sessions.sendCommand(sessionId, type, data)).catch(error => {
      // Native dispatch is fire-and-forget; an ended session cannot prevent the
      // remaining members from receiving their leave/state updates.
      if (error.status !== 404) this.onError(error);
    }).finally(() => {
      if (this.#deliveries.get(key) === delivery) this.#deliveries.delete(key);
    });
    this.#deliveries.set(key, delivery);
  };
  #error(session, type, groupId = emptyGuid) { this.#send(session.Id, 'SyncPlayGroupUpdate', { GroupId: groupId, Data: '', Type: type }); }
  #track(session, group) {
    this.#sessions.set(session.Id.toLowerCase(), group);
    const key = guidKey(session.UserId); this.#activeUsers.set(key, (this.#activeUsers.get(key) ?? 0) + 1);
  }
  async #access(userId, ids) {
    if (!ids.length) return true;
    let user;
    try { user = await this.users.getUser(userId); } catch (error) { if (error.status === 404) return false; throw error; }
    if (!user) return false;
    for (const id of ids) {
      if (guidKey(id) === emptyGuid) throw Object.assign(new Error("Guid can't be empty (Parameter 'id')"), { status: 400 });
      try { await this.library.getItemRecord(id, { user }); } catch (error) { if (error.status === 404) return false; throw error; }
    }
    return true;
  }
  #updateTimer() {
    if (this.#closed || !this.#groups.size) { clearInterval(this.#timer); this.#timer = null; }
    else if (!this.#timer) {
      this.#timer = setInterval(() => this.checkTimeouts().catch(this.onError), 1000);
      this.#timer.unref();
    }
  }
  async #leave(session) {
    const key = session.Id.toLowerCase(), group = this.#sessions.get(key);
    if (!group) { this.#error(session, 'NotInGroup'); return; }
    this.#sessions.delete(key);
    const user = guidKey(session.UserId), count = (this.#activeUsers.get(user) ?? 1) - 1;
    if (count > 0) this.#activeUsers.set(user, count); else this.#activeUsers.delete(user);
    await group.leave(session);
    if (!group.members.size) this.#groups.delete(group.id);
    this.#updateTimer();
  }
  create(session, name) { return this.#run(async () => {
    if (this.#sessions.has(session.Id.toLowerCase())) await this.#leave(session);
    const group = new SyncPlayGroup({ name, access: (user, ids) => this.#access(user, ids), item: async id => {
      if (guidKey(id) === emptyGuid) throw Object.assign(new Error("Guid can't be empty (Parameter 'id')"), { status: 400 });
      try { return await this.library.getItemRecord(id); } catch (error) { if (error.status === 404) return null; throw error; }
    }, send: this.#send, ...this.groupOptions });
    this.#groups.set(group.id, group); this.#track(session, group); this.#updateTimer();
    await group.create(session, this.sessions.getPlaybackItem(session.Id));
    return group.info();
  }); }
  join(session, id) { return this.#run(async () => {
    await this.users.getUser(session.UserId);
    const group = this.#groups.get(guidKey(id));
    if (!group) { this.#error(session, 'GroupDoesNotExist'); return; }
    if (!await group.hasAccess(session.UserId)) { this.#error(session, 'LibraryAccessDenied', group.id); return; }
    const existing = this.#sessions.get(session.Id.toLowerCase());
    if (existing !== group) {
      if (existing) await this.#leave(session);
      this.#track(session, group);
    }
    await group.join(session);
  }); }
  leave(session) { return this.#run(() => this.#leave(session)); }
  list(session) { return this.#run(async () => {
    await this.users.getUser(session.UserId);
    const result = [];
    for (const group of this.#groups.values()) if (await group.hasAccess(session.UserId)) result.push(group.info());
    return result;
  }); }
  get(session, id) { return this.#run(async () => {
    await this.users.getUser(session.UserId);
    const group = this.#groups.get(guidKey(id));
    return group && await group.hasAccess(session.UserId) ? group.info() : null;
  }); }
  handle(session, action, request = {}) { return this.#run(async () => {
    const group = this.#sessions.get(session.Id.toLowerCase());
    if (!group) { this.#error(session, 'NotInGroup'); return; }
    await group.handle(action, request, session);
  }); }
  checkTimeouts() { return this.#run(async () => { for (const group of this.#groups.values()) await group.timeout(); }); }
  async drain() { await this.#tail; await Promise.all(this.#deliveries.values()); }
  async close() {
    this.#closed = true; clearInterval(this.#timer); this.#timer = null;
    this.sessions.off('SessionEnded', this.sessionEnded);
    await this.drain(); this.#groups.clear(); this.#sessions.clear(); this.#activeUsers.clear();
  }
}
