import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function fileSha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function availablePort(requestedPort) {
  if (!Number.isInteger(requestedPort) || requestedPort !== 0 && (requestedPort < 1024 || requestedPort > 65535)) {
    throw new TypeError('Invalid isolated WebDAV port.');
  }
  if (requestedPort) return requestedPort;
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

/** Run an actual external rclone WebDAV server over a new synthetic-only local root. */
export async function startActualWebDav({ evidenceDirectory, port: requestedPort = 0, basePath = '/dav', sourceRoot } = {}) {
  const configured = process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE;
  if (typeof configured !== 'string' || !configured) throw new TypeError('An actual WebDAV executable path is required.');
  if (!path.isAbsolute(configured)) throw new TypeError('An absolute actual WebDAV executable path is required.');
  const executable = path.resolve(configured);
  if (typeof basePath !== 'string' || !/^\/[A-Za-z0-9._~-]+$/u.test(basePath)) throw new TypeError('Invalid isolated WebDAV base path.');
  let externalSource;
  if (sourceRoot !== undefined) {
    if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)) {
      throw new TypeError('The actual WebDAV source root must be an existing absolute directory.');
    }
    externalSource = path.resolve(sourceRoot);
    let source;
    try { source = await lstat(externalSource); }
    catch { throw new TypeError('The actual WebDAV source root must be an existing absolute directory.'); }
    if (!source.isDirectory()) throw new TypeError('The actual WebDAV source root must be an existing absolute directory.');
  }
  const port = await availablePort(requestedPort);
  const versionRun = spawnSync(executable, ['version'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  if (versionRun.status !== 0) throw new Error(`Actual WebDAV executable version check failed: ${versionRun.error?.code ?? versionRun.status}`);
  const version = versionRun.stdout.split(/\r?\n/u).filter(Boolean)[0];
  const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-actual-webdav-'));
  const media = sourceRoot === undefined ? path.join(root, 'synthetic-media') : externalSource;
  const config = path.join(root, 'rclone.conf');
  try {
    if (sourceRoot === undefined) await mkdir(media);
    await writeFile(config, '');
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const username = `isolated-${randomBytes(8).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
  const baseUrl = `http://127.0.0.1:${port}${basePath}/`;
  const args = ['serve', 'webdav', media, '--addr', `127.0.0.1:${port}`, '--baseurl', basePath,
    '--user', username, '--pass', password, '--dir-cache-time', '0s', '--poll-interval', '0',
    '--config', config, '--log-level', 'INFO'];
  let child;
  let output = '';
  let stopped;
  const redact = value => value.replaceAll(password, '[isolated password redacted]')
    .replaceAll(username, '[isolated user redacted]').replaceAll(authorization, '[isolated authorization redacted]');
  const stop = () => stopped ??= (async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill();
      await Promise.race([ended, delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
    }
    const expectedParent = path.resolve(os.tmpdir());
    if (path.dirname(path.resolve(root)) !== expectedParent || !path.basename(root).startsWith('mediamanager-actual-webdav-')) {
      throw new Error('Unexpected actual WebDAV temporary root.');
    }
    const executableSha256 = await fileSha256(executable);
    await rm(root, { recursive: true, force: true });
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(path.join(evidenceDirectory, 'actual-service.log'), redact(output));
      await writeFile(path.join(evidenceDirectory, 'actual-instance.json'), `${JSON.stringify({
        executable, executableSha256, version, root, media, basePath, port, temporaryRootRemoved: true,
        stopped: true, pid: child?.pid, backend: 'rclone WebDAV over an isolated local root', externalSourceRoot: sourceRoot !== undefined,
        referenceDataOpened: false, credentials: 'redacted',
      }, null, 2)}\n`);
    }
  })();
  try {
    child = spawn(executable, args, { cwd: root, windowsHide: true,
      env: { ...process.env, RCLONE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    let spawnError;
    child.on('error', error => { spawnError = error; });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Actual WebDAV exited with code ${child.exitCode}: ${redact(output)}`);
      try {
        const response = await fetch(baseUrl, { method: 'PROPFIND', redirect: 'manual',
          headers: { Authorization: authorization, Depth: '0', 'Accept-Encoding': 'identity' },
          signal: AbortSignal.timeout(500) });
        await response.body?.cancel();
        if (response.status === 207) break;
      } catch {}
      if (attempt === 199) throw new Error(`Actual WebDAV did not become ready: ${redact(output)}`);
      await delay(100);
    }
    return { baseUrl, basePath, authorization, username, root, media, port, version, stop, pid: child.pid };
  } catch (error) {
    await stop();
    throw error;
  }
}
