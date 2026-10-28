import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function liveTvStateFileFailure(errors) {
  if (errors.length === 1) return errors[0];
  const primary = errors[0];
  let message = 'Live TV state file operation and cleanup failed.';
  try { if (primary instanceof Error && typeof primary.message === 'string') message = primary.message; }
  catch { /* Diagnostic properties cannot replace the original failure. */ }
  const failure = new AggregateError(errors, message, { cause: primary });
  for (const key of ['code', 'status', 'statusCode']) {
    try { const value = primary?.[key]; if (value !== undefined) failure[key] = value; }
    catch { /* Retain the original failure even if one diagnostic getter throws. */ }
  }
  return failure;
}

/** Close each staged output before publication and remove only owned files. */
export async function stageLiveTvStateFile(directory, name, bytes, fileSystem = fs) {
  await fileSystem.mkdir(directory, { recursive: true });
  const filename = path.join(directory, name), temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  let handle;
  const errors = [];
  try {
    handle = await fileSystem.open(temporary, 'wx');
    await handle.writeFile(bytes);
  } catch (error) { errors.push(error); }
  if (handle) {
    try { await handle.close(); } catch (error) { errors.push(error); }
    if (errors.length) try { await fileSystem.rm(temporary, { force: true }); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw liveTvStateFileFailure(errors);
  return { filename, temporary, published: false };
}

export async function removeUnpublishedLiveTvStateFiles(replacements, fileSystem = fs) {
  const errors = [];
  for (const replacement of replacements) if (!replacement.published) {
    try { await fileSystem.rm(replacement.temporary, { force: true }); } catch (error) { errors.push(error); }
  }
  return errors;
}
