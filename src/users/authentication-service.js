import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readAuthorization } from '../core/authorization.js';
import { domainError, nativeGuid, wireGuid, nativeDate, wireDate, equalsIgnoreCase, scheduleAllowed,
  normalizeMembers } from './native.js';
import { isDefaultLocalNetwork } from './network.js';

const empty = value => !value || !value.trim();
const zeroGuid = '00000000000000000000000000000000';

export class AuthenticationService extends EventEmitter {
  #loginTail = Promise.resolve();
  constructor({ store, users, sessions, serverId, serverName = 'MediaManager', serverVersion = '13.0.0',
    enableLegacyAuthorization = false, isLocalNetwork = isDefaultLocalNetwork, now = () => new Date(),
    logger = { error() {} } } = {}) {
    super();
    if (!store || !users || !serverId) throw new TypeError('AuthenticationService requires store, users and serverId.');
    Object.assign(this, { store, users, sessions, serverId, serverName, serverVersion, enableLegacyAuthorization, isLocalNetwork, now, logger });
    users.authentication = this;
    if (sessions?.getDeviceCapabilities) users.getDeviceCapabilities = deviceId => sessions.getDeviceCapabilities(deviceId);
  }

  read(request) { return readAuthorization(request, { enableLegacyAuthorization: this.enableLegacyAuthorization }); }

  async authenticate(request) {
    const auth = this.read(request);
    Object.assign(auth, { User: null, UserId: zeroGuid, IsApiKey: false, IsAdministrator: false });
    if (!auth.Token) return auth;
    await this.store.transaction(async database => {
      const device = (await database.rows('Devices', { where: { AccessToken: auth.Token }, limit: 1 }))[0];
      if (device) {
        auth.IsAuthenticated = true;
        if (empty(auth.Client)) auth.Client = device.AppName;
        if (empty(auth.DeviceId)) auth.DeviceId = device.DeviceId;
        const canUpdate = !auth.Client.toLowerCase().includes('chromecast');
        const changes = {};
        if (empty(auth.Device)) auth.Device = device.DeviceName;
        else if (canUpdate && !equalsIgnoreCase(auth.Device, device.DeviceName)) changes.DeviceName = auth.Device;
        if (empty(auth.Version)) auth.Version = device.AppVersion;
        else if (canUpdate && !equalsIgnoreCase(auth.Version, device.AppVersion)) changes.AppVersion = auth.Version;
        if (this.now().getTime() - Date.parse(wireDate(device.DateLastActivity)) > 180000) changes.DateLastActivity = nativeDate(this.now());
        if (Object.keys(changes).length) await database.update('Devices', { Id: device.Id }, changes);
        auth.User = await this.users.loadUser(database, device.UserId);
        auth.UserId = auth.User ? wireGuid(auth.User.Id) : zeroGuid;
        auth.IsAdministrator = auth.User?.Policy.IsAdministrator ?? false;
      } else {
        const key = (await database.rows('ApiKeys', { where: { AccessToken: auth.Token }, limit: 1 }))[0];
        if (key) {
          Object.assign(auth, { IsAuthenticated: true, IsApiKey: true, IsAdministrator: true, Client: key.Name, Token: key.AccessToken });
          if (empty(auth.DeviceId)) auth.DeviceId = this.serverId;
          if (empty(auth.Device)) auth.Device = this.serverName;
          if (empty(auth.Version)) auth.Version = this.serverVersion;
        }
      }
    });
    if (!auth.IsAuthenticated) throw domainError(401, 'Invalid token.');
    if (auth.User?.Policy.IsDisabled) throw domainError(401, 'User account has been disabled.');
    return auth;
  }

  checkUserAccess(user, { remoteEndPoint, ignoreParentalControl = false } = {}) {
    if (!user) throw domainError(403, 'Forbidden');
    if (!this.isLocalNetwork(remoteEndPoint) && !user.Policy.EnableRemoteAccess) throw domainError(403, 'Forbidden');
    if (!user.Policy.IsAdministrator && !ignoreParentalControl && !scheduleAllowed(user, this.now())) throw domainError(403, 'Forbidden');
    return true;
  }

  authorize(auth, { policy = 'Default', remoteEndPoint, startupWizardCompleted = true, requiredPermission } = {}) {
    const firstTimeSetup = policy.startsWith('FirstTimeSetup');
    if (firstTimeSetup && !startupWizardCompleted) {
      if (auth?.IsAuthenticated && !auth.IsApiKey && auth.User) this.checkUserAccess(auth.User, { remoteEndPoint, ignoreParentalControl: true });
      return true;
    }
    if (!auth?.IsAuthenticated) throw domainError(401, '');
    if (policy === 'RequiresElevation') {
      if (!auth.IsAdministrator) throw domainError(403, '');
      return true;
    }
    // DefaultAuthorizationHandler also handles derived requirements: API keys
    // and administrators succeed there before SyncPlayAccessHandler is applied.
    if (policy.startsWith('SyncPlay') && !auth.IsApiKey && !auth.IsAdministrator) {
      const access = auth.User?.Policy.SyncPlayAccess;
      const active = this.syncPlay?.isUserActive(auth.UserId) ?? false;
      const canJoin = access === 'CreateAndJoinGroups' || access === 'JoinGroups';
      if (!auth.User || !canJoin && !active
        || policy === 'SyncPlayCreateGroup' && access !== 'CreateAndJoinGroups'
        || policy === 'SyncPlayJoinGroup' && !canJoin
        || policy === 'SyncPlayIsInGroup' && !active) throw domainError(403, '');
    }
    if (auth.IsApiKey) return true;
    this.checkUserAccess(auth.User, { remoteEndPoint, ignoreParentalControl: firstTimeSetup || policy.includes('IgnoreParentalControl') });
    if (policy === 'CollectionManagement' && !auth.IsAdministrator && !auth.User.Policy.EnableCollectionManagement) throw domainError(403, '');
    if (policy === 'FirstTimeSetupOrElevated' && !auth.IsAdministrator) throw domainError(403, '');
    if (requiredPermission && !auth.User.Permissions.some(permission => permission.Value && permission.Kind === requiredPermission)) throw domainError(403, '');
    return true;
  }

