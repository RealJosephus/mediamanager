import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createWebSocketServer } from '../../src/http/websocket.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';

class FakeSessions extends EventEmitter {
  #sequence = 0;
  #sessions = new Map();

  async logActivity(auth) {
    const Id = `scheduled-task-ws-${++this.#sequence}`;
    this.#sessions.set(Id, { auth, controllers: [] });
    return { Id };
  }

  attachController(sessionId, controller) {
    const session = this.#sessions.get(sessionId);
    session.controllers.push(controller);
    return () => {};
  }

  async getSessions() { return []; }

  async sendMessageToAdminSessions(type, data) {
    const messageId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    await Promise.all([...this.#sessions.values()]
      .filter(session => session.auth.IsAdministrator)
      .flatMap(session => session.controllers.map(controller => controller.sendMessage(type, messageId, data))));
  }
}

class FakeTasks extends EventEmitter {
  values = [];
  listGate = null;
  async list() {
    await this.listGate?.promise;
    return this.values.map(value => structuredClone(value));
  }
}

function inbox(socket) {
  const messages = [];
  const waiters = [];
  socket.on('message', bytes => {
    const message = parseLosslessJson(bytes.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.matches(message)) continue;
      clearTimeout(waiter.timeout);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  return {
    messages,
    next(matches, timeoutMs = 1000) {
      const existing = messages.find(matches);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { matches, resolve };
        waiter.timeout = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error('Missing expected scheduled task WebSocket message.'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    }
  };
}

async function connect(origin, token) {
  const socket = new WebSocket(origin.replace('http', 'ws') + `/socket?ApiKey=${token}`);
  const received = inbox(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await received.next(message => message.MessageType === 'ForceKeepAlive');
  return { socket, received };
}

function count(client, type) {
  return client.received.messages.filter(message => message.MessageType === type).length;
}

test('scheduled task subscriptions force lifecycle snapshots, throttle progress and notify only admins of task results', async () => {
  const server = createServer();
  const sessions = new FakeSessions();
  const tasks = new FakeTasks();
  const refreshes = new EventEmitter();
  refreshes.snapshot = () => new Map();
  const errors = [];
  let now = 10_000;
  let refreshGate;
  const library = {
    getCollectionFolders() { return refreshGate?.promise ?? Promise.resolve([]); }
  };
  const localization = {
    negotiate: request => ({ uiCulture: request.headers['accept-language'] ?? 'en-US' }),
    run: (_locale, operation) => operation()
  };
  const webSockets = createWebSocketServer({
    authentication: {
      authenticate: async request => ({
        IsAuthenticated: true,
        IsAdministrator: new URL(request.url, 'http://localhost').searchParams.get('ApiKey') === 'admin'
      })
    },
    sessions,
    tasks,
    refreshes,
    library,
    localization,
    clock: () => now,
    onError: error => errors.push(error)
  });
  const clients = [];
  let closed = false;
  let listGate;
  try {
    webSockets.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const admin = await connect(origin, 'admin'); clients.push(admin);
    const reader = await connect(origin, 'reader'); clients.push(reader);
    const subscribe = client => client.socket.send(stringifyNativeJson({
      MessageType: 'ScheduledTasksInfoStart', Data: ' 0 , +1000 '
    }));
    subscribe(admin);
    subscribe(reader);
    reader.socket.send(stringifyNativeJson({ MessageType: 'SessionsStart', Data: ' 0 , +1000 ' }));
    reader.socket.send(stringifyNativeJson({ MessageType: 'SessionsStop' }));
    await delay(20);
    assert.equal(count(admin, 'ScheduledTasksInfo'), 0, 'subscription alone does not poll or send immediately');

    tasks.values = [
      { Name: 'Zulu', Id: 'z', State: 'Running', IsHidden: false },
      { Name: 'Hidden', Id: 'h', State: 'Idle', IsHidden: true },
      { Name: 'Alpha', Id: 'a', State: 'Idle', IsHidden: false }
    ];
    tasks.emit('started', { Task: tasks.values[0] });
    const adminStarted = await admin.received.next(message => message.MessageType === 'ScheduledTasksInfo');
    const readerStarted = await reader.received.next(message => message.MessageType === 'ScheduledTasksInfo');
    assert.deepEqual(adminStarted.Data.map(task => task.Name), ['Alpha', 'Zulu']);
    assert.deepEqual(readerStarted.Data.map(task => task.Name), ['Alpha', 'Zulu']);
    assert.match(adminStarted.MessageId, /^[0-9a-f]{32}$/u);

    tasks.values[0].CurrentProgressPercentage = 10;
    now += 100;
    tasks.emit('progress', { Task: tasks.values[0], Progress: 10 });
    await delay(20);
    assert.equal(count(admin, 'ScheduledTasksInfo'), 1, 'progress before the requested interval is suppressed');

    now += 900;
    tasks.emit('progress', { Task: tasks.values[0], Progress: 20 });
    await admin.received.next(message => message.MessageType === 'ScheduledTasksInfo'
      && message.Data.some(task => task.CurrentProgressPercentage === 10));
    await reader.received.next(message => message.MessageType === 'ScheduledTasksInfo'
      && message.Data.some(task => task.CurrentProgressPercentage === 10));
    assert.equal(count(admin, 'ScheduledTasksInfo'), 2);
    assert.equal(count(reader, 'ScheduledTasksInfo'), 2);

    reader.socket.send(stringifyNativeJson({ MessageType: 'SessionsStart', Data: ' 0 , +1000 ' }));
    reader.socket.send(stringifyNativeJson({ MessageType: 'ScheduledTasksInfoStop' }));
    await delay(20);
    sessions.emit('SessionStarted', {});
    await reader.received.next(message => message.MessageType === 'Sessions');
    tasks.values[0] = { Name: 'Zulu', Id: 'z', State: 'Idle', IsHidden: false,
      LastExecutionResult: { Status: 'Completed' } };
    const result = {
      StartTimeUtc: '2026-10-04T00:00:00Z', EndTimeUtc: '2026-10-04T00:00:01Z', Status: 'Completed',
      Name: 'Zulu', Key: 'RefreshLibrary', Id: 'z'
    };
    listGate = Promise.withResolvers();
    tasks.listGate = listGate;
    tasks.emit('completed', { Task: tasks.values[0], Result: result });
    const ended = await admin.received.next(message => message.MessageType === 'ScheduledTaskEnded', 200);
    listGate.resolve();
    tasks.listGate = null;
    await admin.received.next(message => message.MessageType === 'ScheduledTasksInfo'
      && message.Data.some(task => task.LastExecutionResult?.Status === 'Completed'));
    assert.deepEqual(ended, {
      MessageType: 'ScheduledTaskEnded', MessageId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', Data: result
    });
    await delay(20);
    assert.equal(count(reader, 'ScheduledTasksInfo'), 2, 'stopping removes the reader task-info subscription');
    assert.equal(count(reader, 'ScheduledTaskEnded'), 0, 'ordinary authenticated sessions do not receive task results');

    listGate = Promise.withResolvers();
    tasks.listGate = listGate;
    tasks.emit('started', { Task: tasks.values[0] });
    refreshGate = Promise.withResolvers();
    refreshes.emit('RefreshStarted', { Item: { Id: '1', IsFolder: true, IsTopParent: true } });
    await delay(0);
    const shutdownResult = { ...result, EndTimeUtc: '2026-10-04T00:00:02Z' };
    tasks.emit('completed', { Task: tasks.values[0], Result: shutdownResult });
    const closing = webSockets.close();
    const drained = await admin.received.next(message => message.MessageType === 'ScheduledTaskEnded'
      && message.Data.EndTimeUtc === shutdownResult.EndTimeUtc);
    await Promise.race([
      closing,
      delay(1500).then(() => { throw new Error('WebSocket close did not bound a stalled task-info drain.'); })
    ]);
    closed = true;
    assert.deepEqual(drained.Data, shutdownResult, 'close drains notifications accepted before listener detachment');
    listGate.resolve();
    tasks.listGate = null;
    refreshGate.resolve([]);
    assert.equal(tasks.listenerCount('started'), 0);
    assert.equal(tasks.listenerCount('progress'), 0);
    assert.equal(tasks.listenerCount('completed'), 0);
  } finally {
    listGate?.resolve();
    refreshGate?.resolve([]);
    for (const { socket } of clients) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    if (!closed) await webSockets.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
