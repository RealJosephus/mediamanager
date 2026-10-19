import { EventEmitter } from 'node:events';
import { randomUUID, randomInt } from 'node:crypto';
import { md5Guid } from '../core/identity.js';
import { cloneNativeValue } from '../core/json.js';
import { emptyGuid, guidD, guidN, sameGuid, nativeDate, int64, isVideo } from './user-data.js';
import { equalsIgnoreCase, wireDate } from '../users/native.js';
import { bindCapabilities, bindPlaybackReport, defaultCapabilities } from './binding.js';
import { expandPostgresPlayItems } from '../library/playback-items.js';

const emptyPlayerState = () => ({ PositionTicks: null, CanSeek: false, IsPaused: false, IsMuted: false, VolumeLevel: null, AudioStreamIndex: null, SubtitleStreamIndex: null, MediaSourceId: null, PlayMethod: null, RepeatMode: 'RepeatNone', PlaybackOrder: 'Default', LiveStreamId: null });
const failure = (status, message) => Object.assign(new Error(message), { status });
const insensitive = equalsIgnoreCase;
const nowPlayingFields = ['AirTime', 'Chapters', 'Trickplay', 'CumulativeRunTimeTicks', 'DateCreated', 'ExternalUrls', 'Genres', 'OriginalTitle', 'Overview', 'ParentId', 'Path', 'ProviderIds', 'PrimaryImageAspectRatio', 'SeriesStudio', 'SpecialEpisodeNumbers', 'Studios', 'Taglines', 'EnableMediaSourceDisplay', 'Width', 'Height', 'LocalTrailerCount', 'IsHD', 'SpecialFeatureCount', 'MediaStreams'];

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export class SessionService extends EventEmitter {
  #sessions = new Map();
  #capabilities = new Map();
  #tail = Promise.resolve();
  #timers = new Map();
  #reports = new Map();
  #users = new Map();
  #idleTimer;
  constructor({ store, library, userData, users, serverId, configuration = {}, clock = () => new Date(), automaticProgress = true,
    onError = () => {} }) {
    super(); Object.assign(this, { store, library, userData, users, serverId, configuration, clock, automaticProgress, onError });
    users?.on?.('UserCreated', this.#cacheUser);
    users?.on?.('UserUpdated', this.#cacheUser);
    users?.on?.('UserDeleted', this.#forgetUser);
  }
  #run(operation) { const task = this.#tail.then(operation); this.#tail = task.catch(() => {}); return task; }
  #now() { return wireDate(this.clock().toISOString()); }
  #session(id, required = true) { const value = this.#sessions.get(id); if (!value && required) throw failure(404, `Session ${id} not found.`); return value; }
  #contains(session, userId) { return sameGuid(session.UserId, userId) || session.AdditionalUsers.some((user) => sameGuid(user.UserId, userId)); }
  #cacheUser = user => { if (user?.Id) this.#users.set(guidN(user.Id), user); };
  #forgetUser = user => { if (user?.Id) this.#users.delete(guidN(user.Id)); };
  #primaryImageTag(user) {
    try { return this.users?.primaryImageTag?.(user) ?? null; }
    catch (error) {
      try { this.onError(error); } catch { /* Error reporting cannot break session activity. */ }
      return null;
    }
  }
  async #user(id) {
    const user = this.users ? await this.users.getUser(id)
      : this.#users.get(guidN(id)) ?? await this.store.run(async db => (await db.rows('Users', {
        where: { Id: guidD(id) }, limit: 1
      }))[0]);
    this.#cacheUser(user);
    return user;
  }
  countUserSessions(userId) { return [...this.#sessions.values()].filter((session) => sameGuid(session.UserId, userId)).length; }
  getPrimaryUserIds() {
    return [...new Set([...this.#sessions.values()].map(session => session.UserId).filter(userId => userId !== emptyGuid))];
  }
  getSession(id) { return this.#dto(this.#session(id)); }
  getPlaybackItem(id) { return cloneNativeValue(this.#session(id).FullNowPlayingItem ?? null); }
  getDeviceCapabilities(deviceId) { return structuredClone(this.#capabilities.get(deviceId) ?? defaultCapabilities()); }

  getDeviceIdsWithoutPersistentIdentifier() {
    return [...this.#capabilities]
      .filter(([, capabilities]) => capabilities.SupportsPersistentIdentifier === false)
      .map(([deviceId]) => deviceId);
  }
  attachController(sessionId, controller) {
    const session = this.#session(sessionId);
    session.Controllers.push(controller);
    this.emit('SessionControllerConnected', { SessionInfo: this.#dto(session) });
    return async () => {
      if (!this.#sessions.has(sessionId)) return;
      if (!session.Controllers.some(entry => entry.isActive())) await this.endSession(sessionId);
    };
  }
  async sendCommand(sessionId, messageType, data, { controllingSessionId } = {}) {
    const session = this.#session(sessionId);
    await this.#assertControl(session, controllingSessionId);
    const messageId = randomUUID().replaceAll('-', '');
    for (const controller of session.Controllers) await controller.sendMessage(messageType, messageId, data);
  }
  async sendMessageToUserSessions(userIds, messageType, data) {
    const normalized = userIds.map(guidN);
    const targets = [...this.#sessions.values()].filter(session => normalized.some(userId => this.#contains(session, userId)));
    if (!targets.length) return;
    const payload = typeof data === 'function' ? await data() : data;
    const messageId = randomUUID().replaceAll('-', '');
    await Promise.all(targets.flatMap(session => session.Controllers.map(controller => controller.sendMessage(messageType, messageId, payload))));
  }
  sendMessageToAdminSessions(messageType, data) {
    const candidates = [...this.#sessions.values()].map(session => ({
      userIds: [session.UserId, ...session.AdditionalUsers.map(user => user.UserId)]
        .filter(id => id !== emptyGuid).map(guidN),
      controllers: [...session.Controllers]
    }));
    const ids = new Map(candidates.flatMap(candidate => candidate.userIds).map(id => [id, id]));
    const admins = new Set([...ids.keys()].filter(id => this.#users.get(id)?.Policy?.IsAdministrator));
    const missing = [...ids.keys()].filter(id => !this.#users.has(id));
    const deliver = () => {
      const targets = candidates.filter(candidate => candidate.userIds.some(id => admins.has(id)));
      if (!targets.length) return Promise.resolve();
      let payload;
      try { payload = typeof data === 'function' ? data() : data; }
      catch (error) { return Promise.reject(error); }
      return Promise.resolve(payload).then(value => {
        const messageId = randomUUID().replaceAll('-', '');
        return Promise.all(targets.flatMap(target => target.controllers.map(controller => controller.sendMessage(messageType, messageId, value))));
      });
    };
    if (!missing.length) return deliver();
    return Promise.all(missing.map(id => this.#user(id))).then(users => {
      for (const user of users) if (user?.Policy?.IsAdministrator) admins.add(guidN(user.Id));
      return deliver();
    });
  }
  async sendPlaystate(sessionId, data, { controllingSessionId } = {}) {
    const command = { ...data };
    if (controllingSessionId) {
      const userId = this.#session(controllingSessionId).UserId;
      if (userId !== emptyGuid) command.ControllingUserId = userId;
    }
    return this.sendCommand(sessionId, 'Playstate', command, { controllingSessionId });
  }
  async sendPlay(sessionId, data, { controllingSessionId } = {}) {
    const target = this.#session(sessionId);
    const user = target.UserId !== emptyGuid ? await this.#user(target.UserId) : null;
    const mixing = data.PlayCommand === 'PlayInstantMix';
    const items = await this.store.run(db => expandPostgresPlayItems(db, this.library, data.ItemIds, {
      user,
      mixing,
      enableNextEpisodeAutoPlay: Boolean(user?.EnableNextEpisodeAutoPlay),
    }));
    if (user && items.length && !user.Policy.EnableMediaPlayback) throw failure(400, `${user.Username} is not allowed to play media.`);
    const command = cloneNativeValue(data);
    command.ItemIds = items.map(item => guidN(item.Id));
    if (command.PlayCommand === 'PlayInstantMix') command.PlayCommand = 'PlayNow';
    if (command.PlayCommand === 'PlayShuffle') {
      command.ItemIds = shuffle(command.ItemIds);
      command.PlayCommand = 'PlayNow';
    }
    if (controllingSessionId) {
      const userId = this.#session(controllingSessionId).UserId;
      if (userId !== emptyGuid) command.ControllingUserId = userId;
    }
    return this.sendCommand(sessionId, 'Play', command, { controllingSessionId });
  }
  async reportViewing(sessionId, itemId, { controllingSessionId } = {}) {
    let item;
    try { item = await this.library.getItemRecord(itemId); }
    catch (error) { if (error.status !== 404) throw error; }
    const session = this.#session(sessionId);
    await this.#assertControl(session, controllingSessionId);
    session.NowViewingItem = item ? await this.library.getItemDto(item, { fields: nowPlayingFields, enableUserData: false }) : null;
  }
  async logActivity(auth, { remoteEndPoint = null } = {}) {
    return this.#run(async () => {
      const { Client, DeviceId, Version, User } = auth;
      if (!Client || !DeviceId || !Version) throw failure(400, 'Client, device id and application version are required.');
      const userId = User?.Id ?? auth.UserId ?? emptyGuid;
      if (User) this.#users.set(guidN(userId), User);
      const id = md5Guid(Client + DeviceId + guidN(userId));
      let session = this.#sessions.get(id);
      if (!session) {
        const options = await this.store.run(async (db) => (await db.rows('DeviceOptions', {
          where: { DeviceId }, limit: 1
        }))[0]);
        session = { Id: id, UserId: guidN(userId), UserName: User?.Username ?? null, Client, DeviceId, DeviceName: options?.CustomName || auth.Device || 'Network Device', HasCustomDeviceName: Boolean(options?.CustomName), ApplicationVersion: Version, ServerId: this.serverId, PlayState: emptyPlayerState(), AdditionalUsers: [], Capabilities: this.getDeviceCapabilities(DeviceId), RemoteEndPoint: remoteEndPoint, LastActivityDate: '0001-01-01T00:00:00.0000000Z', LastPlaybackCheckIn: '0001-01-01T00:00:00.0000000Z', LastPausedDate: null, DeviceType: null, NowPlayingItem: null, NowViewingItem: null, TranscodingInfo: null, NowPlayingQueue: [], PlaylistItemId: null, UserPrimaryImageTag: this.#primaryImageTag(User), Controllers: [] };
        this.#sessions.set(id, session);
        this.emit('SessionStarted', { SessionInfo: this.#dto(session) });
      }
      const previous = session.LastActivityDate;
      session.UserName = User?.Username ?? null;
      session.UserPrimaryImageTag = this.#primaryImageTag(User);
      session.RemoteEndPoint = remoteEndPoint; session.Client = Client; session.ApplicationVersion = Version;
      if (!session.HasCustomDeviceName || !session.DeviceName) session.DeviceName = auth.Device ?? null;
      session.LastActivityDate = this.#now();
      if (User) await this.store.transaction(async (db) => {
        const current = (await db.rows('Users', { where: { Id: User.Id }, limit: 1 }))[0];
        if (current && this.clock().valueOf() - new Date(current.LastActivityDate?.replace(' ', 'T') + (current.LastActivityDate?.endsWith('Z') ? '' : 'Z')).valueOf() > 60000 || current && !current.LastActivityDate) {
          await db.update('Users', { Id: User.Id }, { LastActivityDate: nativeDate(this.clock()) }, { rowVersion: current.RowVersion });
        }
      });
      if (new Date(session.LastActivityDate) - new Date(previous) > 10000) this.emit('SessionActivity', { SessionInfo: this.#dto(session) });
      return this.#dto(session);
    });
  }
  #dto(session) {
    const { Controllers, FullNowPlayingItem, ...dto } = session;
    dto.TranscodingInfo = this.hls?.getTranscodingInfo?.(session.DeviceId) ?? dto.TranscodingInfo;
    return cloneNativeValue({ ...dto, PlayableMediaTypes: session.Capabilities.PlayableMediaTypes, SupportedCommands: session.Capabilities.SupportedCommands, IsActive: Controllers.length === 0 || Controllers.some((controller) => controller.isActive()), SupportsMediaControl: session.Capabilities.SupportsMediaControl && Controllers.some((controller) => controller.supportsMediaControl), SupportsRemoteControl: session.Capabilities.SupportsMediaControl && Controllers.some((controller) => controller.supportsMediaControl) });
  }
  async getSessions(auth, { deviceId, activeWithinSeconds, controllableByUserId } = {}) {
    const user = auth.User;
    const admin = auth.IsApiKey || user?.Policy?.IsAdministrator;
    let result = [...this.#sessions.values()];
    if (deviceId) result = result.filter((session) => insensitive(session.DeviceId, deviceId));
    if (controllableByUserId && guidN(controllableByUserId) !== emptyGuid) {
      const controlled = await this.#user(controllableByUserId);
      if (!controlled) return [];
      result = result.filter((session) => this.#dto(session).SupportsRemoteControl);
      if (!controlled.Policy?.EnableSharedDeviceControl) result = result.filter((session) => session.UserId !== emptyGuid);
      if (!auth.IsApiKey && !user?.Policy?.EnableRemoteControlOfOtherUsers) result = result.filter((session) => session.UserId === emptyGuid || this.#contains(session, user?.Id));
      if (!auth.IsApiKey) result = result.filter((session) => user && (!session.DeviceId?.trim() || user.Policy?.EnableAllDevices || user.Policy?.IsAdministrator || user.Policy?.EnabledDevices?.some((id) => insensitive(id, session.DeviceId)) || !session.Capabilities.SupportsPersistentIdentifier));
    } else if (!admin) result = result.filter((session) => session.UserId === emptyGuid || this.#contains(session, user?.Id));
    if (activeWithinSeconds > 0) result = result.filter((session) => new Date(session.LastActivityDate).valueOf() >= this.clock().valueOf() - activeWithinSeconds * 1000);
    return result.map((session) => this.#dto(session));
  }
  async #assertControl(target, controllingId) {
    if (!controllingId) return;
    const controlling = this.#session(controllingId);
    if (controlling.UserId === emptyGuid || target.UserId === emptyGuid || this.#contains(target, controlling.UserId)) return;
    if (!(await this.#user(controlling.UserId))?.Policy?.EnableRemoteControlOfOtherUsers) throw failure(403, 'The current user does not have permission to remote control other users.');
  }
  async reportCapabilities(sessionId, capabilities, { controllingSessionId } = {}) {
    const session = this.#session(sessionId);
    await this.#assertControl(session, controllingSessionId);
    session.Capabilities = bindCapabilities(capabilities);
    this.#capabilities.set(session.DeviceId, structuredClone(session.Capabilities));
    this.emit('CapabilitiesChanged', { SessionInfo: this.#dto(session) });
  }
  async addUser(sessionId, userId, { controllingSessionId } = {}) {
    const session = this.#session(sessionId);
    await this.#assertControl(session, controllingSessionId);
    if (controllingSessionId) {
      const controlling = this.#session(controllingSessionId);
      if (controlling.UserId !== emptyGuid && !sameGuid(controlling.UserId, userId) && !(await this.#user(controlling.UserId))?.Policy?.IsAdministrator) throw failure(403, 'The current user does not have permission to attach another user to a session.');
    }
    if (sameGuid(session.UserId, userId)) throw failure(400, 'The requested user is already the primary user of the session.');
    const user = await this.#user(userId);
    if (!user) throw failure(400, 'The requested user does not exist.');
    this.#cacheUser(user);
    if (!this.#contains(session, user.Id)) session.AdditionalUsers.push({ UserId: guidN(user.Id), UserName: user.Username });
  }
  async removeUser(sessionId, userId, { controllingSessionId } = {}) {
    const session = this.#session(sessionId); await this.#assertControl(session, controllingSessionId);
    if (sameGuid(session.UserId, userId)) throw failure(400, 'The requested user is already the primary user of the session.');
    session.AdditionalUsers = session.AdditionalUsers.filter((user) => !sameGuid(user.UserId, userId));
  }
  updateDeviceOptions(deviceId, customName) {
    for (const session of this.#sessions.values()) if (session.DeviceId === deviceId) {
      if (typeof customName === 'string' && customName.trim()) {
        session.HasCustomDeviceName = true;
        session.DeviceName = customName;
      } else session.HasCustomDeviceName = false;
    }
  }
  async endByDevice(deviceId) {
    return this.#run(async () => {
      for (const session of [...this.#sessions.values()]) if (insensitive(session.DeviceId, deviceId)) {
        this.#stopTimer(session.Id); this.#sessions.delete(session.Id); this.emit('SessionEnded', { SessionInfo: this.#dto(session) });
      }
    });
  }
  async endSession(sessionId) { const session = this.#session(sessionId, false); if (session) { this.#stopTimer(sessionId); this.#sessions.delete(sessionId); this.emit('SessionEnded', { SessionInfo: this.#dto(session) }); } }
  #stopTimer(id) { clearInterval(this.#timers.get(id)); this.#timers.delete(id); this.#reports.delete(id); }
  #startTimer(session, info) {
    this.#stopTimer(session.Id);
    this.#reports.set(session.Id, { ...info, LastReportedPositionTicks: info.PositionTicks });
    if (!this.automaticProgress) return;
    const timer = setInterval(() => this.advanceProgress(session.Id).catch((error) => this.emit('SessionError', error)), 1000);
    timer.unref(); this.#timers.set(session.Id, timer);
    if (!this.#idleTimer) {
      this.#idleTimer = setInterval(() => this.checkIdlePlayback().catch((error) => this.emit('SessionError', error)), 300000);
      this.#idleTimer.unref();
    }
  }
  async checkIdlePlayback() {
    for (const session of [...this.#sessions.values()]) if (session.NowPlayingItem && this.clock().valueOf() - new Date(session.LastPlaybackCheckIn).valueOf() > 300000) {
      await this.playbackStopped(session.Id, { Item: session.NowPlayingItem, ItemId: session.NowPlayingItem.Id, MediaSourceId: session.PlayState.MediaSourceId, PositionTicks: this.#reports.get(session.Id)?.LastReportedPositionTicks });
    }
    if (![...this.#sessions.values()].some((session) => session.NowPlayingItem)) { clearInterval(this.#idleTimer); this.#idleTimer = null; }
  }
  async advanceProgress(sessionId) {
    const info = this.#reports.get(sessionId);
    if (!info || info.IsPaused) return;
    const position = int64(info.PositionTicks ?? 0n);
    const next = (position < 0n ? 0n : position) + 10000000n;
    const runtime = this.#session(sessionId, false)?.NowPlayingItem?.RunTimeTicks;
    if (runtime != null && next >= int64(runtime)) return;
    info.PositionTicks = next;
    return this.playbackProgress(sessionId, info, { automated: true });
  }
  playbackStart(sessionId, info) { return this.#run(() => this.#playback(sessionId, info, 'start')); }
  playbackProgress(sessionId, info, { automated = false } = {}) { return this.#run(() => this.#playback(sessionId, info, 'progress', automated)); }
  playbackStopped(sessionId, info) { return this.#run(() => this.#playback(sessionId, info, 'stop')); }
  async #playback(sessionId, report, phase, automated = false) {
    const session = this.#session(sessionId, phase !== 'progress');
    if (!session) return;
    const info = bindPlaybackReport(report, { stopped: phase === 'stop' });
    info.SessionId = sessionId;
    if ((info.PlayMethod === 'Transcode' || info.PlayMethod === 0) && !this.hls?.hasJob(info.PlaySessionId)) info.PlayMethod = 'DirectPlay';
    if (phase === 'stop') { this.#stopTimer(sessionId); if (info.PositionTicks < 0n) throw failure(400, "The PlaybackStopInfo's PositionTicks was negative."); }
    const users = [];
    for (const id of [session.UserId, ...session.AdditionalUsers.map((user) => user.UserId)]) if (id !== emptyGuid) {
      const user = await this.#user(id); if (user) users.push(user); else if (sameGuid(id, session.UserId)) throw failure(500, 'User not found');
    }
    const item = info.ItemId && guidN(info.ItemId) !== emptyGuid
      ? session.FullNowPlayingItem && sameGuid(session.FullNowPlayingItem.Id, info.ItemId) ? session.FullNowPlayingItem : await this.library.getItemRecord(info.ItemId)
      : null;
    if (item) session.FullNowPlayingItem = item;
    let progressItem = item;
    if (item && isVideo(item) && info.MediaSourceId && !sameGuid(info.MediaSourceId, item.Id)) progressItem = (await this.userData.versions(item)).find((version) => sameGuid(version.Id, info.MediaSourceId)) ?? item;
    info.MediaSourceId ||= guidN(info.ItemId);
    info.Item ??= item ? await this.library.getItemDto(item, { fields: nowPlayingFields, enableUserData: false }) : null;
    if (phase === 'stop') { session.NowPlayingItem = null; session.FullNowPlayingItem = null; session.PlayState = emptyPlayerState(); if (info.NowPlayingQueue != null) session.NowPlayingQueue = info.NowPlayingQueue; }
    else {
      session.NowPlayingItem = info.Item; session.LastActivityDate = this.#now();
      if (!automated) session.LastPlaybackCheckIn = this.#now();
      if (info.IsPaused && session.LastPausedDate == null) session.LastPausedDate = this.#now(); else if (!info.IsPaused) session.LastPausedDate = null;
      session.PlayState = { ...emptyPlayerState(), ...Object.fromEntries(Object.keys(emptyPlayerState()).filter((key) => info[key] != null).map((key) => [key, info[key]])), MediaSourceId: info.MediaSourceId };
    }
    session.PlaylistItemId = info.PlaylistItemId ?? null;
    let completed = false;
    if (progressItem && !automated) for (const user of users) completed = await this.userData.playback(user, progressItem, phase, info);
    const event = { Item: item, Users: users, PlaybackPositionTicks: info.PositionTicks, MediaSourceId: info.MediaSourceId, MediaInfo: info.Item, DeviceName: session.DeviceName, ClientName: session.Client, DeviceId: session.DeviceId, Session: this.#dto(session), PlaySessionId: info.PlaySessionId };
    if (phase === 'progress') Object.assign(event, { IsPaused: info.IsPaused ?? false, IsAutomated: automated });
    if (phase === 'stop') event.PlayedToCompletion = completed;
    this.emit({ start: 'PlaybackStart', progress: 'PlaybackProgress', stop: 'PlaybackStopped' }[phase], event);
    if (phase !== 'stop' && info.PlaySessionId?.trim()) this.hls?.ping(info.PlaySessionId, info.IsPaused ?? false);
    if (phase !== 'stop' && !automated) this.#startTimer(session, info);
  }
  async close() {
    clearInterval(this.#idleTimer); this.#idleTimer = null;
    for (const id of this.#reports.keys()) this.#stopTimer(id);
    await this.#tail;
    this.users?.off?.('UserCreated', this.#cacheUser);
    this.users?.off?.('UserUpdated', this.#cacheUser);
    this.users?.off?.('UserDeleted', this.#forgetUser);
    this.#sessions.clear();
  }
}
