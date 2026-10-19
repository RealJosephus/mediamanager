import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function recordCoreFlow(base, identities) {
  if (new URL(base).hostname !== '127.0.0.1') throw new Error('Only isolated loopback services are allowed.');
  const records = [];
  let token;
  const auth = (device = 'core-flow-device') => `MediaBrowser Client="CoreFlow", Device="IsolatedTest", DeviceId="${device}", Version="1.0"${token ? `, Token="${token}"` : ''}`;
  async function call(name, route, { method = 'GET', body, authenticated = true, contentType = 'application/json', device, headers = {} } = {}) {
    const response = await fetch(new URL(route, base), { method, headers: { Accept: 'application/json', ...(authenticated ? { Authorization: auth(device) } : {}), ...(body === undefined ? {} : { 'Content-Type': contentType }), ...headers }, body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body });
    const text = await response.text();
    let value = text;
    try { value = JSON.parse(text); } catch {}
    records.push({ name, route, method, status: response.status, headers: { contentType: response.headers.get('content-type'), contentLanguage: response.headers.get('content-language') }, body: value });
    return value;
  }
  await call('public-users', '/Users/Public', { authenticated: false });
  await call('unauthenticated-users', '/Users', { authenticated: false });
  await call('invalid-login', '/Users/AuthenticateByName', { method: 'POST', body: { Username: 'CoreFlowAdmin', Pw: 'incorrect' } });
  const login = await call('login', '/Users/AuthenticateByName', { method: 'POST', body: { Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' } });
  if (!login.AccessToken) throw new Error('Reference login did not succeed.');
  token = login.AccessToken;
  await call('current-user', '/Users/Me');
  await call('users', '/Users');
  await call('filtered-users', '/Users?isHidden=false&isDisabled=false');
  await call('user-guid-error', '/Users/not-a-guid');
  await call('query-bool-error', '/Users?isHidden=invalid');
  await call('user-missing', '/Users/00000000000000000000000000000099');
  await call('sessions', '/Sessions?deviceId=core-flow-device');
  await call('capabilities', '/Sessions/Capabilities/Full', { method: 'POST', body: { PlayableMediaTypes: ['Video'], SupportedCommands: ['SetVolume'], SupportsMediaControl: true, SupportsPersistentIdentifier: true } });
  await call('sessions-capabilities', '/Sessions?deviceId=core-flow-device');
  const parent = `parentId=${identities.folder}&`;
  await call('items', `/Items?${parent}recursive=true&includeItemTypes=Movie&sortBy=SortName&fields=Overview,Genres,Path,ProviderIds`);
  await call('items-page', `/Items?${parent}recursive=true&includeItemTypes=Movie&sortBy=ProductionYear&sortOrder=Descending&startIndex=1&limit=1`);
  await call('items-search', `/Items?${parent}recursive=true&includeItemTypes=Movie&searchTerm=Alpha`);
  await call('item', `/Items/${identities.movie}`);
  await call('favorite', `/UserFavoriteItems/${identities.movie}`, { method: 'POST' });
  await call('favorites', `/Items?${parent}recursive=true&includeItemTypes=Movie&isFavorite=true`);
  await call('userdata-favorite', `/UserItems/${identities.movie}/UserData`);
  await call('playback-start', '/Sessions/Playing', { method: 'POST', body: { ItemId: identities.movie, PositionTicks: 0, PlayMethod: 'DirectPlay', CanSeek: true, IsPaused: false } });
  await call('playback-progress', '/Sessions/Playing/Progress', { method: 'POST', body: { ItemId: identities.movie, PositionTicks: 36000000000, PlayMethod: 'DirectPlay', CanSeek: true, IsPaused: true } });
  await call('userdata-progress', `/UserItems/${identities.movie}/UserData`);
  await call('playback-stop', '/Sessions/Playing/Stopped', { method: 'POST', body: { ItemId: identities.movie, PositionTicks: 68400000000, Failed: false } });
  await call('userdata-stopped', `/UserItems/${identities.movie}/UserData`);
  await call('unplayed', `/UserPlayedItems/${identities.movie}`, { method: 'DELETE' });
  await call('played', `/UserPlayedItems/${identities.movie}?datePlayed=20260926120000`, { method: 'POST' });
  await call('unfavorite', `/UserFavoriteItems/${identities.movie}`, { method: 'DELETE' });
  await call('logout', '/Sessions/Logout', { method: 'POST' });
  await call('revoked-token', '/Users/Me');
  token = undefined;
  const formLogin = await call('form-login', '/Users/AuthenticateByName', { method: 'POST', contentType: 'application/x-www-form-urlencoded', body: 'username=CoreFlowReader&pw=isolated-reader-password', device: 'core-flow-reader' });
  token = formLogin.AccessToken;
  await call('reader-users', '/Users');
  await call('forbidden-create', '/Users/New', { method: 'POST', body: { Name: 'ForbiddenUser' } });
  await call('forbidden-other-user', `/Items?userId=${identities.adminId}&recursive=true`);
  await call('reader-logout', '/Sessions/Logout', { method: 'POST' });
  return records;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''))) {
  const [base, directory, name = 'reference-responses.json'] = process.argv.slice(2);
  const records = await recordCoreFlow(base, JSON.parse(await readFile(path.join(directory, 'identities.json'), 'utf8')));
  await writeFile(path.join(directory, name), JSON.stringify(records, null, 2));
  console.log(JSON.stringify(records.map(({ name, status }) => ({ name, status }))));
}
