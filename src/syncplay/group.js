import { SyncPlayQueue, newGuid, emptyGuid, guidKey } from './queue.js';
import { utcTicks, formatUtcTicks, maxTicks, absoluteTicks, addTicks, addTimeSpanTicks } from './time.js';

const milliseconds = value => BigInt(value) * 10000n;
const dashed = id => id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');

export class SyncPlayGroup {
  constructor({ name, access, item, send, clock = utcTicks, monotonic = () => performance.now(), waitTimeout = 30000, queueOptions } = {}) {
    Object.assign(this, { name, access, item, send, clock, monotonic, waitTimeout });
    this.id = newGuid();
    this.members = new Map();
    this.queue = new SyncPlayQueue({ clock, ...queueOptions });
    this.runtime = 0n;
    this.state = { type: 'Idle' };
    this.deadline = null;
    this.restart();
  }
  info() { return { GroupId: this.id, GroupName: this.name, State: this.state.type, Participants: [...new Set([...this.members.values()].map(member => member.userName))], LastUpdatedAt: formatUtcTicks(this.clock()) }; }
  restart() { this.position = 0n; this.activity = this.clock(); }
  setState(type, properties = {}) {
    this.state = { type, resumePlaying: false, initialState: null, positionJumped: false, ...properties };
    if (type !== 'Waiting') this.deadline = null;
  }
  addSession(session) {
    const key = session.Id.toLowerCase();
    if (!this.members.has(key)) this.members.set(key, { session, userId: session.UserId, userName: session.UserName, ping: 500n, buffering: false, ignoreWait: false });
    else this.members.get(key).session = session;
  }
  emit(session, filter, type, data) {
    const ids = filter === 'current' ? [session.Id] : [...this.members.values()]
      .filter(member => filter !== 'others' || member.session.Id.toLowerCase() !== session.Id.toLowerCase())
      .filter(member => filter !== 'ready' || !member.buffering).map(member => member.session.Id);
    for (const id of ids) this.send(id, type, data);
  }
  update(session, type, data, filter = 'all') { this.emit(session, filter, 'SyncPlayGroupUpdate', { GroupId: this.id, Data: data, Type: type }); }
  command(session, command, filter = 'all', when = this.activity) {
    this.emit(session, filter, 'SyncPlayCommand', { GroupId: this.id, PlaylistItemId: this.queue.currentId, When: formatUtcTicks(when), PositionTicks: this.position, Command: command, EmittedAt: formatUtcTicks(this.clock()) });
  }
  stateUpdate(session, reason) { this.update(session, 'StateUpdate', { State: this.state.type, Reason: reason }); }
  queueUpdate(session, reason, filter = 'all') {
    const playing = this.state.type === 'Playing';
    this.update(session, 'PlayQueue', { Reason: reason, LastUpdate: this.queue.lastChange, Playlist: this.queue.playlist,
      PlayingItemIndex: this.queue.index, StartPositionTicks: playing ? addTicks(this.position, maxTicks(this.clock() - this.activity, 0n)) : this.position,
      IsPlaying: playing, ShuffleMode: this.queue.shuffleMode, RepeatMode: this.queue.repeatMode }, filter);
  }
  get buffering() { return [...this.members.values()].some(member => member.buffering && !member.ignoreWait); }
  get ping() { return [...this.members.values()].reduce((highest, member) => maxTicks(highest, member.ping), this.members.size ? 0n : 500n); }
  updateDeadline(restart = false) {
    if (this.state.type !== 'Waiting' || !this.buffering) this.deadline = null;
    else if (this.deadline == null || restart) this.deadline = this.monotonic() + this.waitTimeout;
  }
  setBuffer(session, value) { const member = this.members.get(session.Id.toLowerCase()); if (member) member.buffering = value; this.updateDeadline(); }
  setAllBuffer(value) { for (const member of this.members.values()) member.buffering = value; this.updateDeadline(value); }
  async hasAccess(user, ids = this.queue.playlist.map(entry => entry.ItemId)) { return this.access(user, ids); }
  async allHaveAccess(ids) {
    for (const member of this.members.values()) if (!await this.hasAccess(member.userId, ids)) return false;
    return true;
  }
  async updateRuntime(allowEmpty = false) { this.runtime = allowEmpty && this.queue.itemId === emptyGuid ? 0n : BigInt((await this.item(this.queue.itemId)).RunTimeTicks ?? 0); }
  sanitize(value) {
    if (this.runtime < 0n) throw new RangeError('The runtime is less than zero.');
    const position = BigInt(value ?? 0);
    return position < 0n ? 0n : position > this.runtime ? this.runtime : position;
  }
  async create(session, fullItem) {
    this.addSession(session);
    this.restart();
    if (fullItem) {
      this.queue.reset(); this.queue.setPlaylist(session.NowPlayingQueue.map(entry => entry.Id)); this.queue.setItem(fullItem.Id, 'ItemId');
      this.runtime = BigInt(fullItem.RunTimeTicks ?? 0); this.position = BigInt(session.PlayState.PositionTicks ?? 0);
      this.setState('Waiting', { resumePlaying: !session.PlayState.IsPaused });
    }
    this.update(session, 'GroupJoined', this.info(), 'current');
    await this.handle('SessionJoined', {}, session);
  }
  async join(session) {
    this.addSession(session);
    this.update(session, 'GroupJoined', this.info(), 'current'); this.update(session, 'UserJoined', session.UserName, 'others');
    await this.handle('SessionJoined', {}, session);
  }
  async leave(session) {
    await this.handle('SessionLeaving', {}, session);
    this.members.delete(session.Id.toLowerCase()); this.updateDeadline();
    this.update(session, 'GroupLeft', dashed(this.id), 'current'); this.update(session, 'UserLeft', session.UserName, 'others');
  }
  async timeout() {
    if (this.deadline == null || this.deadline > this.monotonic()) return;
    this.deadline = null;
    if (this.state.type !== 'Waiting') return;
    const member = [...this.members.values()].find(entry => entry.buffering && !entry.ignoreWait);
    if (!member) return;
    if (this.state.resumePlaying) await this.handle('Unpause', {}, member.session);
    else {
      this.setAllBuffer(false); this.setState('Paused'); this.command(member.session, 'Pause'); this.stateUpdate(member.session, 'Pause');
    }
  }
  async transition(type, action, request, session) {
    const previous = this.state.type;
    this.setState(type);
    await this.handle(action, request, session, previous);
  }
  async handle(action, request, session, previous = this.state.type) {
    const state = this.state;
    // Actions shared by all four native states.
    if (action === 'RemoveFromPlaylist') {
      let removed;
      if (request.ClearPlaylist) {
        this.queue.clear(request.ClearPlayingItem); removed = request.ClearPlayingItem;
        if (removed) this.restart();
      } else {
        removed = this.queue.remove(request.PlaylistItemIds);
        if (removed) { await this.updateRuntime(true); this.restart(); }
      }
      this.queueUpdate(session, 'RemoveItems');
      if (removed && !this.queue.isPlaying) await this.transition('Idle', 'Stop', {}, session);
      return;
    }
    if (action === 'MovePlaylistItem') { if (this.queue.move(request.PlaylistItemId, request.NewIndex)) this.queueUpdate(session, 'MoveItem'); return; }
    if (action === 'Queue') {
      if (request.ItemIds.length && await this.allHaveAccess(request.ItemIds)) {
        this.queue.append(request.ItemIds, request.Mode === 'QueueNext'); this.queueUpdate(session, request.Mode === 'QueueNext' ? 'QueueNext' : 'Queue');
      }
      return;
    }
    if (action === 'SetRepeatMode' || action === 'SetShuffleMode') {
      this.queue[action === 'SetRepeatMode' ? 'setRepeat' : 'setShuffle'](request.Mode);
      this.queueUpdate(session, action === 'SetRepeatMode' ? 'RepeatMode' : 'ShuffleMode'); return;
    }
    if (action === 'Ping') {
      const member = this.members.get(session.Id.toLowerCase());
      if (member) member.ping = request.Ping < 0n ? 0n : request.Ping > 10000n ? 10000n : request.Ping;
      return;
    }
    if (action === 'IgnoreWait') {
      const member = this.members.get(session.Id.toLowerCase()); if (member) member.ignoreWait = request.IgnoreWait;
      this.updateDeadline();
      if (state.type === 'Waiting' && !this.buffering) {
        if (state.resumePlaying) await this.transition('Playing', 'Unpause', {}, session); else this.setState('Paused');
      }
      return;
    }
    if (state.type === 'Waiting') return this.waiting(action, request, session, previous);
    if (action === 'SessionLeaving') return;
    if (action === 'SessionJoined') {
      if (state.type === 'Idle') this.command(session, 'Stop', 'current');
      else await this.transition('Waiting', action, request, session);
      return;
    }
    if (['Play', 'SetPlaylistItem', 'NextItem', 'PreviousItem'].includes(action)) return this.transition('Waiting', action, request, session);
    if (state.type === 'Idle') {
      if (action === 'Unpause') return this.transition('Waiting', action, request, session);
      this.command(session, 'Stop', previous === 'Idle' ? 'current' : 'all'); return;
    }
    if (action === 'Stop') return this.transition('Idle', action, request, session);
    if (action === 'Seek') return this.transition('Waiting', action, request, session);
    if (action === 'Buffer') {
      if (state.type !== 'Playing' || !state.ignoreBuffering) return this.transition('Waiting', action, request, session);
      return;
    }
    if (action === 'Unpause') {
      if (state.type === 'Paused') return this.transition('Playing', action, request, session);
      if (previous !== 'Playing') {
        this.activity = this.clock() + milliseconds(maxTicks(this.ping * 2n, 500n));
        this.command(session, 'Unpause'); this.stateUpdate(session, 'Unpause');
      } else this.command(session, 'Unpause', 'current');
    } else if (action === 'Pause') {
      if (state.type === 'Playing') return this.transition('Paused', action, request, session);
      if (previous !== 'Paused') {
        const now = this.clock(); this.position = addTicks(this.position, maxTicks(now - this.activity, 0n)); this.activity = now;
        this.command(session, 'Pause'); this.stateUpdate(session, 'Pause');
      } else this.command(session, 'Pause', 'current');
    } else if (action === 'Ready') {
      if (previous === state.type) this.command(session, state.type === 'Playing' ? 'Unpause' : 'Pause', 'current');
      else if (previous === 'Waiting') {
        if (state.type === 'Paused') this.command(session, 'Pause');
        this.stateUpdate(session, 'Ready');
      }
    }
  }
  async waiting(action, request, session, previous) {
    const state = this.state;
    state.initialState ??= previous;
    if (action === 'SessionJoined') {
      if (previous === 'Playing') { state.resumePlaying = true; const now = this.clock(); this.position = addTicks(this.position, maxTicks(now - this.activity, 0n)); this.activity = now; }
      this.queueUpdate(session, 'NewPlaylist', 'current'); this.setBuffer(session, true); this.command(session, 'Pause', 'ready'); return;
    }
    if (action === 'SessionLeaving') {
      this.setBuffer(session, false);
      if (!this.buffering) {
        if (state.resumePlaying) await this.transition('Playing', 'Unpause', {}, session); else this.setState('Paused');
      }
      return;
    }
    if (action === 'Stop') return this.transition('Idle', action, request, session);
    if (['Play', 'SetPlaylistItem', 'NextItem', 'PreviousItem'].includes(action)) {
      state.resumePlaying = true;
      let success = false;
      let reason;
      if (action === 'Play') {
        const ids = request.PlayingQueue, index = request.PlayingItemPosition;
        success = ids.length > 0 && index >= 0 && index < ids.length && await this.allHaveAccess(ids);
        if (success) { this.queue.reset(); this.queue.setPlaylist(ids); this.queue.setIndex(index); await this.updateRuntime(); this.position = request.StartPositionTicks; this.activity = this.clock(); }
        reason = 'NewPlaylist';
      } else if (action === 'SetPlaylistItem') {
        success = this.queue.setItem(request.PlaylistItemId); await this.updateRuntime(!success); this.restart(); reason = 'SetCurrentItem';
      } else {
        if (guidKey(request.PlaylistItemId) !== this.queue.currentId) return;
        success = this.queue.advance(action === 'NextItem' ? 1 : -1);
        if (success) { await this.updateRuntime(); this.restart(); }
        reason = action;
      }
      state.positionJumped = success;
      if (!success) this.setState(previous === 'Playing' || previous === 'Paused' ? previous : 'Idle');
      else { this.queueUpdate(session, reason); this.setAllBuffer(true); }
      return;
    }
    if (action === 'Unpause') {
      if (previous === 'Idle') {
        this.restart(); state.positionJumped = true; state.resumePlaying = true; this.queueUpdate(session, 'NewPlaylist'); this.setAllBuffer(true);
      } else if (state.resumePlaying) {
        this.setAllBuffer(false); this.setState('Playing', { ignoreBuffering: true }); await this.handle('Unpause', {}, session, 'Waiting');
      } else { state.resumePlaying = true; this.stateUpdate(session, 'Unpause'); }
      return;
    }
    if (action === 'Pause') { state.resumePlaying = false; this.stateUpdate(session, 'Pause'); return; }
    if (action === 'Seek') {
      if (previous === 'Playing') state.resumePlaying = true; else if (previous === 'Paused') state.resumePlaying = false;
      this.position = this.sanitize(request.PositionTicks); this.activity = this.clock(); state.positionJumped = true;
      this.command(session, 'Seek'); this.setAllBuffer(true); this.stateUpdate(session, 'Seek'); return;
    }
    if (action !== 'Buffer' && action !== 'Ready') return;
    if (guidKey(request.PlaylistItemId) !== this.queue.currentId) {
      this.queueUpdate(session, 'SetCurrentItem', 'current'); this.setBuffer(session, true); return;
    }
    if (action === 'Buffer') {
      if (previous === 'Playing') {
        state.resumePlaying = true; this.setBuffer(session, true);
        const now = this.clock(); this.position = addTicks(this.position, maxTicks(now - this.activity, 0n)); this.activity = now;
        this.command(session, 'Pause', 'ready');
      } else {
        if (previous === 'Paused') state.resumePlaying = false;
        this.setBuffer(session, true); if (!state.resumePlaying) this.command(session, 'Pause', 'current');
      }
      this.stateUpdate(session, 'Buffer'); return;
    }
    const now = this.clock();
    let elapsed = now - request.When.ticks;
    if (absoluteTicks(elapsed) > milliseconds(2000) || !request.IsPlaying) elapsed = 0n;
    const requested = this.sanitize(request.PositionTicks);
    const delay = BigInt.asIntN(64, this.position - addTimeSpanTicks(requested, elapsed));
    if (state.resumePlaying) {
      const tolerance = request.IsPlaying && !state.positionJumped ? milliseconds(60000) : milliseconds(500);
      if (absoluteTicks(delay) > tolerance) { this.setBuffer(session, true); this.command(session, 'Seek', 'current'); this.stateUpdate(session, 'Ready'); return; }
      this.setBuffer(session, false);
      if (this.buffering) this.command(session, 'Pause', 'current', now + delay);
      else {
        if (delay > milliseconds(this.ping * 2n)) {
          this.activity = now + delay; this.command(session, 'Unpause', request.IsPlaying ? 'others' : 'all');
        } else { this.activity = now + milliseconds(maxTicks(this.ping * 2n, 500n)); this.command(session, 'Unpause'); }
        this.setState('Playing'); await this.handle('Ready', request, session, 'Waiting');
      }
    } else {
      if (absoluteTicks(BigInt.asIntN(64, this.position - requested)) > milliseconds(500)) { this.setBuffer(session, true); this.command(session, 'Seek', 'current'); this.stateUpdate(session, 'Ready'); return; }
      this.setBuffer(session, false);
      if (!this.buffering) {
        this.setState('Paused');
        if (state.initialState === 'Playing') await this.handle('Pause', request, session, 'Waiting');
        else if (state.initialState === 'Paused') await this.handle('Ready', request, session, 'Waiting');
      }
    }
  }
}
