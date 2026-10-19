import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PluginHost } from '../../src/plugins/host.js';

export async function pluginFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'plugin-lifecycle-'));
  let host = await PluginHost.open({directory:path.join(root,'host'),preinstalled:false,...options});
  t.after(async()=>{try{await host.close();}finally{await fs.rm(root,{recursive:true,force:true});}});
  return {root,get host(){return host;},async reopen(){await host.close();host=await PluginHost.open({directory:path.join(root,'host'),preinstalled:false,...options});return host;}};
}

export async function fixturePackage(root, {id='fixture',version='0.1.0',label='initial',failure,wait=false,frozen=false}={}) {
  const directory=path.join(root,'source-'+randomUUID());await fs.mkdir(directory);
  const manifest={name:'@test/'+id,version,type:'module',mediamanager:{id,name:'Controlled test plugin',entry:'index.js'}};
  await fs.writeFile(path.join(directory,'package.json'),JSON.stringify(manifest));
  await fs.writeFile(path.join(directory,'index.js'),`
import fs from 'node:fs/promises';
import path from 'node:path';
export function validateConfiguration(configuration) {
  if (Object.keys(configuration).some(key=>!['message','wait'].includes(key)) || configuration.message!==undefined && typeof configuration.message!=='string') throw new TypeError('Invalid fixture configuration.');
}
export async function activate(context) {
  const label=${JSON.stringify(label)};
  const record=event=>fs.appendFile(path.join(context.dataPath,'events.txt'),event+' '+label+'\\n');
  await record('activate');context.own(()=>record('close'));
  ${failure==='activate'?'throw new Error("Controlled activation failure.");':''}
  ${wait?'const alive=setInterval(()=>{},1000);context.own(()=>clearInterval(alive));await fs.writeFile(path.join(context.dataPath,"prepared"),label);await new Promise(()=>{});':''}
  const provider={id:'fixture-provider',name:'Controlled test plugin',kind:'local',itemTypes:['Movie'],
    async getMetadata(item,{signal}) {
      await record('start');
      if(context.configuration.wait) await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
      return {HasMetadata:true,Item:{...item,Name:context.configuration.message??label},People:[]};
    }};
  await context.register('metadata',{id:context.id,name:'Controlled test plugin',providers:[${frozen?'Object.freeze(provider)':'provider'}]});
  await context.register('route',{method:'GET',path:'/Fixture/Echo',handle:async()=>({label,message:context.configuration.message??null})});
  await context.register('route',{method:'GET',path:'/Fixture/Wait',async handle({signal}){
    await record('route');await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  }});
  await fs.writeFile(path.join(context.cachePath,'entry'),label);
  return {configuration:context.configuration,fields:{message:{kind:'string'}},async connect(){${failure==='connect'?'throw new Error("Controlled connection failure.");':''}}};
}
`);
  return directory;
}
