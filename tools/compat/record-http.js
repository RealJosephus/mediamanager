import { mkdir, writeFile } from 'node:fs/promises';
const base = process.argv[2];
if (!base || new URL(base).hostname !== '127.0.0.1') throw new Error('An explicit isolated loopback reference URL is required.');
const cases = [];
for (const route of ['/System/Ping','/Localization/Countries','/Localization/Cultures','/Localization/ParentalRatings','/Localization/Options']) {
  for (const language of ['en-US','zh-CN']) {
    const response = await fetch(new URL(route,base),{headers:{'Accept-Language':language,'Accept':'application/json'}});
    const body = await response.text();
    cases.push({route,language,status:response.status,headers:{'content-type':response.headers.get('content-type'),
      'content-language':response.headers.get('content-language')},body});
  }
}
await mkdir('tests/fixtures/http',{recursive:true});
await writeFile('tests/fixtures/http/localization-reference.json',JSON.stringify(cases,null,2));
console.log(JSON.stringify(cases.map(({route,language,status})=>({route,language,status}))));
