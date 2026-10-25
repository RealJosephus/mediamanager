import {readFile} from 'node:fs/promises';

const [action,id,argument]=process.argv.slice(2);
const token=process.env.MEDIAMANAGER_ADMIN_TOKEN,base=process.env.MEDIAMANAGER_URL;
if(!base||!token)throw new Error('MEDIAMANAGER_URL and MEDIAMANAGER_ADMIN_TOKEN are required.');
const encoded=encodeURIComponent(id??'');
let method='GET',route,body;
switch(action){
 case 'list':route='/Plugins';break;
 case 'show':route=`/Plugins/${encoded}`;break;
 case 'install':method='POST';route='/Plugins/Install';body={path:id};break;
 case 'update':method='POST';route=`/Plugins/${encoded}/Update`;body={path:argument};break;
 case 'configure':method='POST';route=`/Plugins/${encoded}/Configuration`;body=JSON.parse(await readFile(argument,'utf8'));break;
 case 'enable':case 'disable':method='POST';route=`/Plugins/${encoded}/Enabled`;body={enabled:action==='enable'};break;
 case 'uninstall':method='DELETE';route=`/Plugins/${encoded}`;break;
 case 'clear-cache':method='DELETE';route=`/Plugins/${encoded}/Cache`;break;
 case 'storage':route='/Storage/Configuration';break;
 case 'storage-types':route='/Storage/Types';break;
 case 'storage-status':route='/Storage/Status';break;
 case 'storage-configure':method='POST';route='/Storage/Configuration';body=JSON.parse(await readFile(id,'utf8'));break;
 case 'storage-bind':method='POST';route='/Storage/Bindings';body=JSON.parse(await readFile(id,'utf8'));break;
 default:throw new Error('Usage: plugins.js list | show ID | install DIRECTORY | update ID DIRECTORY | configure ID JSON_FILE | enable ID | disable ID | uninstall ID | clear-cache ID | storage | storage-types | storage-status | storage-configure JSON_FILE | storage-bind JSON_FILE');
}
if(!['list','storage','storage-types','storage-status'].includes(action)&&!id)throw new Error('A plugin ID, package directory or JSON file is required.');
const url=new URL(base);url.pathname=url.pathname.replace(/\/$/u,'')+route;url.search='';url.hash='';
const response=await fetch(url,{method,headers:{Authorization:`MediaBrowser Token="${token}"`,'Content-Type':'application/json'},
 ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(120000)});
const text=await response.text();
if(!response.ok)throw new Error(`Management request failed (${response.status}): ${text}`);
if(text)console.log(JSON.stringify(JSON.parse(text),null,2));
