import { writeFile, mkdir } from 'node:fs/promises';

await mkdir('tests/fixtures/core', { recursive: true });
const authorization = [
  '', 'Client="A,B", Token="a%2Bb+c", token="lower"', 'Token="one",Token="two"',
  'Token=" x "', 'Token=abc', 'Token="a%zzb"', 'Token="%ff"', 'Token="a&b#c"',
  'Device="中文 测试", Version="1"', 'Token="x",', ' x =" y "', 'Token="a=b,c"',
];
const locales = [
  {}, {query:'?culture=zh-CN'}, {query:'?ui-culture=zh-CN'}, {query:'?culture=fr&ui-culture=zh-CN'},
  {query:'?culture=zh-CN&ui-culture=fr'}, {query:'?culture=fr',header:'zh-CN'},
  {query:'?culture=zh-CN',header:'en-US'}, {header:'fr;q=1,zh-CN;q=0.8,en-US;q=0.7'},
  {header:'zh-TW'}, {header:'zh'}, {header:'zh-CN;q=0'}, {header:'fr,de,es,zh-CN'},
  {header:'zh-Hans-CN'}, {header:'EN-us'}, {header:'en_US'},
  {cookie:'.AspNetCore.Culture=c=zh-CN|uic=zh-CN',header:'en-US'},
  {cookie:'.AspNetCore.Culture=c=|uic=zh-CN'},
  {cookie:'.AspNetCore.Culture=c=fr|uic=fr',header:'zh-CN'},
  {cookie:'.AspNetCore.Culture=c%3Dzh-CN%7Cuic%3Dzh-CN'},
  {query:'?culture=&ui-culture=zh-CN'}, {query:'?culture=fr&culture=zh-CN'},
  {query:'?culture=ZH-cn'}, {header:'zh-CN;q=0.2,en-US;q=0.9'},
  {header:'fr;q=0.1,de;q=0.2,es;q=0.3,zh-CN;q=1'},
  {header:'zh_CN'}, {query:'?culture=zh_CN'}, {header:'zh-CN-extra'},
  {cookie:'.AspNetCore.Culture="c=zh-CN|uic=zh-CN"'},
  {query:'?culture=zh-CN&culture=en-US'},
];
await writeFile('tests/fixtures/core/authorization-input.json', JSON.stringify(authorization, null, 2));
await writeFile('tests/fixtures/core/locale-input.json', JSON.stringify(locales, null, 2));
