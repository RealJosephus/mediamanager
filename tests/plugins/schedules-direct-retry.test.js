import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSchedulesDirectProvider } from '../../plugins/schedules-direct/provider.js';

const start = '2025-03-01T12:00:00Z', end = '2025-03-01T13:00:00Z';
const account = { Username: 'user', Password: 'example', ListingsId: 'A' };
const routes = JSON.parse(await readFile(new URL('./fixtures/schedules-direct/input.json', import.meta.url), 'utf8'));
const routeOf = url => new URL(url).pathname.slice('/20141201'.length);

test('a canceled status check permits an immediate independent listings refresh', async () => {
  const canceled = new AbortController();
  let checks = 0;
  const provider = createSchedulesDirectProvider({ cachePath: '/unused', now: () => Date.parse(start), fetch: async (url, init) => {
    const route = routeOf(url);
    if (route === '/status' && ++checks === 1) {
      canceled.abort(new Error('first guide refresh canceled'));
      throw canceled.signal.reason;
    }
    return Response.json(routes[init.method + ' ' + route]);
  } });
  await assert.rejects(provider.getChannels(account, { signal: canceled.signal }), /first guide refresh canceled/);
  const channels = await provider.getChannels(account);
  assert.equal(channels[0].Number, '7');
  assert.equal(checks, 2);
});

test('artwork uses the renewed session when the guide hash request had to renew the token', async () => {
  let tokens = 0, hashes = 0;
  const provider = createSchedulesDirectProvider({ cachePath: '/unused', now: () => Date.parse(start), fetch: async (url, init) => {
    const route = routeOf(url);
    if (route === '/token') return Response.json({ message: 'OK', token: 'fixture-' + ++tokens });
    if (route === '/schedules/md5' && ++hashes === 1) return Response.json({ code: 1004 }, { status: 403 });
    if (['/schedules','/programs','/metadata/programs/'].includes(route)) assert.equal(init.headers.token, 'fixture-2');
    return Response.json(routes[init.method + ' ' + route]);
  } });
  const [program] = await provider.getPrograms(account, '21', start, end);
  assert.equal(tokens, 2);
  assert.equal(new URL(program.ImageUrl).searchParams.get('token'), 'fixture-2');
});
