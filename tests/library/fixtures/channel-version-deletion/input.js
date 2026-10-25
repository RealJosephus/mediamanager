export const id = index => `cd200000000000000000${String(index).padStart(12, '0')}`;
export const primaryId = id(1), parentId = id(2), alternateIds = [id(3), id(4)], userId = id(5);
export function makeInput() {
  const sample = (name, values = {}) => ({ name, kind: 'linked', count: 1, outerProvider: true, outcome: 'success', ...values });
  return { primaryId, parentId, alternateIds, userId, cases: [
    sample('ordinary primary deletes its missing external linked version'),
    sample('outer false does not disable the fresh recursive provider default', { outerProvider: false }),
    sample('missing external local version follows the same recursive default', { kind: 'local', outerProvider: false }),
    sample('SQL version identity survives empty unsaved primary arrays', { clearWarmVersions: true, outerProvider: false }),
    sample('second provider failure retains the already deleted first version', { count: 2, outcome: 'io', failAt: 1, failure: 500 }),
    sample('first provider failure precedes all metadata and SQL cleanup', { outcome: 'failure', failAt: 0, failure: 500 }),
    sample('recursive provider argument failure is ignored before cleanup', { outcome: 'argument', failAt: 0 }),
    sample('existing external linked version is promoted without provider deletion', { survivor: true }),
  ] };
}
