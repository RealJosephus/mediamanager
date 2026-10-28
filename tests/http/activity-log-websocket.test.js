import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createWebSocketServer } from '../../src/http/websocket.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { errorObservation } from '../helpers/error-observation.js';

class ActivitySessions extends EventEmitter {
  async logActivity(auth) { return { Id: auth.testIdentity }; }
  attachController() { return async () => {}; }
}

async function waitFor(condition, signal) {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    signal.throwIfAborted();
    assert.ok(performance.now() < deadline, 'The expected activity-log WS frames were not delivered.');
    await delay(5, undefined, { signal });
  }
}

test('activity-log WS uses admin or API-key subscriptions, event-only empty data, duplicate starts, first-stop removal and real close', {
  timeout: 30000,
}, async t => {
  const sessions = new ActivitySessions(), activityEvents = new EventEmitter(), server = createServer(), clients = [], diagnostics = [];
  const webSockets = createWebSocketServer({ sessions, activities: activityEvents,
    authentication: { authenticate: async request => {
      const identity = new URL(request.url, 'http://activity.invalid').searchParams.get('ApiKey');
      return { IsAuthenticated: true, testIdentity: identity, IsApiKey: identity === 'api-key',
        User: identity === 'api-key' ? null : { Policy: { IsAdministrator: identity === 'admin' } } };
    } },
    localization: { negotiate: () => ({ uiCulture: 'en-US' }), run: (_locale, action) => action() },
    onError: error => diagnostics.push(errorObservation(error)) });
  let closed = false, failed = false, failure;
  const cleanupErrors = [];
  const connect = async identity => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/socket?ApiKey=${identity}`);
    const client = { socket, messages: [], errors: [] }; clients.push(client);
    socket.on('message', bytes => client.messages.push(parseLosslessJson(bytes.toString())));
    socket.on('error', error => client.errors.push(errorObservation(error)));
    await once(socket, 'open', { signal: t.signal });
    await waitFor(() => client.messages.some(message => message.MessageType === 'ForceKeepAlive'), t.signal);
    return client;
  };
  const activities = client => client.messages.filter(message => message.MessageType === 'ActivityLogEntry');
  const barrier = async (client, messages = []) => {
    const before = client.messages.filter(message => message.MessageType === 'KeepAlive').length;
    for (const message of messages) client.socket.send(stringifyNativeJson(message));
    client.socket.send(stringifyNativeJson({ MessageType: 'KeepAlive' }));
    await waitFor(() => client.messages.filter(message => message.MessageType === 'KeepAlive').length === before + 1, t.signal);
  };
  try {
    webSockets.attach(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const admin = await connect('admin'), reader = await connect('reader'), apiKey = await connect('api-key');
    await barrier(admin, [
      { MessageType: 'ActivityLogEntryStart', Data: ' 0 , +1 ' },
      { MessageType: 'ActivityLogEntryStart', Data: ' 5000 , +1000000 ' }
    ]);
    await barrier(reader, [{ MessageType: 'ActivityLogEntryStart', Data: '0,1' }]);
    await barrier(apiKey, [{ MessageType: 'ActivityLogEntryStart', Data: '9223372036854775807,9223372036854775807' }]);
    for (const client of clients) assert.deepEqual(activities(client), [], 'Starting a subscription does not poll or immediately send.');
    activityEvents.emit('EntryCreated', { privateLogEntry: 'The designated wire data does not expose this entry.' });
    await waitFor(() => activities(admin).length === 2 && activities(apiKey).length === 1, t.signal);
    await barrier(reader);
    assert.deepEqual(activities(reader), [], 'A normal authenticated user cannot subscribe to the activity log.');
    for (const client of [admin, apiKey]) for (const message of activities(client)) {
      assert.deepEqual(message.Data, []);
      assert.equal(typeof message.MessageId, 'string');
    }

    await barrier(admin, [{ MessageType: 'ActivityLogEntryStop' }]);
    activityEvents.emit('EntryCreated', {});
    await waitFor(() => activities(admin).length === 3 && activities(apiKey).length === 2, t.signal);
    await barrier(admin, [{ MessageType: 'ActivityLogEntryStop' }]);
    activityEvents.emit('EntryCreated', {});
    await waitFor(() => activities(apiKey).length === 3, t.signal);
    await barrier(admin);
    assert.equal(activities(admin).length, 3, 'Each Stop removes only the first matching subscription.');
    await barrier(apiKey, [{ MessageType: 'ActivityLogEntryStop' }, { MessageType: 'ActivityLogEntryStop' }]);
    activityEvents.emit('EntryCreated', {});
    await Promise.all(clients.map(client => barrier(client)));
    assert.equal(activities(admin).length, 3); assert.equal(activities(apiKey).length, 3);

    await barrier(admin, [{ MessageType: 'ActivityLogEntryStart', Data: '0,1000000' }]);
    await barrier(apiKey, [{ MessageType: 'ActivityLogEntryStart', Data: '0,1000000' }]);
    activityEvents.emit('EntryCreated', {});
    const clientClosures = clients.map(({ socket }) => once(socket, 'close'));
    await webSockets.close(); closed = true;
    await Promise.all(clientClosures);
    assert.equal(activities(admin).length, 4); assert.equal(activities(apiKey).length, 4);
    assert.deepEqual(activities(reader), []);
    assert.ok(clients.every(({ socket }) => socket.readyState === WebSocket.CLOSED));
  } catch (error) { failed = true; failure = error; }
  finally {
    for (const action of [
      async () => { if (!closed) await webSockets.close(); },
      async () => {
        await Promise.all(clients.map(({ socket }) => {
          if (socket.readyState === WebSocket.CLOSED) return;
          const closed = new Promise(resolve => socket.once('close', resolve)); socket.terminate(); return closed;
        }));
      },
      async () => { if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    ]) { try { await action(); } catch (error) { cleanupErrors.push(error); } }
    t.diagnostic(stringifyNativeJson({ scope: 'Actual Node WS consumer with controlled authentication and session event source; no PG or same-run Native claim.',
      diagnostics, clients: clients.map(client => ({ messages: client.messages, errors: client.errors, closed: client.socket.readyState === WebSocket.CLOSED })) }));
  }
  if (failed && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], 'Activity-log WS operation and cleanup failed.', { cause: failure });
  if (failed) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Activity-log WS cleanup failed.', { cause: cleanupErrors[0] });
});
