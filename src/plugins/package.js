import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const officialPackagesPath = fileURLToPath(new URL('../../plugins/', import.meta.url));
const sdkPath = fileURLToPath(new URL('../../packages/plugin-sdk/', import.meta.url));
export const validPluginId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
  && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value);

export async function physicalDirectory(directory, { missing = false } = {}) {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let cursor = resolved;
  for (;;) {
    try { const stat = await fs.lstat(cursor === root && /^\\\\\?\\[A-Za-z]:\\$/u.test(cursor) ? cursor.slice(4) : cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TypeError('Plugin directories must be physical directories.');
    } catch (error) { if (!missing || error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor); if (parent === cursor || cursor === root) break; cursor = parent;
  }
  return resolved;
}

export async function inspectPackage(directory) {
  directory = await physicalDirectory(directory);
  const files = []; let size = 0;
  const visit = async (relative = '') => {
    if (relative.split(path.sep).length > 32) throw new TypeError('Plugin package directory depth exceeds its limit.');
    for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules') continue;
      if (entry.name.startsWith('.') || /[:\\]/.test(entry.name) || entry.isSymbolicLink()) throw new TypeError('Plugin packages cannot contain hidden files, links or alternate streams.');
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        const info = await fs.lstat(path.join(directory,name));
        if (files.length >= 4096 || size + info.size > 32 * 1024 * 1024) throw new TypeError('Plugin package exceeds its file or byte limit.');
        const bytes = await fs.readFile(path.join(directory, name)); size += bytes.length;
        if (size > 32 * 1024 * 1024) throw new TypeError('Plugin package changed while being read.');
        files.push({ name: name.replaceAll('\\','/'), bytes });
      } else throw new TypeError('Plugin packages must contain ordinary files.');
    }
  };
  await visit();
  const manifestFile = files.find(file=>file.name==='package.json');
  if (!manifestFile) throw new TypeError('Plugin package.json is required.');
  const manifest = JSON.parse(manifestFile.bytes.toString('utf8')), declaration = manifest.mediamanager;
  if (!validPluginId(declaration?.id) || typeof declaration.name !== 'string' || !declaration.name
    || manifest.type !== 'module' || typeof manifest.name !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)
    || typeof declaration.entry !== 'string' || !/^[a-zA-Z0-9_./-]+\.js$/.test(declaration.entry)
    || declaration.entry.split('/').includes('..') || declaration.entry.startsWith('/')
    || !files.some(file=>file.name===declaration.entry)) throw new TypeError('Invalid Node plugin manifest.');
  if (manifest.scripts || Object.keys(manifest.dependencies ?? {}).some(name=>!['@mediamanager/plugin-sdk','fast-xml-parser'].includes(name))) {
    throw new TypeError('Plugin dependencies must be bundled; install scripts are not supported.');
  }
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.name).update('\0').update(file.bytes).update('\0');
  return { manifest, files, digest:hash.digest('hex') };
}

export async function stagePackage(source, root) {
  const inspected = await inspectPackage(source), release = randomUUID();
  const directory = path.join(root, 'packages', release);
  await physicalDirectory(directory, { missing: true });
  await fs.mkdir(directory, {recursive:true});
  try {
    for (const file of inspected.files) { const target=path.join(directory,file.name); await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,file.bytes,{flag:'wx'}); }
    await prepareDependencies(directory, inspected.manifest);
    return { release, digest:inspected.digest, manifest:inspected.manifest };
  } catch(error) { await fs.rm(directory,{recursive:true,force:true}); throw error; }
}

// Generated import facades are ordinary files, so instance capture needs no
// symlink exemption. Rebuilding them binds a restored package to this host SDK.
async function prepareDependencies(directory, manifest) {
  const write = async (relative, content) => {
    const target=path.join(directory,'node_modules',relative);
    await physicalDirectory(path.dirname(target),{missing:true});await fs.mkdir(path.dirname(target),{recursive:true});
    try { if (!(await fs.lstat(target)).isFile()) throw new TypeError('Generated plugin dependencies must be ordinary files.'); }
    catch (error) { if(error.code!=='ENOENT')throw error; }
    await fs.writeFile(target,content);
  };
  const sdk=JSON.parse(await fs.readFile(path.join(sdkPath,'package.json'),'utf8'));
  await write('@mediamanager/plugin-sdk/package.json',JSON.stringify({name:sdk.name,type:'module',exports:sdk.exports}));
  for(const entry of Object.values(sdk.exports))await write('@mediamanager/plugin-sdk/'+entry,
    'export * from '+JSON.stringify(pathToFileURL(path.join(sdkPath,entry)).href)+';\n');
  if(manifest.dependencies?.['fast-xml-parser']){
    await write('fast-xml-parser/package.json',JSON.stringify({name:'fast-xml-parser',type:'module',exports:'./index.js'}));
    await write('fast-xml-parser/index.js','export * from '+JSON.stringify(import.meta.resolve('fast-xml-parser'))+';\n');
  }
}

export async function verifyRelease(root, descriptor) {
  if (!/^[0-9a-f-]{36}$/.test(descriptor?.release ?? '')) throw new TypeError('Invalid plugin release identity.');
  const directory=path.join(root,'packages',descriptor.release), inspected=await inspectPackage(directory);
  if(inspected.digest!==descriptor.digest) throw new Error('Installed plugin package integrity check failed.');
  if(JSON.stringify(inspected.manifest)!==JSON.stringify(descriptor.manifest))throw new Error('Installed plugin manifest does not match its persisted descriptor.');
  await prepareDependencies(directory,inspected.manifest);
  return directory;
}
