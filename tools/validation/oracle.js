import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile, sha256 } from './inventory.js';
import { assertIsolatedOutput, repositoryRoot, validationExecutable } from './paths.js';
import { observeExecutionPhase } from './execution-diagnostics.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];

function validateProcessTimeout(processTimeoutMs) {
  if (!Number.isSafeInteger(processTimeoutMs) || processTimeoutMs < 1) throw new TypeError('The oracle process timeout must be a positive safe integer.');
}

async function oracleSourceFiles(project) {
  return [project, path.join(repositoryRoot, 'tests/Directory.Build.props'),
    ...(await readdir(path.dirname(project))).filter(name => name.endsWith('.cs')).map(name => path.join(path.dirname(project), name))];
}

async function buildOracle({ project, output, environment }) {
  project = path.resolve(repositoryRoot, project);
  output = path.resolve(repositoryRoot, output);
  assertIsolatedOutput(output, environment);
  const dotnet = validationExecutable('dotnet', environment);
  const name = path.basename(project, '.csproj');
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const sourceFiles = await oracleSourceFiles(project);
  const sources = await Promise.all(sourceFiles.map(describeFile));
  const isolatedProject = path.join(output, 'project');
  await mkdir(isolatedProject);
  await observeExecutionPhase('oracle.copy.sources', async () => {
    for (const source of sourceFiles) await copyFile(source, path.join(isolatedProject, path.basename(source)));
  }, { environment, fixture: project });
  const buildArgs = ['build', path.join(isolatedProject, path.basename(project)), '-c', 'Release', '--nologo', '-v', 'minimal',
    '-p:UseSharedCompilation=false',
    `-p:BaseOutputPath=${path.join(output, 'bin')}${path.sep}`,
    `-p:BaseIntermediateOutputPath=${path.join(output, 'obj')}${path.sep}`];
  const build = await observeExecutionPhase('oracle.build', () => spawnSync(dotnet, buildArgs,
    { cwd: repositoryRoot, env: environment, windowsHide: true, encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024, timeout: 120000 }), { environment, fixture: project,
      resultKind: value => value.status === 0 && !value.error ? 'succeeded' : 'failed' });
  await writeFile(path.join(output, 'build.stdout.txt'), build.stdout || '', { flag: 'wx' });
  await writeFile(path.join(output, 'build.stderr.txt'), build.stderr || '', { flag: 'wx' });
  const dll = path.join(output, 'bin/Release/net10.0', name + '.dll');
  return { project, output, environment, dotnet, sourceFiles, sources, isolatedProject, buildArgs, build, dll };
}

async function executeOracle(context, { output, args, processTimeoutMs }) {
  const { project, environment, dotnet, sources, buildArgs, build, dll } = context;
  const processArgs = [dll, ...args.map(argument => argument.replaceAll('{output}', output))];
  const run = build.status === 0 ? await observeExecutionPhase('oracle.process', () => spawnSync(dotnet, processArgs,
    { cwd: repositoryRoot, env: environment, windowsHide: true, encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024, timeout: processTimeoutMs }), { environment, fixture: project,
      resultKind: value => value.status === 0 && !value.error ? 'succeeded' : 'failed' }) : null;
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
    process: run ? { args: processArgs, pid: run.pid, status: run.status, signal: run.signal, errorCode: run.error?.code, timeoutMs: processTimeoutMs } : null,
    outputs, oracleAssembly: build.status === 0 ? await describeFile(dll) : null,
    passed: !build.error && build.status === 0 && !run?.error && run?.status === 0 };
  return record;
}

