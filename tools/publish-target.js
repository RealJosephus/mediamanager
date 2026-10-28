import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishProductionTarget, readProductionTarget } from '../src/production-target.js';

const usage = 'Usage: npm run target:publish -- --source <proposed-target.json> --output <current-target.json>';

export async function runPublishTargetCli(argv = process.argv.slice(2), { environment = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length === 1 && argv[0] === '--help') { stdout.write(usage + '\n'); return 0; }
  let target;
  try {
    const options = {};
    for (let index = 0; index < argv.length; index += 2) {
      const name = argv[index], value = argv[index + 1];
      if (!['--source', '--output'].includes(name) || Object.hasOwn(options, name)
        || typeof value !== 'string' || !value || value.startsWith('--') || /[\0\r\n]/u.test(value)) throw new Error(usage);
      options[name] = path.resolve(value);
    }
    if (!options['--source'] || !options['--output']) throw new Error(usage);
    target = await readProductionTarget(options['--source']);
    const result = await publishProductionTarget(options['--output'], target, { environment });
    stdout.write(JSON.stringify({ ok: true, ...result }) + '\n'); return 0;
  } catch (error) {
    const connection = target && environment[target.postgresUrlEnvironment];
    const description = String(error?.message ?? error);
    const message = (typeof connection === 'string' && connection ? description.replaceAll(connection, '[PostgreSQL connection redacted]') : description)
      .replace(/\bpostgres(?:ql)?:\/\/[^\s"']+/giu, 'postgresql://[REDACTED]');
    stderr.write(JSON.stringify({ ok: false, error: { message } }) + '\n'); return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPublishTargetCli();
}
