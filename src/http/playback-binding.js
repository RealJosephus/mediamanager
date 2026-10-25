import schema from './resources/playback-body-schema.json' with { type:'json' };
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';

export function bindPlaybackBody(body, source) {
  return bindJsonModel(body,{schema,root:schema.playback,source}) ?? {};
}

export function bindDeviceProfile(body, source) {
  return bindJsonModel(body,{schema,root:schema.definitions[schema.playback.reference].fields.DeviceProfile,source});
}

export function validatePlaybackBody(body, source) {
  return validateJsonModel(bindPlaybackBody(body,source),{schema,root:schema.playback});
}
