import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { validationExecutable, validationOutputRoot } from '../validation/paths.js';

const mode = process.argv[2];
if (!['capture', 'audit'].includes(mode)) throw new Error('Use capture or audit.');
const root = validationOutputRoot();
await fs.mkdir(root, { recursive: true });
const client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
  connectionTimeoutMillis: 10000, query_timeout: 15000, statement_timeout: 15000 });
await client.connect();
try {
  const database = (await client.query("SELECT version() AS version, current_database() AS database, current_user AS role, inet_server_port() AS port, pg_postmaster_start_time() AS started_at")).rows[0];
  const schemas = (await client.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('public','information_schema') ORDER BY nspname")).rows;
  const connections = (await client.query("SELECT pid,state,application_name FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND pid<>pg_backend_pid() ORDER BY pid")).rows;
  const roles = (await client.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows;
  const record = { recordedAt: new Date().toISOString(), mode, database, schemas, connections, roles };
  if (mode === 'capture') {
    const temporary = await fs.mkdtemp(path.join(await fs.realpath(process.env.RUNNER_TEMP ?? os.tmpdir()), 'mediamanager-test-tmp-'));
    if (!process.env.GITHUB_ENV) throw new Error('CI environment capture requires GITHUB_ENV.');
    // Hosted runners may expose /var or TEMP through a symbolic link. Keep the
    // production physical-directory checks and give fixtures a canonical root.
    await fs.appendFile(process.env.GITHUB_ENV, ['TMPDIR', 'TMP', 'TEMP'].map(name => `${name}=${temporary}\n`).join(''));
    record.runner = { platform: process.platform, arch: process.arch, release: os.release(), node: process.version,
      temporary,
      image: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null,
      commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null };
    record.tools = [];
    for (const name of ['git', 'dotnet', 'ffmpeg', 'ffprobe']) {
      const executable = validationExecutable(name);
      const result = spawnSync(executable, [name.startsWith('ff') ? '-version' : '--version'],
        { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      record.tools.push({ name, executable, status: result.status, version: (result.stdout || result.stderr || '').split(/\r?\n/u)[0] });
      if (result.status !== 0) throw new Error(`The ${name} executable is unavailable.`);
    }
  } else {
    const initial = JSON.parse(await fs.readFile(path.join(root, 'environment.json'), 'utf8'));
    if (database.started_at.toISOString() !== initial.database.started_at) throw new Error('The PostgreSQL instance changed during validation.');
    const initialSchemas = new Set(initial.schemas.map(row => row.nspname));
    const initialRoles = new Set(initial.roles.map(row => row.rolname));
    record.leakedSchemas = schemas.filter(row => !initialSchemas.has(row.nspname));
    record.leakedRoles = roles.filter(row => !initialRoles.has(row.rolname));
    record.clean = record.leakedSchemas.length === 0 && record.leakedRoles.length === 0 && connections.length === 0;
    if (!record.clean) process.exitCode = 1;
  }
  await fs.writeFile(path.join(root, mode === 'capture' ? 'environment.json' : 'postgres-audit.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ mode, schemas: schemas.length, connections: connections.length,
    leakedRoles: record.leakedRoles?.length ?? null, clean: record.clean ?? null }));
} finally { await client.end(); }
