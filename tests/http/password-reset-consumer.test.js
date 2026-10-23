import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DefaultPasswordResetProvider } from '../../src/users/password-reset-service.js';
import { parseJsonDateTime } from '../../src/http/json-date-time.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const fixture = new URL('./fixtures/password-reset/', import.meta.url);
const inputBytes = await readFile(new URL('current-input.json', fixture));
const input = JSON.parse(inputBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const enabled = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000 };

test('current Native public password reset provider consumes same-run Node PIN files', enabled, async t => {
  assert.equal(input.length, 3);
  const output = path.resolve(validationOutputRoot());
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'password-reader-current-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = new Date('2099-01-02T03:04:05.123Z');
  const cases = [];
  for (const sample of input) {
    const programData = path.join(root, sample.Name);
    await mkdir(programData);
    const provider = new DefaultPasswordResetProvider({ users: {}, programDataPath: programData, now: () => now });
    const observation = await provider.start({ Username: sample.UserName }, sample.EnteredUsername, true);
    assert.equal(observation.Action, 'PinCode', sample.Name);
    assert.equal(path.dirname(observation.PinFile), programData, sample.Name);
    assert.ok(path.basename(observation.PinFile).startsWith('passwordreset'), sample.Name);
    const bytes = await readFile(observation.PinFile), document = JSON.parse(bytes);
    assert.match(document.Pin, /^[0-9A-F]{2}(?:-[0-9A-F]{2}){3}$/u, sample.Name);
    assert.equal(document.UserName, sample.UserName, sample.Name);
    assert.equal(document.PinFile, observation.PinFile, sample.Name);
    assert.equal(parseJsonDateTime(document.ExpirationDate).ticks,
      parseJsonDateTime(observation.PinExpirationDate).ticks, sample.Name);
    assert.ok(parseJsonDateTime(document.ExpirationDate).ticks > parseJsonDateTime(now.toISOString()).ticks, sample.Name);
    cases.push({ Name: sample.Name, UserId: sample.UserId, UserName: sample.UserName, ProgramData: programData,
      FileName: observation.PinFile, SourceSha256: hash(bytes), RedeemPin: sample.CompactPin ? document.Pin.replaceAll('-', '') : document.Pin });
  }
  const manifestBytes = Buffer.from(JSON.stringify({ Cases: cases }, null, 2) + '\n');
  const manifest = path.join(root, 'manifest.json');
  await writeFile(manifest, manifestBytes, { flag: 'wx' });
  const nativeRoot = path.join(root, 'native');
  await recordOracle({ project: 'tests/http/fixtures/password-reset/current/Oracle.csproj', output: nativeRoot,
    args: [manifest, '{output}/native.json'] });
  const native = JSON.parse(await readFile(path.join(nativeRoot, 'native.json')));
  assert.equal(native.Results.length, cases.length);
  for (const [index, sample] of input.entries()) {
    const expected = cases[index], actual = native.Results[index];
    assert.deepEqual(actual, {
      Name: sample.Name,
      SourceSha256: expected.SourceSha256,
      Success: true,
      UsersReset: [sample.UserName],
      ChangedUserId: sample.UserId.replaceAll('-', '').toLowerCase(),
      RequestedPin: expected.RedeemPin,
      FileDeleted: true,
    });
    await assert.rejects(readFile(expected.FileName), error => error.code === 'ENOENT', sample.Name);
  }
});
