import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createRuntime } from '../../src/runtime.js';
import { parseLosslessJson, stringifyNativeJson, withNativeNulls, cloneNativeValue } from '../../src/core/json.js';
import { assertProjectedEqual } from '../comparison-observations.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase,
  postgresTestConnectionString } from '../database/postgres-fixture.js';

test('lossless protocol integers survive parsing and native output omits null object fields',t=>{
  const value = parseLosslessJson('{"Ticks":9223372036854775807,"Null":null,"Values":[null,1]}');
  assert.equal(value.Ticks,9223372036854775807n);
  assertProjectedEqual(t,'Int64 and array null',stringifyNativeJson(value),'{"Ticks":9223372036854775807,"Values":[null,1]}',parseLosslessJson);
  assertProjectedEqual(t,'camel naming',stringifyNativeJson({URL:'x',UserId:'y',IsHD:true},{camel:true}),'{"url":"x","userId":"y","isHD":true}',parseLosslessJson);
  assertProjectedEqual(t,'explicit native null',stringifyNativeJson(withNativeNulls({ChannelId:null,Overview:null},['ChannelId'])), '{"ChannelId":null}',parseLosslessJson);
  assertProjectedEqual(t,'cloned dictionary',stringifyNativeJson(cloneNativeValue({NowPlayingItem:withNativeNulls({ChannelId:null,ProviderIds:new Map([['Tmdb','123']])},['ChannelId'])})), '{"NowPlayingItem":{"ChannelId":null,"ProviderIds":{"Tmdb":"123"}}}',parseLosslessJson);
});

test('native Dictionary entries retain spelling and null values under CamelCase DTO profiles',async()=>{
  const expected=await readFile(new URL('../fixtures/core/json-oracle.json',import.meta.url),'utf8');
  const actual=stringifyNativeJson({ProviderIds:new Map([['Tmdb','123'],['Imdb','tt'],['Missing',null]]),
    NullValue:null,Values:[null,1],URL:'x',UserId:'y',IsHD:true},{camel:true});
  assert.deepEqual(JSON.parse(actual),JSON.parse(expected));
});

test('native HTTP JSON preserves string values, property and dictionary keys and integer tokens', t => {
  const text = '"<>&\'`中😀\\\n';
  const escaped = String.raw`\u0022\u003C\u003E\u0026\u0027\u0060\u4E2D\uD83D\uDE00\\\n`;
  const value = { [text]: text, Values: [text, null], Dictionary: new Map([[text, text], ['Null', null]]), Ticks: 9223372036854775807n };
  const output = stringifyNativeJson(value);
  assertProjectedEqual(t, 'JSON escaping', output, '{"' + escaped + '":"' + escaped + '","Values":["' + escaped + '",null],"Dictionary":{"'
    + escaped + '":"' + escaped + '","Null":null},"Ticks":9223372036854775807}', parseLosslessJson);
  assert.deepEqual(parseLosslessJson(output), { [text]: text, Values: [text, null], Dictionary: { [text]: text, Null: null }, Ticks: 9223372036854775807n });
});

test('HTTP keeps native culture data with fixed English messages and MediaManager identity', {
  skip: !postgresTestConnectionString,
}, async(t)=>{
  const database = await createPostgresTestDatabase(null, 'core_http_local');
  let application;
  t.after(async()=>{ await application?.close(); await dropPostgresTestDatabase(database); });
  application = await createRuntime({configuration:{UICulture:'en-US',MetadataCountryCode:'US',IsStartupWizardCompleted:false},
    database,serverId:'a'.repeat(32)});
  application.server.listen(0,'127.0.0.1');
  await once(application.server,'listening');
  const cases = JSON.parse(await readFile(new URL('../fixtures/http/localization-reference.json',import.meta.url),'utf8'));
  const base = `http://127.0.0.1:${application.server.address().port}`;
  for (const reference of cases) {
    const response = await fetch(base+reference.route,{headers:{'accept':'application/json','accept-language':reference.language}});
    assert.equal(response.status,reference.status,reference.route);
    for (const [key,value] of Object.entries(reference.headers)) assert.equal(response.headers.get(key),key === 'content-language' ? 'en-US' : value,reference.route);
    let expected = parseLosslessJson(reference.body);
    if (reference.route === '/System/Ping') expected = 'MediaManager';
    if (reference.route.endsWith('/Options')) expected = expected.filter(item=>item.Value === 'en-US');
    assert.deepEqual(await response.json(),expected,reference.route+' '+reference.language);
  }
});

test('real authentication protects routes and missing routes never fabricate a result', {
  skip: !postgresTestConnectionString,
}, async(t)=>{
  const database = await createPostgresTestDatabase(null, 'core_http_auth');
  let application;
  t.after(async()=>{ await application?.close(); await dropPostgresTestDatabase(database); });
  application = await createRuntime({configuration:{IsStartupWizardCompleted:true},
    database,serverId:'a'.repeat(32)});
  application.server.listen(0,'127.0.0.1'); await once(application.server,'listening');
  const base = `http://127.0.0.1:${application.server.address().port}`;
  assert.equal((await fetch(base+'/Localization/Countries')).status,401);
  assert.equal((await fetch(base+'/Items')).status,401);
  assert.equal((await fetch(base+'/MissingEndpoint')).status,404);
});
