import { PluginHost } from '../../src/plugins/host.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../../src/http/application.js';
import { createRuntime } from '../../src/runtime.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const remoteConfiguration = {
  images: {
    backdrop_sizes: ['w300', 'original'],
    base_url: 'http://images.invalid/',
    logo_sizes: ['w45'],
    poster_sizes: ['w92'],
    profile_sizes: ['h632'],
    secure_base_url: 'https://images.invalid/',
    still_sizes: ['w185'],
    future_field: 'ignored',
  },
  change_keys: ['ignored'],
};

const expectedImages = {
  BackdropSizes: ['w300', 'original'],
  BaseUrl: 'http://images.invalid/',
  LogoSizes: ['w45'],
  PosterSizes: ['w92'],
  ProfileSizes: ['h632'],
  SecureBaseUrl: 'https://images.invalid/',
  StillSizes: ['w185'],
};

async function applicationFixture(tmdbClient, onError = () => {}) {
  const plugins=await PluginHost.open({options:{tmdb:{fetch:async()=>Response.json(await tmdbClient.getClientConfiguration())}}});
  const application = await createApplication({
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
    authentication: {
      async authenticate(request) {
        if (request.headers['x-emby-token'] !== 'fixture-token') throw Object.assign(new Error('Unauthorized'), { status: 401 });
        return { IsAuthenticated: true, IsAdministrator: false, User: { Policy: { EnableRemoteAccess: true } } };
      },
      read() { return { IsAuthenticated: false }; },
      authorize(auth, { policy }) {
        assert.equal(policy, 'Default');
        if (!auth.IsAuthenticated) throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
    },
    plugins,
    onError,
  });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  return {
    application,
    origin: `http://127.0.0.1:${application.server.address().port}`,
    close: async () => {await plugins.close();await new Promise(resolve => application.server.close(resolve));},
  };
}

test('TMDB client configuration requires default authentication and returns only native image fields', async () => {
  let calls = 0;
  const fixture = await applicationFixture({ async getClientConfiguration() { calls++; return remoteConfiguration; } });
  try {
    assert.ok(fixture.application.implementedRoutes.includes('GET /Tmdb/ClientConfiguration'));
    assert.equal((await fetch(`${fixture.origin}/Tmdb/ClientConfiguration`)).status, 401);
    const response = await fetch(`${fixture.origin}/Tmdb/ClientConfiguration`, { headers: { 'X-Emby-Token': 'fixture-token' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await response.json(), expectedImages);
    assert.equal(calls, 1, 'An unauthorized request must not call TMDB.');
  } finally { await fixture.close(); }
});

test('TMDB client configuration preserves native null and maps provider failures to 500', async () => {
  const nullFixture = await applicationFixture({ async getClientConfiguration() { return { images: null }; } });
  try {
    const response = await fetch(`${nullFixture.origin}/Tmdb/ClientConfiguration`, { headers: { 'X-Emby-Token': 'fixture-token' } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'null');
  } finally { await nullFixture.close(); }

  const upstream = Object.assign(new Error('Synthetic TMDB throttling response.'), { status: 429 });
  const errors = [];
  const failedFixture = await applicationFixture({ async getClientConfiguration() { throw upstream; } }, error => errors.push(error));
  try {
    const response = await fetch(`${failedFixture.origin}/Tmdb/ClientConfiguration`, { headers: { 'X-Emby-Token': 'fixture-token' } });
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'Error processing request.');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].cause, upstream);
  } finally { await failedFixture.close(); }
});

test('runtime manages the TMDB route and aborts owned transport on disable', async t => {
  let calls=0,wait=false;
  const started=Promise.withResolvers();
  const runtime=await createRuntime({database:await createPostgresTestDatabase(t,'tmdb_http_runtime'),
    configuration:{UICulture:'en-US',IsStartupWizardCompleted:true},serverId:'tmdb-http-test',
    pluginOptions:{options:{tmdb:{fetch:async(_url,{signal})=>{calls++;if(wait){started.resolve();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}return Response.json(remoteConfiguration);}}}}});
  t.after(()=>runtime.close());
  const apiKey=await runtime.apiKeys.create('TMDB HTTP tests');
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${runtime.server.address().port}/Tmdb/ClientConfiguration?ApiKey=${apiKey.AccessToken}`;
  assert.deepEqual(await (await fetch(url)).json(),expectedImages);assert.equal(calls,1);
  await runtime.plugins.clearCache('tmdb');wait=true;
  const pending=fetch(url);await started.promise;
  await runtime.plugins.setEnabled('tmdb',false);assert.equal((await pending).status,500);
  assert.equal((await fetch(url)).status,404);
  assert.equal(runtime.implementedRoutes.includes('GET /Tmdb/ClientConfiguration'),false);
  wait=false;await runtime.plugins.setEnabled('tmdb',true);
  assert.deepEqual(await (await fetch(url)).json(),expectedImages);
});
