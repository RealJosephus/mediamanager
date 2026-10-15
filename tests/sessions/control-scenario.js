import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';

import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';

export async function record(origin) {
  const records = [], raw = [], sockets=[];
  const auth=(token,device)=>`MediaBrowser Client="SessionExpansion", Device="Isolated Device", DeviceId="${device}", Version="1.0"${token?`, Token="${token}"`:''}`;
  async function call(name,route,{token,device='controller',body,method=body?'POST':'GET'}={}) {
    const response=await fetch(origin+route,{method,headers:{Authorization:auth(token,device),...(body?{'Content-Type':'application/json'}:{})},body:body?stringifyNativeJson(body):undefined});
    const text=await response.text();let value=text;try{value=parseLosslessJson(text);}catch{}
    if(name)records.push({name,status:response.status,body:value});
    return value;
  }
  async function socket(token,name,language='en-US') {
    const ws=new WebSocket(origin.replace('http','ws')+`/socket?ApiKey=${token}`,{headers:{'Accept-Language':language}});sockets.push(ws);
    const messages=[];
    ws.on('message',bytes=>{const message=parseLosslessJson(bytes.toString());messages.push(message);raw.push({connection:name,message});});
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    async function next(type) {for(let n=0;n<100;n++){const index=messages.findIndex(message=>message.MessageType===type);if(index>=0)return messages.splice(index,1)[0];await delay(20);}throw new Error(`Missing ${type} on ${name}`);}
    return {ws,next,messages};
  }
  const controller=await call(null,'/Users/AuthenticateByName',{body:{Username:'CoreFlowAdmin',Pw:'isolated-core-flow-password'}});
  const player=await call(null,'/Users/AuthenticateByName',{device:'player',body:{Username:'CoreFlowAdmin',Pw:'isolated-core-flow-password'}});
  if(!controller.AccessToken||!player.AccessToken)throw new Error('Reference login failed.');
  const token=controller.AccessToken, sessionId=player.SessionInfo.Id;
  try {
    await call('capabilities','/Sessions/Capabilities/Full',{token:player.AccessToken,device:'player',body:{SupportsMediaControl:true,PlayableMediaTypes:['Video'],SupportedCommands:['SetVolume','DisplayMessage']}});
    const initial=await call(null,'/Sessions?deviceId=player',{token});
    records.push({name:'remote-before-socket',body:initial.map(item=>({Id:item.Id,SupportsRemoteControl:item.SupportsRemoteControl}))});
    const playerSocket=await socket(player.AccessToken,'player','zh-CN');
    records.push({name:'force-keepalive',body:await playerSocket.next('ForceKeepAlive')});
    playerSocket.ws.send('{"MessageType":"KeepAlive"}');
    records.push({name:'keepalive',body:await playerSocket.next('KeepAlive')});
    const connected=await call(null,'/Sessions?deviceId=player',{token});
    records.push({name:'remote-with-socket',body:connected.map(item=>({Id:item.Id,SupportsRemoteControl:item.SupportsRemoteControl}))});
    const commands=[
      ['pause',`/Sessions/${sessionId}/Playing/Pause`,undefined,'Playstate'],
      ['seek',`/Sessions/${sessionId}/Playing/Seek?seekPositionTicks=9007199254740993&controllingUserId=forged`,undefined,'Playstate'],
      ['command',`/Sessions/${sessionId}/Command/VolumeUp`,undefined,'GeneralCommand'],
      ['system',`/Sessions/${sessionId}/System/ToggleFullscreen`,undefined,'GeneralCommand'],
      ['full-command',`/Sessions/${sessionId}/Command`,{Name:'SetVolume',Arguments:{Volume:'37',MixedCase:null},ControllingUserId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},'GeneralCommand'],
      ['message',`/Sessions/${sessionId}/Message`,{Header:' ',Text:'中文 message',TimeoutMs:9007199254740993n},'GeneralCommand'],
      ['browse',`/Sessions/${sessionId}/Viewing?itemType=Movie&itemId=22222222222222222222222222222222&itemName=Movie`,undefined,'GeneralCommand'],
      ['play',`/Sessions/${sessionId}/Playing?itemIds=22222222222222222222222222222222&playCommand=PlayNow&startPositionTicks=9007199254740993&audioStreamIndex=2&subtitleStreamIndex=3&startIndex=0&mediaSourceId=source`,undefined,'Play'],
      ['play-missing',`/Sessions/${sessionId}/Playing?itemIds=ffffffffffffffffffffffffffffffff&playCommand=PlayNext`,undefined,'Play']
    ];
    for(const [name,route,body,type] of commands){await call(name,route,{token,body,method:'POST'});records.push({name:`${name}-wire`,body:await playerSocket.next(type)});}
    for(const [name,route,body] of [
      ['invalid-playstate',`/Sessions/${sessionId}/Playing/999`],['invalid-ticks',`/Sessions/${sessionId}/Playing/Seek?seekPositionTicks=9223372036854775808`],
      ['missing-session','/Sessions/missing/Playing/Pause'],['missing-message',`/Sessions/${sessionId}/Message`,{}]])await call(name,route,{token,body,method:'POST'});
    playerSocket.ws.send('{"MessageType":"SessionsStart","Data":"0,10000"}');
    await delay(100);
    await call('capabilities-event','/Sessions/Capabilities/Full',{token:player.AccessToken,device:'player',body:{SupportsMediaControl:true,PlayableMediaTypes:['Video'],SupportedCommands:['SetVolume']}});
    const event=await playerSocket.next('Sessions');
    records.push({name:'sessions-event',body:{MessageType:event.MessageType,Data:event.Data.map(item=>({Id:item.Id,SupportsRemoteControl:item.SupportsRemoteControl,SupportedCommands:item.SupportedCommands})).sort((a,b)=>a.Id.localeCompare(b.Id))}});
    playerSocket.ws.send('{"MessageType":"SessionsStop"}');
    const nextSocket=await socket(player.AccessToken,'player-second');
    await nextSocket.next('ForceKeepAlive');
    nextSocket.ws.send('{"MessageType":"KeepAlive"}');await nextSocket.next('KeepAlive');
    await call('latest-socket',`/Sessions/${sessionId}/Playing/Unpause`,{token,method:'POST'});
    records.push({name:'latest-socket-wire',body:await nextSocket.next('Playstate')});
    nextSocket.ws.close();await new Promise(resolve=>nextSocket.ws.once('close',resolve));await delay(100);
    await call('remaining-socket',`/Sessions/${sessionId}/Playing/Stop`,{token,method:'POST'});
    records.push({name:'remaining-socket-wire',body:await playerSocket.next('Playstate')});
    playerSocket.ws.close();await new Promise(resolve=>playerSocket.ws.once('close',resolve));await delay(100);
    records.push({name:'ended-after-final-socket',body:(await call(null,'/Sessions?deviceId=player',{token})).length});
    return {records,raw,identities:{controllerId:controller.SessionInfo.Id,playerId:sessionId,userId:controller.User.Id}};
  } finally {for(const ws of sockets)ws.terminate();}
}
