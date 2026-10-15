import { nativeTextBytes, decodeNativeTextBytes, nativeTextOrdinalIgnoreCaseKey } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { authenticatePassword, createPasswordHash } from '../core/password.js';
import { md5Guid } from '../core/identity.js';
import { tableDefinition } from '../database/model.js';
import { AUTHENTICATION_PROVIDER, PASSWORD_RESET_PROVIDER, permissionNames, preferenceNames, configurationFields,
  configurationPreferences, policyPreferences, guidPreferences, subtitleModes, syncPlayModes, days, unratedItems,
  domainError, upperInvariant, nativeGuid, wireGuid, nativeDate, wireDate, enumValue, enumName, equalsIgnoreCase,
  defaultPermissions, defaultConfiguration, defaultPolicy, normalizeMembers, validateUsername, matchesUsernamePattern, scheduleAllowed } from './native.js';
import { isDefaultLocalNetwork } from './network.js';
import { clrTrim } from '../metadata/whitespace.js';

async function candidateUserIds(database, {
  isHidden,
  isDisabled,
  publicOnly,
  authorizedDeviceId = null,
  requireRemoteAccess = false,
}) {
  const parameters = [];
  const permission = (name, expected) => {
    parameters.push(permissionNames.indexOf(name));
    const exists = `EXISTS (SELECT 1 FROM "Permissions" p WHERE p."UserId" = u."Id" AND p."Kind" = $${parameters.length} AND p."Value" = TRUE)`;
    return expected ? exists : `NOT ${exists}`;
  };
  const predicates = [];
  if (publicOnly) {
    predicates.push(permission('IsHidden', false), permission('IsDisabled', false));
  } else {
    if (typeof isHidden === 'boolean') predicates.push(permission('IsHidden', isHidden));
    if (typeof isDisabled === 'boolean') predicates.push(permission('IsDisabled', isDisabled));
  }
  if (requireRemoteAccess) predicates.push(permission('EnableRemoteAccess', true));
  if (authorizedDeviceId !== null) {
    parameters.push(preferenceNames.indexOf('EnabledDevices'));
    const preferenceKind = `$${parameters.length}`;
    parameters.push(nativeTextOrdinalIgnoreCaseKey(authorizedDeviceId));
    const deviceKey = `$${parameters.length}`;
    predicates.push(`(${permission('IsAdministrator', true)} OR ${permission('EnableAllDevices', true)} OR EXISTS (
      SELECT 1 FROM "Preferences" device_preference
      CROSS JOIN LATERAL unnest(string_to_array(COALESCE(${nativeTextSql(database.schemaName).projection('device_preference."Value"')}, ''), ',')) enabled("DeviceId")
      WHERE device_preference."UserId" = u."Id" AND device_preference."Kind" = ${preferenceKind}
        AND ${nativeTextSql(database.schemaName).ordinalIgnoreCaseKey(nativeTextSql(database.schemaName).fromProjection('enabled."DeviceId"'))} = ${deviceKey}
    ))`);
  }
  const result = await database.client.query(`SELECT u."Id" FROM "Users" u${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''}
    ORDER BY u."Username", u."Id"`, parameters);
  return result.rows.map(row => decodeNativeTextBytes(row.Id));
}

async function creationState(database, normalizedUsername) {
  const result = await database.client.query(`SELECT
    EXISTS (SELECT 1 FROM "Users" WHERE "NormalizedUsername" = $1) AS duplicate,
    COALESCE(MAX("InternalId"), 0::bigint) AS maximum
    FROM "Users"`, [nativeTextBytes(normalizedUsername)]);
  return { duplicate: result.rows[0].duplicate, maximum: result.rows[0].maximum };
}

