import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function stageSubtitleBurn(subtitles, source, stream, mediaPath, signal) {
  if (!stream) return;
  const root = path.resolve(tmpdir());
  const cwd = await mkdtemp(path.join(root, 'mediamanager-burn-'));
  const release = async () => {
    if (path.dirname(cwd) !== root || !path.basename(cwd).startsWith('mediamanager-burn-')) throw new Error('Invalid subtitle staging directory.');
    await rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  };
  try {
    const { extension, bytes } = await subtitles.load(source, stream, mediaPath, signal);
    const subtitleFile = 'subtitle.' + extension;
    await writeFile(path.join(cwd, subtitleFile), bytes, { flag: 'wx', signal });
    let count = 0;
    for await (const font of subtitles.fonts(source, mediaPath, signal)) {
      if (count === 0) await mkdir(path.join(cwd, 'fonts'));
      await writeFile(path.join(cwd, 'fonts', `${++count}.${font.extension}`), font.bytes, { flag: 'wx', signal });
    }
    return { cwd, filter: 'subtitles=f=' + subtitleFile + (count ? ':fontsdir=fonts' : ''), release };
  } catch (error) {
    try { await release(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
    throw error;
  }
}
