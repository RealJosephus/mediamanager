import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

export const requiredValidationServices = ['postgres'];
test('record registration sites for the expanded production HTTP table',async t=>{
  const rows=[];
  const original=Array.prototype.push;
  function capture(...values) {
    const r=values[0];
    if(r && typeof r==='object' && typeof r.run==='function' && r.pattern instanceof RegExp && Object.hasOwn(r,'abortOnDisconnect')){
      const stack=new Error().stack.split('\n');
      original.call(rows,{method:r.method,path:r.path,policy:typeof r.policy==='function'?String(r.policy):r.policy,
        isPublic:typeof r.isPublic==='function'?String(r.isPublic):r.isPublic,body:r.body,abortOnDisconnect:r.abortOnDisconnect,
        frames:stack.slice(2),handler:String(r.run)});
    }
    return Reflect.apply(original,this,values);
  }
  const {createMetadataHttpFixture}=await import('../helpers/metadata-http-fixture.js');
  let runtime;
  try {
    Array.prototype.push=capture;
    ({runtime}=await createMetadataHttpFixture(t));
  } finally {Array.prototype.push=original;}
  assert.deepEqual(rows.map(r=>r.method+' '+r.path),runtime.implementedRoutes);
  const dest=path.join(process.env.MEDIAMANAGER_VALIDATION_OUTPUT_ROOT,'implementation-audit');
  await mkdir(dest,{recursive:true});
  await writeFile(path.join(dest,'registered-interfaces.json'),JSON.stringify(rows,null,2));
});
