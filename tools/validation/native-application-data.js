import path from 'node:path';
import { mkdir } from 'node:fs/promises';

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
