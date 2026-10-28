import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** An installed Node plugin, not a replacement for the runtime consumer. */
export async function createLyricProviderPackage(root) {
  const source = path.join(root, 'provider-package'); await mkdir(source);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@test/lyric-provider', version: '0.1.0', type: 'module',
    mediamanager: { id: 'lyric-provider-fixture', name: 'Controlled original lyric provider', entry: 'index.js' } }));
  await writeFile(path.join(source, 'index.js'), [
    "import { appendFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    "export async function activate(context) {",
    " const record = value => appendFile(path.join(context.dataPath,'requests.jsonl'),JSON.stringify(value)+'\\n');",
    " const response = entry => entry ? { format:entry.format,bytes:Buffer.from(entry.bytes,'base64') } : null;",
    " const metadata = value => value === null ? null : Object.fromEntries(Object.entries(value).map(([key,entry])=>",
    "  [key,['Length','Offset'].includes(key)&&entry!==null?BigInt(entry):entry]));",
    " for (const definition of context.options.providers) await context.register('lyric',{",
    "  name:definition.name,order:definition.order,",
    "  async search(request,{signal}) {",
    "   signal.throwIfAborted();",
    "   await record({provider:definition.name,mediaPath:request.mediaPath,songName:request.songName,albumName:request.albumName,",
    "    albumArtistsNames:request.albumArtistsNames,artistNames:request.artistNames,duration:request.duration?.toString()??null,",
    "    isAutomated:request.isAutomated,providerIds:Object.fromEntries(request.providerIds)});",
    "   if(definition.searchError)throw new Error('Controlled provider search failure.');",
    "   return definition.entries.map(entry=>({id:entry.id,providerName:entry.providerName,metadata:metadata(entry.metadata),lyrics:response(entry)}));",
    "  },",
    "  async getLyrics(id,{signal}) {",
    "   if(id==='error')throw new Error('Controlled provider read failure.');",
    "   if(id==='download-disconnect'||id==='lifecycle-held'){",
    "    const read=await fetch(context.options.sourceUrl+'/'+id,{signal});",
    "    try{return {format:'txt',bytes:new Uint8Array(await read.arrayBuffer())};}",
    "    finally{if(read.body&&!read.body.locked)await read.body.cancel();}",
    "   }",
    "   return response(definition.entries.find(entry=>entry.id===id));",
    "  }",
    " });",
    " return {};",
    "}",
  ].join('\n') + '\n');
  return source;
}
