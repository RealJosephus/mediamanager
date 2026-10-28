export function lyricFailure(reasons, message) {
  if (reasons.length === 1) return reasons[0];
  const primary = reasons[0], error = new AggregateError(reasons, message, { cause: primary });
  if (primary !== null && ['object', 'function'].includes(typeof primary)) for (const name of ['code', 'status', 'statusCode']) {
    try { if (name in primary) error[name] = primary[name]; } catch { }
  }
  return error;
}