  async login(request, authorization, { remoteEndPoint } = {}) {
    const input = normalizeMembers(request, { Username: null, Pw: null });
    for (const field of ['Client', 'DeviceId', 'Device', 'Version']) if (typeof authorization[field] !== 'string' || !authorization[field]) throw domainError(400, `Value cannot be null or empty. (Parameter '${field}')`);
    const operation = this.#loginTail.then(async () => {
      const user = await this.users.authenticateUser(input.Username, input.Pw, { remoteEndPoint, isUserSession: true });
      return this.#createSession(user, authorization, { remoteEndPoint });
    });
    this.#loginTail = operation.catch(() => {});
    return operation;
  }

  async authenticateDirect(userId, authorization) {
    for (const field of ['Client', 'DeviceId', 'Device', 'Version']) {
      if (typeof authorization[field] !== 'string' || !authorization[field]) throw domainError(400, `${field} is required.`);
    }
    const operation = this.#loginTail.then(async () => {
      const id = nativeGuid(userId);
      const user = id === '00000000-0000-0000-0000-000000000000' ? null : await this.users.getUser(id);
      if (!user) throw domainError(400, 'Invalid username');
      return this.#createSession(user, authorization, {});
    });
    this.#loginTail = operation.catch(() => {});
    return operation;
  }

  async #createSession(user, authorization, { remoteEndPoint }) {
    if (!user) throw domainError(401, 'Invalid username or password entered.');
    if (!this.users.canAccessDevice(user, authorization.DeviceId)) throw domainError(403, 'User is not allowed access from this device.');
    const count = this.sessions?.countUserSessions(user.Id) ?? 0;
    if (user.MaxActiveSessions >= 1 && count >= user.MaxActiveSessions) throw domainError(403, 'User is at their maximum number of sessions.');
    const existing = await this.store.run(database => database.rows('Devices', {
      where: { UserId: user.Id, DeviceId: authorization.DeviceId },
      columns: ['Id', 'DeviceId', 'AccessToken'],
    }));
    for (const previous of existing) {
      try {
        await this.store.transaction(database => database.delete('Devices', { Id: previous.Id }));
        await this.sessions?.endByDevice(previous.DeviceId);
      } catch (error) {
        this.logger.error?.(error, 'Error while logging out existing session.');
      }
    }
    const date = nativeDate(this.now());
    const device = await this.store.transaction(database => database.insert('Devices', {
      UserId: user.Id, AppName: authorization.Client, AppVersion: authorization.Version,
      DeviceName: authorization.Device, DeviceId: authorization.DeviceId,
      AccessToken: randomUUID().replaceAll('-', ''), DateCreated: date, DateModified: date,
      DateLastActivity: date, IsActive: false,
    }));
    const auth = { ...authorization, Token: device.AccessToken, User: user, UserId: wireGuid(user.Id),
      IsAuthenticated: true, IsApiKey: false, IsAdministrator: user.Policy.IsAdministrator };
    if (!this.sessions) throw new Error('A SessionService is required for authentication.');
    const session = await this.sessions.logActivity(auth, { remoteEndPoint });
    const result = { User: this.users.getUserDto(user), SessionInfo: session, AccessToken: device.AccessToken, ServerId: this.serverId };
    this.emit('AuthenticationResult', result);
    return result;
  }

  async logout(token) {
    if (!token) throw domainError(400, 'Access token is required.');
    const device = await this.store.transaction(async database => {
      const device = (await database.rows('Devices', { where: { AccessToken: token }, limit: 1 }))[0];
      if (device) await database.delete('Devices', { Id: device.Id });
      return device;
    });
    if (device) await this.sessions?.endByDevice(device.DeviceId);
  }

  async revokeUserTokens(userId, exceptToken) {
    const normalizedUserId = nativeGuid(userId);
    const devices = (await this.store.run(database => database.rows('Devices', {
      where: { UserId: normalizedUserId }, columns: ['Id', 'DeviceId', 'AccessToken'],
    }))).filter(device => !equalsIgnoreCase(exceptToken, device.AccessToken));
    for (const device of devices) {
      await this.store.transaction(database => database.delete('Devices', { Id: device.Id }));
      await this.sessions?.endByDevice(device.DeviceId);
    }
  }

}