async function publishRecord(output, record) {
  await writeFile(path.join(output, 'record.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  if (!record.passed) throw new Error(`Oracle failed; see ${path.join(output, 'record.json')}.`);
  return record;
}

export async function recordOracle({ project, output, args = [], environment = process.env, processTimeoutMs = 120000 }) {
  validateProcessTimeout(processTimeoutMs);
  const context = await buildOracle({ project, output, environment });
  return publishRecord(context.output, await executeOracle(context, { output: context.output, args, processTimeoutMs }));
}

function assertSameDescriptor(actual, expected) {
  if (!actual.available || actual.kind !== expected.kind || actual.filename !== expected.filename
    || expected.kind === 'file' && (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)) {
    throw new Error(`Prepared oracle input changed: ${expected.filename}`);
  }
  if (expected.kind === 'directory') {
    const members = new Map(actual.entries.map(entry => [entry.name, entry]));
    if (members.size !== expected.entries.length) throw new Error(`Prepared oracle membership changed: ${expected.filename}`);
    for (const entry of expected.entries) {
      const filename = path.join(expected.filename, entry.name), current = members.get(entry.name);
      assertSameDescriptor({ ...current, filename }, { ...entry, filename });
    }
  }
}

async function requiredDescriptor(filename) {
  const description = await describeFile(filename);
  if (!description.available || !['file', 'directory'].includes(description.kind)) {
    throw new Error(`Prepared oracle input is not an ordinary file or directory: ${filename}`);
  }
  return description;
}

/** Build once for one capture; every record runs a fresh process in a new output directory. */
export async function compileOracle({ project, output, environment = process.env }) {
  environment = { ...environment };
  const context = await buildOracle({ project, output, environment });
  const { sources, sourceFiles, isolatedProject, dotnet, dll, build, buildArgs } = context;
  const receiptFile = path.join(context.output, 'oracle-build.json');
  const isolatedSources = await Promise.all(sourceFiles.map(filename => requiredDescriptor(path.join(isolatedProject, path.basename(filename)))));
  for (const [index, source] of sources.entries()) {
    const copy = isolatedSources[index];
    assertSameDescriptor(await requiredDescriptor(source.filename), source);
    assertSameDescriptor({ ...copy, filename: source.filename }, source);
  }
  const artifacts = build.status === 0 && !build.error ? await requiredDescriptor(path.join(context.output, 'bin')) : null;
  const tool = await requiredDescriptor(dotnet);
  const jellyfinDll = environment.MEDIAMANAGER_JELLYFIN_DLL ? await requiredDescriptor(environment.MEDIAMANAGER_JELLYFIN_DLL) : null;
  const buildRecord = { schemaVersion: 1, kind: 'oracle-build', recordedAt: new Date().toISOString(), project: context.project,
    dotnet: tool, node: process.version, timezone: environment.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    jellyfinDll, sourceFiles: sources, sourceFilesSha256: sha256(JSON.stringify(sources)), isolatedSources,
    build: { args: buildArgs, status: build.status, signal: build.signal, errorCode: build.error?.code },
    logs: await Promise.all(['build.stdout.txt', 'build.stderr.txt'].map(name => requiredDescriptor(path.join(context.output, name)))),
    artifacts, oracleAssembly: artifacts ? await requiredDescriptor(dll) : null, passed: !build.error && build.status === 0 };
  await writeFile(receiptFile, JSON.stringify(buildRecord, null, 2) + '\n', { flag: 'wx' });
  if (!buildRecord.passed) throw new Error(`Oracle build failed; see ${receiptFile}.`);
  const receipt = await requiredDescriptor(receiptFile);
  const fresh = async () => {
    const currentSources = await oracleSourceFiles(context.project);
    if (currentSources.length !== sourceFiles.length || currentSources.some(filename => !sourceFiles.includes(filename))) {
      throw new Error(`Prepared oracle source membership changed: ${context.project}`);
    }
    for (const expected of [...sources, ...isolatedSources, tool, ...(jellyfinDll ? [jellyfinDll] : []), ...buildRecord.logs, receipt]) {
      assertSameDescriptor(await requiredDescriptor(expected.filename), expected);
    }
    const currentArtifacts = await requiredDescriptor(artifacts.filename);
    assertSameDescriptor(currentArtifacts, artifacts);
    return { sourceFilesUnchanged: true, isolatedSourcesUnchanged: true, executableUnchanged: true,
      buildReceipt: receipt, artifactsSha256: currentArtifacts.entriesSha256 };
  };
  return { buildRecord: structuredClone(buildRecord), async record({ output, args = [], processTimeoutMs = 120000 }) {
    validateProcessTimeout(processTimeoutMs);
    output = path.resolve(repositoryRoot, output);
    assertIsolatedOutput(output, environment);
    await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
    const before = await fresh();
    const record = await executeOracle(context, { output, args, processTimeoutMs });
    record.executionKind = 'prepared-build';
    record.build = { ...record.build, executed: false, receipt };
    record.verification = { before };
    try { record.verification.after = await fresh(); }
    catch (error) {
      record.passed = false; record.verification.failure = { message: error.message, code: error.code };
      try { await writeFile(path.join(output, 'record.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); }
      catch (recordingError) {
        throw new AggregateError([error, recordingError], 'Prepared oracle verification and failure recording failed.', { cause: error });
      }
      throw error;
    }
    return publishRecord(output, record);
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [project, output, ...args] = process.argv.slice(2);
  if (!project || !output) throw new Error('Usage: node tools/validation/oracle.js PROJECT NEW_OUTPUT_DIRECTORY [ORACLE_ARGUMENTS; {output} expands to the new directory]');
  recordOracle({ project, output, args }).then(record => console.log(JSON.stringify({ passed: record.passed, output, sourceFilesSha256: record.sourceFilesSha256 })))
    .catch(error => { console.error(error.message); process.exitCode = 2; });
}