async function insertUser(database, name, permissions = defaultPermissions()) {
  const state = await creationState(database, upperInvariant(name));
  if (state.duplicate) throw domainError(400, `A user with the name '${name}' already exists.`);
  const row = Object.fromEntries(tableDefinition('Users').columns.map(column => [column.name,
    column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'INTEGER' ? 0 : '']));
  Object.assign(row, { Id: nativeGuid(randomUUID()), Username: name, NormalizedUsername: upperInvariant(name),
    Password: null, AuthenticationProviderId: AUTHENTICATION_PROVIDER, PasswordResetProviderId: PASSWORD_RESET_PROVIDER,
    InternalId: state.maximum + 1n,
    EnableUserPreferenceAccess: true, HidePlayedInLatest: true, RememberAudioSelections: true,
    RememberSubtitleSelections: true, EnableNextEpisodeAutoPlay: true, PlayDefaultAudioTrack: true, RowVersion: 0n });
  await database.insert('Users', row);
  await database.insertBatch('Permissions', Object.entries(permissions).map(([name, Value]) => ({
    UserId: row.Id, Kind: permissionNames.indexOf(name), Value, RowVersion: 0n,
  })));
  await database.insertBatch('Preferences', preferenceNames.map((_name, Kind) => ({
    UserId: row.Id, Kind, Value: '', RowVersion: 0n,
  })));
  return row.Id;
}

async function enabledUserSample(database) {
  const disabledKind = permissionNames.indexOf('IsDisabled');
  return (await database.client.query(`SELECT u."Id" FROM "Users" u
    WHERE NOT EXISTS (SELECT 1 FROM "Permissions" p
      WHERE p."UserId" = u."Id" AND p."Kind" = $1 AND p."Value" = TRUE)
    LIMIT 2`, [disabledKind])).rows;
}

export function userImageTag(image) {
  const match = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d{1,7}))?Z?$/.exec(image.LastModified);
  if (!match || Number(match[1]) < 1) throw new TypeError('Invalid stored user image date.');
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const milliseconds = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  const parsed = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() + 1 !== Number(month)
    || parsed.getUTCDate() !== Number(day) || parsed.getUTCHours() !== Number(hour)
    || parsed.getUTCMinutes() !== Number(minute) || parsed.getUTCSeconds() !== Number(second)) {
    throw new TypeError('Invalid stored user image date.');
  }
  const ticks = (BigInt(milliseconds) + 62135596800000n) * 10000n + BigInt(fraction.padEnd(7, '0'));
  return md5Guid(image.Path + ticks);
}

export class UserService extends EventEmitter {
  constructor({ store, serverId, castReceiverApplications = [], isLocalNetwork = isDefaultLocalNetwork,
    now = () => new Date(), getDeviceCapabilities = () => ({ SupportsPersistentIdentifier: true }), getImageTag } = {}) {
    super();
    if (!store || !serverId) throw new TypeError('UserService requires a store and serverId.');
    Object.assign(this, { store, serverId, castReceiverApplications, isLocalNetwork, now, getDeviceCapabilities, getImageTag });
  }

  async loadUser(database, id) {
    const normalized = nativeGuid(id);
    if (normalized === '00000000-0000-0000-0000-000000000000') throw domainError(400, "Guid can't be empty");
    return (await this.loadUsers(database, [normalized]))[0] ?? null;
  }

  async loadUsers(database, ids) {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const users = await database.rows('Users', uniqueIds.length === 1
      ? { where: { Id: uniqueIds[0] }, limit: 1 }
      : { whereIn: { Id: uniqueIds } });
    if (users.length === 0) return [];
    const foundIds = users.map(user => user.Id);
    const relationOptions = () => foundIds.length === 1
      ? { where: { UserId: foundIds[0] } }
      : { whereIn: { UserId: foundIds } };
    const permissions = await database.rows('Permissions', relationOptions());
    const preferences = await database.rows('Preferences', relationOptions());
    const schedules = await database.rows('AccessSchedules', relationOptions());
    const images = await database.rows('ImageInfos', relationOptions());
    const group = rows => {
      const result = new Map();
      for (const row of rows) {
        const values = result.get(row.UserId);
        if (values) values.push(row);
        else result.set(row.UserId, [row]);
      }
      return result;
    };
    const permissionRows = group(permissions);
    const preferenceRows = group(preferences);
    const scheduleRows = group(schedules);
    const imageRows = group(images);
    const byId = new Map(users.map(user => {
      for (const field of ['Username', 'AuthenticationProviderId', 'PasswordResetProviderId']) {
        if (user[field] == null || user[field] === '') throw domainError(400, `${field} cannot be empty.`);
      }
      user.Permissions = permissionRows.get(user.Id) ?? [];
      user.Preferences = preferenceRows.get(user.Id) ?? [];
      user.AccessSchedules = scheduleRows.get(user.Id) ?? [];
      user.ProfileImage = imageRows.get(user.Id)?.[0] ?? null;
      user.Policy = this.getPolicy(user);
      user.Configuration = this.getConfiguration(user);
      return [user.Id, user];
    }));
    return uniqueIds.flatMap(id => byId.has(id) ? [byId.get(id)] : []);
  }

