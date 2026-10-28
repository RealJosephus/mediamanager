import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireOperationLease } from '../../src/migration/operation-lease.js';

const carrierDirectory = '/Users/Shared/mediamanager-operation-leases';
const carrierFor = identity => path.join(carrierDirectory, createHash('sha256').update(identity).digest('hex') + '.lock');
const legacyPort = identity => 20000 + createHash('sha256').update(identity).digest().readUInt16BE(3) % 40000;

async function leaseOwner(t, identity, { uid, gid, differentEnvironment = false, preparing = false } = {}) {
  const owner=spawn(process.execPath,[fileURLToPath(new URL('../helpers/operation-lease-owner.js',import.meta.url))],{
    env:{...process.env,MM_LEASE_TEST_IDENTITY:identity,...(preparing?{MM_LEASE_TEST_HOLD_PREPARATION:'true'}:{}),...(differentEnvironment?{
      HOME:path.join(os.tmpdir(),'different-lease-home-'+randomUUID()),TMPDIR:path.join(os.tmpdir(),'different-lease-temp-'+randomUUID())}:{})},
    uid,gid,windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],
  });
  let diagnostics='';
  owner.stderr.on('data',bytes=>{diagnostics=(diagnostics+bytes).slice(-65536);});
  const exited=new Promise(resolve=>owner.once('close',(code,signal)=>resolve({code,signal})));
  t.after(async()=>{if(owner.exitCode==null&&owner.signalCode==null)owner.kill('SIGKILL');await exited;});
  const admitted=await new Promise((resolve,reject)=>{
    owner.once('error',reject);
    owner.once('message',message=>message?.kind===(preparing?'preparing':'held')?resolve(message):reject(new Error('Unexpected lease owner message.')));
    owner.once('exit',()=>reject(new Error('Lease owner exited before admission: '+diagnostics)));
  });
  return {owner,exited,admitted};
}

function legacyCollision(prefix) {
  const byPort = new Map();
  for (let index=0; index<=40000; index++) {
    const identity=prefix+index,port=legacyPort(identity);
    if (byPort.has(port)) return { first:byPort.get(port),second:identity,port };
    byPort.set(port,identity);
  }
  throw new Error('The finite legacy endpoint map did not produce its required collision.');
}

async function controlledTcpEndpoint() {
  // Only fixture input allocation retries a busy TCP port. Neither identity has
  // acquired a lease yet, and production lease acquisition never scans ports.
  for (let attempt=0; attempt<16; attempt++) {
    const pair=legacyCollision('unrelated-endpoint-'+randomUUID()+'-');
    const server=createServer({pauseOnConnect:true},socket=>socket.destroy());
    try {
      await new Promise((resolve,reject)=>{
        server.once('error',reject);
        server.listen({host:'127.0.0.1',port:pair.port,exclusive:true},resolve);
      });
      return {...pair,server};
    } catch (reason) { if(reason?.code!=='EADDRINUSE')throw reason; }
  }
  throw new Error('Could not reserve a controlled unrelated TCP endpoint.');
}

test('distinct full identities coexist while their former TCP endpoint is owned by an unrelated server', {timeout:30000}, async t=>{
  const {first,second,port,server}=await controlledTcpEndpoint(),leases=[];
  t.after(async()=>{
    const failures=[];
    for(const lease of leases)try{await lease.release();}catch(reason){failures.push(reason);}
    try{await new Promise((resolve,reject)=>server.close(reason=>reason?reject(reason):resolve()));}catch(reason){failures.push(reason);}
    if(failures.length===1)throw failures[0];
    if(failures.length)throw new AggregateError(failures,'Controlled endpoint cleanup failed.',{cause:failures[0]});
  });
  assert.notEqual(first,second);assert.equal(legacyPort(first),port);assert.equal(legacyPort(second),port);
  assert.equal(server.listening,true);assert.equal(server.address().port,port);
  const one=await acquireOperationLease(first);leases.push(one);
  const two=await acquireOperationLease(second);leases.push(two);
  one.assertHeld();two.assertHeld();
  await assert.rejects(acquireOperationLease(first),reason=>{
    assert.equal(reason.code,'OPERATION_LEASE_ACTIVE');assert.ok(reason.cause);
    if(process.platform==='darwin')assert.ok(['EWOULDBLOCK','EAGAIN'].includes(reason.cause.code));
    return true;
  });
  await one.release();
  const next=await acquireOperationLease(first);leases.push(next);next.assertHeld();two.assertHeld();
  assert.equal(server.listening,true);
});

