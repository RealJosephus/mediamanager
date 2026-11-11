import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyClosure, inventory } from '../validation/inventory.js';
import { repositoryRoot, validationOutputRoot } from '../validation/paths.js';
import { changedFilesForEvent, selectAffected } from './affected.js';

const serviceFlags = {
  jellyfinDll: 'MEDIAMANAGER_CI_NATIVE_REFERENCE',
  nativeInstance: 'MEDIAMANAGER_CI_NATIVE_INSTANCE',
  currentNativeSqlite: 'MEDIAMANAGER_CI_NATIVE_SQLITE',
  dvdReference: 'MEDIAMANAGER_CI_DVD_REFERENCE',
  blurayReference: 'MEDIAMANAGER_CI_BLURAY_REFERENCE',
  jellyfinWeb: 'MEDIAMANAGER_CI_WEB_CLIENTS',
  embyWeb: 'MEDIAMANAGER_CI_EMBY_WEB',
  alist: 'MEDIAMANAGER_CI_ALIST_REFERENCE',
};
const automatic = environment => ['push', 'pull_request'].includes(environment.GITHUB_EVENT_NAME)
  && environment.MEDIAMANAGER_CI_PROFILE !== 'full' && environment.MEDIAMANAGER_CI_RELEASE_PAIR !== 'true'
  && !(environment.MEDIAMANAGER_CI_TEST_FILES ?? '').split(/[\r\n,]+/u).some(value => value.trim());

/** Supply the declared inputs of proven affected tests. Availability and actual
 * input verification still belong to the final CI scope and strict runner. */
export function planAffectedInputs({ dependencies, impact, environment }) {
  const flags = Object.fromEntries(Object.values(serviceFlags).map(name => [name, environment[name] === 'true' ? 'true' : 'false']));
  const services = automatic(environment) && impact.mode === 'affected'
    ? [...new Set(dependencyClosure(dependencies, impact.affected).flatMap(entry => entry.services ?? []))].sort() : [];
  if (services.length) {
    const enable = name => { flags[serviceFlags[name]] = 'true'; };
    for (const service of services) if (Object.hasOwn(serviceFlags, service)) enable(service);
    if (services.includes('browser') && flags.MEDIAMANAGER_CI_WEB_CLIENTS !== 'true'
      && flags.MEDIAMANAGER_CI_EMBY_WEB !== 'true') enable('jellyfinWeb');
    if (flags.MEDIAMANAGER_CI_WEB_CLIENTS === 'true' || flags.MEDIAMANAGER_CI_EMBY_WEB === 'true') enable('currentNativeSqlite');
    if (flags.MEDIAMANAGER_CI_NATIVE_SQLITE === 'true' || flags.MEDIAMANAGER_CI_DVD_REFERENCE === 'true'
      || flags.MEDIAMANAGER_CI_BLURAY_REFERENCE === 'true') enable('nativeInstance');
    if (flags.MEDIAMANAGER_CI_NATIVE_INSTANCE === 'true') enable('jellyfinDll');
  }
  return { impact, services, flags };
}

export async function main(environment = process.env) {
  let dependencies = { entries: [] }, impact = { mode: 'manual', affected: [] };
  if (automatic(environment)) {
    dependencies = await inventory(environment);
    const comparison = await changedFilesForEvent(environment);
    const git = spawnSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, windowsHide: true, encoding: 'utf8',
      timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    if (git.error || git.status !== 0) throw new Error('Cannot identify tracked inputs for provisioning.', { cause: git.error });
    impact = selectAffected({ dependencies, tracked: new Set(git.stdout.split('\0').filter(Boolean)), comparison, environment });
  }
  const plan = planAffectedInputs({ dependencies, impact, environment });
  const output = path.join(validationOutputRoot(environment), 'provisioning', 'affected-inputs.json');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  if (!environment.GITHUB_ENV) throw new Error('Input provisioning requires the GitHub environment file.');
  await appendFile(environment.GITHUB_ENV, Object.entries(plan.flags).map(([name, value]) => `${name}=${value}\n`).join(''));
  console.log(`Input provisioning: ${impact.mode}; ${plan.services.length ? plan.services.join(', ') : 'configured inputs retained'}.`);
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
