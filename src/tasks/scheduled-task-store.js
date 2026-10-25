import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { parseLosslessJson, stringifyNativeJson } from '../core/json.js';
import { bindTaskTriggerInfos } from './scheduled-task-binding.js';

const maximumTaskFileBytes = 1024 * 1024;

function unsafePath(message) {
  return Object.assign(new Error(message), { code: 'unsafe-scheduled-task-path' });
}

function samePath(left, right) {
  const comparable = value => process.platform === 'win32'
    ? path.toNamespacedPath(path.resolve(value))
    : path.resolve(value);
  left = comparable(left);
  right = comparable(right);
  return path.relative(left, right) === '' && path.relative(right, left) === '';
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function existingAncestor(filename) {
  let candidate = path.resolve(filename);
  while (true) {
    try { await lstat(candidate); return candidate; }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function physicalDirectory(directory) {
  const resolved = path.resolve(directory);
  const metadata = await lstat(resolved);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw unsafePath(`Scheduled task directory is not a physical directory: ${directory}`);
  }
  const physical = await realpath(resolved);
  if (!samePath(resolved, physical)) {
    throw unsafePath(`Scheduled task directory traverses a link or junction: ${directory}`);
  }
  return physical;
}

async function taskDirectory(root, directory, { create = false } = {}) {
  const resolvedRoot = path.resolve(root);
  let rootPhysical;
  try { rootPhysical = await physicalDirectory(resolvedRoot); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const ancestor = await existingAncestor(resolvedRoot);
    await physicalDirectory(ancestor);
    if (!create) return null;
    await mkdir(resolvedRoot, { recursive: true });
    rootPhysical = await physicalDirectory(resolvedRoot);
  }
  if (create) await mkdir(directory, { recursive: true });
  let directoryPhysical;
  try { directoryPhysical = await physicalDirectory(directory); }
  catch (error) { if (!create && error?.code === 'ENOENT') return null; throw error; }
  if (!contained(rootPhysical, directoryPhysical)) {
    throw unsafePath(`Scheduled task directory escapes its instance root: ${directory}`);
  }
  return directoryPhysical;
}

async function validateFile(filename, root, { missing = false } = {}) {
  const directory = path.dirname(filename);
  const directoryPhysical = await taskDirectory(root, directory);
  if (directoryPhysical == null) return false;
  let metadata;
  try { metadata = await lstat(filename); }
  catch (error) { if (missing && error?.code === 'ENOENT') return false; throw error; }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw unsafePath(`Scheduled task document is not a physical regular file: ${filename}`);
  }
  const physical = await realpath(filename);
  if (!contained(directoryPhysical, physical)) {
    throw unsafePath(`Scheduled task document escapes its instance root: ${filename}`);
  }
  return true;
}

function guidFilename(id) {
  if (typeof id !== 'string' || !/^[a-f\d]{32}$/iu.test(id)) {
    throw new TypeError('A native scheduled task id is required.');
  }
  const value = id.toLowerCase();
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}.js`;
}

async function readJson(filename, root, { emptyIsNull = false, bind } = {}) {
  if (!await validateFile(filename, root, { missing: true })) return null;
  let bytes;
  try { bytes = await readFile(filename); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (bytes.length > maximumTaskFileBytes) {
    throw new Error(`Scheduled task file exceeds ${maximumTaskFileBytes} bytes: ${filename}`);
  }
  if (!bytes.length) {
    if (emptyIsNull) return null;
    throw new SyntaxError(`Scheduled task file is empty: ${filename}`);
  }
  const source = bytes.toString('utf8');
  let value;
  try { value = parseLosslessJson(source); }
  catch (cause) {
    throw Object.assign(new SyntaxError(`Scheduled task JSON is invalid: ${filename}`, { cause }), {
      code: 'invalid-scheduled-task-json'
    });
  }
  return bind ? bind(value, source) : value;
}

async function atomicJson(filename, root, value) {
  const directory = path.dirname(filename);
  const directoryPhysical = await taskDirectory(root, directory, { create: true });
  await validateFile(filename, root, { missing: true });
  const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    const text = stringifyNativeJson(value);
    if (Buffer.byteLength(text) > maximumTaskFileBytes) {
      throw new Error(`Scheduled task file exceeds ${maximumTaskFileBytes} bytes: ${filename}`);
    }
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (!samePath(directoryPhysical, await physicalDirectory(directory))) {
      throw unsafePath(`Scheduled task directory changed during persistence: ${directory}`);
    }
    await validateFile(filename, root, { missing: true });
    await rename(temporary, filename);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export class ScheduledTaskFileStore {
  #closed = false;
  #closePromise;
  #tail = Promise.resolve();

  constructor({ taskId, programDataPath, configurationDirectoryPath, dataPath } = {}) {
    if (typeof programDataPath !== 'string' || !path.isAbsolute(programDataPath)) {
      throw new TypeError('Scheduled task persistence requires an absolute program data path.');
    }
    configurationDirectoryPath ??= path.resolve(programDataPath, '..', 'config');
    dataPath ??= path.join(programDataPath, 'data');
    if (typeof configurationDirectoryPath !== 'string' || !path.isAbsolute(configurationDirectoryPath)
      || typeof dataPath !== 'string' || !path.isAbsolute(dataPath)) {
      throw new TypeError('Scheduled task persistence paths must be absolute.');
    }
    const filename = guidFilename(taskId);
    this.configurationRoot = path.resolve(configurationDirectoryPath);
    this.historyRoot = path.resolve(dataPath);
    this.configurationPath = path.join(configurationDirectoryPath, 'ScheduledTasks', filename);
    this.historyPath = path.join(dataPath, 'ScheduledTasks', filename);
  }

  #closedOperation() {
    return Promise.reject(Object.assign(new Error('Scheduled task persistence is closed.'), { code: 'closed' }));
  }

  loadTriggers() {
    return this.#closed ? this.#closedOperation() : readJson(this.configurationPath, this.configurationRoot, {
      bind: bindTaskTriggerInfos
    });
  }

  loadHistory() {
    return this.#closed ? this.#closedOperation() : readJson(this.historyPath, this.historyRoot, { emptyIsNull: true });
  }

  #save(filename, root, value) {
    if (this.#closed) return this.#closedOperation();
    const operation = this.#tail.then(() => atomicJson(filename, root, value));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  saveTriggers(value) { return this.#save(this.configurationPath, this.configurationRoot, value); }
  saveHistory(value) { return this.#save(this.historyPath, this.historyRoot, value); }
  close() {
    if (!this.#closePromise) {
      this.#closed = true;
      this.#closePromise = this.#tail;
    }
    return this.#closePromise;
  }
}

export const scheduledTaskFilename = guidFilename;
