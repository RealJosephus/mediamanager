import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { audioArguments, audioStreamPlan } from '../../src/media-execution/audio.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { runMediaTool } from '../helpers/media-tool.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const enabled = Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL);

test('stereo downmix follows the native channel layouts and produces the same decoded samples', { skip: !enabled, timeout: 180000 }, async t => {
  const algorithms = ['None', 'Dave750', 'NightmodeDialogue', 'Rfc7845', 'Ac4'];
  const layouts = [[6, null], [6, '5.1'], [8, '7.1'], [4, 'quad'], [4, '4.0'], [3, '3.0'], [7, '7.0'], [2, 'stereo']];
  const cases = algorithms.flatMap(algorithm => layouts.map(([Channels, Layout]) => ({
    Name: `${algorithm}-${Channels}-${Layout}`, Channels, Layout,
    Options: { DownMixStereoAlgorithm: algorithm, DownMixAudioBoost: 1.25 },
  })));
  const root = path.join(validationOutputRoot(), 'stereo-downmix-' + randomUUID());
  await mkdir(root, { recursive: true });
  const input = path.join(root, 'input.json');
  await writeFile(input, JSON.stringify(cases, null, 2));
  await recordOracle({ project: 'tests/playback/fixtures/audio-downmix/Oracle.csproj', output: path.join(root, 'native'),
    args: [input, '{output}/selection.json'] });
  const expected = JSON.parse(await readFile(path.join(root, 'native/selection.json'), 'utf8'));
  const commands = [];
  const observed = [];
  try {
    for (const [index, entry] of cases.entries()) {
      const plan = audioStreamPlan({ Codec: 'aac', Channels: entry.Channels, ChannelLayout: entry.Layout }, {
        MediaType: 'Video', AudioCodec: 'ac3', MaxAudioChannels: 2, AudioBitRate: 192000,
      }, ['ac3'], {}, { hls: true, videoCopy: true, configuration: entry.Options });
      const args = audioArguments(plan);
      const filter = args.includes('-af') ? args[args.indexOf('-af') + 1] : '';
      observed.push({ Name: entry.Name, Channels: plan.channels, Bitrate: plan.bitrate, FilterArgs: filter ? ` -af "${filter}"` : '' });
      assert.deepEqual(observed.at(-1), expected[index]);
      if (entry.Layout !== '5.1' || !args.includes('-af') || args.includes('-ac')) continue;
      // Each input channel has a different frequency and amplitude.
      const generator = 'aevalsrc=' + [233, 313, 379, 97, 457, 563].map((hz, channel) =>
        `${(channel + 1) / 100}*sin(2*PI*${hz}*t)`).join('|') + ':c=5.1:s=48000:d=1';
      const encode = filterValue => runMediaTool('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', generator, '-af', filterValue,
        '-c:a', 'pcm_f32le', '-f', 'framemd5', '-'], commands, t.signal);
      const first = await encode(expected[index].FilterArgs.slice(6, -1));
      assert.deepEqual(await encode(filter), first, entry.Name + ' samples');
    }
  } finally { await writeFile(path.join(root, 'node.json'), JSON.stringify({ observed, commands }, null, 2)); }
});
