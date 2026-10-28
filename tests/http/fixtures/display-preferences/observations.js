import { tableDefinition } from '../../../../src/database/model.js';
import { projectProblemTrace } from '../../../helpers/http-body-projection.js';

export const preferenceTables = ['DisplayPreferences', 'ItemDisplayPreferences', 'CustomItemDisplayPreferences', 'HomeSection'];
export function normalizePreferenceState(state) {
  return Object.fromEntries(preferenceTables.map(table => [table, state[table].map(row => Object.fromEntries(
    tableDefinition(table).columns.map(column => {
      let value = row[column.name];
      if (value != null && column.clrType === 'bool') value = Boolean(value);
      if (value != null && column.clrType === 'Guid') value = value.toUpperCase();
      return [column.name, value];
    })
  ))]));
}
export function projectPreferenceObservation(row) {
  return { name: row.name, before: normalizePreferenceState(row.before), after: normalizePreferenceState(row.after),
    observations: row.observations.map(observation => {
      const json = projectProblemTrace(observation.json && structuredClone(observation.json), observation.status);
      return { status: observation.status, contentType: observation.contentType,
        allow: observation.allow.split(',').map(value => value.trim()).filter(Boolean).sort(),
        ...(json == null ? { body: observation.body } : { json }), state: normalizePreferenceState(observation.state) };
    }) };
}
