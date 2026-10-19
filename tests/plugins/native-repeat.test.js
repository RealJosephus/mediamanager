import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import reader from '../metadata/fixtures/nfo-partial-reader/repeat.json' with {type:'json'};
import provider from '../metadata/fixtures/nfo-scalar-provider/repeat.json' with {type:'json'};
import readerNative from '../metadata/fixtures/nfo-partial-reader/native.json' with {type:'json'};
import providerNative from '../metadata/fixtures/nfo-scalar-provider/native.json' with {type:'json'};
import readerSource from '../metadata/fixtures/nfo-partial-reader/provenance.json' with {type:'json'};
import providerSource from '../metadata/fixtures/nfo-scalar-provider/provenance.json' with {type:'json'};

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const verify=async entry=>{const bytes=await readFile(entry.filename??entry.path);if(entry.bytes!==undefined)assert.equal(bytes.length,entry.bytes);assert.equal(hash(bytes),entry.sha256);return bytes;};
for(const [name,proof,native,source]of [['NFO reader',reader,readerNative,readerSource],['NFO provider',provider,providerNative,providerSource]])test(name+' independently repeats the real native differential with bound source and assembly bytes',async()=>{
 await verify(proof.input);assert.equal(proof.recordings.length,2);assert.notEqual(proof.recordings[0].oracleAssembly.filename,proof.recordings[1].oracleAssembly.filename);
 for(const record of proof.recordings){assert.equal(record.passed,true);assert.equal(record.build.status,0);assert.equal(record.process.status,0);
  for(const entry of [record.dotnet,record.jellyfinDll,record.oracleAssembly,...record.sourceFiles,...record.outputs])await verify(entry);
 }
 for(const [filename,sha256]of Object.entries(source.jellyfin.sources))for(const directory of [source.jellyfin.root,'D:/mediamanager-validation/20261005/jellyfin-baseline/source'])await verify({filename:path.join(directory,filename),sha256});
 for(const [filename,entry]of Object.entries(source.runtime.assemblies))await verify({...entry,filename:path.join(path.dirname(source.runtime.jellyfinDll.path),filename)});
 let prior;
 for(const entry of proof.outputs){const result=JSON.parse(await verify(entry));assert.equal(result.inputSha256,proof.input.sha256);assert.deepEqual(result.results,native.results);if(prior)assert.deepEqual(result,prior);prior=result;}
});
