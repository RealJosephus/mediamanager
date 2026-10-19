import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { AutoDiscoveryService, createDiscoveryAddressResolver } from '../../src/network/auto-discovery.js';
import { createRuntime } from '../../src/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { assertProjectedEqual } from '../comparison-observations.js';

function bind(socket, options) {
  return new Promise((resolve, reject) => {
    const failed = error => { socket.off('listening', listening); reject(error); };
    const listening = () => { socket.off('error', failed); resolve(socket.address()); };
    socket.once('error', failed).once('listening', listening).bind(options);
  });
}

function close(socket) {
  return new Promise((resolve, reject) => {
    socket.close(error => error ? reject(error) : resolve());
  });
}

function send(socket, value, port) {
  return new Promise((resolve, reject) => {
    socket.send(Buffer.from(value, 'utf8'), port, '127.0.0.1', error => error ? reject(error) : resolve());
  });
}

function receive(socket, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for a UDP datagram.')), timeoutMs);
    const received = (message, remote) => finish(null, { message, remote });
    const failed = error => finish(error);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off('message', received);
      socket.off('error', failed);
      if (error) reject(error); else resolve(value);
    };
    socket.once('message', received).once('error', failed);
  });
}

async function expectNoMessage(socket, timeoutMs = 75) {
  await assert.rejects(receive(socket, timeoutMs), /Timed out waiting/u);
}

test('disabled discovery never creates or binds a socket', async () => {
  let sockets = 0;
  const discovery = new AutoDiscoveryService({
    enabled: false,
    serverId: 'disabled-id',
    resolveAddress: async () => 'http://127.0.0.1:8096',
    createSocket() { sockets += 1; throw new Error('must not create a socket'); }
  });
  assert.equal(await discovery.start(), null);
  assert.equal(discovery.address(), null);
  assert.equal(sockets, 0);
  await discovery.close();
  await discovery.close();
});

test('v2 discovery matches ordinal-ignore-case and unicasts the native DTO to the sender', async t => {
  const requests = [];
  const discovery = new AutoDiscoveryService({
    serverId: "id<&'\"",
    serverName: "伺服器 <script>&'\" 😀 \u2028 \u2029 bad:\uD800:x:\uDC00:end",
    port: 0,
    resolveAddress: async remote => {
      requests.push(remote);
      return "http://127.0.0.1:8096/媒体/<tag>&'\"+\\\b\f\n\r\t\u0001\u2028";
    }
  });
  const client = createSocket('udp4');
  const bystander = createSocket('udp4');
  t.after(async () => {
    if (client.address) try { await close(client); } catch { /* Already closed. */ }
    if (bystander.address) try { await close(bystander); } catch { /* Already closed. */ }
    await discovery.close();
  });
  await bind(client, { address: '127.0.0.1', port: 0, exclusive: true });
  await bind(bystander, { address: '127.0.0.1', port: 0, exclusive: true });
  const listening = await discovery.start();
  assert.equal(listening.address, '0.0.0.0');

  await send(client, 'who is another server?', listening.port);
  await expectNoMessage(client);
  assert.deepEqual(requests, []);

  const response = receive(client);
  await send(client, 'prefix WHO IS jElLyFiNsErVeR? suffix', listening.port);
  const { message, remote } = await response;
  assert.equal(remote.port, listening.port);
  // Preserve the original native recording; release comparison uses its four fields.
  assertProjectedEqual(t, 'UDP JSON', message.toString('hex').toUpperCase(),
    '7B2241646472657373223A22687474703A2F2F3132372E302E302E313A383039362F5C75354139325C75344635332F5C75303033437461675C75303033455C75303032365C75303032375C75303032325C75303032425C5C5C625C665C6E5C725C745C75303030315C7532303238222C224964223A2269645C75303033435C75303032365C75303032375C7530303232222C224E616D65223A225C75344633415C75363730445C7535363638205C75303033437363726970745C75303033455C75303032365C75303032375C7530303232205C75443833445C7544453030205C7532303238205C7532303239206261643A5C75464646443A783A5C75464646443A656E64222C22456E64706F696E7441646472657373223A6E756C6C7D',
    value => JSON.parse(Buffer.from(value, 'hex').toString('utf8')));
  assert.ok(message.length <= 65_507, 'the response fits a single IPv4 UDP datagram');
  assert.deepEqual(JSON.parse(message.toString('utf8')), {
    Address: "http://127.0.0.1:8096/媒体/<tag>&'\"+\\\b\f\n\r\t\u0001\u2028",
    Id: "id<&'\"",
    Name: "伺服器 <script>&'\" 😀 \u2028 \u2029 bad:\uFFFD:x:\uFFFD:end",
    EndpointAddress: null
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].port, client.address().port);
  await expectNoMessage(bystander);

  const releasedPort = listening.port;
  await discovery.close();
  const replacement = createSocket('udp4');
  await bind(replacement, { address: '0.0.0.0', port: releasedPort, exclusive: true });
  await close(replacement);
});

