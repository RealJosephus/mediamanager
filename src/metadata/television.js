export function parseSeriesStatus(value) {
  if (value == null) return null;
  const source = String(value); const normalized = source.trim().toLowerCase();
  const names = ['Continuing', 'Ended', 'Unreleased'];
  const result = names.find((name) => name.toLowerCase() === normalized);
  if (result) return result;
  if (/^[+-]?\d+$/.test(normalized) && Number(normalized) >= -2147483648 && Number(normalized) <= 2147483647) return names[Number(normalized)] ?? Number(normalized);
  const flags = normalized.split(',').map((part) => names.findIndex((name) => name.toLowerCase() === part.trim()));
  if (flags.length > 1 && flags.every((part) => part >= 0)) { const value = flags.reduce((a, b) => a | b, 0); return names[value] ?? value; }
  if (['pilot', 'returning series', 'returning'].includes(source.toLowerCase())) return 'Continuing';
  if (['cancelled', 'canceled'].includes(source.toLowerCase())) return 'Ended';
  return null;
}

export function parseAirDays(value) {
  if (!value) return null;
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (value.toLowerCase() === 'daily') return names;
  const normalized = value.trim().toLowerCase();
  if (/^[+-]?\d+$/.test(normalized) && Number(normalized) >= -2147483648 && Number(normalized) <= 2147483647) return [names[Number(normalized)] ?? Number(normalized)];
  const flags = normalized.split(',').map((part) => names.findIndex((name) => name.toLowerCase() === part.trim()));
  if (flags.every((part) => part >= 0)) { const result = flags.reduce((a, b) => a | b, 0); return [names[result] ?? result]; }
  return [];
}