  getUser(id) { return this.store.run(database => this.loadUser(database, id)); }

  getUserByName(name) {
    if (typeof name !== 'string' || clrTrim(name) === '') throw domainError(400, 'Invalid username');
    return this.store.run(async database => {
      const row = (await database.rows('Users', { where: { NormalizedUsername: upperInvariant(name) }, columns: ['Id'], limit: 1 }))[0];
      return row ? this.loadUser(database, row.Id) : null;
    });
  }

  async saveUserSnapshot(source) {
    const columns = tableDefinition('Users').columns.map(column => column.name);
    if (!source || columns.some(name => !Object.hasOwn(source, name)) || !['Permissions', 'Preferences', 'AccessSchedules'].every(name => Array.isArray(source[name]))
      || source.ProfileImage === undefined) throw new TypeError('Saving a user requires a complete repository snapshot.');
    await this.store.transaction(async database => {
      const current = await this.loadUser(database, source.Id);
      if (!current) throw domainError(404, 'User not found');
      const changes = Object.fromEntries(columns.filter(name => name !== 'Id' && !isDeepStrictEqual(source[name], current[name])).map(name => [name, source[name]]));
      if (Object.keys(changes).length) {
        changes.RowVersion = (BigInt(source.RowVersion) + 1n) & 4294967295n;
        if (await database.update('Users', { Id: current.Id, RowVersion: current.RowVersion }, changes) === 0n) throw new Error('Concurrency conflict');
      }
      for (const table of ['Permissions', 'Preferences']) {
        const incoming = new Map(source[table].map(row => [row.Kind, row.Value]));
        for (const row of current[table]) {
          if (!incoming.has(row.Kind)) await database.delete(table, { Id: row.Id });
          else {
            const value = incoming.get(row.Kind); incoming.delete(row.Kind);
            if (!isDeepStrictEqual(value, row.Value)) await database.update(table, { Id: row.Id }, { Value: value }, { rowVersion: row.RowVersion });
          }
        }
        for (const [Kind, Value] of incoming) await database.insert(table, { UserId: current.Id, Kind, Value, RowVersion: 0n });
      }
      await database.deleteWhere('AccessSchedules', { UserId: current.Id });
      for (const row of source.AccessSchedules) await database.insert('AccessSchedules', {
        UserId: current.Id, DayOfWeek: row.DayOfWeek, StartHour: row.StartHour, EndHour: row.EndHour
      });
      if (source.ProfileImage == null) {
        if (current.ProfileImage) await database.delete('ImageInfos', { Id: current.ProfileImage.Id });
      } else if (!current.ProfileImage) await database.insert('ImageInfos', {
        UserId: current.Id, Path: source.ProfileImage.Path, LastModified: source.ProfileImage.LastModified
      });
      else {
        const imageChanges = Object.fromEntries(['Path', 'LastModified'].filter(name => source.ProfileImage[name] !== current.ProfileImage[name]).map(name => [name, source.ProfileImage[name]]));
        if (Object.keys(imageChanges).length) await database.update('ImageInfos', { Id: current.ProfileImage.Id }, imageChanges);
      }
    });
  }

  getPreference(user, name) {
    const value = user.Preferences.find(preference => preference.Kind === preferenceNames.indexOf(name))?.Value;
    if (!value) return [];
    const entries = value.split(',');
    if (guidPreferences.has(name)) return entries.flatMap(entry => {
      try { return [wireGuid(entry.trim())]; } catch { return []; }
    });
    if (name === 'BlockUnratedItems') return entries.flatMap(entry => {
      try { return [enumName(enumValue(/^[+-]?\d+$/.test(entry.trim()) ? Number(entry.trim()) : entry.trim(), unratedItems), unratedItems)]; }
      catch { return []; }
    });
    return entries;
  }

