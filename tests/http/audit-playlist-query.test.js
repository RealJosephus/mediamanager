import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { unusedPort, portAvailable } from '../helpers/library-exchange-state.js';
import { createWebServerFixture } from '../web/web-fixture.js';

export const requiredValidationServices = ['postgres','dotnet','jellyfinDll','nativeInstance','currentNativeSqlite'];
async function observations(origin, token, userId) {
  const rows = [];
  for (const [label, query, body] of [
    ['body','',{Name:'Audit body only'}],
    ['query','?name=Audit%20query%20only&mediaType=Audio',undefined],
    ['both','?name=Audit%20query%20wins&mediaType=Audio',{Name:'Audit body fallback',MediaType:'Audio'}]
  ]) {
    const headers = {Authorization:'MediaBrowser Token="' + token + '"',Accept:'application/json'};
    if (body) headers['Content-Type'] = 'application/json';
    const create = await fetch(origin+'/Playlists'+query,{method:'POST',headers,body:body && JSON.stringify(body)});
    const raw = await create.text();
    const row = {label,status:create.status};
    if (create.ok) {
      const id = JSON.parse(raw).Id;
      const item = await fetch(origin + '/Users/' + userId + '/Items/' + id, {headers});
      row.read = item.status;
      const text = await item.text();
      if (item.ok) row.name = JSON.parse(text).Name;
    }
    rows.push(row);
  }
  return rows;
}
test('legacy and current playlist creation record the same status and persisted name', {timeout:300000}, async t => {
  const current = await currentNativeReference();
  const parent = await mkdtemp(path.join(tmpdir(),'audit-playlist-'));
  const clone = path.join(parent,'instance'), port = await unusedPort(), origin = 'http://127.0.0.1:' + port;
  let reference, candidate;
  try {
    await cp(current.sourceRoot,clone,{recursive:true});
    await mkdir(path.join(clone,'log'),{recursive:true});
    await current.prepareClone(clone,port);
    reference = current.start({referenceRoot:clone,outputRoot:parent,label:'playlist',origin});
    await reference.ready();
    const native = await observations(origin,current.accessToken,current.userId);
    candidate = await createWebServerFixture({signal:t.signal});
    const login = await fetch(candidate.origin + '/Users/AuthenticateByName',{method:'POST',
      headers:{Authorization:'MediaBrowser Client="Playlist Audit", Device="Fixture", DeviceId="playlist-audit", Version="1"','Content-Type':'application/json'},
      body:JSON.stringify({Username:candidate.username,Pw:candidate.password})});
    assert.equal(login.status,200);
    const account = await login.json();
    const actual = await observations(candidate.origin,account.AccessToken,account.User.Id);
    t.diagnostic('AUDIT '+JSON.stringify({native,actual}));
    assert.ok(native.every(row=>row.status===200 && row.read===200));
    assert.deepEqual(actual,native);
  } finally {
    try { await candidate?.close(); }
    finally {
      try {
        if (reference) {
          const stopped=await reference.stop(async ()=>(await fetch(origin+'/System/Shutdown',{method:'POST',headers:{'X-Emby-Token':current.accessToken}})).status,()=>portAvailable(port));
          assert.ok(stopped.cleanShutdown && stopped.pidGone && stopped.portAvailable);
        }
      } finally {
        try {await current.finish();} finally {assert.equal(path.dirname(parent),tmpdir());await rm(parent,{recursive:true,force:true});}
      }
    }
  }
});
