export function readPublishedServerStartupOptions({ args = [], environment = {} } = {}) {
  let publicAddress;
  for (const [key, value] of Object.entries(environment)) {
    if (key.slice(0, 9).toLowerCase() === 'jellyfin_' && key.slice(9).toLowerCase() === 'publishedserverurl') publicAddress = value;
  }
  let supplied = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--published-server-url' && !argument.startsWith('--published-server-url=')) continue;
    if (supplied) throw new TypeError('The --published-server-url option may only be supplied once.');
    supplied = true;
    if (argument === '--published-server-url') {
      // The actual StartupOptions parser leaves a value-less string option
      // unset. An explicit empty equals token is a separate parse failure.
      if (index + 1 === args.length || args[index + 1].startsWith('--')) continue;
      publicAddress = args[++index];
    } else {
      publicAddress = argument.slice('--published-server-url='.length);
      if (publicAddress === '') throw new TypeError('The --published-server-url equals token requires a value.');
    }
  }
  if (publicAddress !== undefined && typeof publicAddress !== 'string') throw new TypeError('PublishedServerUrl must be a string.');
  return { publicAddress };
}
