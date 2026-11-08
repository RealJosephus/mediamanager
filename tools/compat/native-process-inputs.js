import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { describeFile } from '../validation/inventory.js';
import { validationExecutable } from '../validation/paths.js';

async function executableIdentity(filename) {
  const identity = await describeFile(filename);
  if (!identity.available || identity.kind !== 'file') throw new Error('Reference executable must be an ordinary file.');
  return identity;
}

export async function resolveNativeTools(environment = process.env) {
  const executables = [];
  async function resolveExecutable(name, requested) {
    let filename = await realpath(requested);
    const dispatch = [], shim = `${filename}.shim`;
    let source;
    try { source = await readFile(shim, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (source !== undefined) {
      const target = /^path\s*=\s*"?([^"\r\n]+)"?\s*$/mu.exec(source)?.[1]?.trim();
      if (!target || !path.isAbsolute(target)) throw new Error('Reference executable shim must declare an absolute target.');
      dispatch.push(await executableIdentity(filename), await executableIdentity(shim));
      filename = await realpath(target);
    }
    if (!path.isAbsolute(filename)) throw new Error('Reference executable paths must be absolute.');
    executables.push({ name, requested, ...await executableIdentity(filename), dispatch });
    return filename;
  }
  const dotnet = await resolveExecutable('dotnet', validationExecutable('dotnet', environment));
  const ffmpeg = await resolveExecutable('ffmpeg', validationExecutable('ffmpeg', environment));
  // MediaEncoder.SetFFmpegPath derives this sibling from the actual --ffmpeg
  // argument before probing its capabilities; a separate PATH lookup is wrong.
  await resolveExecutable('ffprobe', ffmpeg.replace(/[^/\\]+?(\.[^/\\\n.]+)?$/u, 'ffprobe$1'));
  return { dotnet, ffmpeg, executables };
}

export async function verifyNativeProcessInputs({ executables, subtitleEditDataDirectory }) {
  for (const executable of executables.flatMap(value => [value, ...value.dispatch])) {
    if ((await describeFile(executable.filename)).sha256 !== executable.sha256) throw new Error('Native executable changed during its process lifetime.');
  }
  if (subtitleEditDataDirectory && !(await stat(path.join(subtitleEditDataDirectory, 'Dictionaries'))).isDirectory()) {
    throw new Error('Native subtitle dictionaries were not initialized in isolated application data.');
  }
}
