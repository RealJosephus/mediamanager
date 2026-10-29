export function errorObservation(value, ancestors = new Set()) {
  if (!(value instanceof Error) && !Array.isArray(value)) return value;
  if (ancestors.has(value)) return { circular: true };
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(entry => errorObservation(entry, ancestors));
    return Object.fromEntries([...new Set(['name', ...Object.getOwnPropertyNames(value)])]
      .map(key => [key, errorObservation(value[key], ancestors)]));
  } finally { ancestors.delete(value); }
}
