import { validationPath } from '../validation/paths.js';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

const root=validationPath(resolve('.agent-docs/baselines/jellyfin-current/source'));
const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const mappings=[
  ['src/core/authorization.js','Jellyfin.Server.Implementations/Security/AuthorizationContext.cs'],
  ['src/core/password.js','MediaBrowser.Model/Cryptography/PasswordHash.cs'],
  ['src/core/password.js','Emby.Server.Implementations/Cryptography/CryptographyProvider.cs'],
  ['src/core/password.js','Jellyfin.Server.Implementations/Users/DefaultAuthenticationProvider.cs'],
  ['src/core/identity.js','MediaBrowser.Common/Extensions/BaseExtensions.cs'],
  ['src/core/identity.js','Emby.Server.Implementations/Library/LibraryManager.cs'],
  ['src/core/i18n.js','Emby.Server.Implementations/Localization/LocalizationManager.cs'],
  ['src/core/i18n.js','MediaBrowser.Controller/Entities/BaseItem.cs'],
  ['src/core/i18n.js','Jellyfin.Server/Startup.cs'],
  ['src/core/localization-data.js','Emby.Server.Implementations/Localization/LocalizationManager.cs'],
  ['src/core/localization-data.js','Jellyfin.Api/Controllers/LocalizationController.cs'],
  ['src/core/json.js','src/Jellyfin.Extensions/Json/JsonDefaults.cs'],
  ['src/http/application.js','Jellyfin.Api/Controllers/SystemController.cs'],
  ['src/http/application.js','Jellyfin.Api/Controllers/LocalizationController.cs'],
];
for (const file of ['en-US.json','zh-CN.json']) mappings.push([`src/core/resources/${file}`,`Emby.Server.Implementations/Localization/Core/${file}`]);
for (const file of ['countries.json','iso6392.txt']) mappings.push([`src/core/resources/${file}`,`Emby.Server.Implementations/Localization/${file}`]);
for (const file of await readdir('src/core/resources/ratings')) mappings.push([`src/core/resources/ratings/${file}`,`Emby.Server.Implementations/Localization/Ratings/${file}`]);
const sources=[];
for (const [implementation,source] of mappings) sources.push({implementation,source,sourceSha256:await digest(validationPath(resolve(root,source))),
  implementationSha256:await digest(implementation),license:'Jellyfin repository GPL v2; copyright retained through source attribution'});
await writeFile(validationPath('.agent-docs/evidence/core-provenance.json'),JSON.stringify({recordedAt:new Date().toISOString(),
  baseline:'208c278b75abd897aefa1e1175126eac5e4dbfaa plus captured local changes',sources,
  unicodeTable:'Generated from .NET SDK 10.0.401 String.ToLowerInvariant on Windows using tools/compat/create-oracle.js; production reads JSON only',
  otherModules:'See implementation-storage.md, implementation-database.md, implementation-metadata.md and generated source inventories.'},null,2));
console.log(JSON.stringify({sourceMappings:sources.length}));
