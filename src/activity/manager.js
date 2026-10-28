import { EventEmitter } from 'node:events';
import { nativeDate, nativeGuid, wireGuid } from '../users/native.js';

const emptyUserId = '00000000000000000000000000000000';
const userMessages = {
  UserCreated: 'UserCreatedWithName',
  UserDeleted: 'UserDeletedWithName',
  UserPasswordChanged: 'UserPasswordChangedWithName',
  UserLockedOut: 'UserLockedOutWithName',
};

/** Owns committed activity writes and their post-commit notifications. */
export class ActivityLogManager extends EventEmitter {
  #pending = new Set();
  #closing = false;
  #closePromise;

  constructor({ store, localization, onError = () => {}, clock = () => new Date() }) {
    super();
    Object.assign(this, { store, localization, onError, clock });
  }

  create(entry) {
    if (this.#closing) return Promise.reject(Object.assign(new Error('Activity logging is closing.'), { code: 'closed', status: 503 }));
    const values = { Name: entry.Name, Type: entry.Type, UserId: nativeGuid(entry.UserId ?? emptyUserId),
      ItemId: entry.ItemId ?? null, Overview: entry.Overview ?? null, ShortOverview: entry.ShortOverview ?? null,
      DateCreated: nativeDate(this.clock()), LogSeverity: entry.LogSeverity ?? 2, RowVersion: 0n };
    const pending = Promise.resolve().then(async () => {
      const stored = await this.store.run(database => database.insert('ActivityLogs', values));
      // An observer may fail after the database commit. Keep that prefix and
      // let the direct caller apply its own best-effort activity policy.
      this.emit('EntryCreated', stored);
      return stored;
    });
    this.#pending.add(pending);
    const release = () => this.#pending.delete(pending);
    void pending.then(release, release);
    return pending;
  }

  async #record(entry) {
    try { await this.create(entry()); }
    catch (error) {
      // The designated EventManager awaits each logger, reports its failure,
      // and continues the original user/authentication operation.
      try { void Promise.resolve(this.onError(error)).catch(() => {}); }
      catch { /* Error reporting cannot replace the business result. */ }
    }
  }

  userEvent(type, user) {
    return this.#record(() => ({ Name: this.localization.format(userMessages[type], [user.Username]), Type: type,
      UserId: type === 'UserDeleted' ? emptyUserId : user.Id, LogSeverity: type === 'UserLockedOut' ? 4 : 2 }));
  }

  authenticationSucceeded(result) {
    return this.#record(() => ({ Name: this.localization.format('AuthenticationSucceededWithUserName', [result.User.Name]),
      Type: 'AuthenticationSucceeded', UserId: result.User.Id,
      ShortOverview: this.localization.format('LabelIpAddressValue', [result.SessionInfo?.RemoteEndPoint ?? '']) }));
  }

  authenticationFailed(username, remoteEndPoint) {
    return this.#record(() => ({ Name: this.localization.format('FailedLoginAttemptWithUserName', [username]),
      Type: 'AuthenticationFailed', UserId: emptyUserId, LogSeverity: 4,
      ShortOverview: this.localization.format('LabelIpAddressValue', [remoteEndPoint ?? '']) }));
  }

  sessionEvent(type, session) {
    if (session.UserName == null || session.UserName === '') return Promise.resolve();
    return this.#record(() => ({ Name: this.localization.format(type === 'SessionStarted'
      ? 'UserOnlineFromDevice' : 'UserOfflineFromDevice', [session.UserName, session.DeviceName]),
      Type: type, UserId: session.UserId,
      ShortOverview: this.localization.format('LabelIpAddressValue', [session.RemoteEndPoint ?? '']) }));
  }

  playbackEvent(phase, event) {
    const media = event.MediaInfo;
    if (!media || !event.Users?.length || ['ThemeSong', 'ThemeVideo', 8, 9].includes(event.Item?.ExtraType)) return Promise.resolve();
    const mediaType = media.MediaType;
    const type = mediaType === 'Audio' || mediaType === 2 ? 'AudioPlayback'
      : mediaType === 'Video' || mediaType === 1 ? 'VideoPlayback' : null;
    if (phase === 'stop' && type === null) return Promise.resolve();
    return this.#record(() => {
      let name = media.Name ?? '';
      if (media.SeriesName != null && media.SeriesName !== '') name = `${media.SeriesName} - ${name}`;
      if (media.Artists?.length) name = `${media.Artists[0] ?? ''} - ${name}`;
      const user = event.Users[0];
      return { Name: this.localization.format(phase === 'stop'
        ? 'UserStoppedPlayingItemWithValues' : 'UserStartedPlayingItemWithValues', [user.Username, name, event.DeviceName]),
        Type: phase === 'stop' ? `${type}Stopped` : type ?? 'Playback', UserId: user.Id,
        ItemId: event.Item ? wireGuid(event.Item.Id) : null };
    });
  }

  downloading(user, item, auth) {
    return this.#record(() => ({ Name: this.localization.format('UserDownloadingItemWithValues', [user.Username, item.Name]),
      Type: 'UserDownloadingContent', UserId: auth.UserId ?? user.Id, ItemId: wireGuid(item.Id),
      ShortOverview: `App: ${auth.Client ?? ''}, Device: ${auth.Device ?? ''}` }));
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    return this.#closePromise = (async () => {
      while (this.#pending.size) await Promise.allSettled([...this.#pending]);
      this.removeAllListeners();
    })();
  }
}
