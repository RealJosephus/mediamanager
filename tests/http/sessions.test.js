import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { parsePlayedDate } from '../../src/http/date-binding.js';
import dateOracle from '../sessions/fixtures/date-binding.json' with { type: 'json' };
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

test('native LegacyDateTimeModelBinder and SQLite UTC conversion differential', () => {
  const now = new Date(dateOracle.now.slice(0, 19));
  for (const entry of dateOracle.cases) {
    const query = new URLSearchParams(entry.values.map(value => ['datePlayed', value]));
    if (!entry.valid) assert.throws(() => parsePlayedDate(query, { now, offsetMinutes: () => -480 }), { status: 400, errors: { datePlayed: [`The value '${entry.values[0]}' is not valid.`] } }, JSON.stringify(entry));
    else assert.equal(parsePlayedDate(query, { now, offsetMinutes: () => -480 }) ?? null, entry.stored ? `${entry.stored.replace(' ', 'T')}Z` : null, JSON.stringify(entry));
  }
  assert.equal(parsePlayedDate(new URLSearchParams('datePlayed=invalid&DATEPLAYED=20260926120000')), undefined);
});

const itemId = '22222222-2222-2222-2222-222222222222';
function nativeItem() {
  const row = Object.fromEntries(tableDefinition('BaseItems').columns.map(column => [column.name,
    column.clrType.replace('?', '') === 'DateTime' ? '2026-09-26 00:00:00.0000000' : column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
  return { ...row, Id: itemId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'HTTP Movie', CleanName: 'http movie', SortName: 'http movie', Data: '{}', MediaType: 'Video', RunTimeTicks: 9223372036854775000n, Path: 'Z:\\Isolated\\movie.mkv', IsFolder: false };
}

test('real runtime HTTP binds session bodies and user data without losing Int64 or accepting cross-user control', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const temporaryRoot = await realpath(tmpdir());
  const stateRoot = await mkdtemp(path.join(temporaryRoot, 'mediamanager-session-data-'));
  t.after(async () => {
    assert.equal(path.dirname(stateRoot), temporaryRoot);
    assert.ok(path.basename(stateRoot).startsWith('mediamanager-session-data-'));
    await rm(stateRoot, { recursive: true, force: true });
  });
  const database = await createPostgresTestDatabase(t, 'http_session_data');
  const runtime = await createRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: 'http-test',
    programDataPath: path.join(stateRoot, 'program'), configurationDirectoryPath: path.join(stateRoot, 'config') });
  runtime.sessions.automaticProgress = false;
  try {
    await database.insert('BaseItems', nativeItem());
    const first = await runtime.users.createUser({ Name: 'First', Password: 'test-password' });
    const second = await runtime.users.createUser({ Name: 'Second', Password: 'test-password' });
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    async function call(route, { token, body, method = body ? 'POST' : 'GET', deviceId = 'shared-device' } = {}) {
      const response = await fetch(origin + route, { method, headers: { Authorization: `MediaBrowser Client="HttpTest", Device="Device", DeviceId="${deviceId}", Version="1"${token ? `, Token="${token}"` : ''}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: stringifyNativeJson(body) } : {}) });
      const text = await response.text();
      return { status: response.status, body: text && response.headers.get('content-type')?.includes('json') ? parseLosslessJson(text) : text };
    }
    const login = await call('/Users/AuthenticateByName', { body: { username: 'First', pw: 'test-password' } });
    const other = await call('/Users/AuthenticateByName', { body: { username: 'Second', pw: 'test-password' } });
    assert.equal(login.status, 200); assert.equal(other.status, 200);
    const token = login.body.AccessToken;
    assert.notEqual(login.body.SessionInfo.Id, other.body.SessionInfo.Id, 'user identity binds sessions with the same client/device');
    const denied = await call(`/Sessions/Capabilities/Full?id=${other.body.SessionInfo.Id}`, { token, body: { supportsMediaControl: true } });
    assert.equal(denied.status, 403);
    assert.equal((await call('/Sessions/Capabilities/Full', { token, body: { playableMediaTypes: ['Video'], supportedCommands: ['SetVolume'], supportsMediaControl: true, ignoredField: 'must-not-serialize' } })).status, 204);
    let sessions = await call('/Sessions', { token });
    assert.equal(sessions.body.length, 1);
    assert.deepEqual(sessions.body[0].Capabilities.PlayableMediaTypes, ['Video']);
    assert.equal(sessions.body[0].Capabilities.SupportsMediaControl, true);
    assert.equal(sessions.body[0].Capabilities.SupportsPersistentIdentifier, false, 'Full DTO uses its own false default rather than the internal model default');
    assert.equal('ignoredField' in sessions.body[0].Capabilities, false);
    assert.equal((await call('/Sessions/Capabilities/Full', { token, body: { playableMediaTypes: 'Video, garbage,Audio', supportedCommands: 'SetVolume,garbage,0',
      appStoreUrl: 1, deviceProfile: { directPlayProfiles: [{ container: 'mkv', type: 'Video' }] } } })).status, 204);
    sessions = await call('/Sessions', { token });
    const capabilities = sessions.body[0].Capabilities;
    assert.deepEqual(capabilities.PlayableMediaTypes, ['Video', 'Audio']);
    assert.deepEqual(capabilities.SupportedCommands, ['SetVolume', 'MoveUp']);
    assert.equal(capabilities.AppStoreUrl, '1');
    assert.equal(capabilities.DeviceProfile.MaxStreamingBitrate, 8000000);
    assert.deepEqual(capabilities.DeviceProfile.DirectPlayProfiles, [{ Container: 'mkv', Type: 'Video' }]);
    const invalidProfile = await call('/Sessions/Capabilities/Full', { token, body: { deviceProfile: { directPlayProfiles: [{ container: 'mkv', type: 'invalid' }] } } });
    assert.equal(invalidProfile.status, 400);
    assert.deepEqual(invalidProfile.body.errors.capabilities, ['The capabilities field is required.']);
    assert.ok(invalidProfile.body.errors['$.deviceProfile.directPlayProfiles[0].type']);
    assert.equal((await call('/Sessions/Capabilities?playableMediaTypes=Video,garbage,Audio&supportedCommands=SetVolume,garbage,0', { token, method: 'POST' })).status, 204);
    sessions = await call('/Sessions', { token });
    assert.deepEqual(sessions.body[0].Capabilities.PlayableMediaTypes, ['Video', 'Audio']);
    assert.deepEqual(sessions.body[0].Capabilities.SupportedCommands, ['SetVolume', 'MoveUp']);
    assert.equal(sessions.body[0].Capabilities.SupportsPersistentIdentifier, true);
    assert.equal((await call('/Sessions/Capabilities?playableMediaTypes=Video&playableMediaTypes=garbage&playableMediaTypes=Book&supportedCommands=SetVolume&supportedCommands=bad', { token, method: 'POST' })).status, 204);
    sessions = await call('/Sessions', { token });
    assert.deepEqual(sessions.body[0].Capabilities.PlayableMediaTypes, ['Video', 'Book']);
    assert.deepEqual(sessions.body[0].Capabilities.SupportedCommands, ['SetVolume']);
    assert.equal((await call('/Sessions/Capabilities?id=%20', { token, method: 'POST' })).status, 204);
    assert.equal((await call('/Sessions/Capabilities?supportsMediaControl=bad', { token, method: 'POST' })).status, 400);
    assert.equal((await call('/Sessions/Playing', { token, body: { itemId, positionTicks: 0n } })).status, 204);
    assert.equal((await call('/Sessions/Playing/Progress', { token, body: { itemId, positionTicks: 900719925474099301n, playMethod: 'Transcode', isPaused: true } })).status, 204);
    sessions = await call('/Sessions', { token });
    assert.equal(sessions.body[0].PlayState.PositionTicks, 900719925474099301n);
    assert.equal(sessions.body[0].PlayState.PlayMethod, 'DirectPlay');
    assert.equal(sessions.body[0].PlayState.IsPaused, true);
    assert.equal(sessions.body[0].NowPlayingItem.ChannelId, null, 'Guid.Empty converter output survives the session DTO snapshot');
    assert.equal((await call('/Sessions/Playing/Progress', { token, body: { itemId, playMethod: 'directstream', repeatMode: 1, playbackOrder: '1' } })).status, 204);
    sessions = await call('/Sessions', { token });
    assert.equal(sessions.body[0].PlayState.PlayMethod, 'DirectStream');
    assert.equal(sessions.body[0].PlayState.RepeatMode, 'RepeatAll');
    assert.equal(sessions.body[0].PlayState.PlaybackOrder, 'Shuffle');
    assert.equal((await call('/Sessions/Playing/Progress', { token, body: { itemId, isPaused: 'true' } })).status, 400);
    assert.equal((await call('/Sessions/Playing/Progress', { token, body: { itemId, positionTicks: 9223372036854775808n } })).status, 400);
    assert.equal((await call(`/UserItems/${itemId}/UserData`, { token, body: { playbackPositionTicks: 9007199254740993n, isFavorite: true } })).status, 200);
    const data = await call(`/UserItems/${itemId}/UserData`, { token });
    assert.equal(data.status, 200); assert.equal(data.body.PlaybackPositionTicks, 9007199254740993n); assert.equal(data.body.IsFavorite, true);
    assert.equal((await call(`/UserItems/${itemId}/UserData`, { token, body: { isFavorite: 'false' } })).status, 400);
    assert.equal((await call(`/UserItems/${itemId}/UserData`, { token, body: { playCount: 2147483648 } })).status, 400);
    let rated = await call(`/UserItems/${itemId}/UserData`, { token, body: { playCount: '2', rating: '8.5' } });
    assert.equal(rated.body.PlayCount, 2); assert.equal(rated.body.Rating, 8.5); assert.equal(rated.body.Likes, true);
    rated = await call(`/UserItems/${itemId}/UserData`, { token, body: { rating: 2, likes: true } });
    assert.equal(rated.body.Rating, 2); assert.equal(rated.body.Likes, false, 'Rating is applied after Likes regardless of JSON order');
    rated = await call(`/UserItems/${itemId}/UserData`, { token, body: { rating: null, likes: null } });
    assert.equal(rated.body.Rating, 2); assert.equal(rated.body.Likes, false, 'nullable update fields do not clear existing values');
    assert.equal((await call(`/UserItems/${itemId}/UserData`, { token, body: { rating: 10.01 } })).status, 400);
    rated = await call(`/UserItems/${itemId}/Rating?likes=true`, { token, method: 'POST' });
    assert.equal(rated.body.Rating, 10); assert.equal(rated.body.Likes, true);
    rated = await call(`/UserItems/${itemId}/Rating`, { token, method: 'POST' });
    assert.equal('Rating' in rated.body, false); assert.equal('Likes' in rated.body, false, 'missing likes clears the personal rating');
    await call(`/UserItems/${itemId}/Rating?likes=false`, { token, method: 'POST' });
    rated = await call(`/UserItems/${itemId}/Rating`, { token, method: 'DELETE' });
    assert.equal('Rating' in rated.body, false); assert.equal('Likes' in rated.body, false);
    assert.equal((await call(`/Users/${second.Id}/FavoriteItems/${itemId}`, { token, method: 'POST' })).status, 403);
    assert.equal((await call('/Sessions/Playing/Stopped', { token, body: { itemId, positionTicks: -1n } })).status, 400);
    assert.equal((await call(`/Sessions/${login.body.SessionInfo.Id}/User/${second.Id}`, { token, method: 'POST' })).status, 403);
    await runtime.users.updatePolicy(first.Id, { ...(await runtime.users.getUser(first.Id)).Policy, IsAdministrator: true });
    assert.equal((await call(`/Sessions/${login.body.SessionInfo.Id}/User/${second.Id}`, { token, method: 'POST' })).status, 204);
    sessions = await call('/Sessions', { token });
    assert.equal(sessions.body.find(session => session.Id === login.body.SessionInfo.Id).AdditionalUsers[0].UserId, second.Id);
    assert.equal((await call(`/UserPlayedItems/${itemId}?datePlayed=20260230000000`, { token, method: 'POST' })).status, 400);
    assert.equal((await call(`/UserPlayedItems/${itemId}?datePlayed=20260926123000`, { token, method: 'POST' })).status, 200);
    assert.equal((await runtime.userData.get(second.Id, itemId)).Played, true);
    assert.equal((await runtime.userData.get(second.Id, itemId)).LastPlayedDate, '2026-09-26T12:30:00.0000000Z');
    assert.equal((await call(`/Sessions/${login.body.SessionInfo.Id}/User/${second.Id}`, { token, method: 'DELETE' })).status, 204);
    assert.equal((await call(`/UserPlayedItems/${itemId}`, { token, method: 'DELETE' })).status, 200);
    assert.equal((await runtime.userData.get(first.Id, itemId)).Played, false);
    assert.equal((await runtime.userData.get(second.Id, itemId)).Played, true);
    for (const [date, expected] of [
      ['2026-09-26T12:34:56.1234567+08:00', '2026-09-26T04:34:56.1234567Z'],
      ['2026-09-26T12:34:56.12345675Z', '2026-09-26T12:34:56.1234568Z'],
      ['2026-09-26T12:34:56.99999999Z', '2026-09-26T12:34:57.0000000Z'],
      ['Sat, 26 Sep 2026 12:34:56 GMT', '2026-09-26T12:34:56.0000000Z'],
    ]) {
      const played = await call(`/UserPlayedItems/${itemId}?datePlayed=${encodeURIComponent(date)}`, { token, method: 'POST' });
      assert.equal(played.status, 200, date);
      assert.equal(played.body.LastPlayedDate, expected, date);
      assert.equal((await call(`/UserItems/${itemId}/UserData`, { token })).body.LastPlayedDate, expected);
      const row = (await database.rows('UserData', { where: { ItemId: itemId } })).find(row => row.UserId.replaceAll('-', '').toLowerCase() === first.Id);
      assert.equal(row.LastPlayedDate, expected.replace('T', ' ').replace(/0*Z$/, '').replace(/\.$/, ''));
    }
    assert.equal((await call(`/UserPlayedItems/${itemId}?datePlayed=bad&DATEPLAYED=also-bad`, { token, method: 'POST' })).status, 200);
    assert.equal((await call(`/UserPlayedItems/${itemId}?datePlayed=bad`, { token, method: 'DELETE' })).status, 200);
    assert.equal((await call('/Sessions/Logout', { token, method: 'POST' })).status, 204);
    assert.equal((await call('/Sessions', { token })).status, 401);
    assert.equal((await runtime.users.getUser(first.Id)).Username, 'First');
  } finally { await runtime.close(); }
});
