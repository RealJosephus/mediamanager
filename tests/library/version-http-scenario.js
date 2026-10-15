import {parseLosslessJson,stringifyNativeJson} from '../../src/core/json.js';
const ids=['22222222-2222-2222-2222-222222222222','A2222222-2222-2222-2222-222222222222','B2222222-2222-2222-2222-222222222222'];
export async function recordVersionHttp(origin) {
 const base='MediaBrowser Client="VersionsOracle", Device="Isolated", DeviceId="versions-oracle", Version="1"';
 const login=await(await fetch(origin+'/Users/AuthenticateByName',{method:'POST',headers:{Authorization:base,'Content-Type':'application/json'},body:'{"Username":"CoreFlowAdmin","Pw":"isolated-core-flow-password"}'})).json();
 if(!login.AccessToken)throw new Error('Isolated login failed');
 const headers={Authorization:base+`, Token="${login.AccessToken}"`,'Content-Type':'application/json'};
 const records=[];async function call(name,route,method='GET',body){const response=await fetch(origin+route,{method,headers,body:body===undefined?undefined:stringifyNativeJson(body)});const text=await response.text();let parsed=text;try{parsed=parseLosslessJson(text);}catch{}records.push({name,status:response.status,body:parsed});return parsed;}
 const user=(await(await fetch(origin+'/Users/'+login.User.Id,{headers})).json());
 user.Policy.EnableVideoPlaybackTranscoding=false;user.Policy.EnableAudioPlaybackTranscoding=false;
 await call('disable-encoding','/Users/'+user.Id+'/Policy','POST',user.Policy);
 for(const [index,id]of ids.entries())await call('detail-'+index,'/Items/'+id);
 for(const [index,id]of ids.entries())await call('playback-'+index,'/Items/'+id+'/PlaybackInfo','POST',{});
 for(const [index,id]of ids.entries())await call('progress-'+index,`/UserItems/${id}/UserData`,'POST',{PlaybackPositionTicks:BigInt(index*10000000),LastPlayedDate:`2026-09-2${index}T12:00:00.1234567Z`});
 await call('resume-primary','/Items/'+ids[0]);await call('resume-alternate','/Items/'+ids[1]);
 user.Policy.BlockedTags=['restricted'];await call('restrict-version','/Users/'+user.Id+'/Policy','POST',user.Policy);
 await call('restricted-primary','/Items/'+ids[0]);await call('restricted-playback','/Items/'+ids[0]+'/PlaybackInfo','POST',{});await call('restricted-alternate','/Items/'+ids[2]);

 return records;
}
