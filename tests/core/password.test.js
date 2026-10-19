import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pbkdf2Sync } from 'node:crypto';
import { parsePasswordHash,serializePasswordHash,verifyPasswordHash,authenticatePassword,createPasswordHash,DEFAULT_ITERATIONS } from '../../src/core/password.js';

test('native C# password hashes authenticate in Node and reject a changed password',async()=>{
  const cases=JSON.parse(await readFile(new URL('../fixtures/core/password-oracle.json',import.meta.url),'utf8'));
  for (const row of cases) {
    const hash=parsePasswordHash(row.hash);
    assert.equal(serializePasswordHash(hash),row.hash);
    assert.equal(await verifyPasswordHash(hash,row.password),true);
    assert.equal(await verifyPasswordHash(hash,row.password+'x'),false);
  }
});

test('password authentication upgrades legacy hashes and preserves modern hashes',async()=>{
  const salt=Buffer.from('1020304050607080','hex');
  const legacy=serializePasswordHash({id:'PBKDF2',parameters:new Map([['iterations','1000']]),salt,
    hash:pbkdf2Sync('password',salt,1000,32,'sha1')});
  const user={Password:legacy};
  assert.deepEqual(await authenticatePassword('tester','password',user),{Username:'tester'});
  assert.notEqual(user.Password,legacy);
  assert.equal(parsePasswordHash(user.Password).parameters.get('iterations'),String(DEFAULT_ITERATIONS));
  const current=user.Password;
  await authenticatePassword('tester','password',user);
  assert.equal(user.Password,current);
});

test('native empty-password and malformed-hash branches are retained',async()=>{
  assert.deepEqual(await authenticatePassword('tester','',{Password:null}),{Username:'tester'});
  await assert.rejects(authenticatePassword('tester','x',{Password:null}),/Invalid username/);
  await assert.rejects(authenticatePassword('tester','x',{Password:''}),/String can't be empty/);
  for (const value of ['','$','$a$$01','$a$00$','$a$00$01$02','$a$x=1,x=2$01','$a$z']) assert.throws(()=>parsePasswordHash(value));
  assert.equal(serializePasswordHash(parsePasswordHash('$a$iterations=1,')),'$a$iterations=1');
});

test('new CSPRNG salts retain the native PBKDF2 parameters and hex format',async()=>{
  const hash=parsePasswordHash(await createPasswordHash('password'));
  assert.equal(hash.salt.length,16);
  assert.equal(hash.hash.length,64);
  assert.equal(hash.id, 'PBKDF2-SHA512');
  assert.equal(hash.parameters.get('iterations'), '210000');
  assert.match(serializePasswordHash(hash), /^\$PBKDF2-SHA512\$iterations=210000\$[0-9A-F]{32}\$[0-9A-F]{128}$/u);
  assert.equal(await verifyPasswordHash(hash, 'password'), true);
});

test('valid salts containing zero bytes survive parsing and password verification', async () => {
  const salt = Buffer.from('000102030405060708090A0B0C0D0E00', 'hex');
  const value = { id: 'PBKDF2-SHA512', parameters: new Map([['iterations', '210000']]), salt,
    hash: pbkdf2Sync('密碼😀', salt, DEFAULT_ITERATIONS, 64, 'sha512') };
  const parsed = parsePasswordHash(serializePasswordHash(value));
  assert.deepEqual(parsed.salt, salt);
  assert.equal(await verifyPasswordHash(parsed, '密碼😀'), true);
  assert.equal(await verifyPasswordHash(parsed, '密碼😀x'), false);
});

test('native malformed Unicode and integer parser boundaries do not authenticate replaced input',async()=>{
  const oracle=JSON.parse(await readFile(new URL('../fixtures/core/password-review-oracle.json',import.meta.url),'utf8'));
  for (const row of oracle.results) {
    if (row.exception) assert.throws(()=>parsePasswordHash(row.input),row.input);
    else assert.equal(serializePasswordHash(parsePasswordHash(row.input)),row.canonical,row.input);
  }
  const inputs={null:null,empty:'','55296':'\uD800','65533':'\uFFFD'};
  for (const row of oracle.unicode) {
    if (row.exception) await assert.rejects(createPasswordHash(inputs[row.input]),/invalid UTF-16/);
    else assert.equal(await verifyPasswordHash(parsePasswordHash(row.hash),inputs[row.input]),true,row.input);
  }
  const salt=Buffer.from('1020304050607080','hex');
  for (const row of oracle.integers) {
    const hash={id:'PBKDF2',parameters:new Map([['iterations',row.input]]),salt,hash:pbkdf2Sync('p',salt,1,32,'sha1')};
    if (!row.valid || row.value<=0) await assert.rejects(verifyPasswordHash(hash,'p'));
    else assert.equal(await verifyPasswordHash(hash,'p'),true,JSON.stringify(row.input));
  }
  const replacement=parsePasswordHash(await createPasswordHash('\uFFFD'));
  await assert.rejects(verifyPasswordHash(replacement,'\uD800'),/invalid UTF-16/);
});
