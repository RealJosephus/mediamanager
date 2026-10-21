export async function activate(context) {
  const { tuners, invoke } = context.options;
  for (const definition of tuners) await context.register('tuner', {
    type: definition.type, name: definition.type, isSupported: definition.isSupported !== false,
    getChannels: (...args) => invoke('tuner', 'channels', definition, args),
    getChannelStreamMediaSources: (...args) => invoke('tuner', 'sources', definition, args),
    discoverDevices: async () => [],
    getChannelStream() { throw new Error('Core stream sharing is outside this reader fixture.'); },
  });
  await context.register('listings', { type: 'controlled', name: 'Controlled listings',
    validate: async () => {}, getLineups: async () => [],
    getChannels: (...args) => invoke('listings', 'channels', null, args),
    getPrograms: (...args) => invoke('listings', 'programs', null, args),
  });
}
