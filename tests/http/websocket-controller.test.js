import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createWebSocketServer } from '../../src/http/websocket.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';

class FakeSessions extends EventEmitter {
  attachments = 0;
  detachments = 0;
  async logActivity() { return { Id: 'websocket-controller-session' }; }

  attachController(_sessionId, controller) {
    this.attachments += 1;
    this.controller = controller;
    return () => { this.detachments += 1; };
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
          reject(new Error('Missing expected WebSocket message.'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    }
  };
}

async function connect(origin) {
  const socket = new WebSocket(origin.replace('http', 'ws') + '/socket?ApiKey=test-token');
  const received = inbox(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await received.next(message => message.MessageType === 'ForceKeepAlive');
  return { socket, received };
}

test('one session sends UserDataChanged only to its most recently active open WebSocket', async () => {
  const server = createServer();
  const sessions = new FakeSessions();
  const errors = [];
  let now = 100;
  const localization = {
    negotiate: () => ({ uiCulture: 'en-US' }),
    run: (_locale, operation) => operation()
  };
  const webSockets = createWebSocketServer({
    authentication: { authenticate: async () => ({ IsAuthenticated: true }) },
    sessions,
    localization,
    clock: () => now,
    onError: error => errors.push(error)
  });
  const clients = [];
  let webSocketsClosed = false;
  try {
    webSockets.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const first = await connect(origin); clients.push(first);
    now = 200;
    const second = await connect(origin); clients.push(second);

    assert.ok(sessions.controller, 'the shared session controller is attached');
    const secondMessageId = '22222222222222222222222222222222';
    await sessions.controller.sendMessage('UserDataChanged', secondMessageId, { Target: 'second' });
    await second.received.next(message => message.MessageId === secondMessageId);

    now = 300;
    first.socket.send(stringifyNativeJson({ MessageType: 'KeepAlive' }));
    await first.received.next(message => message.MessageType === 'KeepAlive');
    const firstMessageId = '11111111111111111111111111111111';
    await sessions.controller.sendMessage('UserDataChanged', firstMessageId, { Target: 'first' });
    await first.received.next(message => message.MessageId === firstMessageId);

    await webSockets.close();
    webSocketsClosed = true;
    assert.deepEqual(first.received.messages.filter(message => message.MessageType === 'UserDataChanged'), [{
      MessageType: 'UserDataChanged', MessageId: firstMessageId, Data: { Target: 'first' }
    }]);
    assert.deepEqual(second.received.messages.filter(message => message.MessageType === 'UserDataChanged'), [{
      MessageType: 'UserDataChanged', MessageId: secondMessageId, Data: { Target: 'second' }
    }]);
    assert.equal(sessions.attachments, 1, 'one shared controller is attached for both sockets');
    assert.equal(sessions.detachments, 1, 'the shared controller detaches once when its last socket closes');
    assert.deepEqual(errors, []);
  } finally {
    for (const { socket } of clients) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    if (!webSocketsClosed) await webSockets.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('close waits for an established controller detach within the shutdown deadline', async () => {
  const server = createServer();
  const sessions = new EventEmitter();
  const detachGate = Promise.withResolvers();
  const detachStarted = Promise.withResolvers();
  let detachFinished = 0;
  sessions.logActivity = async () => ({ Id: 'slow-detach' });
  sessions.attachController = () => async () => {
    detachStarted.resolve();
    await detachGate.promise;
    detachFinished += 1;
  };
  const webSockets = createWebSocketServer({
    authentication: { authenticate: async () => ({ IsAuthenticated: true }) },
    sessions,
    localization: {
      negotiate: () => ({ uiCulture: 'en-US' }),
      run: (_locale, operation) => operation()
    }
  });
  let client;
  let closed = false;
  try {
    webSockets.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    client = await connect(`http://127.0.0.1:${server.address().port}`);
    const closing = webSockets.close();
    await detachStarted.promise;
    assert.equal(await Promise.race([closing.then(() => 'closed'), delay(20, 'waiting')]), 'waiting');
    detachGate.resolve();
    await closing;
    closed = true;
    assert.equal(detachFinished, 1);
  } finally {
    detachGate.resolve();
    if (client?.socket.readyState !== WebSocket.CLOSED) client?.socket.terminate();
    if (!closed) await webSockets.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('close bounds a pending activity handshake and forbids post-close controller attachment', async () => {
  const server = createServer();
  const sessions = new EventEmitter();
  const activity = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let attached = 0;
  sessions.logActivity = async () => {
    entered.resolve();
    return activity.promise;
  };
  sessions.attachController = () => {
    attached += 1;
    return () => {};
  };
  const errors = [];
  const webSockets = createWebSocketServer({
    authentication: { authenticate: async () => ({ IsAuthenticated: true }) },
    sessions,
    localization: {
      negotiate: () => ({ uiCulture: 'en-US' }),
      run: (_locale, operation) => operation()
    },
    onError: error => errors.push(error)
  });
  let socket;
  let closed = false;
  try {
    webSockets.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `ws://127.0.0.1:${server.address().port}`;
    socket = new WebSocket(`${origin}/socket?ApiKey=test-token`);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await entered.promise;

    await Promise.race([
      webSockets.close(),
      delay(1500).then(() => { throw new Error('WebSocket close did not bound a pending activity handshake.'); })
    ]);
    closed = true;
    activity.resolve({ Id: 'too-late' });
    await delay(20);

    assert.equal(attached, 0, 'a handshake completing after close must not attach a session controller');
    assert.deepEqual(errors, []);
    await webSockets.close();
  } finally {
    activity.resolve({ Id: 'cleanup' });
    if (socket?.readyState !== WebSocket.CLOSED) socket?.terminate();
    if (!closed) await webSockets.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('a client disconnect during activity logging still releases the created session', async () => {
  const server = createServer();
  const sessions = new EventEmitter();
  const activity = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const detached = Promise.withResolvers();
  let attached = 0;
  let detachments = 0;
  sessions.logActivity = async () => {
    entered.resolve();
    return activity.promise;
  };
  sessions.attachController = () => {
    attached += 1;
    return () => {
      detachments += 1;
      detached.resolve();
    };
  };
  const webSockets = createWebSocketServer({
    authentication: { authenticate: async () => ({ IsAuthenticated: true }) },
    sessions,
    localization: {
      negotiate: () => ({ uiCulture: 'en-US' }),
      run: (_locale, operation) => operation()
    }
  });
  let socket;
  let closed = false;
  try {
    webSockets.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/socket?ApiKey=test-token`);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await entered.promise;
    const socketClosed = new Promise(resolve => socket.once('close', resolve));
    socket.terminate();
    await socketClosed;

    activity.resolve({ Id: 'disconnected-activity' });
    await detached.promise;
    assert.equal(attached, 1);
    assert.equal(detachments, 1);

    await webSockets.close();
    closed = true;
  } finally {
    activity.resolve({ Id: 'cleanup' });
    if (socket?.readyState !== WebSocket.CLOSED) socket?.terminate();
    if (!closed) await webSockets.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('close destroys and bounds a raw upgrade waiting on authentication', async () => {
  const server = createServer();
  const sessions = new EventEmitter();
  const authenticationGate = Promise.withResolvers();
  const authenticationStarted = Promise.withResolvers();
  let attached = 0;
  sessions.attachController = () => { attached += 1; return () => {}; };
  const webSockets = createWebSocketServer({
    authentication: {
      authenticate: async () => {
        authenticationStarted.resolve();
        return authenticationGate.promise;
      }
    },
    sessions,
    localization: {
      negotiate: () => ({ uiCulture: 'en-US' }),
      run: (_locale, operation) => operation()
    }
  });
  let socket;
  let closed = false;
  try {
    webSockets.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/socket?ApiKey=test-token`);
    socket.on('error', () => {});
    await authenticationStarted.promise;

    await Promise.race([
      webSockets.close(),
      delay(1500).then(() => { throw new Error('WebSocket close did not bound a pending authentication upgrade.'); })
    ]);
    closed = true;
    const openConnections = await new Promise((resolve, reject) => {
      server.getConnections((error, count) => error ? reject(error) : resolve(count));
    });
    assert.equal(openConnections, 0, 'shutdown destroys the pre-WebSocket TCP connection');
    authenticationGate.resolve({ IsAuthenticated: true });
    await delay(20);
    assert.equal(attached, 0, 'late authentication cannot attach a session controller');
  } finally {
    authenticationGate.resolve({ IsAuthenticated: true });
    if (socket?.readyState !== WebSocket.CLOSED) socket?.terminate();
    if (!closed) await webSockets.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
