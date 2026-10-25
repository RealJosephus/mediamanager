export async function activate(context) {
  const { tuners, listings, invoke } = context.options;
  for (const definition of tuners) await context.register('tuner', {
    type: definition.type, name: definition.name, isSupported: definition.isSupported !== false,
    validate: (...args) => invoke('tuner', 'validate', definition, args),
    getChannels: (...args) => invoke('tuner', 'channels', definition, args),
    discoverDevices: (...args) => invoke('tuner', 'discover', definition, args),
    getChannelStream() { throw new Error('No stream executor belongs to this control.'); },
    getChannelStreamMediaSources: async () => [],
  });
  for (const definition of listings) await context.register('listings', {
    type: definition.type, name: definition.name,
    validate: (...args) => invoke('listings', 'validate', definition, args),
    getChannels: (...args) => invoke('listings', 'channels', definition, args),
    getLineups: (...args) => invoke('listings', 'lineups', definition, args),
    getPrograms: (...args) => invoke('listings', 'programs', definition, args),
  });
}
