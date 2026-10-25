import { M3uTuner } from './tuner.js';

export function validateConfiguration(configuration) {
  if (Object.keys(configuration).length) throw new TypeError('M3U tuner settings belong to the shared Live TV configuration.');
}
export async function activate(context) {
  validateConfiguration(context.getConfiguration());
  const options = Object.create(context.options, {
    cachePath: { get: () => context.options.cachePath ?? context.paths.cachePath ?? context.cachePath },
    logger: { get: () => context.options.logger ?? context.logger },
  });
  const tuner = new M3uTuner(options);
  context.own(() => tuner.close());
  await context.register('tuner', tuner);
  return { connect: services => tuner.connect(services) };
}
