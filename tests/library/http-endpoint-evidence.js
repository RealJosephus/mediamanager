import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';

/** Keep every endpoint observation while encoding identical full states once.
 * Exact JSON encodings, rather than selected fields or hashes, determine reuse.
 * Readers expand each stateIndex through endpointStates before comparison. */
export async function writeHttpEndpointEvidence(directory, dialect, actual, comparison) {
  const endpointStates = [], indices = new Map();
  const stateReference = state => {
    const encoded = json(state);
    let index = indices.get(encoded);
    if (index === undefined) {
      index = endpointStates.length; indices.set(encoded, index); endpointStates.push(state);
    }
    return { stateIndex: index };
  };
  const caseStages = actual.caseStages.map(stage => ({ ...stage,
    before: stateReference(stage.before), after: stateReference(stage.after) }));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${dialect}.json`), json({ ...actual, caseStages, endpointStates }), { flag: 'wx' });
  await writeFile(path.join(directory, `${dialect}-comparison.json`), json(comparison), { flag: 'wx' });
}