test('operation leases validate input and preserve ordinary carrier ownership and raw cleanup failures', {timeout:30000}, async t=>{
  for(const value of ['',null,0,'nul\0identity'])await assert.rejects(acquireOperationLease(value),TypeError);
  await assert.rejects(acquireOperationLease('valid',{label:''}),TypeError);
  const initial=await acquireOperationLease('carrier-platform-check-'+randomUUID());
  initial.assertHeld();await initial.release();assert.throws(()=>initial.assertHeld(),/no longer held/);
  if(process.platform!=='darwin'){
    t.diagnostic('Pipe/abstract ownership was exercised; filesystem carrier branches are specific to Darwin.');
    return;
  }
  const metadata=await fs.promises.lstat(carrierDirectory);
  assert.equal(metadata.isDirectory(),true);assert.equal(metadata.isSymbolicLink(),false);assert.equal(metadata.mode&0o7777,0o1777);
  const identity='ordinary-readonly-carrier-'+randomUUID(),filename=carrierFor(identity);
  const original=Buffer.from('Ordinary stale bytes are not a live owner.\n');
  await fs.promises.writeFile(filename,original,{flag:'wx',mode:0o444});await fs.promises.chmod(filename,0o444);
  const lease=await acquireOperationLease(identity);
  try{lease.assertHeld();assert.deepEqual(await fs.promises.readFile(filename),original);}
  finally{await lease.release();}
  const before=await fs.promises.lstat(filename,{bigint:true});
  const {default:koffi}=await import('koffi'),library=koffi.load('/usr/lib/libSystem.B.dylib');
  const lock=library.func('int flock(int fd, int operation)');
  const external=await fs.promises.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const readonlyFd=external.fd;
  try {
    assert.equal(lock(external.fd,2|4),0,'The actual BSD exclusive lock accepts a read-only descriptor.');
    await assert.rejects(acquireOperationLease(identity),{code:'OPERATION_LEASE_ACTIVE'});
  } finally {
    const failures=[];
    if(lock(external.fd,8)!==0)failures.push(new Error('The real external read-only lock did not unlock.'));
    try{await external.close();}catch(reason){failures.push(reason);}
    if(failures.length===1)throw failures[0];
    if(failures.length)throw new AggregateError(failures,'External carrier cleanup failed.',{cause:failures[0]});
  }
  await assert.rejects(external.stat(),{code:'EBADF'});
  const again=await acquireOperationLease(identity);
  try{
    again.assertHeld();const after=await fs.promises.lstat(filename,{bigint:true});
    assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);
    assert.deepEqual(await fs.promises.readFile(filename),original);
  }finally{await again.release();}
  const busyIdentity='busy-close-failure-'+randomUUID(),busyFile=carrierFor(busyIdentity);
  const heldOwner=await acquireOperationLease(busyIdentity),openBeforeBusy=fs.promises.open;
  let contenderStat,unexpectedContender,busyObservation,busyPrimary,busyFailed=false;
  fs.promises.open=async(...args)=>{
    const file=await openBeforeBusy(...args);
    if(args[0]===busyFile){
      contenderStat=file.stat.bind(file);const close=file.close.bind(file);
      file.close=async()=>{await close();throw 0;};
    }
    return file;
  };syncBuiltinESMExports();
  try{
    const outcome=await acquireOperationLease(busyIdentity).then(value=>({passed:true,value}),reason=>({passed:false,reason}));
    if(outcome.passed)unexpectedContender=outcome.value;
    assert.equal(outcome.passed,false);
    const aggregate=outcome.reason,busy=aggregate.errors?.[0],native=busy?.cause;
    assert.ok(aggregate instanceof AggregateError);assert.equal(aggregate.code,'OPERATION_LEASE_ACTIVE');
    assert.equal(aggregate.cause,busy);assert.deepEqual(aggregate.errors,[busy,0]);
    assert.equal(busy.code,'OPERATION_LEASE_ACTIVE');assert.equal(aggregate.cause.cause,native);
    assert.equal(native.syscall,'flock');assert.ok(['EAGAIN','EWOULDBLOCK'].includes(native.code));
    await assert.rejects(contenderStat(),{code:'EBADF'});
    heldOwner.assertHeld();
    busyObservation={code:aggregate.code,native:{code:native.code,errno:native.errno,syscall:native.syscall},
      orderedErrors:['original busy reason',0],sameOriginalCause:true,contenderFdCloseError:'EBADF',ownerStillHeld:true};
  }catch(reason){busyFailed=true;busyPrimary=reason;}
  finally{
    const failures=[];
    fs.promises.open=openBeforeBusy;syncBuiltinESMExports();
    if(unexpectedContender)try{await unexpectedContender.release();}catch(reason){failures.push(reason);}
    try{await heldOwner.release();}catch(reason){failures.push(reason);}
    if(busyFailed&&failures.length)throw new AggregateError([busyPrimary,...failures],'Busy contender fixture and cleanup failed.',{cause:busyPrimary});
    if(busyFailed)throw busyPrimary;
    if(failures.length===1)throw failures[0];
    if(failures.length)throw new AggregateError(failures,'Busy contender cleanup failed.',{cause:failures[0]});
  }
  const afterBusy=await acquireOperationLease(busyIdentity);
  try{afterBusy.assertHeld();}finally{await afterBusy.release();}
  const target=carrierFor('carrier-link-target-'+randomUUID());
  await fs.promises.writeFile(target,'unchanged target',{flag:'wx'});
  const symlinkIdentity='carrier-symlink-exact-'+randomUUID(),symlinkFile=carrierFor(symlinkIdentity);
  await fs.promises.symlink(target,symlinkFile);
  try{
    await assert.rejects(acquireOperationLease(symlinkIdentity));
    assert.equal((await fs.promises.lstat(symlinkFile)).isSymbolicLink(),true);
    assert.equal(await fs.promises.readFile(target,'utf8'),'unchanged target');
  }finally{await fs.promises.unlink(symlinkFile);}
  const directoryIdentity='carrier-directory-'+randomUUID(),directoryFile=carrierFor(directoryIdentity);
  await fs.promises.mkdir(directoryFile);
  try{await assert.rejects(acquireOperationLease(directoryIdentity));assert.equal((await fs.promises.lstat(directoryFile)).isDirectory(),true);}
  finally{await fs.promises.rmdir(directoryFile);}
  const closeFaults=[];
  for(const reason of [false,0,'',null,undefined]){
    const faultIdentity='carrier-close-failure-'+randomUUID(),faultFile=carrierFor(faultIdentity);
    const warmed=await acquireOperationLease(faultIdentity);await warmed.release();
    const originalOpen=fs.promises.open;let stat;
    fs.promises.open=async(...args)=>{
      const actual=await originalOpen(...args);
      if(args[0]===faultFile){
        stat=actual.stat.bind(actual);const close=actual.close.bind(actual);
        actual.close=async()=>{await close();throw reason;};
      }
      return actual;
    };syncBuiltinESMExports();
    let faulty,delivered=false,primaryFailed=false,primary;
    try{
      faulty=await acquireOperationLease(faultIdentity);faulty.assertHeld();
      const releasing=faulty.release();assert.equal(faulty.release(),releasing);
      try{await assert.rejects(releasing,actual=>{assert.equal(actual,reason);return true;});}finally{delivered=true;}
      assert.throws(()=>faulty.assertHeld(),/no longer held/);
      let fdError;
      await assert.rejects(stat(),error=>{fdError=error.code;assert.equal(error.code,'EBADF');return true;});
      closeFaults.push({reasonType:typeof reason,value:reason??null,undefinedValue:reason===undefined,actualClosedFdError:fdError});
    }catch(failure){primaryFailed=true;primary=failure;}
    finally{
      const failures=[];
      try{if(faulty&&!delivered)await faulty.release();}catch(failure){failures.push(failure);}
      fs.promises.open=originalOpen;syncBuiltinESMExports();
      if(primaryFailed&&failures.length)throw new AggregateError([primary,...failures],'Lease failure fixture and cleanup failed.',{cause:primary});
      if(primaryFailed)throw primary;
      if(failures.length===1)throw failures[0];
      if(failures.length)throw new AggregateError(failures,'Lease failure fixture cleanup failed.',{cause:failures[0]});
    }
    const recovered=await acquireOperationLease(faultIdentity);recovered.assertHeld();await recovered.release();
  }
  const publicFailure=Object.assign(new Error('Controlled carrier inspection failed.'),{code:0,status:false,statusCode:null});
  const getterFailure=Object.defineProperties(new Error('Controlled carrier public-field getter failed.'),{
    code:{get(){throw false;}},status:{value:''},statusCode:{value:0},
  });
  for(const primary of [false,publicFailure,getterFailure]){
    const faultIdentity='carrier-read-and-close-failure-'+randomUUID(),faultFile=carrierFor(faultIdentity);
    const warmed=await acquireOperationLease(faultIdentity);await warmed.release();
    const originalOpen=fs.promises.open;let actualStat;
    fs.promises.open=async(...args)=>{
      const actual=await originalOpen(...args);
      if(args[0]===faultFile){
        actualStat=actual.stat.bind(actual);const close=actual.close.bind(actual);
        actual.stat=async()=>{throw primary;};actual.close=async()=>{await close();throw 0;};
      }
      return actual;
    };syncBuiltinESMExports();
    try{
      await assert.rejects(acquireOperationLease(faultIdentity),reason=>{
        assert.ok(reason instanceof AggregateError);assert.deepEqual(reason.errors,[primary,0]);assert.equal(reason.cause,primary);
        if(primary===publicFailure){assert.equal(reason.code,0);assert.equal(reason.status,false);assert.equal(reason.statusCode,null);}
        if(primary===getterFailure){
          assert.equal(Object.hasOwn(reason,'code'),false);assert.equal(reason.status,'');assert.equal(reason.statusCode,0);
        }
        return true;
      });
      await assert.rejects(actualStat(),{code:'EBADF'});
    }finally{fs.promises.open=originalOpen;syncBuiltinESMExports();}
    const recovered=await acquireOperationLease(faultIdentity);recovered.assertHeld();await recovered.release();
  }
  t.diagnostic(JSON.stringify({diagnosticOnly:true,darwinCarrier:{
    sharedMode:(metadata.mode&0o7777).toString(8),ordinaryBytesPreserved:true,readonlyExclusiveLockObserved:true,
    readonlyFd,readonlyFdCloseError:'EBADF',
    canonicalDevice:String(before.dev),canonicalInode:String(before.ino),sameInodeReacquired:true,
    closeFaults,busyCloseFailure:{...busyObservation,reacquired:true},
    admissionFailures:{errors:[false,0],cause:false,actualClosedFdError:'EBADF',publicFalsyFieldsPreserved:true,throwingGetterPreservedCause:true},
  }}));
});

