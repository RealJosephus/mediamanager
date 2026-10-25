import { HdHomerunTuner } from './tuner.js';

export function validateConfiguration(configuration) {
  if (Object.keys(configuration).length) throw new TypeError('HDHomeRun tuner settings belong to the shared Live TV configuration.');
}
export async function activate(context) {
  validateConfiguration(context.getConfiguration());
  const options = Object.create(context.options, {
    cachePath: { get: () => context.options.cachePath ?? context.paths.cachePath ?? context.cachePath },
    logger: { get: () => context.options.logger ?? context.logger },
  });
  const tuner = new HdHomerunTuner(options);
  context.own(() => tuner.close()); await context.register('tuner', tuner);
  return { connect: services => tuner.connect(services) };
}
