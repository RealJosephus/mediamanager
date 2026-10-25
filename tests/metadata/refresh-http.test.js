import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApplication } from '../helpers/application.js';
import inputs from './fixtures/refresh-http/input.json' with {type:'json'};
import expected from './fixtures/refresh-http/reference.json' with {type:'json'};

const itemId = '22222222222222222222222222222222';
async function fixture(metadata) {
  const errors = [];
  const application = await createTestApplication({configuration:{UICulture:'en-US',IsStartupWizardCompleted:true},
    authentication:{authenticate:async()=>({IsAuthenticated:true,IsAdministrator:true}),authorize(_auth,{policy}){assert.equal(policy,'RequiresElevation');}},
    library:{async getItemRecord(id){if(id!==itemId)throw Object.assign(new Error('Missing'),{status:404});return {Id:id,Type:'Movie'};}},
    metadata,onError:error=>errors.push(error)});
  await new Promise(resolve=>application.server.listen(0,'127.0.0.1',resolve));
  return {errors,origin:`http://127.0.0.1:${application.server.address().port}`,close:()=>new Promise(resolve=>application.server.close(resolve))};
}

test('metadata refresh query binding matches 13 isolated native HTTP responses',async()=>{
  const queued=[];
  const app=await fixture({validateRefresh(){},async queue(...args){queued.push(args);}});
  try {
    const records=[];
    for(const input of inputs){
      const response=await fetch(`${app.origin}/Items/${input.id}/Refresh${input.query}`,{method:'POST'});
      const text=await response.text();let body=text;try{body=JSON.parse(text);}catch{}
      records.push({name:input.name,status:response.status,body});
    }
    const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='traceId').map(([key,value])=>[key,normalize(value)])):value;
    assert.deepEqual(normalize(records),normalize(expected));
    assert.equal(queued.length,3);
    for(const [id,options,priority] of queued){assert.equal(id,itemId);assert.equal(options.MetadataRefreshMode,'None');assert.equal(options.ForceSave,false);assert.equal(priority,0);}
  }finally{await app.close();}
});

test('metadata refresh queues work, passes replacement flags, and reports background failures',async()=>{
  let finish, queued;
  const pending=new Promise((_,reject)=>{finish=reject;});
  const app=await fixture({validateRefresh(){},queue(id,options){queued={id,options};return pending;}});
  try {
    const response=await fetch(`${app.origin}/Items/${itemId}/Refresh?metadataRefreshMode=FullRefresh&replaceAllMetadata=true`,{method:'POST'});
    assert.equal(response.status,204);
    assert.deepEqual(queued,{id:itemId,options:{MetadataRefreshMode:'FullRefresh',ImageRefreshMode:'None',ReplaceAllMetadata:true,ReplaceAllImages:false,RegenerateTrickplay:false,IsAutomated:false,ForceSave:true,RemoveOldMetadata:true}});
    const failure=new Error('Synthetic provider failure');finish(failure);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(app.errors,[failure]);
  }finally{await app.close();}
});

test('metadata refresh queues full image replacement and only rejects generated media or missing storage',async()=>{
  const queued=[];
  const app=await fixture({validateRefresh(item){if(item.Type!=='Movie')throw new Error('Unexpected');},async queue(...args){queued.push(args);}});
  try {
    for(const query of ['imageRefreshMode=FullRefresh','replaceAllImages=true'])assert.equal((await fetch(`${app.origin}/Items/${itemId}/Refresh?${query}`,{method:'POST'})).status,204);
    assert.equal((await fetch(`${app.origin}/Items/${itemId}/Refresh?regenerateTrickplay=true`,{method:'POST'})).status,501);
    assert.deepEqual(queued.map(([,options])=>({ImageRefreshMode:options.ImageRefreshMode,ReplaceAllImages:options.ReplaceAllImages,ForceSave:options.ForceSave,RemoveOldMetadata:options.RemoveOldMetadata})),[
      {ImageRefreshMode:'FullRefresh',ReplaceAllImages:false,ForceSave:true,RemoveOldMetadata:false},
      {ImageRefreshMode:'None',ReplaceAllImages:true,ForceSave:true,RemoveOldMetadata:false},
    ]);
  }finally{await app.close();}
  const noStorage=await fixture();
  try{assert.equal((await fetch(`${noStorage.origin}/Items/${itemId}/Refresh`,{method:'POST'})).status,501);}finally{await noStorage.close();}
});

