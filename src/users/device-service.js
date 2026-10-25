import { nativeTextBytes, decodeNativeTextBytes, nativeTextOrdinalIgnoreCaseKey } from '../database/native-text.js';
import { domainError, wireDate, wireGuid } from './native.js';
const deviceTextFields = ['DeviceName', 'DeviceId', 'UserId', 'AppName', 'AppVersion',
  'DateLastActivity', 'LastUserName', 'CustomName'];
function decodeDeviceProjection(row) {
  if (!row) return row;
  return Object.fromEntries(Object.entries(row).map(([name, value]) => [name,
    deviceTextFields.includes(name) && value != null ? decodeNativeTextBytes(value) : value]));
}

const emptyGuid = '00000000000000000000000000000000';
const defaultCapabilities = () => ({
  PlayableMediaTypes: [],
  SupportedCommands: [],
  SupportsMediaControl: false,
  SupportsPersistentIdentifier: true
});

export class DeviceService {
  constructor({ store, users, sessions } = {}) {
    if (!store || !users || !sessions) throw new TypeError('DeviceService requires store, users and sessions.');
    Object.assign(this, { store, users, sessions });
  }

  async #dto(database, device, options, userCache) {
    let username = device.LastUserName;
    if (username === undefined) {
      let user = userCache.get(device.UserId);
      if (user === undefined) {
        user = await this.users.loadUser(database, device.UserId);
        userCache.set(device.UserId, user);
      }
      if (!user) throw domainError(404, `User with UserId ${device.UserId} not found`);
      username = user.Username;
    }
    return {
      Name: device.DeviceName,
      CustomName: options?.CustomName ?? null,
      Id: device.DeviceId,
      LastUserName: username,
      AppName: device.AppName,
      AppVersion: device.AppVersion,
      LastUserId: wireGuid(device.UserId),
      DateLastActivity: wireDate(device.DateLastActivity),
      Capabilities: defaultCapabilities(),
      IconUrl: this.sessions.getDeviceCapabilities(device.DeviceId).IconUrl
    };
  }

  async list(userId) {
    return this.store.run(async database => {
      let user = null;
      if (userId && userId !== emptyGuid) {
        user = await this.users.loadUser(database, userId);
        if (!user) throw domainError(404, 'User not found.');
      }
      const parameters = [];
      let predicate = '';
      if (user && !user.Policy.EnableAllDevices && !user.Policy.IsAdministrator) {
        const transientIds = this.sessions.getDeviceIdsWithoutPersistentIdentifier?.() ?? [];
        const allowedKeys = [...new Set([...user.Policy.EnabledDevices, ...transientIds]
          .map(nativeTextOrdinalIgnoreCaseKey))];
        if (allowedKeys.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
        parameters.push(allowedKeys);
        predicate = 'WHERE mm_ordinal_ignore_case_key(d."DeviceId") = ANY($1::bytea[])';
      }
      const rows = (await database.client.query(`SELECT d."DeviceName", d."DeviceId", d."UserId",
        d."AppName", d."AppVersion", d."DateLastActivity", u."Username" AS "LastUserName",
        device_option."CustomName", count(*) OVER () AS "__TotalRecordCount"
        FROM "Devices" d
        JOIN "Users" u ON u."Id" = d."UserId"
        LEFT JOIN LATERAL (
          SELECT o."CustomName" FROM "DeviceOptions" o
          WHERE o."DeviceId" = d."DeviceId" ORDER BY o."Id" ASC LIMIT 1
        ) device_option ON TRUE
        ${predicate}
        ORDER BY d."DateLastActivity" DESC, d."DeviceId" ASC, d."Id" ASC`, parameters)).rows;
      const items = [];
      for (const rawDevice of rows) {
        const device = decodeDeviceProjection(rawDevice);
        items.push(await this.#dto(database, device,
          device.CustomName == null ? null : { CustomName: device.CustomName }, new Map()));
      }
      const total = rows.length ? Number(rows[0].__TotalRecordCount) : 0;
      if (!Number.isSafeInteger(total) || total < 0) throw new Error('PostgreSQL returned an invalid device count.');
      return { Items: items, TotalRecordCount: total, StartIndex: 0 };
    });
  }

  async info(deviceId) {
    return this.store.run(async database => {
      const rawDevice = (await database.client.query(`SELECT d."DeviceName", d."DeviceId", d."UserId",
        d."AppName", d."AppVersion", d."DateLastActivity", u."Username" AS "LastUserName",
        device_option."CustomName"
        FROM "Devices" d
        JOIN "Users" u ON u."Id" = d."UserId"
        LEFT JOIN LATERAL (
          SELECT o."CustomName" FROM "DeviceOptions" o
          WHERE o."DeviceId" = d."DeviceId" ORDER BY o."Id" ASC LIMIT 1
        ) device_option ON TRUE
        WHERE d."DeviceId" = $1
        ORDER BY d."DateLastActivity" DESC, d."Id" ASC LIMIT 1`, [nativeTextBytes(deviceId)])).rows[0];
      const device = decodeDeviceProjection(rawDevice);
      if (!device) return null;
      return this.#dto(database, device,
        device.CustomName == null ? null : { CustomName: device.CustomName }, new Map());
    });
  }

  async options(deviceId) {
    return this.store.run(async database => {
      const option = (await database.rows('DeviceOptions', { where: { DeviceId: deviceId }, limit: 1 }))[0];
      return option ? { Id: option.Id, DeviceId: option.DeviceId, CustomName: option.CustomName } : null;
    });
  }

  async updateOptions(deviceId, customName) {
    await this.store.transaction(async database => {
      const current = (await database.rows('DeviceOptions', { where: { DeviceId: deviceId }, limit: 1 }))[0];
      if (current) await database.update('DeviceOptions', { Id: current.Id }, { CustomName: customName });
      else await database.insert('DeviceOptions', { DeviceId: deviceId, CustomName: customName });
    });
    this.sessions.updateDeviceOptions(deviceId, customName);
  }

  async delete(ids) {
    const unique = [...new Set(ids)];
    const deleted = await this.store.transaction(async database => {
      const rows = unique.length ? await database.rows('Devices', {
        whereIn: { DeviceId: unique }, columns: ['DeviceId'],
      }) : [];
      if (ids.some(id => !rows.some(device => device.DeviceId === id))) return false;
      if (unique.length) await database.deleteWhere('Devices', {}, { whereIn: { DeviceId: unique } });
      return true;
    });
    if (!deleted) return false;
    for (const id of unique) await this.sessions.endByDevice(id);
    return true;
  }
}
