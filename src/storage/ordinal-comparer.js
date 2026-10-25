// Scalar equivalence classes recorded from the pinned Jellyfin .NET runtime.
// OrdinalIgnoreCase is distinct from invariant lower/upper casing.
import mapping from './resources/ordinal-ignore-case.json' with { type: 'json' };

export function ordinalIgnoreCaseKey(value) {
  return [...value].map(character => mapping[character] ?? character).join('');
}

export function ordinalIgnoreCaseEquals(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.length === right.length && ordinalIgnoreCaseKey(left) === ordinalIgnoreCaseKey(right);
}
