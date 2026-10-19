import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';

const movieId = '22222222222222222222222222222222';
const startPositionTicks = 6000000000n;
const bootstrapWhen = '0001-01-01T00:00:00Z';

export const syncPlayDateImpactCases = Object.freeze([
  { name: 'minimum-minus-14-playing', boundary: 'minimum-year-minus-14', when: '0001-01-01T00:00:00-14:00', isPlaying: true },
  { name: 'minimum-minus-14-paused', boundary: 'minimum-year-minus-14', when: '0001-01-01T00:00:00-14:00', isPlaying: false },
  { name: 'minimum-utc-playing', boundary: 'minimum-year-utc', when: '0001-01-01T00:00:00+00:00', isPlaying: true },
  { name: 'minimum-utc-paused', boundary: 'minimum-year-utc', when: '0001-01-01T00:00:00+00:00', isPlaying: false },
  { name: 'inside-two-second-guard', boundary: 'server-clock-minus-1000ms', clockOffsetMilliseconds: 1000, isPlaying: true },
  { name: 'outside-two-second-guard', boundary: 'server-clock-minus-3000ms', clockOffsetMilliseconds: 3000, isPlaying: true },
]);

const authHeader = (actor, token) => `MediaBrowser Client="SyncPlayDateImpact", Device="Isolated", DeviceId="syncplay-date-impact-${actor}", Version="1"${token ? `, Token="${token}"` : ''}`;

