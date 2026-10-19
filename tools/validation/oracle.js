import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile, sha256 } from './inventory.js';
import { assertIsolatedOutput, repositoryRoot, validationExecutable } from './paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];

export async function recordOracle({ project, output, args = [], environment = process.env }) {
  project = path.resolve(repositoryRoot, project);
  output = path.resolve(repositoryRoot, output);
  assertIsolatedOutput(output, environment);
  const dotnet = validationExecutable('dotnet', environment);
  const directory = path.dirname(project), name = path.basename(project, '.csproj');
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const sourceFiles = [project, path.join(repositoryRoot, 'tests/Directory.Build.props'),
    ...(await readdir(directory)).filter(name => name.endsWith('.cs')).map(name => path.join(directory, name))];
  const sources = await Promise.all(sourceFiles.map(describeFile));
  const isolatedProject = path.join(output, 'project');
  await mkdir(isolatedProject);
  for (const source of sourceFiles) await copyFile(source, path.join(isolatedProject, path.basename(source)));
  const buildArgs = ['build', path.join(isolatedProject, path.basename(project)), '-c', 'Release', '--nologo', '-v', 'minimal',
    `-p:BaseOutputPath=${path.join(output, 'bin')}${path.sep}`,
    `-p:BaseIntermediateOutputPath=${path.join(output, 'obj')}${path.sep}`];
  const build = spawnSync(dotnet, buildArgs, { cwd: repositoryRoot, env: environment, windowsHide: true,
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
  await writeFile(path.join(output, 'build.stdout.txt'), build.stdout || '', { flag: 'wx' });
  await writeFile(path.join(output, 'build.stderr.txt'), build.stderr || '', { flag: 'wx' });
  const dll = path.join(output, 'bin/Release/net10.0', name + '.dll');
  const processArgs = [dll, ...args.map(argument => argument.replaceAll('{output}', output))];
  const run = build.status === 0 ? spawnSync(dotnet, processArgs, { cwd: repositoryRoot, env: environment, windowsHide: true,
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 }) : null;
  if (run) {
    await writeFile(path.join(output, 'stdout.txt'), run.stdout || '', { flag: 'wx' });
    await writeFile(path.join(output, 'stderr.txt'), run.stderr || '', { flag: 'wx' });
  }
  const outputs = [];
  for (const entry of await readdir(output, { withFileTypes: true })) if (entry.isFile()) outputs.push(await describeFile(path.join(output, entry.name)));
  const record = { schemaVersion: 1, recordedAt: new Date().toISOString(), project, dotnet: await describeFile(dotnet),
    node: process.version, timezone: environment.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    jellyfinDll: environment.MEDIAMANAGER_JELLYFIN_DLL ? await describeFile(environment.MEDIAMANAGER_JELLYFIN_DLL) : null,
    sourceFiles: sources, sourceFilesSha256: sha256(JSON.stringify(sources)),
    build: { args: buildArgs, status: build.status, signal: build.signal, errorCode: build.error?.code },
    process: run ? { args: processArgs, status: run.status, signal: run.signal, errorCode: run.error?.code } : null,
    outputs, oracleAssembly: build.status === 0 ? await describeFile(dll) : null,
    passed: build.status === 0 && run?.status === 0 };
  await writeFile(path.join(output, 'record.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  if (!record.passed) throw new Error(`Oracle failed; see ${path.join(output, 'record.json')}.`);
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [project, output, ...args] = process.argv.slice(2);
  if (!project || !output) throw new Error('Usage: node tools/validation/oracle.js PROJECT NEW_OUTPUT_DIRECTORY [ORACLE_ARGUMENTS; {output} expands to the new directory]');
  recordOracle({ project, output, args }).then(record => console.log(JSON.stringify({ passed: record.passed, output, sourceFilesSha256: record.sourceFilesSha256 })))
    .catch(error => { console.error(error.message); process.exitCode = 2; });
}
