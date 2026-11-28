import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';

export const requiredValidationServices = ['postgres'];
test('record registration sites for the expanded production HTTP table',async t=>{
  const rows=[];
  globalThis[Symbol.for('mediamanager.audit.registration')]=rows;
  const hooks=registerHooks({load(url,context,nextLoad){
    const result=nextLoad(url,context);
    if(!url.endsWith('/src/http/application.js'))return result;
    const source=Buffer.from(result.source).toString();
    const at='routes.push({ method, path,';
    assert.equal(source.split(at).length,2);
    // The addition has no newline and runs only as routes are registered.
    const line="globalThis[Symbol.for('mediamanager.audit.registration')].push({method,path,policy:typeof policy==='function'?String(policy):policy,isPublic:typeof isPublic==='function'?String(isPublic):isPublic,body,abortOnDisconnect,frames:new Error().stack.split('\\n').slice(2,8),handler:String(run)}); ";
    return {...result,source:source.replace(at,()=>line+at)};
  }});
  t.after(()=>{hooks.deregister();delete globalThis[Symbol.for('mediamanager.audit.registration')];});
  const {createMetadataHttpFixture}=await import('../helpers/metadata-http-fixture.js');
  const {runtime}=await createMetadataHttpFixture(t);
  assert.deepEqual(rows.map(r=>r.method+' '+r.path),runtime.implementedRoutes);
  const dest=path.join(process.env.MEDIAMANAGER_VALIDATION_OUTPUT_ROOT,'implementation-audit');
  await mkdir(dest,{recursive:true});
  await writeFile(path.join(dest,'registered-interfaces.json'),JSON.stringify(rows,null,2));
});
