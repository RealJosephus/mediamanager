import { HdHomerunTuner } from './tuner.js';

export function validateConfiguration(configuration) {
  if (Object.keys(configuration).length) throw new TypeError('HDHomeRun tuner settings belong to the shared Live TV configuration.');
}
export async function activate(context) {
  validateConfiguration(context.configuration);
  const tuner = new HdHomerunTuner({ cachePath: context.paths.cachePath ?? context.cachePath, logger: context.logger, ...context.options });
  context.own(() => tuner.close()); await context.register('tuner', tuner);
  return { connect: services => tuner.connect(services) };
}
