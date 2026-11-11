/** Keep cleanup failures in order without replacing the original rejection. */
export function operationFailure(errors, fallback) {
  if (errors.length === 1) return errors[0];
  const primary = errors[0];
  let message = fallback;
  try { const value = primary?.message; if (typeof value === 'string') message = value; }
  catch { /* Diagnostic getters cannot replace an operation failure. */ }
  const failure = new AggregateError(errors, message, { cause: primary });
  for (const key of ['code', 'status', 'statusCode']) {
    try { const value = primary?.[key]; if (value !== undefined) failure[key] = value; }
    catch { /* The original rejection remains available in cause and errors. */ }
  }
  return failure;
}

/** Await each owned cleanup and report failures in operation order. */
export async function withCleanup(operation, cleanups, fallback) {
  let value;
  const errors = [];
  try { value = await operation(); } catch (error) { errors.push(error); }
  for (const cleanup of cleanups) try { await cleanup(); } catch (error) { errors.push(error); }
  if (errors.length) throw operationFailure(errors, fallback);
  return value;
}
