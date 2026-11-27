import model from '../../src/core/resources/live-tv-configuration-model.json' with { type: 'json' };

// Source managers receive stored options, including explicitly null lists.
function withDefaults(type, value) {
  if (value == null) return value;
  if (type.kind === 'array') return value.map(item => withDefaults(type.item, item));
  if (type.kind !== 'object') return value;

  const { defaults, fields } = model.definitions[type.reference];
  const result = structuredClone(defaults);
  for (const [name, child] of Object.entries(value)) {
    result[name] = withDefaults(fields[name].type, child);
  }
  return result;
}

export const liveTvOptions = properties => withDefaults(model.roots.livetv.type, properties);