  getPolicy(user) {
    const policy = defaultPolicy();
    for (const name of permissionNames) policy[name] = user.Permissions.find(row => row.Kind === permissionNames.indexOf(name))?.Value ?? false;
    // The pinned UserManager does not project the persisted lyric permission.
    policy.EnableLyricManagement = false;
    Object.assign(policy, { MaxParentalRating: user.MaxParentalRatingScore, MaxParentalSubRating: user.MaxParentalRatingSubScore,
      EnableUserPreferenceAccess: user.EnableUserPreferenceAccess, RemoteClientBitrateLimit: user.RemoteClientBitrateLimit ?? 0,
      AuthenticationProviderId: user.AuthenticationProviderId, PasswordResetProviderId: user.PasswordResetProviderId,
      InvalidLoginAttemptCount: user.InvalidLoginAttemptCount, LoginAttemptsBeforeLockout: user.LoginAttemptsBeforeLockout ?? -1,
      MaxActiveSessions: user.MaxActiveSessions, SyncPlayAccess: enumName(user.SyncPlayAccess, syncPlayModes),
      AccessSchedules: user.AccessSchedules.map(row => ({ Id: row.Id, UserId: wireGuid(row.UserId),
        DayOfWeek: enumName(row.DayOfWeek, days), StartHour: row.StartHour, EndHour: row.EndHour })) });
    for (const name of [...policyPreferences, 'BlockedChannels', 'BlockedMediaFolders']) policy[name] = this.getPreference(user, name);
    return policy;
  }

  getConfiguration(user) {
    const configuration = Object.fromEntries(configurationFields.map(name => [name, user[name]]));
    configuration.SubtitleMode = enumName(user.SubtitleMode, subtitleModes);
    configuration.SubtitleLanguagePreference ??= '';
    for (const [name, preference] of Object.entries(configurationPreferences)) configuration[name] = this.getPreference(user, preference);
    configuration.CastReceiverId = this.castReceiverApplications.find(app => app.Id === user.CastReceiverId)?.Id
      ?? this.castReceiverApplications[0]?.Id ?? null;
    return configuration;
  }

  getUserDto(user) {
    if (!user) throw domainError(404, 'User not found');
    return { Name: user.Username, ServerId: this.serverId, Id: wireGuid(user.Id), PrimaryImageTag: this.primaryImageTag(user), HasPassword: true, HasConfiguredPassword: true, HasConfiguredEasyPassword: false,
    EnableAutoLogin: user.EnableAutoLogin, LastLoginDate: wireDate(user.LastLoginDate), LastActivityDate: wireDate(user.LastActivityDate),
    Configuration: user.Configuration, Policy: user.Policy };
  }

  primaryImageTag(user) {
    if (!user?.ProfileImage) return null;
    return this.getImageTag ? this.getImageTag(user) : userImageTag(user.ProfileImage);
  }

  canAccessDevice(user, deviceId) {
    return user.Policy.EnableAllDevices || user.Policy.IsAdministrator
      || user.Policy.EnabledDevices.some(id => equalsIgnoreCase(id, deviceId))
      || !this.getDeviceCapabilities(deviceId).SupportsPersistentIdentifier;
  }

  async listUsers({ isHidden, isDisabled, publicOnly = false, deviceId, remoteEndPoint,
    startupWizardCompleted = true } = {}) {
    return this.store.run(async database => {
      const enforcePublicAccess = publicOnly && startupWizardCompleted;
      const authorizedDeviceId = enforcePublicAccess && deviceId
        && this.getDeviceCapabilities(deviceId).SupportsPersistentIdentifier ? deviceId : null;
      const requireRemoteAccess = enforcePublicAccess && !this.isLocalNetwork(remoteEndPoint);
      const ids = await candidateUserIds(database, {
        isHidden,
        isDisabled,
        publicOnly,
        authorizedDeviceId,
        requireRemoteAccess,
      });
      const result = [];
      const candidates = await this.loadUsers(database, ids);
      for (const user of candidates) {
        if (!user) continue;
        if (publicOnly ? user.Policy.IsHidden || user.Policy.IsDisabled
          : ((isHidden !== undefined && isHidden !== null && user.Policy.IsHidden !== isHidden)
            || (isDisabled !== undefined && isDisabled !== null && user.Policy.IsDisabled !== isDisabled))) continue;
        if (publicOnly && startupWizardCompleted && ((deviceId && !this.canAccessDevice(user, deviceId))
            || (!this.isLocalNetwork(remoteEndPoint) && !user.Policy.EnableRemoteAccess))) continue;
        result.push(user);
      }
      result.sort((left, right) => left.Username.localeCompare(right.Username, 'en-US'));
      return result.map(user => this.getUserDto(user));
    });
  }

