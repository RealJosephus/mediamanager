import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { lowerInvariant, md5Guid, getNewItemId } from '../../src/core/identity.js';
import { parseAuthorizationParts } from '../../src/core/authorization.js';
import { Localization, createCoreLocalization, metadataLocale } from '../../src/core/i18n.js';

const fixture = async name => JSON.parse(await readFile(new URL(`../fixtures/core/${name}-oracle.json`, import.meta.url), 'utf8'));

test('native .NET identity recordings match MD5 GUID order and invariant Unicode casing', async () => {
  for (const row of await fixture('identity')) {
    assert.equal(lowerInvariant(row.input), row.lower, row.input);
    assert.equal(md5Guid(row.input), row.md5, row.input);
  }
  assert.equal(lowerInvariant('ΟΣ'), 'οσ');
  assert.equal(lowerInvariant('İ'), 'İ');
});

test('identity preserves program-data normalization and case-sensitive native paths', () => {
  const config = { programDataPath: 'D:/data' };
  assert.equal(getNewItemId('D:/data/root/A', 'Type', config), md5Guid('Typeroot\\a'));
  assert.equal(getNewItemId('D:/database/A', 'Type', config), md5Guid('Typebase\\a'));
  assert.equal(getNewItemId('d:/data/A', 'Type', config), md5Guid('Typed:/data/a'));
  assert.notEqual(getNewItemId('/A', 'Type', {...config,enableCaseSensitiveItemIds:true}), getNewItemId('/a', 'Type', config));
});

test('authorization parsing matches extracted current-source oracle', async () => {
  for (const row of await fixture('authorization')) assert.deepEqual({...parseAuthorizationParts(row.input)}, row.parts, row.input);
});

test('request culture negotiation retains the ASP.NET sorting and formatting context', async () => {
  const localization = new Localization();
  for (const row of await fixture('locale')) {
    const result = localization.negotiate({ url: `/${row.input.query ?? ''}`, headers: {
      ...(row.input.cookie ? {cookie:row.input.cookie} : {}), ...(row.input.header ? {'accept-language':row.input.header} : {}),
    } });
    assert.deepEqual(result, {culture:row.culture, uiCulture:row.uiCulture}, JSON.stringify(row.input));
  }
});

test('server messages are independent of request cultures and retain key lookup', async () => {
  const localization = await createCoreLocalization();
  const values = JSON.parse(await readFile(new URL('../../src/core/resources/en-US.json', import.meta.url), 'utf8'));
  for (const uiCulture of ['en-US', 'zh-CN']) {
    localization.run({ culture: uiCulture, uiCulture }, () => {
      for (const [key, value] of Object.entries(values)) assert.equal(localization.text(key), value);
    });
  }
  localization.register('test', { message: 'English' });
  assert.equal(localization.text('MESSAGE',{namespace:'test'}),'English');
  assert.equal(localization.text('Missing',{namespace:'test'}),'Missing');
  assert.throws(()=>localization.register('test',{}),/Duplicate/);
});

test('requests, deferred WebSocket callbacks and background locale contexts remain isolated', async () => {
  const localization = new Localization({serverCulture:'en-US'});
  const callbacks = [];
  await Promise.all(['en-US','zh-CN'].map(uiCulture => localization.run({culture:uiCulture,uiCulture}, async () => {
    callbacks.push(localization.bind(()=>localization.context.uiCulture));
    await new Promise(resolve=>setTimeout(resolve,uiCulture==='en-US'?10:1));
    assert.equal(localization.context.uiCulture,uiCulture);
    localization.runBackground(()=>assert.equal(localization.context.uiCulture,'en-US'));
  })));
  assert.deepEqual(callbacks.map(callback=>callback()),['en-US','zh-CN']);
});

test('metadata language and country independently inherit native hierarchy', () => {
  assert.deepEqual(metadataLocale({ item:{PreferredMetadataLanguage:'fr'}, parents:[{PreferredMetadataCountryCode:'CA'}],
    library:{PreferredMetadataLanguage:'zh',MetadataCountryCode:'CN'} }),{language:'fr',country:'CA'});
  assert.deepEqual(metadataLocale(),{language:'en',country:'US'});
  assert.deepEqual(metadataLocale({server:{PreferredMetadataLanguage:'',MetadataCountryCode:''}}),{language:'',country:''});
});