test('concurrent acquisition observes only a completely published carrier', {timeout:30000}, async t=>{
  const identity='concurrent-carrier-'+randomUUID();
  if(process.platform!=='darwin'){
    const results=await Promise.allSettled([acquireOperationLease(identity),acquireOperationLease(identity)]);
    const held=results.filter(result=>result.status==='fulfilled'),denied=results.filter(result=>result.status==='rejected');
    t.after(async()=>{for(const result of held)await result.value.release();});
    assert.equal(held.length,1);assert.equal(denied.length,1);
    assert.equal(denied[0].reason.code,'OPERATION_LEASE_ACTIVE');held[0].value.assertHeld();
    return;
  }
  const filename=carrierFor(identity),entered=Promise.withResolvers(),resume=Promise.withResolvers();
  const originalOpen=fs.promises.open;
  let prepared,orphan,first,firstDelivered=false,owner,exited,primaryFailed=false,primary;
  fs.promises.open=async(...args)=>{
    const handle=await originalOpen(...args);
    if(typeof args[0]==='string'&&args[0].startsWith(filename+'.')&&args[0].endsWith('.preparing')){
      prepared=args[0];const chmod=handle.chmod.bind(handle);
      handle.chmod=async mode=>{entered.resolve();await resume.promise;return chmod(mode);};
    }
    return handle;
  };syncBuiltinESMExports();
  try{
    first=acquireOperationLease(identity).then(value=>({passed:true,value}),reason=>({passed:false,reason}));
    await Promise.race([entered.promise,first.then(outcome=>{
      throw new Error('The first acquisition completed before its held permission preparation.',{cause:outcome.reason});
    })]);
    await assert.rejects(fs.promises.lstat(filename),{code:'ENOENT'});
    const other=await leaseOwner(t,identity);owner=other.owner;exited=other.exited;
    const canonical=await fs.promises.lstat(filename,{bigint:true});
    assert.equal(canonical.isFile(),true);assert.equal(canonical.mode&0o777n,0o444n);
    resume.resolve();
    const outcome=await first;firstDelivered=true;
    assert.equal(outcome.passed,false);assert.equal(outcome.reason.code,'OPERATION_LEASE_ACTIVE');
    await assert.rejects(fs.promises.lstat(prepared),{code:'ENOENT'},
      'The losing private preparation is removed only after its FD closes.');
    owner.kill('SIGKILL');const termination=await exited;owner=null;
    assert.equal(termination.signal,'SIGKILL');
    fs.promises.open=originalOpen;syncBuiltinESMExports();
    const current=await acquireOperationLease(identity);
    try{
      current.assertHeld();const after=await fs.promises.lstat(filename,{bigint:true});
      assert.equal(after.dev,canonical.dev);assert.equal(after.ino,canonical.ino);
    }finally{await current.release();}
    const interruptedIdentity='killed-carrier-preparation-'+randomUUID();
    const interrupted=await leaseOwner(t,interruptedIdentity,{preparing:true});
    owner=interrupted.owner;exited=interrupted.exited;orphan=interrupted.admitted;
    assert.equal(path.dirname(orphan.filename),carrierDirectory);
    assert.ok(orphan.filename.startsWith(carrierFor(interruptedIdentity)+'.')&&orphan.filename.endsWith('.preparing'));
    await assert.rejects(fs.promises.lstat(carrierFor(interruptedIdentity)),{code:'ENOENT'});
    owner.kill('SIGKILL');const interruptedExit=await exited;owner=null;
    assert.equal(interruptedExit.signal,'SIGKILL');
    const abandoned=await fs.promises.lstat(orphan.filename,{bigint:true});
    assert.equal(String(abandoned.dev),orphan.dev);assert.equal(String(abandoned.ino),orphan.ino);
    const subsequent=await acquireOperationLease(interruptedIdentity);
    try{subsequent.assertHeld();}finally{await subsequent.release();}
    t.diagnostic(JSON.stringify({diagnosticOnly:true,atomicCarrierPublication:{preparedUnpublishedWhileHeld:true,
      secondProcessOwnedCanonical:true,loserRejected:true,loserPreparationRemoved:true,ownerExit:termination,
      sameCanonicalInodeReacquired:true,killedUnpublishedPreparer:{owner:orphan,exit:interruptedExit,
        canonicalAbsentAtKill:true,subsequentAcquisition:true}}}));
  }catch(reason){primaryFailed=true;primary=reason;}
  finally{
    const failures=[];resume.resolve();
    if(owner){try{if(owner.exitCode==null&&owner.signalCode==null)owner.kill('SIGKILL');await exited;}catch(reason){failures.push(reason);}}
    if(first)try{
      const outcome=await first;
      if(outcome.passed)await outcome.value.release();else if(!firstDelivered)failures.push(outcome.reason);
    }catch(reason){failures.push(reason);}
    fs.promises.open=originalOpen;syncBuiltinESMExports();
    if(orphan)try{
      const named=await fs.promises.lstat(orphan.filename,{bigint:true});
      if(!named.isFile()||named.isSymbolicLink()||String(named.dev)!==orphan.dev||String(named.ino)!==orphan.ino)
        throw new Error('The controlled unpublished preparation changed before fixture cleanup.');
      await fs.promises.unlink(orphan.filename);
    }catch(reason){failures.push(reason);}
    if(primaryFailed&&failures.length)throw new AggregateError([primary,...failures],'Carrier publication fixture and cleanup failed.',{cause:primary});
    if(primaryFailed)throw primary;
    if(failures.length===1)throw failures[0];
    if(failures.length)throw new AggregateError(failures,'Carrier publication cleanup failed.',{cause:failures[0]});
  }
});