  async createUser(request) {
    const { Name, Password } = normalizeMembers(request, { Name: null, Password: null });
    validateUsername(Name);
    const user = await this.store.transaction(async database => {
      return this.loadUser(database, await insertUser(database, Name));
    });
    this.emit('UserCreated', user);
    if (Password !== null) {
      await this.changePassword(user.Id, Password);
      return this.getUserDto(await this.getUser(user.Id));
    }
    return this.getUserDto(user);
  }

  async initialize() {
    await this.store.transaction(async database => {
      if ((await database.rows('Users', { columns: ['Id'], limit: 1 })).length) return;
      const currentName = userInfo().username;
      const name = matchesUsernamePattern(currentName) ? currentName : 'MyJellyfinUser';
      await insertUser(database, name, { ...defaultPermissions(), IsAdministrator: true,
        EnableContentDeletion: true, EnableRemoteControlOfOtherUsers: true });
    });
  }

  getFirstUser() {
    return this.store.run(async database => {
      const { rows } = await database.relationRowsInInsertionOrder('Users', { limit: 1 });
      return rows[0] ? this.loadUser(database, rows[0].Id) : null;
    });
  }

  async renameUser(id, oldName, name) {
    validateUsername(name);
    if (oldName === name) throw domainError(400, 'The new and old names must be different.');
    const user = await this.store.transaction(async database => {
      const normalized = nativeGuid(id);
      if ((await database.rows('Users', { where: { NormalizedUsername: upperInvariant(name) }, columns: ['Id'], limit: 2 }))
        .some(row => row.Id !== normalized)) throw domainError(400, `A user with the name '${name}' already exists.`);
      const current = await this.loadUser(database, normalized);
      if (!current) throw domainError(404, 'User not found');
      await database.update('Users', { Id: current.Id }, { Username: name, NormalizedUsername: upperInvariant(name) }, { rowVersion: current.RowVersion });
      return this.loadUser(database, current.Id);
    });
    this.emit('UserUpdated', user);
  }

  async setPermission(database, user, name, value) {
    if (typeof value !== 'boolean') throw domainError(400, `${name} must be a boolean.`);
    const Kind = permissionNames.indexOf(name);
    const row = user.Permissions.find(row => row.Kind === Kind);
    if (row) { if (row.Value !== value) await database.update('Permissions', { Id: row.Id }, { Value: value }, { rowVersion: row.RowVersion }); }
    else await database.insert('Permissions', { UserId: user.Id, Kind, Value: value, RowVersion: 0n });
  }

  async setPreference(database, user, name, values) {
    if (!Array.isArray(values)) throw domainError(400, `${name} must be an array.`);
    const Kind = preferenceNames.indexOf(name);
    const Value = values.map(value => guidPreferences.has(name) ? nativeGuid(value)
      : name === 'BlockUnratedItems' ? enumName(enumValue(value, unratedItems), unratedItems) : String(value ?? '')).join(',');
    const row = user.Preferences.find(row => row.Kind === Kind);
    if (row) { if (row.Value !== Value) await database.update('Preferences', { Id: row.Id }, { Value }, { rowVersion: row.RowVersion }); }
    else await database.insert('Preferences', { UserId: user.Id, Kind, Value, RowVersion: 0n });
  }

  async updateConfiguration(id, request) {
    const configuration = normalizeMembers(request, defaultConfiguration());
    return this.store.transaction(async database => {
      const user = await this.loadUser(database, id);
      if (!user) throw domainError(404, 'User not found');
      const values = Object.fromEntries(configurationFields.map(name => [name, configuration[name]]));
      values.SubtitleMode = enumValue(configuration.SubtitleMode, subtitleModes);
      if (configuration.CastReceiverId && this.castReceiverApplications.some(app => app.Id === configuration.CastReceiverId)) values.CastReceiverId = configuration.CastReceiverId;
      await database.update('Users', { Id: user.Id }, values, { rowVersion: user.RowVersion });
      for (const [name, preference] of Object.entries(configurationPreferences)) await this.setPreference(database, user, preference, configuration[name]);
    });
  }

