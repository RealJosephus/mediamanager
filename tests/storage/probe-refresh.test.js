import { testFileSystem } from './plugin-files.js';
import { openMetadataRelations, trackMetadataContexts, attachMetadataItemCreation, closeMetadataFixture, removeMetadataTestRoot } from '../metadata/relations-fixture.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { ProbeService } from '../../src/library/probe-service.js';
import { exportCurrentSqlite, transferDatabase, databaseDigest } from '../../src/migration/database-transfer.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap, ProbeReadBridge, probeRaw } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { externalCandidates } from '../../src/storage/external-streams.js';
import { normalizeProbeChapters } from '../../src/storage/probe-metadata.js';
import { defaultLibraryOptions } from '../../src/library/options.js';

const id = 'D1111111-1111-1111-1111-111111111111';
const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
const ffmpegAvailable = spawnSync(validationExecutable('ffmpeg'), ['-version'], {windowsHide: true}).status === 0;
function ffmpeg(args) { const run = spawnSync(validationExecutable('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], {windowsHide:true}); assert.equal(run.status, 0, run.stderr?.toString()); }

test('actual network probe metadata, external streams, locks and native SQLite return on PostgreSQL', {skip:!ffmpegAvailable || !process.env.MEDIAMANAGER_TEST_POSTGRES}, async t => {
  const mode='postgres';
  const directory = await mkdtemp(path.join(os.tmpdir(),'mediamanager-probe-refresh-'));
  const registry = new StorageRegistry();
  let db, service, store, library, linkedChildren, itemCreation;
  const contextLoaders = [];
  t.after(async () => {
    await closeMetadataFixture({ library, itemCreation, linkedChildren, contexts: contextLoaders, before: [() => service?.close()],
      after: [() => registry.close(),
        () => db?.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
        () => db?.client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`),
        () => store ? store.close() : db?.close(), () => removeMetadataTestRoot(directory, 'mediamanager-probe-refresh-')] });
  });
  registry.registerType('fixture', ()=>new MemoryStorageAdapter());
  await registry.createInstance('fixture','fixture',{});
  const vfs=new VirtualFileSystem(registry);vfs.mount({path:'/media',instanceId:'fixture',root:'/',capabilities:{create:true,replace:true,delete:true}});
  const adapter={write:(name,bytes)=>vfs.write('/media'+name,bytes),delete:name=>vfs.delete('/media'+name)};
  const identityMap=new IdentityAccessMap();identityMap.addPrefix({identityRoot:'Z:\\ProbeFixture',accessRoot:'/media',style:'windows',returnAccess:'isolated synthetic media'});
  const schema=`probe_refresh_${Date.now()}_${Math.floor(Math.random()*10000)}`;
  const source=new SqliteDatabase(':memory:',{create:true});
  db=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true});
  const chapterText=';FFMETADATA1\ntitle=Embedded title\nsynopsis=Embedded overview\ndate=2024\ngenre=Drama;Comedy\ncopyright=Studio A;Studio B\niTunEXTC=mpaa|PG|100|Guidance\nWM/MediaCredits=Actor A;Actor B\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=100\ntitle=00:00:00\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=100\nEND=200\ntitle=Second\n';
  await writeFile(path.join(directory,'tags.txt'),chapterText);
  ffmpeg(['-f','lavfi','-i','color=size=32x32:rate=10:duration=0.2','-f','ffmetadata','-i',path.join(directory,'tags.txt'),'-map_metadata','1','-map_chapters','1','-c:v','ffv1',path.join(directory,'movie.mkv')]);
  ffmpeg(['-f','lavfi','-i','anullsrc=r=8000:cl=mono','-t','0.2','-c:a','pcm_s16le',path.join(directory,'movie.en.default.wav')]);
  await adapter.write('/movie.mkv',await readFile(path.join(directory,'movie.mkv')));
  await adapter.write('/movie.en.default.wav',await readFile(path.join(directory,'movie.en.default.wav')));
  await adapter.write('/movie.en.forced.srt',Buffer.from('1\n00:00:00,000 --> 00:00:00,100\nSynthetic subtitle\n'));
  await adapter.write('/movie2.en.srt',Buffer.from('unrelated'));
  await source.insert('BaseItems',{...empty('BaseItems'),Id:id,Type:'MediaBrowser.Controller.Entities.Movies.Movie',Name:'Stored title',Path:'Z:\\ProbeFixture\\movie.mkv',MediaType:'Video',Overview:'Locked overview',Data:'{"VideoType":"VideoFile","Unknown":{"long":9007199254740993,"nullable":null}}'});
  await source.insert('BaseItemMetadataFields',{ItemId:id,Id:6});
  try {await transferDatabase(source,db,{instanceBinding:{serverId:id.replaceAll('-','').toLowerCase(),originIdentityDigest:createHash('sha256').update('Isolated synthetic probe refresh source').digest('hex')}});}finally{source.close();}
  const spoolRoot=path.join(directory,'metadata-spool'); linkedChildren=await openMetadataRelations(db,spoolRoot);
  store=new DomainStore(db); library=new LibraryService({fileSystem: testFileSystem, store,linkedChildren,serverId:'probe-test',programDataPath:path.join(directory,'state')});
  const baseLoad=trackMetadataContexts(createMetadataContextLoader({fileSystem: testFileSystem, store,library,linkedChildren,spoolRoot,vfs,identityMap,configuration:{DummyChapterDuration:0}}),contextLoaders);
  const loadContext=Object.assign(async (...args)=>{const loaded=await baseLoad(...args);loaded.libraryOptions={...defaultLibraryOptions(),EnableEmbeddedTitles:true};return loaded;},baseLoad);
  loadContext.withContext=async(reference,options,operation)=>{const loaded=await loadContext(reference,options);try{return await operation(loaded);}finally{await loaded.dispose();}};
  itemCreation=attachMetadataItemCreation({store,library,linkedChildren,loadContext});
  service=new ProbeService({store,vfs,identityMap,loadContext,library});
  const result=await service.refresh(id,{force:true,replaceAllMetadata:true});
  assert.deepEqual(result.externalStreamFailures,[]);
  const loaded=await loadContext(id), streams=await db.rows('MediaStreamInfos',{where:{ItemId:id},orderBy:[{column:'StreamIndex',direction:'ASC'}]});
  assert.equal(loaded.item.Name,'Embedded title');assert.equal(loaded.item.Overview,'Locked overview');assert.equal(loaded.item.ProductionYear,2024);
  assert.equal(loaded.item.OfficialRating,'PG');assert.deepEqual(loaded.item.Genres,['Drama','Comedy']);assert.deepEqual(loaded.item.Studios,['Studio A','Studio B']);
  assert.deepEqual(loaded.context.people.map(person=>person.Name),['Actor A','Actor B']);
  for (const name of ['Actor A','Actor B']) {
    const person=(await db.rows('BaseItems',{where:{Id:loaded.personIdentity(name).Id}}))[0];
    assert.equal(person.Type,'MediaBrowser.Controller.Entities.Person');
    assert.equal(person.Name,name);
    assert.notEqual(person.DateLastSaved,null);
  }
  assert.deepEqual(streams.map(stream=>[stream.StreamIndex,stream.StreamType,stream.IsExternal]),[[0,2,true],[1,0,true],[2,1,false]]);
  assert.equal(streams[0].IsForced,true);assert.equal(streams[0].Language,'eng');assert.equal(streams[1].IsDefault,true);
  assert.equal(streams[0].Path,'Z:\\ProbeFixture\\movie.en.forced.srt');
  const chapters=await db.rows('Chapters',{where:{ItemId:id},orderBy:[{column:'ChapterIndex',direction:'ASC'}]});
  assert.deepEqual(chapters.map(chapter=>[chapter.Name,chapter.StartPositionTicks]),[['Chapter 1',0n],['Second',1000000n]]);
  const saved=(await db.rows('BaseItems',{where:{Id:id}}))[0];
  const data=JSON.parse(saved.Data);assert.equal(Object.hasOwn(data,'Unknown'),false,'typed native JSON drops undeclared extension data');assert.equal(data.DefaultVideoStreamIndex,2);assert.deepEqual(data.AudioFiles,['Z:\\ProbeFixture\\movie.en.default.wav']);assert.equal(data.SubtitleFiles.length,1);
  assert.equal(result.sourceConsistency,'versioned');
  assert.equal((await service.refresh(id,{replaceAllMetadata:true})).reason,'unchanged-version');
  const target=path.join(directory,'return.db');await exportCurrentSqlite(db,target,{testOnlyAllowSyntheticEnvelope:true});
  const back=new SqliteDatabase(target,{readOnly:true});try {assert.deepEqual(await databaseDigest(back),await databaseDigest(db));}finally{back.close();}
  if(process.env.MEDIAMANAGER_PROBE_EVIDENCE){const evidence=path.join(process.env.MEDIAMANAGER_PROBE_EVIDENCE,mode);await mkdir(evidence,{recursive:true});await exportCurrentSqlite(db,path.join(evidence,'return.db'),{testOnlyAllowSyntheticEnvelope:true});await writeFile(path.join(evidence,'expected.json'),JSON.stringify({item:{Name:loaded.item.Name,Overview:loaded.item.Overview,ProductionYear:loaded.item.ProductionYear,OfficialRating:loaded.item.OfficialRating,Genres:loaded.item.Genres,Studios:loaded.item.Studios,DefaultVideoStreamIndex:data.DefaultVideoStreamIndex,SubtitleFiles:data.SubtitleFiles,AudioFiles:data.AudioFiles},streams,chapters},(_,v)=>typeof v==='bigint'?String(v):v,2));}
  await adapter.delete('/movie.en.forced.srt');
  assert.equal((await service.refresh(id)).changed,true);assert.equal((await db.rows('MediaStreamInfos',{where:{ItemId:id}})).some(stream=>stream.StreamType===2),false);
  await db.update('BaseItems',{Id:id},{IsLocked:true,Name:'Locked name',OfficialRating:'Locked rating'});
  await service.refresh(id,{force:true,replaceAllMetadata:true});
  assert.equal((await db.rows('BaseItems',{where:{Id:id}}))[0].Name,'Locked name');
  assert.equal((await db.rows('BaseItems',{where:{Id:id}}))[0].OfficialRating,'Locked rating');
});

test('external VobSub pairing is exact and bridge access stays within explicitly leased siblings',async t=>{
  const registry=new StorageRegistry();registry.registerType('memory',()=>new MemoryStorageAdapter());const adapter=await registry.createInstance('fixture','memory',{});
  const vfs=new VirtualFileSystem(registry);vfs.mount({path:'/media',instanceId:'fixture',capabilities:{}});const bridge=new ProbeReadBridge(vfs);t.after(async()=>{await bridge.close();await registry.close();});
  for(const filename of ['movie.mkv','movie.en.idx','movie.en.sub','movie.fr.idx','movie.jp.sub','movie.Case.idx','movie.case.sub','secret.txt'])await adapter.write('/'+filename,Buffer.from(filename));
  const candidates=await externalCandidates(vfs,'/media/movie.mkv','Z:\\Fixture\\movie.mkv');
  assert.deepEqual(candidates.map(file=>file.name),['movie.en.idx','movie.jp.sub','movie.case.sub']);
  const lease=await bridge.lease('/media/movie.en.idx',{relatedPaths:['/media/movie.en.sub']});
  assert.equal(await(await fetch(lease.url)).text(),'movie.en.idx');assert.equal(await(await fetch(lease.url.replace('.idx','.sub'))).text(),'movie.en.sub');
  assert.equal((await fetch(new URL('secret.txt',lease.url))).status,404);assert.equal((await fetch(new URL('../secret.txt',lease.url))).status,404);
  await adapter.write('/movie.en.sub',Buffer.from('changed'));assert.equal((await fetch(lease.url.replace('.idx','.sub'))).status,412);
  await adapter.write('/pair.idx',Buffer.from('# VobSub index file, v7 (do not modify this line!)\nsize: 720x480\npalette: 000000, ffffff, 808080, c0c0c0, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000\nid: en, index: 0\ntimestamp: 00:00:01:000, filepos: 000000000\nid: fr, index: 1\ntimestamp: 00:00:02:000, filepos: 000000000\n'));
  await adapter.write('/pair.sub',Buffer.alloc(2048));
  const probed=await probeRaw(bridge,'/media/pair.idx',{relatedPaths:['/media/pair.sub']});
  assert.deepEqual(probed.raw.streams.map(stream=>[stream.codec_name,stream.tags.language]),[['dvd_subtitle','en'],['dvd_subtitle','fr']]);
});

test('dummy chapters and disabled chapter refresh follow native duration gates',()=>{
  assert.deepEqual(normalizeProbeChapters([],{runtime:250000000n,dummyChapterDuration:10,hasVideo:true}).map(chapter=>chapter.StartPositionTicks),[0n,100000000n]);
  assert.deepEqual(normalizeProbeChapters([],{runtime:1n,dummyChapterDuration:10,hasVideo:true}).map(chapter=>chapter.StartPositionTicks),[0n]);
  assert.equal(normalizeProbeChapters([],{mode:'ValidationOnly'}),null);
  assert.throws(()=>normalizeProbeChapters([],{runtime:432000000001n,dummyChapterDuration:10,hasVideo:true}),RangeError);
});
