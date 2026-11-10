import { stageReleasePairEvidence } from './release-pair.js';

if (process.argv.length !== 4 || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Use the Actions release-pair collector with the runner results and a fresh output directory.');
}
await stageReleasePairEvidence(process.argv[2], process.argv[3]);
