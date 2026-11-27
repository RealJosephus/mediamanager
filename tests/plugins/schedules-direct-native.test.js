import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSchedulesDirectProvider } from '../../plugins/schedules-direct/provider.js';
import { LiveTvCountriesClient } from '../../src/core/live-tv-countries.js';
import { compileOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const input = fileURLToPath(new URL('./fixtures/schedules-direct/input.json', import.meta.url));
test('Schedules Direct matches the native provider and exchanges cached lineups, schedules and rejected image URIs in both directions', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL,
}, async () => {
  const output = path.join(validationOutputRoot(), 'schedules-direct-' + randomUUID());
  const oracle = await compileOracle({ project: 'tests/plugins/fixtures/schedules-direct/Oracle.csproj', output: path.join(output, 'build') });
  const nativeOutput = path.join(output, 'native');
  await oracle.record({ output: nativeOutput, args: [input, '{output}/native.json'] });
  const native = JSON.parse(await fs.readFile(path.join(nativeOutput, 'native.json'), 'utf8'));
  const routes = JSON.parse(await fs.readFile(input, 'utf8'));
  const cache = path.join(output, 'candidate-cache'), exchange = path.join(output, 'imported-native-cache');
  await fs.mkdir(cache); await fs.cp(path.join(nativeOutput, 'sd-cache'), exchange, { recursive: true });
  const rounds = [];
  for (const [index, cachePath] of [cache, cache, exchange].entries()) {
    const calls = [];
    const imagePolicy = new LiveTvCountriesClient({ cachePath });
    try {
      const provider = createSchedulesDirectProvider({ cachePath, imagePolicy, fileSystem: fs, fetch: async (url, init) => {
        const uri = new URL(url);
        assert.equal(uri.origin, 'https://json.schedulesdirect.org');
        const key = init.method + ' ' + uri.pathname.slice('/20141201'.length);
        calls.push(key); assert.ok(Object.hasOwn(routes, key), key);
        return Response.json(routes[key]);
      } });
      const info = { Username: 'user', Password: 'password', ListingsId: 'A' };
      await provider.validate(info, true, true);
      const lineups = await provider.getLineups(info, 'USA', '12345');
      const channels = (await provider.getChannels(info)).map(({ Id, Name, Number, CallSign }) => ({ Id, Name, Number, CallSign }));
      const [program] = await provider.getPrograms(info, 'I21.json.schedulesdirect.org', '2025-03-01T12:00:00Z', '2025-03-01T13:00:00Z');
      const reference = native.rounds[Math.min(index, 1)];
      const observed = { lineups, channels, program: Object.fromEntries(Object.keys(reference.program).map(key => [key, program[key] ?? null])), calls };
      rounds.push(observed);
      assert.deepEqual(observed, reference);
      if (!index) assert.equal(await imagePolicy.reportImageFailure(program.ImageUrl, { sdCode: 5000 }), true);
    } finally { await imagePolicy.close(); }
  }
  assert.notEqual(rounds[0].program.ImageUrl, rounds[1].program.ImageUrl);
  assert.ok(!rounds[2].calls.includes('POST /schedules') && !rounds[2].calls.includes('POST /programs'));
  const nativeWarmOutput = path.join(output, 'native-from-candidate');
  await oracle.record({ output: nativeWarmOutput, args: [input, '{output}/native.json', cache] });
  const imported = JSON.parse(await fs.readFile(path.join(nativeWarmOutput, 'native.json'), 'utf8'));
  assert.deepEqual(imported.rounds, [native.rounds[1]]);
  await fs.writeFile(path.join(output, 'comparison.json'), JSON.stringify({ nativeAssembly: native.assemblySha256, rounds,
    nativeFromCandidate: imported.rounds[0] }, null, 2) + '\n');
});