  async updateUser(id, request) {
    const dto = normalizeMembers(request, { Name: null, Configuration: defaultConfiguration() });
    validateUsername(dto.Name);
    await this.store.transaction(async database => {
      const user = await this.loadUser(database, id);
      if (!user) throw domainError(404, 'User not found');
      if (dto.Name === user.Username) return;
      if ((await database.rows('Users', {
        where: { NormalizedUsername: upperInvariant(dto.Name) }, columns: ['Id'], limit: 2
      })).some(row => row.Id !== user.Id)) throw domainError(400, `A user with the name '${dto.Name}' already exists.`);
      await database.update('Users', { Id: user.Id }, { Username: dto.Name, NormalizedUsername: upperInvariant(dto.Name) }, { rowVersion: user.RowVersion });
    });
    await this.updateConfiguration(id, dto.Configuration);
    this.emit('UserUpdated', await this.getUser(id));
  }

  async updatePolicy(id, request, { currentToken = null } = {}) {
    const policy = normalizeMembers(request, defaultPolicy());
    for (const key of ['AuthenticationProviderId', 'PasswordResetProviderId']) if (typeof policy[key] !== 'string' || !policy[key].trim()) throw domainError(400, `The ${key} field is required.`);
    const result = await this.store.transaction(async database => {
      const user = await this.loadUser(database, id);
      if (!user) throw domainError(404, 'User not found');
      const administrators = await database.rows('Permissions', {
        where: { Kind: permissionNames.indexOf('IsAdministrator'), Value: true }, columns: ['Id'], limit: 2
      });
      if (!policy.IsAdministrator && user.Policy.IsAdministrator && administrators.length === 1) throw domainError(403, 'There must be at least one user in the system with administrative access.');
      if (policy.IsDisabled && user.Policy.IsAdministrator) throw domainError(403, 'Administrators cannot be disabled.');
      if (policy.IsDisabled && !user.Policy.IsDisabled && (await enabledUserSample(database)).length === 1) throw domainError(403, 'There must be at least one enabled user in the system.');
      const values = { MaxParentalRatingScore: policy.MaxParentalRating, MaxParentalRatingSubScore: policy.MaxParentalSubRating,
        EnableUserPreferenceAccess: policy.EnableUserPreferenceAccess, RemoteClientBitrateLimit: policy.RemoteClientBitrateLimit,
        AuthenticationProviderId: policy.AuthenticationProviderId, PasswordResetProviderId: policy.PasswordResetProviderId,
        InvalidLoginAttemptCount: policy.InvalidLoginAttemptCount, LoginAttemptsBeforeLockout: policy.LoginAttemptsBeforeLockout === -1 ? null
          : policy.LoginAttemptsBeforeLockout === 0 ? 3 : policy.LoginAttemptsBeforeLockout,
        MaxActiveSessions: policy.MaxActiveSessions, SyncPlayAccess: enumValue(policy.SyncPlayAccess, syncPlayModes) };
      await database.update('Users', { Id: user.Id }, values, { rowVersion: user.RowVersion });
      for (const name of permissionNames) await this.setPermission(database, user, name, policy[name]);
      if (!Array.isArray(policy.AccessSchedules)) throw domainError(400, 'AccessSchedules must be an array.');
      const accessSchedules = [];
      for (const entry of policy.AccessSchedules) {
        const schedule = normalizeMembers(entry, { DayOfWeek: 'Sunday', StartHour: 0, EndHour: 0 });
        accessSchedules.push({ UserId: user.Id, DayOfWeek: enumValue(schedule.DayOfWeek, days),
          StartHour: schedule.StartHour, EndHour: schedule.EndHour });
      }
      await database.deleteWhere('AccessSchedules', { UserId: user.Id });
      await database.insertBatch('AccessSchedules', accessSchedules);
      for (const name of policyPreferences) await this.setPreference(database, user, name, policy[name] ?? (name === 'BlockUnratedItems' ? [] : null));
      return { user: await this.loadUser(database, id), revoke: policy.IsDisabled && !user.Policy.IsDisabled };
    });
    if (result.revoke) await this.authentication?.revokeUserTokens(id, currentToken);
    this.emit('UserUpdated', result.user);
  }

