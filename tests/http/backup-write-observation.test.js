import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { StorageFileSystem } from '../../src/storage/files.js';
import { createMetadataHttpFixture } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres'];
test('observe an independent user write while a files-only backup is reading one selected file', async t => {
  const {runtime,request,database}=await createMetadataHttpFixture(t);
  const directory=path.join(runtime.applicationPaths.dataPath,'subtitles');
  const witness=path.join(directory,'audit.srt');
  await mkdir(directory,{recursive:true});await writeFile(witness,'Audit subtitle');
  const atFile=Promise.withResolvers(), allowRead=Promise.withResolvers();
  const original=StorageFileSystem.prototype.createReadStream;
  t.mock.method(StorageFileSystem.prototype,'createReadStream',function(filename,...args){
    if (filename!==witness) return original.call(this,filename,...args);
    const owner=this;
    return Readable.from((async function*(){atFile.resolve();await allowRead.promise;yield* original.call(owner,filename,...args);})());
  });
  const checkLock=()=>database.withConnection(async db=>{
    const key='mediamanager:domain-write:'+db.schemaName;
    const sql='(hashtextextended($1,0))';
    const ok=(await db.client.query('SELECT pg_try_advisory_lock'+sql+' AS available',[key])).rows[0].available;
    if(ok)await db.client.query('SELECT pg_advisory_unlock'+sql,[key]);
    return ok;
  });
  const control=await checkLock();assert.equal(control,true);
  const before=performance.now();
  const archive=request('/Backup/Create',{method:'POST',body:{Database:false,Subtitles:true}});
  let user;
  try {
    assert.ok(await Promise.race([atFile.promise.then(()=>true),delay(5000,false,{ref:false})]));
    const during=await checkLock();
    let done=false;
    user=request('/Users/New',{method:'POST',body:{Name:'Backup concurrent user',Password:'fixture-private'}}).finally(()=>{done=true;});
    const health=await request('/health');
    await delay(800);
    const pending=!done;const held=Math.round(performance.now()-before);
    allowRead.resolve();
    const [a,u]=await Promise.all([archive,user]);const released=await checkLock();
    assert.equal(a.status,200);assert.equal(u.status,200);
    const dest=path.join(process.env.MEDIAMANAGER_VALIDATION_OUTPUT_ROOT,'implementation-audit');
    await mkdir(dest,{recursive:true});
    await writeFile(path.join(dest,'backup-concurrency.json'),JSON.stringify({lockAvailableBefore:control,lockAvailableDuringFileRead:during,
      userWriteOutstandingAfter800ms:pending,healthStatus:health.status,archiveStatus:a.status,userStatusAfterRelease:u.status,
      lockAvailableAfter:released,elapsedUntilReleaseMs:held},null,2));
  } finally {allowRead.resolve();await Promise.allSettled([archive,user]);}
});
