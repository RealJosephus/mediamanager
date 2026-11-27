// Jellyfin.LiveTv/Listings/SchedulesDirect.cs, GPL-2.0-only.
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getSchedulePrograms } from './programs.js';

const api = 'https://json.schedulesdirect.org/20141201';
const day = 86400000;
const safeName = value => value.replace(/[^A-Za-z0-9]/g, '_');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const authError = () => Object.assign(new Error('Could not authenticate with Schedules Direct'), { status: 401 });
function required(value, name) {
  if (value == null || value === '') throw Object.assign(new Error("Value cannot be null or empty. (Parameter '" + name + "')"), { status: 400 });
  return value;
}

export function createSchedulesDirectProvider(options = {}) {
  const { fetch: fetchImpl = globalThis.fetch, now = Date.now, fileSystem, imagePolicy, userAgent = 'MediaManager' } = options;
  const tokens = new Map(), statusCache = new Map(), retryTimes = new Map();
  let offlineUntil = 0, loginAfter = 0, metadataUntil = 0, tokenGeneration = imagePolicy?.tokenGeneration;
  async function applyCode(code) {
    if ([4001, 4002, 4003, 4005, 4007, 4008, 4010].includes(code)) loginAfter = Infinity;
    else if (code === 3000) offlineUntil = now() + 3600000;
    else if ([3001, 4004].includes(code)) loginAfter = now() + 1800000;
    else if (code === 4009) loginAfter = now() + day;
    if ([4009, 4010].includes(code)) {
      metadataUntil = (Math.floor(now() / day) + 1) * day;
      await imagePolicy?.markMetadataLimit?.();
    }
    if ([4009, 4010, 5002, 5003, 5004].includes(code)) await imagePolicy?.markImageLimit?.();
    if (loginAfter > now() || offlineUntil > now()) tokens.clear();
  }
  async function request(info, route, { method = 'GET', body, signal, retry = true } = {}) {
    const token = route === '/token' ? null : await getToken(info, signal);
    if (!token && route !== '/token' && route !== '/status') throw authError();
    const response = await fetchImpl(api + route, {
      method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(100000)]) : AbortSignal.timeout(100000),
      headers: { 'User-Agent': userAgent, ...(token ? { token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = await response.text();
    let value;
    try { value = bytes ? JSON.parse(bytes) : null; }
    catch (error) { if (response.ok) throw error; }
    const code = value?.code;
    if (response.ok && (!code || route === '/schedules')) return value;
    await applyCode(code);
    if (route !== '/token' && retry && response.status < 500 && ([1004, 1010, 4006].includes(code) || response.status === 403 && code == null)) {
      tokens.clear();
      return request(info, route, { method, body, signal, retry: false });
    }
    throw Object.assign(new Error('Schedules Direct request failed (' + response.status + ')'), { httpStatus: response.status, sdCode: code });
  }
  async function getToken(info, signal) {
    if (tokenGeneration !== imagePolicy?.tokenGeneration) { tokens.clear(); tokenGeneration = imagePolicy?.tokenGeneration; }
    if (!info?.Username?.trim() || !info.Password || now() < Math.max(loginAfter, offlineUntil)) return null;
    let entry = tokens.get(info.Username);
    if (!entry || entry.expires <= now()) {
      const password = createHash('sha1').update(info.Password.replace(/[^\x00-\x7f]/gu, '?'), 'ascii').digest('hex');
      const pending = request(null, '/token', { method: 'POST', body: { username: info.Username, password }, signal })
        .then(result => { if (result?.message !== 'OK' || !result.token) throw authError(); return result.token; });
      entry = { pending, expires: now() + 20 * 3600000 };
      tokens.set(info.Username, entry);
      try { return await pending; }
      catch (error) {
        if (tokens.get(info.Username) === entry) tokens.delete(info.Username);
        if (error.httpStatus >= 400 && error.httpStatus < 500 && loginAfter <= now()) loginAfter = now() + 1800000;
        throw error;
      }
    }
    return entry.pending;
  }
  async function online(info, signal) {
    const account = info?.Username;
    let entry = statusCache.get(account);
    if (offlineUntil <= now() && (!entry || entry.expires <= now())) {
      const pending = request(info, '/status', { signal }).catch(() => {
        if (signal?.aborted) {
          if (statusCache.get(account) === entry) statusCache.delete(account);
          signal.throwIfAborted();
        }
        return null;
      });
      statusCache.set(account, entry = { pending, signal, expires: now() + 600000 });
    }
    let status;
    try { status = await entry?.pending; }
    catch (error) {
      signal?.throwIfAborted();
      // A concurrent caller can be waiting on the canceled owner's check.
      if (entry.signal?.aborted) return online(info, signal);
      throw error;
    }
    signal?.throwIfAborted();
    if (status?.systemStatus?.some(value => equal(value.status, 'Offline')) && offlineUntil <= now()) offlineUntil = now() + 3600000;
    if (offlineUntil > now()) throw new Error('Schedules Direct reports that the service is offline.');
    return status;
  }
  const cacheDirectory = (kind, id) => path.join(options.cachePath, 'schedulesdirect', kind, safeName(id));
  const cacheName = (kind, id, key) => path.join(cacheDirectory(kind, id), safeName(key) + '.json');
  const readCache = async file => {
    if (!fileSystem) return null;
    try { return JSON.parse(await fileSystem.readFile(file, 'utf8')); }
    catch { return null; }
  };
  const writeCache = async (file, value) => {
    if (!fileSystem) return;
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await fileSystem.mkdir(path.dirname(file), { recursive: true });
      await fileSystem.writeFile(temporary, JSON.stringify(value));
      await fileSystem.rename(temporary, file);
    } catch { await fileSystem.unlink(temporary).catch(() => {}); }
  };
  async function pruneScheduleCache(station, dates) {
    if (!fileSystem) return;
    const directory = cacheDirectory('schedules', station);
    const keep = new Set(dates.map(date => safeName(date) + '.json'));
    try {
      for (const entry of await fileSystem.readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json') && !keep.has(entry.name)) {
          await fileSystem.unlink(path.join(directory, entry.name));
        }
      }
    } catch { /* As with cache writes, a filesystem error must not discard a covered guide. */ }
  }
  async function authorized(info, signal) {
    const token = await getToken(info, signal);
    if (!token) throw authError();
    const status = await online(info, signal);
    return { status };
  }
  return {
    name: 'Schedules Direct', type: 'SchedulesDirect',
    async validate(info, validateLogin, validateListings, { signal } = {}) {
      loginAfter = offlineUntil = 0;
      statusCache.clear(); tokens.delete(info.Username);
      if (validateLogin) {
        required(info.Username, 'info.Username'); required(info.Password, 'info.Password');
        if (!await getToken(info, signal)) throw authError();
      }
      await online(info, signal);
      if (validateListings) {
        const id = required(info.ListingsId, 'info.ListingsId');
        if (!await getToken(info, signal)) throw authError();
        const result = await request(info, '/lineups', { signal }).catch(error => { if (error.httpStatus !== 400) throw error; });
        if (!result?.lineups?.some(lineup => equal(lineup.lineup, id))) {
          await request(info, '/lineups/' + encodeURIComponent(id), { method: 'PUT', signal });
        }
      }
    },
    async getLineups(info, country, location, { signal } = {}) {
      await authorized(info, signal);
      const params = new URLSearchParams({ country: country ?? '', postalcode: location ?? '' });
      const headends = await request(info, '/headends?' + params, { signal });
      return (headends ?? []).flatMap(headend => (headend.lineups ?? []).map(value => ({
        Name: value.name?.trim() ? value.name : value.lineup,
        Id: value.lineup?.trim() ? value.lineup : value.uri?.split('/').at(-1),
      })));
    },
    async getChannels(info, { signal } = {}) {
      if (!info.ListingsId) return [];
      const { status } = await authorized(info, signal);
      const modified = status?.lineups?.find(lineup => equal(lineup.lineup ?? lineup.ID, info.ListingsId))?.modified;
      const filename = modified && cacheName('lineups', info.ListingsId, new Date(modified).toISOString().slice(0, 19).replace(/\D/gu, ''));
      let lineup = filename && await readCache(filename);
      if (!lineup) {
        lineup = await request(info, '/lineups/' + encodeURIComponent(info.ListingsId), { signal });
        if (filename && lineup) await writeCache(filename, lineup);
      }
      const stations = new Map((lineup?.stations ?? []).map(s => [String(s.stationID).toLowerCase(), s]));
      return (lineup?.map ?? []).map(channel => {
        const station = stations.get(String(channel.stationID).toLowerCase());
        const number = [channel.logicalChannelNumber, channel.channel].find(value => value?.trim())
          ?? (channel.atscMajor ?? 0) + '.' + (channel.atscMinor ?? 0);
        const Number = number.replace(/^0+/u, '');
        return { Id: channel.stationID, Name: station?.name?.trim() ? station.name : Number, Number,
          CallSign: station?.callsign, ImageUrl: station?.logo?.URL ?? station?.logo?.url, ChannelType: 'TV' };
      });
    },
    async getPrograms(info, channelId, start, end, { signal } = {}) {
      if (metadataUntil > now() || await imagePolicy?.isMetadataDailyLimitActive?.()) throw new Error('The Schedules Direct daily request limit has been reached.');
      const station = required(channelId, 'channelId').replace(/\.json\.schedulesdirect\.org/giu, '').replace(/^I+/u, '');
      await authorized(info, signal);
      return getSchedulePrograms(station, start, end, { now, signal, getToken: () => getToken(info, signal), api, retryTimes, imagePolicy, applyCode,
        cacheName, readCache, writeCache, pruneScheduleCache, post: (route, body) => request(info, route, { method: 'POST', body, signal }) });
    },
  };
}