  async changePassword(id, password) {
    if (typeof password !== 'string') throw domainError(400, 'Password must be a string.');
    const user = await this.store.transaction(async database => {
      const user = await this.loadUser(database, id);
      if (!user) throw domainError(404, 'User not found');
      if (user.Policy.IsAdministrator && clrTrim(password) === '') throw domainError(400, 'Admin user passwords must not be empty');
      if (!user.AuthenticationProviderId || equalsIgnoreCase(user.AuthenticationProviderId, AUTHENTICATION_PROVIDER)) {
        const hash = password ? await createPasswordHash(password) : null;
        if (hash !== user.Password) await database.update('Users', { Id: user.Id }, { Password: hash }, { rowVersion: user.RowVersion });
      }
      return this.loadUser(database, id);
    });
    this.emit('UserPasswordChanged', user);
  }

  async deleteUser(id) {
    const user = await this.store.transaction(async database => {
      const user = await this.loadUser(database, id);
      if (!user) throw domainError(404, 'User not found');
      if ((await database.rows('Users', { columns: ['Id'], limit: 2 })).length === 1) throw domainError(500, `The user '${user.Username}' cannot be deleted because there must be at least one user in the system.`);
      if (user.Policy.IsAdministrator && (await database.rows('Permissions', {
        where: { Kind: permissionNames.indexOf('IsAdministrator'), Value: true }, columns: ['Id'], limit: 2
      })).length === 1) throw domainError(400, `The user '${user.Username}' cannot be deleted because there must be at least one admin user in the system.`);
      await database.delete('Users', { Id: user.Id });
      return user;
    });
    this.emit('UserDeleted', user);
  }

  async authenticateUser(username, password, { remoteEndPoint, isUserSession = true } = {}) {
    if (typeof username !== 'string' || !username.trim()) throw domainError(400, 'Value cannot be null. (Parameter \'username\')');
    const result = await this.store.transaction(async database => {
      const row = (await database.rows('Users', { where: { NormalizedUsername: upperInvariant(username) }, limit: 1 }))[0];
      if (!row) return { error: domainError(401, 'Invalid username or password entered.') };
      const user = await this.loadUser(database, row.Id);
      let success = false;
      if (equalsIgnoreCase(user.AuthenticationProviderId, AUTHENTICATION_PROVIDER)) {
        try { await authenticatePassword(username, password, user); success = true; }
        catch (error) { if (error.message !== 'Invalid username or password') throw error; }
      }
      if (user.Policy.IsDisabled) return { error: domainError(403, `The ${user.Username} account is currently disabled. Please consult with your administrator.`) };
      if (!user.Policy.EnableRemoteAccess && !this.isLocalNetwork(remoteEndPoint)) return { error: domainError(403, 'Forbidden.') };
      if (!scheduleAllowed(user, this.now())) return { error: domainError(403, 'User is not allowed access at this time.') };
      if (success) {
        const values = { InvalidLoginAttemptCount: 0 };
        if (isUserSession) values.LastActivityDate = values.LastLoginDate = nativeDate(this.now());
        // The pinned manager reloads its detached entity after provider authentication,
        // discarding a legacy password upgrade. Only ChangePassword persists a new hash.
        await database.update('Users', { Id: user.Id }, values);
        const authenticated = await this.loadUser(database, user.Id);
        authenticated.InvalidLoginAttemptCount = user.InvalidLoginAttemptCount;
        authenticated.Policy.InvalidLoginAttemptCount = user.InvalidLoginAttemptCount;
        return { user: authenticated };
      }
      const attempts = user.InvalidLoginAttemptCount + 1;
      const locked = user.LoginAttemptsBeforeLockout !== null && attempts >= user.LoginAttemptsBeforeLockout;
      // The pinned lockout branch saves the increment, then performs a second SQL increment.
      await database.update('Users', { Id: user.Id }, { InvalidLoginAttemptCount: attempts + Number(locked) }, locked ? { rowVersion: user.RowVersion } : {});
      if (locked) {
        for (const permission of user.Permissions) await database.update('Permissions', { Id: permission.Id },
          { Value: permission.Kind === 2 ? true : permission.Value }, { rowVersion: permission.RowVersion });
        if (!user.Permissions.some(permission => permission.Kind === 2)) await this.setPermission(database, user, 'IsDisabled', true);
        for (const preference of user.Preferences) await database.update('Preferences', { Id: preference.Id }, {}, { rowVersion: preference.RowVersion });
      }
      return { user: null, locked: locked ? await this.loadUser(database, user.Id) : null };
    });
    if (result.error) throw result.error;
    if (result.locked) this.emit('UserLockedOut', result.locked);
    return result.user;
  }
}
