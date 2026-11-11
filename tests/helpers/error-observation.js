export function errorObservation(value) {
  return observe(value, new Set());
}

function observe(value, ancestors) {
  if (!(value instanceof Error) && !Array.isArray(value)) return value;
  if (ancestors.has(value)) return { circular: true };
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(entry => observe(entry, ancestors));
    return Object.fromEntries([...new Set(['name', ...Object.getOwnPropertyNames(value)])]
      .map(key => [key, observe(value[key], ancestors)]));
  } finally { ancestors.delete(value); }
}
