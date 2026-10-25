import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerLiveTvSourceRoutes } from '../../src/http/live-tv-source-routes.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';

test('source action registration preserves elevation, typed bodies, aliases and password/query conversion', async () => {
  const routes = new Map(), calls = [];
  const sources = Object.fromEntries(['saveTunerHost', 'deleteTunerHost', 'getTunerHostTypes', 'discoverTuners',
    'saveListingProvider', 'deleteListingsProvider', 'getLineups', 'getChannelMappingOptions', 'setChannelMapping']
    .map(name => [name, (...args) => { calls.push({ name, args }); return args[0]; }]));
  const bytes = Buffer.from('{"fixture":true}'); sources.getCountries = () => bytes;
  registerLiveTvSourceRoutes((method, route, handler, options) => routes.set(method + ' ' + route, { handler, options }), { liveTvSources: sources });
  const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'source-action-control' });
  const ordinary = { IsAuthenticated: true, IsAdministrator: false, User: { Policy: { EnableLiveTvAccess: true } } };
  for (const [name, { options }] of routes) {
    const readAccess = ['GET /LiveTv/TunerHosts/Types', 'GET /LiveTv/ListingProviders/Default', 'GET /LiveTv/ListingProviders/Lineups'].includes(name);
    assert.equal(options.policy, readAccess ? 'LiveTvAccess' : 'RequiresElevation', name);
    if (!readAccess) assert.throws(() => authentication.authorize(ordinary, options), { status: 403 });
  }
  const invoke = async (name, query = '', source) => {
    const route = routes.get(name), context = { query: new URLSearchParams(query) };
    if (source !== undefined) context.body = route.options.bindBody(null, source);
    return route.handler(context);
  };
  await invoke('POST /LiveTv/TunerHosts', '', '{"type":"controlled","tunercount":"2"}');
  assert.equal(calls.at(-1).args[0].TunerCount, 2); assert.equal(calls.at(-1).args[0].AllowHWTranscoding, true);
  for (const suffix of ['Discover', 'Discvover']) {
    await invoke('GET /LiveTv/Tuners/' + suffix, 'NEWDEVICESONLY=true');
    assert.deepEqual(calls.at(-1), { name: 'discoverTuners', args: [true] });
  }
  const beforeInvalid = calls.length;
  await assert.rejects(invoke('GET /LiveTv/Tuners/Discover', 'newDevicesOnly=1'), { status: 400 });
  assert.equal(calls.length, beforeInvalid);
  await invoke('POST /LiveTv/ListingProviders', 'pw=' + encodeURIComponent(' controlled fixture ') + '&validateLogin=true', '{"Type":"controlled"}');
  assert.equal(calls.at(-1).args[0].Password, createHash('sha1').update(' controlled fixture ').digest('hex'));
  assert.deepEqual(calls.at(-1).args[1], { validateListings: false, validateLogin: true });
  await invoke('POST /LiveTv/ListingProviders', 'pw=%20%20', '{"Password":"retained-fixture"}');
  assert.equal(calls.at(-1).args[0].Password, 'retained-fixture');
  await invoke('GET /LiveTv/ListingProviders/Lineups', 'id=%20%20&type=%20controlled%20&country=US');
  assert.deepEqual(calls.at(-1).args, [{ type: ' controlled ', id: null, location: null, country: 'US' }]);
  assert.equal((await invoke('DELETE /LiveTv/TunerHosts', 'id=%20%20')).status, 204);
  assert.deepEqual(calls.at(-1).args, [null]);
  await assert.rejects(invoke('POST /LiveTv/ChannelMappings', '', '{}'), { status: 400 });
  await assert.rejects(invoke('POST /LiveTv/TunerHosts', '', 'null'), { status: 400 });
  await invoke('POST /LiveTv/ChannelMappings', '', '{"providerid":1,"tunerchannelid":true,"providerchannelid":"epg"}');
  assert.deepEqual(calls.at(-1).args, ['1', 'true', 'epg']);
  const result = await invoke('GET /LiveTv/ListingProviders/SchedulesDirect/Countries');
  const headers = {}, chunks = [];
  await result.send({ method: 'GET' }, { setHeader: (key, value) => { headers[key] = value; }, write: chunk => chunks.push(chunk), end() {} });
  assert.equal(headers['Content-Type'], 'application/json'); assert.deepEqual(Buffer.concat(chunks), bytes);
});