test('address resolution advertises only a proven HTTP listener and route, unless an explicit URL is injected', async () => {
  let listening = null;
  let route = '127.0.0.1';
  let routeCalls = 0;
  const server = { address: () => listening };
  const resolve = createDiscoveryAddressResolver({
    server,
    baseUrl: '/native',
    resolveRouteAddress: async () => { routeCalls += 1; return route; }
  });
  const remote = { address: '127.0.0.1', port: 12345, family: 'IPv4' };
  assert.equal(await resolve(remote), null);
  assert.equal(routeCalls, 0);

  listening = { address: '127.0.0.1', port: 19000, family: 'IPv4' };
  assert.equal(await resolve(remote), 'http://127.0.0.1:19000/native');
  route = '192.0.2.10';
  assert.equal(await resolve(remote), null, 'a concrete listener cannot advertise another interface');
  listening = { address: '0.0.0.0', port: 19001, family: 'IPv4' };
  assert.equal(await resolve(remote), 'http://192.0.2.10:19001/native');
  route = '0.0.0.0';
  assert.equal(await resolve(remote), null, 'an unspecified route is not a reachable advertised address');

  const explicit = createDiscoveryAddressResolver({
    server: { address: () => null },
    publishedUrl: 'https://proxy.example.test/jellyfin/'
  });
  assert.equal(await explicit(remote), 'https://proxy.example.test/jellyfin');
});

test('runtime exposes a waitable post-listen start and advertises its actual HTTP port even with native HTTPS enabled', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const database = await createPostgresTestDatabase(null, 'auto_discovery');
  const runtime = await createRuntime({
    database,
    configuration: { UICulture: 'en-US', BaseUrl: '/native', NetworkConfiguration: { EnableHttps: true } },
    serverId: 'runtime-discovery-id',
    serverName: 'Runtime Discovery',
    autoDiscoveryOptions: { enabled: true, port: 0, resolveRouteAddress: async () => '127.0.0.1' }
  });
  const client = createSocket('udp4');
  t.after(async () => {
    try { await close(client); } catch { /* Already closed. */ }
    await runtime.close().catch(() => {});
    await dropPostgresTestDatabase(database);
  });
  await assert.rejects(() => runtime.startAutoDiscovery(), { code: 'ERR_HTTP_SERVER_NOT_LISTENING' });
  assert.equal(runtime.autoDiscovery.address(), null);
  await new Promise((resolve, reject) => {
    runtime.server.once('error', reject).listen(0, '127.0.0.1', resolve);
  });
  const httpPort = runtime.server.address().port;
  const udpAddress = await runtime.startAutoDiscovery();
  await bind(client, { address: '127.0.0.1', port: 0, exclusive: true });
  const response = receive(client);
  await send(client, 'who is JellyfinServer?', udpAddress.port);
  const body = JSON.parse((await response).message.toString('utf8'));
  assert.deepEqual(body, {
    Address: `http://127.0.0.1:${httpPort}/native`,
    Id: 'runtime-discovery-id',
    Name: 'Runtime Discovery',
    EndpointAddress: null
  });

  const releasedPort = udpAddress.port;
  await runtime.close();
  assert.equal(runtime.server.listening, false);
  const replacement = createSocket('udp4');
  await bind(replacement, { address: '0.0.0.0', port: releasedPort, exclusive: true });
  await close(replacement);
  await assert.rejects(database.rows('Users'), /not open|closed/iu);
});

test('bind failure rolls back the discovery socket and runtime close releases the HTTP listener', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const blocker = createSocket('udp4');
  t.after(async () => {
    try { await close(blocker); }
    catch (error) { if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw error; }
  });
  const occupied = await bind(blocker, { address: '0.0.0.0', port: 0, exclusive: true });
  const database = await createPostgresTestDatabase(null, 'discovery_fail');
  t.after(() => dropPostgresTestDatabase(database));
  const runtime = await createRuntime({
    database,
    configuration: { UICulture: 'en-US' },
    serverId: 'runtime-discovery-failure',
    autoDiscoveryOptions: { enabled: true, port: occupied.port, resolveAddress: async () => 'http://127.0.0.1' }
  });
  try {
    await new Promise((resolve, reject) => runtime.server.once('error', reject).listen(0, '127.0.0.1', resolve));
    await assert.rejects(runtime.startAutoDiscovery(), { code: 'EADDRINUSE' });
    await runtime.close();
    assert.equal(runtime.server.listening, false);
    assert.equal(runtime.autoDiscovery.address(), null);
    await assert.rejects(database.rows('Users'), /not open|closed/iu);
  } finally {
    await runtime.close().catch(() => {});
    await close(blocker);
  }
  const replacement = createSocket('udp4');
  await bind(replacement, { address: '0.0.0.0', port: occupied.port, exclusive: true });
  await close(replacement);
});

test('close is bounded when an injected resolver ignores cancellation', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers();
  const discovery = new AutoDiscoveryService({
    serverId: 'bounded-close',
    port: 0,
    closeTimeoutMs: 30,
    resolveAddress: async () => {
      entered.resolve();
      return new Promise(() => {});
    }
  });
  t.after(async () => {
    try { await discovery.close(); }
    catch (error) { assert.match(error.message, /Timed out draining UDP auto-discovery work/u); }
  });
  const client = createSocket('udp4');
  t.after(async () => { try { await close(client); } catch { /* Already closed. */ } });
  await bind(client, { address: '127.0.0.1', port: 0, exclusive: true });
  const listening = await discovery.start();
  await send(client, 'who is JellyfinServer?', listening.port);
  await entered.promise;
  const started = Date.now();
  const closing = discovery.close();
  await assert.rejects(closing, /Timed out draining UDP auto-discovery work/u);
  assert.equal(discovery.close(), closing);
  assert.ok(Date.now() - started < 500, 'close must not wait forever for an injected resolver');
  const replacement = createSocket('udp4');
  await bind(replacement, { address: '0.0.0.0', port: listening.port, exclusive: true });
  await close(replacement);
});
