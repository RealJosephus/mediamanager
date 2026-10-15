import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

/** Run an actual externally built AList with a new database and synthetic-only Local drive. */
export async function startActualAList({ connectionString, evidenceDirectory, port: requestedPort = 0 } = {}) {
  const executable = path.resolve(process.env.MEDIAMANAGER_ALIST_EXECUTABLE);
  if (!path.isAbsolute(executable)) throw new TypeError('An absolute actual AList executable path is required.');
  if (!Number.isInteger(requestedPort) || requestedPort !== 0 && (requestedPort < 1024 || requestedPort > 65535)) throw new TypeError('Invalid isolated AList port.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-actual-alist-'));
  const data = path.join(root, 'data');
  const media = path.join(root, 'synthetic-media');
  await mkdir(data); await mkdir(media);
  const database = `alist_runtime_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  let child, token, output = '', stopped;
  const password = randomBytes(24).toString('hex');
  const stop = () => stopped ??= (async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill();
      await ended;
    }
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
    const expectedParent = path.resolve(os.tmpdir());
    if (path.dirname(path.resolve(root)) !== expectedParent || !path.basename(root).startsWith('mediamanager-actual-alist-')) throw new Error('Unexpected actual AList temporary root.');
    await rm(root, { recursive: true, force: true });
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(path.join(evidenceDirectory, 'actual-service.log'), output.replaceAll(password, '[isolated password redacted]').replaceAll(token ?? '\0', '[isolated token redacted]').replace(/([?&]sign=)[^&\s"]+/gu, '$1[redacted]'));
      await writeFile(path.join(evidenceDirectory, 'actual-instance.json'), `${JSON.stringify({ executable, root, data, media, database, databaseDropped: true, temporaryRootRemoved: true, stopped: true, pid: child?.pid, backend: 'postgres', referenceDataOpened: false }, null, 2)}\n`);
    }
  })();
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    const endpoint = new URL(connectionString); endpoint.pathname = `/${database}`;
    const listener = net.createServer(); listener.listen(requestedPort, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const baseUrl = `http://127.0.0.1:${port}`;
    await writeFile(path.join(data, 'config.json'), JSON.stringify({ force: true, scheme: { address: '127.0.0.1', http_port: port, https_port: -1 }, database: { type: 'postgres', dsn: endpoint.toString(), table_prefix: 'runtime_' }, log: { enable: false }, s3: { enable: false }, ftp: { enable: false }, sftp: { enable: false } }));
    child = spawn(executable, ['server', '--data', data, '--log-std'], { cwd: root, windowsHide: true, env: { ...process.env, ALIST_ADMIN_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    let spawnError; child.on('error', error => { spawnError = error; });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Actual AList exited with code ${child.exitCode}: ${output.replaceAll(password, '[redacted]')}`);
      try { if ((await fetch(`${baseUrl}/ping`, { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
      if (attempt === 199) throw new Error('Actual AList did not become ready.');
      await delay(100);
    }
    const api = async (operation, body) => {
      const response = await fetch(`${baseUrl}/api/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) }, body: JSON.stringify(body) });
      const result = await response.json();
      if (result.code !== 200) throw new Error(`Actual AList ${operation} failed with code ${result.code}: ${result.message}`);
      return result.data;
    };
    token = (await api('auth/login', { username: 'admin', password })).token;
    await api('admin/storage/create', { mount_path: '/Synthetic', driver: 'Local', cache_expiration: 0, enable_sign: true, addition: JSON.stringify({ root_folder_path: media, show_hidden: true, thumbnail: false, mkdir_perm: '777' }) });
    return { baseUrl, token, root, data, media, stop, api, pid: child.pid };
  } catch (error) { await stop(); throw error; }
}