function asText(value) {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

function commandScheduleClass(command) {
  const scheduled = Date.parse(command.When) - Date.parse(command.EmittedAt);
  assert.ok(Number.isFinite(scheduled), 'SyncPlay commands must expose parseable When and EmittedAt timestamps.');
  if (command.Command === 'Unpause') {
    assert.ok(scheduled >= 750 && scheduled <= 1250,
      `Expected the default one-second recovery schedule, observed ${scheduled} ms.`);
    return 'default-ping-approximately-1000ms';
  }
  assert.equal(command.Command, 'Seek');
  return scheduled <= 250 ? 'not-future-scheduled' : 'unexpected-future-schedule';
}

function outboundEchoesWhen(entry) {
  return JSON.stringify({ response: entry.targetReady.body, messages: entry.targetReady.messages, group: entry.group.body })
    .includes(entry.actualWhen);
}

export function normalizeSyncPlayDateImpact(recording) {
  return {
    schemaVersion: 1,
    startPositionTicks: startPositionTicks.toString(),
    cases: recording.cases.map(entry => {
      const targetMessages = entry.targetReady.messages.b ?? [];
      const commands = targetMessages.filter(message => message.MessageType === 'SyncPlayCommand').map(message => message.Data);
      assert.equal(commands.length, 1, `${entry.name}: target Ready must emit exactly one SyncPlay command to the target session.`);
      const command = commands[0];
      const updates = targetMessages.filter(message => message.MessageType === 'SyncPlayGroupUpdate'
        && message.Data?.Type === 'StateUpdate').map(message => message.Data.Data);
      assert.equal(updates.length, 1, `${entry.name}: target Ready must emit exactly one state update to the target session.`);
      assert.equal(entry.targetReady.status, 204, `${entry.name}: Ready status`);
      assert.equal(entry.group.status, 200, `${entry.name}: group status`);
      return {
        name: entry.name,
        input: { boundary: entry.boundary, isPlaying: entry.isPlaying },
        result: {
          readyStatus: entry.targetReady.status,
          positionTicks: asText(command.PositionTicks),
          state: entry.group.body.State,
          command: command.Command,
          commandPositionTicks: asText(command.PositionTicks),
          delayOutcome: command.Command === 'Seek' ? 'outside-500ms-tolerance' : 'within-500ms-tolerance',
          effectiveDelay: entry.boundary === 'server-clock-minus-1000ms'
            ? 'negative-more-than-5000000-ticks'
            : '0-ticks-after-two-second-guard',
          commandSchedule: commandScheduleClass(command),
          stateUpdate: { State: updates[0].State, Reason: updates[0].Reason },
          requestWhenEchoed: outboundEchoesWhen(entry),
        },
      };
    }),
  };
}

export function assertSyncPlayDateImpactEquivalent(actual, expected) {
  assertSyncPlayDateImpactContract(normalizeSyncPlayDateImpact(actual), expected);
}

export function assertSyncPlayDateImpactContract(actual, expected) {
  assert.deepEqual(actual, expected);
}

export async function recordSyncPlayDateImpact(origin, {
  onAuthenticated,
  onBeforeTargetReady,
  onAfterTargetReady,
  onCompleted,
} = {}) {
  const actors = {}, sockets = [], raw = [], cases = [];

  async function request(route, { actor = 'a', method = 'GET', body } = {}) {
    const response = await fetch(origin + route, {
      method,
      headers: {
        Authorization: authHeader(actor, actors[actor]?.AccessToken),
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : stringifyNativeJson(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    let parsed = text;
    try { parsed = text === '' ? '' : parseLosslessJson(text); } catch { /* Preserve a non-JSON response. */ }
    return { status: response.status, contentType: response.headers.get('content-type'), body: parsed };
  }

  async function openSocket(actor) {
    const messages = [];
    const socket = new WebSocket(`${origin.replace(/^http/u, 'ws')}/socket?ApiKey=${actors[actor].AccessToken}`);
    sockets.push(socket);
    socket.on('message', bytes => {
      const message = parseLosslessJson(bytes.toString());
      raw.push({ actor, message });
      if (message.MessageType?.startsWith('SyncPlay')) messages.push(message);
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return { socket, messages };
  }

  async function step(name, route, options = {}) {
    const response = await request(route, options);
    await delay(120);
    const messages = Object.fromEntries(Object.entries(actors)
      .filter(([, actor]) => actor.socket)
      .map(([key, actor]) => [key, actor.socket.messages.splice(0)]));
    return { name, ...response, messages };
  }

  const post = (name, endpoint, body, actor = 'a') => step(name, `/SyncPlay/${endpoint}`, { actor, method: 'POST', body });

  try {
    for (const actor of ['a', 'b']) {
      const login = await request('/Users/AuthenticateByName', {
        actor,
        method: 'POST',
        body: { Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' },
      });
      assert.equal(login.status, 200, `${actor}: native/candidate fixture login failed`);
      actors[actor] = login.body;
    }
    for (const actor of ['a', 'b']) actors[actor].socket = await openSocket(actor);
    await delay(120);
    for (const actor of ['a', 'b']) actors[actor].socket.messages.length = 0;
    await onAuthenticated?.({
      token: actors.a.AccessToken,
      userId: actors.a.User.Id,
      deviceIds: ['syncplay-date-impact-a', 'syncplay-date-impact-b'],
    });

    for (const definition of syncPlayDateImpactCases) {
      const setup = [];
      const created = await post(`${definition.name}-create`, 'New', { GroupName: `Date impact ${definition.name}` });
      assert.equal(created.status, 200, `${definition.name}: create`);
      setup.push(created);
      const groupId = created.body.GroupId;
      const joined = await post(`${definition.name}-join`, 'Join', { GroupId: groupId }, 'b');
      assert.equal(joined.status, 204, `${definition.name}: join`);
      setup.push(joined);
      const queued = await post(`${definition.name}-queue`, 'SetNewQueue', {
        PlayingQueue: [movieId],
        PlayingItemPosition: 0,
        StartPositionTicks: startPositionTicks,
      });
      assert.equal(queued.status, 204, `${definition.name}: queue`);
      setup.push(queued);
      const playQueue = Object.values(queued.messages).flat().find(message => message.MessageType === 'SyncPlayGroupUpdate'
        && message.Data?.Type === 'PlayQueue')?.Data.Data;
      assert.ok(playQueue?.Playlist?.[0]?.PlaylistItemId, `${definition.name}: native/candidate queue did not expose its playlist identity`);
      const playlistItemId = playQueue.Playlist[0].PlaylistItemId;

      const firstReady = await post(`${definition.name}-bootstrap-ready`, 'Ready', {
        PlaylistItemId: playlistItemId,
        When: bootstrapWhen,
        PositionTicks: startPositionTicks,
        IsPlaying: false,
      });
      assert.equal(firstReady.status, 204, `${definition.name}: bootstrap Ready`);
      setup.push(firstReady);

      let actualWhen = definition.when;
      let clock;
      if (definition.clockOffsetMilliseconds != null) {
        clock = await step(`${definition.name}-clock`, '/GetUtcTime', { actor: 'anonymous' });
        assert.equal(clock.status, 200, `${definition.name}: public clock`);
        const serverTime = Date.parse(clock.body.ResponseTransmissionTime);
        assert.ok(Number.isFinite(serverTime), `${definition.name}: public clock response`);
        actualWhen = new Date(serverTime - definition.clockOffsetMilliseconds).toISOString();
      }

      const callbackContext = await onBeforeTargetReady?.({ ...definition, actualWhen });
      const targetReady = await post(`${definition.name}-target-ready`, 'Ready', {
        PlaylistItemId: playlistItemId,
        When: actualWhen,
        PositionTicks: startPositionTicks,
        IsPlaying: definition.isPlaying,
      }, 'b');
      const group = await step(`${definition.name}-group`, `/SyncPlay/${groupId}`);
      const diagnostic = await onAfterTargetReady?.({ ...definition, actualWhen, targetReady, group }, callbackContext);

      cases.push({
        name: definition.name,
        boundary: definition.boundary,
        isPlaying: definition.isPlaying,
        actualWhen,
        setup,
        ...(clock ? { clock } : {}),
        targetReady,
        group,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      });

      const leaveB = await post(`${definition.name}-leave-b`, 'Leave', undefined, 'b');
      const leaveA = await post(`${definition.name}-leave-a`, 'Leave', undefined, 'a');
      assert.equal(leaveB.status, 204, `${definition.name}: leave b`);
      assert.equal(leaveA.status, 204, `${definition.name}: leave a`);
    }
    await onCompleted?.();
    return { schemaVersion: 1, cases, raw };
  } finally {
    for (const socket of sockets) socket.terminate();
  }
}
