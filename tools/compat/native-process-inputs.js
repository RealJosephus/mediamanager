import path from 'node:path';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
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

export async function prepareNativeApplicationData(root) {
  // libse 4.0.12 probes the assembly directory on Unix unless the user's data
  // directory exists. Source: SubtitleEdit/subtitleedit@6305d8ff4df1c7e7b55cf6d647ac6c95464071b1,
  // src/libse/Common/Configuration.cs:152-178 (the NuGet package's source commit).
  const runtimeEnvironment = {}, userConfiguration = path.join(root, 'config', 'native-user');
  let subtitleEditDataDirectory;
  if (process.platform === 'linux') {
    runtimeEnvironment.XDG_CONFIG_HOME = userConfiguration;
    subtitleEditDataDirectory = path.join(userConfiguration, 'Subtitle Edit');
  } else if (process.platform === 'darwin') {
    // .NET uses Foundation's Application Support directory on macOS; CoreFoundation
    // honors CFFIXED_USER_HOME rather than the XDG configuration variable.
    // dotnet/runtime@v10.0.12: Environment.GetFolderPathCore.Unix.cs:92-94;
    // apple-oss-distributions/CF@5b29c619aaf0cf1042bcfefc4bb10ef15b89dc11:
    // CFPlatform.c, _CFCopyHomeDirURLForUser.
    runtimeEnvironment.CFFIXED_USER_HOME = userConfiguration;
    subtitleEditDataDirectory = path.join(userConfiguration, 'Library', 'Application Support', 'Subtitle Edit');
  }
  if (subtitleEditDataDirectory) await mkdir(subtitleEditDataDirectory, { recursive: true });
  return { runtimeEnvironment, subtitleEditDataDirectory };
}

export async function verifyNativeProcessInputs({ executables, subtitleEditDataDirectory }) {
  for (const executable of executables.flatMap(value => [value, ...value.dispatch])) {
    if ((await describeFile(executable.filename)).sha256 !== executable.sha256) throw new Error('Native executable changed during its process lifetime.');
  }
  if (subtitleEditDataDirectory && !(await stat(path.join(subtitleEditDataDirectory, 'Dictionaries'))).isDirectory()) {
    throw new Error('Native subtitle dictionaries were not initialized in isolated application data.');
  }
}
