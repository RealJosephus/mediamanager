import { validationPath } from '../validation/paths.js';
import { readFile,writeFile } from 'node:fs/promises';
import { SqliteDatabase } from '../../src/database/sqlite.js';

const base=process.argv[2];
const source=process.argv[3];
if (!base || new URL(base).hostname!=='127.0.0.1' || !source) throw new Error('An explicit isolated loopback URL and frozen reference database are required.');
const database=new SqliteDatabase(source,{readOnly:true,requireMigrationHistory:true});
let device;
try { device=database.rows('Devices',{where:{DeviceId:'fixture-oracle'}})[0]; }
finally { database.close(); }
if (!device) throw new Error('No validation device session exists.');
const headers={Authorization:`MediaBrowser Token="${device.AccessToken}"`};
const infoResponse=await fetch(new URL('/System/Info/Public',base));
if (!infoResponse.ok) throw new Error(`Restored reference did not start: ${infoResponse.status}`);
const info=await infoResponse.json();
const logsResponse=await fetch(new URL('/System/ActivityLog/Entries?limit=200',base),{headers});
if (!logsResponse.ok) throw new Error(`Migrated session authentication failed: ${logsResponse.status}`);
const logs=await logsResponse.json();
const mutation=logs.Items.find(item=>item.Name==='Edited current Node PostgreSQL state' && item.ShortOverview==='中文 / current state');
if (!mutation) throw new Error('The returned server did not expose the current PostgreSQL mutation.');
const configResponse=await fetch(new URL('/System/Configuration',base),{headers});
const config=await configResponse.json();
if (config.LogFileRetentionDays!==7) throw new Error('The returned server did not retain the current configuration.');
const originalId=(await readFile(validationPath('.agent-docs/reference-instance/data/data/device.txt'),'utf8')).trim();
if (info.Id!==originalId) throw new Error('The returned server identity changed.');
const shutdown=await fetch(new URL('/System/Shutdown',base),{method:'POST',headers});
if (!shutdown.ok) throw new Error(`Restored server shutdown failed: ${shutdown.status}`);
const report={checkedAt:new Date().toISOString(),serverIdentityPreserved:true,migratedSessionAuthenticated:true,
  currentPostgresMutationReadable:true,currentConfigurationPreserved:true,activityId:mutation.Id,shutdownStatus:shutdown.status,
  limitations:['No populated media library or writable remote sidecars in this scenario.','Client matrix and media access after return migration remain unverified.']};
await writeFile(validationPath('.agent-docs/evidence/roundtrip-runtime-verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
