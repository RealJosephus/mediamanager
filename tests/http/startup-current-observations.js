import { projectStartupObservation as projectState } from './fixtures/startup/observations.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';

export { startupTables } from './fixtures/startup/observations.js';

export async function projectStartupObservation(row, sample, environmentUserName) {
  const observations = row.observations.map(observation => ({ ...observation,
    json: observation.json != null && typeof observation.body === 'string'
      ? parseLosslessJson(observation.body) : observation.json }));
  const projected = await projectState({ ...row, observations }, sample, environmentUserName);
  return { ...projected, observations: projected.observations.map((value, index) => {
    const observation = observations[index];
    let body = observation.json == null ? observation.body : projectProblemTrace(observation.json, observation.status);
    // The state projector already verified the initial OS user and response.
    // Reuse only its declared root Name binding, with the raw rest of the DTO.
    if (observation.status === 200 && value.body?.Name === '$environment-user') body = { ...body, Name: value.body.Name };
    return { ...value, body };
  }) };
}
