import { HttpAdapter } from './adapter.js';

export function validateConfiguration(configuration) {
  if (Object.keys(configuration).length) throw new TypeError('HTTP settings belong to each storage instance.');
}

export async function activate(context) {
  validateConfiguration(context.getConfiguration());
  await context.register('storage', {
    type: 'http',
    create: (configuration, options) => new HttpAdapter(configuration, options),
    defaults: ['http:', 'https:'].map(protocol => ({
      id: protocol.slice(0, -1), config: {}, identityRoot: protocol, style: 'uri', capabilities: {},
      returnAccess: 'Retain the original public HTTP source URI.',
    })),
  });
}