test('folder refresh uses the shared metadata queue with native high priority and refresh options',async()=>{
  const queued=[];
  const application=await createTestApplication({configuration:{UICulture:'en-US',IsStartupWizardCompleted:true},
    authentication:{authenticate:async()=>({IsAuthenticated:true,IsAdministrator:true}),authorize(_auth,{policy}){assert.equal(policy,'RequiresElevation');}},
    library:{async getItemRecord(id){return {Id:id,Type:'Folder',IsFolder:true,Path:'Z:\\Library'};}},
    metadata:{validateRefresh(item){assert.equal(item.Type,'Folder');},async queue(id,options,priority){queued.push({id,options,priority});}}});
  await new Promise(resolve=>application.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${application.server.address().port}`;
  try{
    assert.equal((await fetch(`${origin}/Items/${itemId}/Refresh`,{method:'POST'})).status,204);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(queued,[{id:itemId,priority:0,options:{MetadataRefreshMode:'None',ImageRefreshMode:'None',ReplaceAllMetadata:false,
      ReplaceAllImages:false,RegenerateTrickplay:false,IsAutomated:false,ForceSave:false,RemoveOldMetadata:false}}]);
    assert.equal((await fetch(`${origin}/Items/${itemId}/Refresh?metadataRefreshMode=ValidationOnly`,{method:'POST'})).status,204);
    assert.equal((await fetch(`${origin}/Items/${itemId}/Refresh?metadataRefreshMode=FullRefresh`,{method:'POST'})).status,204);
    assert.equal((await fetch(`${origin}/Items/${itemId}/Refresh?imageRefreshMode=ValidationOnly`,{method:'POST'})).status,204);
    assert.deepEqual(queued.map(entry=>[entry.priority,entry.options.MetadataRefreshMode,entry.options.ImageRefreshMode,entry.options.ForceSave]),
      [[0,'None','None',false],[0,'ValidationOnly','None',false],[0,'FullRefresh','None',true],[0,'None','ValidationOnly',false]]);
  }finally{await new Promise(resolve=>application.server.close(resolve));}
});

test('library refresh queues one background generation, returns immediately and reports failures',async()=>{
  const errors=[];
  let rejectScan, queued=0;
  const pending=new Promise((_,reject)=>{rejectScan=reject;});
  const application=await createTestApplication({configuration:{UICulture:'en-US',IsStartupWizardCompleted:true},
    authentication:{authenticate:async()=>({IsAuthenticated:true,IsAdministrator:true}),authorize(_auth,{policy}){assert.equal(policy,'RequiresElevation');}},
    libraryScanner:{capabilities:{completeLibraryScan:true}},tasks:{cancelIfRunningAndQueue(){queued++;return pending;}},onError:error=>errors.push(error)});
  await new Promise(resolve=>application.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${application.server.address().port}`;
  try{
    const response=await Promise.race([
      fetch(`${origin}/Library/Refresh`,{method:'POST'}),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('Library refresh waited for background work.')),1000))
    ]);
    assert.equal(response.status,204);
    assert.equal(queued,1);
    const failure=new Error('Synthetic library scan failure');
    rejectScan(failure);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(errors,[failure]);
  }finally{await new Promise(resolve=>application.server.close(resolve));}

  const unavailable=await createTestApplication({configuration:{UICulture:'en-US',IsStartupWizardCompleted:true},
    authentication:{authenticate:async()=>({IsAuthenticated:true,IsAdministrator:true}),authorize(_auth,{policy}){assert.equal(policy,'RequiresElevation');}}});
  await new Promise(resolve=>unavailable.server.listen(0,'127.0.0.1',resolve));
  try{
    const origin=`http://127.0.0.1:${unavailable.server.address().port}`;
    assert.equal((await fetch(`${origin}/Library/Refresh`,{method:'POST'})).status,501);
  }finally{await new Promise(resolve=>unavailable.server.close(resolve));}

  const missingTaskManager=await createTestApplication({configuration:{UICulture:'en-US',IsStartupWizardCompleted:true},
    authentication:{authenticate:async()=>({IsAuthenticated:true,IsAdministrator:true}),authorize(){ }},
    libraryScanner:{capabilities:{completeLibraryScan:true}}});
  await new Promise(resolve=>missingTaskManager.server.listen(0,'127.0.0.1',resolve));
  try{
    const origin=`http://127.0.0.1:${missingTaskManager.server.address().port}`;
    assert.equal((await fetch(`${origin}/Library/Refresh`,{method:'POST'})).status,501);
  }finally{await new Promise(resolve=>missingTaskManager.server.close(resolve));}

  let partialQueued=0;
  const partial=await createTestApplication({configuration:{UICulture:'en-US',IsStartupWizardCompleted:true},
    authentication:{authenticate:async()=>({IsAuthenticated:true,IsAdministrator:true}),authorize(){ }},
    libraryScanner:{capabilities:{completeLibraryScan:false},queue(){partialQueued++;}}});
  await new Promise(resolve=>partial.server.listen(0,'127.0.0.1',resolve));
  try{
    const origin=`http://127.0.0.1:${partial.server.address().port}`;
    assert.equal((await fetch(`${origin}/Library/Refresh`,{method:'POST'})).status,501);
    assert.equal(partialQueued,0);
  }finally{await new Promise(resolve=>partial.server.close(resolve));}
});

