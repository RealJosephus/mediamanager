import path from 'node:path';
import os from 'node:os';
import { after } from 'node:test';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';

// Unit fixtures already choose isolated paths. Their filesystem dependency is
// the actual local plugin adapter, including handle closure and link rejection.
const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
registry.registerType('fixture-local', configuration => LocalAdapter.open(configuration));
let number = 0;
for (const root of new Set([path.parse(os.tmpdir()).root,path.parse(process.cwd()).root])) {
  const id = String(++number), accessRoot = '/test-'+id;
  await registry.createInstance(id,'fixture-local',{root,writable:true});
  vfs.mount({path:accessRoot,instanceId:id,root:'/',capabilities:{create:true,replace:true,mkdir:true,delete:true,rename:true,atomicReplace:true}});
  identityMap.addPrefix({identityRoot:root,accessRoot,style:process.platform==='win32'?'windows':'posix',caseSensitive:process.platform!=='win32',returnAccess:'Isolated test fixture'});
}
export const testFileSystem = new StorageFileSystem({vfs,identityMap});
after(()=>registry.close());
