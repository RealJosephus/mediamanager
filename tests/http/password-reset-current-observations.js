import { projectResetObservation as projectState } from './fixtures/password-reset-http-current/observations.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';

export { allowedMethods, normalizeSnapshot } from './fixtures/password-reset-http-current/observations.js';
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export async function projectResetObservation(row) {
  const observations = row.observations.map(observation => ({ ...observation,
    json: (observation.hasJson ?? observation.json !== null) && typeof observation.body === 'string'
      ? parseLosslessJson(observation.body) : observation.json }));
  const projected = await projectState({ ...row, observations: observations.map(observation => {
    if (!object(observation.json)) return observation;
    // Hash, snapshot and PIN-file proofs keep their original inputs. The old
    // public trace rule is superseded by the actual HTTP role below.
    const { traceId: _trace, ...json } = observation.json;
    if (observation.status !== 200 && json.Action === 'PinCode') delete json.Action;
    return { ...observation, json };
  }) });
  return { ...projected, observations: projected.observations.map((value, index) => {
    const observation = observations[index], hasJson = observation.hasJson ?? observation.json !== null;
    let body = hasJson ? projectProblemTrace(observation.json, observation.status) : observation.body;
    if (observation.status === 200 && object(body) && body.Action === 'PinCode') {
      body = { ...body, PinFile: value.body.PinFile, PinExpirationDate: value.body.PinExpirationDate };
    }
    return { ...value, body };
  }) };
}
