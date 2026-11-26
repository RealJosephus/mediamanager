import recordedModel from './resources/configuration-model.json' with { type: 'json' };

// The recorded XML schema is a sealed historical input. The current server
// model adds a persisted setting that is internal to the configuration manager.
const model = structuredClone(recordedModel);
const server = model.definitions.ServerConfiguration;
server.fields.EnableObsoleteEndpoints = {
  type: { kind: 'boolean' }, element: 'EnableObsoleteEndpoints', nullable: false, defaultValue: null,
};
server.order.push('EnableObsoleteEndpoints');
server.defaults.EnableObsoleteEndpoints = true;
model.roots.server.defaults.EnableObsoleteEndpoints = true;

export default model;