test('library refresh contains an asynchronously rejecting error reporter',async()=>{
  const application=await createTestApplication({configuration:{UICulture:'en-US',IsStartupWizardCompleted:true},
    authentication:{authenticate:async()=>({IsAuthenticated:true,IsAdministrator:true}),authorize(){}},
    libraryScanner:{capabilities:{completeLibraryScan:true}},tasks:{cancelIfRunningAndQueue(){return Promise.reject(new Error('background failure'));}},
    onError:async()=>{throw new Error('reporter failure');}});
  await new Promise(resolve=>application.server.listen(0,'127.0.0.1',resolve));
  try{
    const origin=`http://127.0.0.1:${application.server.address().port}`;
    assert.equal((await fetch(`${origin}/Library/Refresh`,{method:'POST'})).status,204);
    await new Promise(resolve=>setImmediate(resolve));
  }finally{await new Promise(resolve=>application.server.close(resolve));}
});

for (const folder of [false, true]) for (const synchronous of [false, true]) test(`${folder ? 'folder' : 'metadata'} refresh contains ${synchronous ? 'synchronous' : 'asynchronous'} queue and reporter failures`,async()=>{
  const failure = new Error('Controlled background refresh failure');
  const application = await createTestApplication({configuration:{UICulture:'en-US',IsStartupWizardCompleted:true},
    authentication:{authenticate:async()=>({IsAuthenticated:true,IsAdministrator:true}),authorize(){}},
    library:{async getItemRecord(id){return {Id:id,Type:folder?'Folder':'Movie'};}},
    metadata:{validateRefresh(){},queue(){if(synchronous)throw failure;return Promise.reject(failure);}},
    onError:async error=>{assert.equal(error,failure);throw new Error('Controlled reporter failure');}});
  await new Promise(resolve=>application.server.listen(0,'127.0.0.1',resolve));
  try {
    const origin=`http://127.0.0.1:${application.server.address().port}`;
    assert.equal((await fetch(`${origin}/Items/${itemId}/Refresh`,{method:'POST'})).status,204);
    await new Promise(resolve=>setImmediate(resolve));
  }finally{await new Promise(resolve=>application.server.close(resolve));}
});