test('operation leases exclude another process and the kernel releases a killed owner', { timeout: 30000 }, async t => {
  const identity = 'operation-lease-test-' + randomUUID();
  const peerUid=process.env.MEDIAMANAGER_TEST_LEASE_PEER_UID,peerGid=process.env.MEDIAMANAGER_TEST_LEASE_PEER_GID;
  const crossUser=peerUid!==undefined||peerGid!==undefined;
  if(crossUser){
    assert.equal(process.platform,'darwin');assert.equal(process.getuid(),0);
    for(const value of [peerUid,peerGid])assert.match(value??'',/^[0-9]+$/);
    assert.ok(Number.isSafeInteger(Number(peerUid))&&Number(peerUid)>0&&Number(peerUid)<0xffffffff);
    assert.ok(Number.isSafeInteger(Number(peerGid))&&Number(peerGid)>=0&&Number(peerGid)<0xffffffff);
  }
  // The first UID publishes the readable carrier before a different UID owns it.
  let firstCarrier;
  if(process.platform==='darwin'){
    const first=await acquireOperationLease(identity);
    try{
      const info=await fs.promises.lstat(carrierFor(identity),{bigint:true});
      firstCarrier={uid:Number(info.uid),gid:Number(info.gid),mode:(info.mode&0o777n).toString(8),
        dev:String(info.dev),ino:String(info.ino)};
      assert.equal(firstCarrier.uid,process.getuid());assert.equal(firstCarrier.mode,'444');
    }finally{await first.release();}
  }
  const {owner,exited,admitted}=await leaseOwner(t,identity,{differentEnvironment:process.platform==='darwin',
    ...(crossUser?{uid:Number(peerUid),gid:Number(peerGid)}:{})});
  if(crossUser){
    assert.equal(admitted.uid,Number(peerUid));assert.equal(admitted.gid,Number(peerGid));
    assert.notEqual(admitted.uid,process.getuid());assert.notEqual(admitted.uid,firstCarrier.uid);
  }
  t.diagnostic(JSON.stringify({diagnosticOnly:true,parentUid:process.getuid?.()??null,owner:admitted,
    crossUidExecuted:crossUser,firstCarrier,differentEnvironment:process.platform==='darwin'}));
  await assert.rejects(acquireOperationLease(identity), /already active/);
  owner.kill('SIGKILL');
  const termination=await exited;
  if(process.platform!=='win32')assert.equal(termination.signal,'SIGKILL');
  const lease = await acquireOperationLease(identity);
  t.after(() => lease.release());
  lease.assertHeld();
  const releasing = lease.release();
  assert.throws(() => lease.assertHeld(), /no longer held/);
  assert.equal(lease.release(), releasing);
  await releasing;
  assert.throws(() => lease.assertHeld(), /no longer held/);
  t.diagnostic(JSON.stringify({diagnosticOnly:true,killedLeaseOwner:{owner:admitted,exit:termination,
    crossUidExecuted:crossUser,firstCarrier,reacquired:true,normalReleaseCompleted:true}}));
});
