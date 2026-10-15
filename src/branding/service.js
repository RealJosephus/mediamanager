import path from 'node:path';
import { HttpResult, noContent, notFound } from '../http/binding.js';
import { MIN_DATE } from '../library/records.js';
import { clrTrim } from '../metadata/whitespace.js';
import { MetadataImageAssets, imagePathApi } from '../metadata/image-assets.js';
import { decodeBase64Stream, imageUploadExtension } from '../images/upload.js';

export class BrandingService {
  #lifetime = new AbortController();
  #active = new Set();
  #requests = new Set();
  #tail = Promise.resolve();
  constructor({ configurationStore, images, dataPath, assets, fileSystem } = {}) {
    if (!configurationStore || !images) throw new TypeError('Branding requires native configuration and image delivery services.');
    Object.assign(this, { configurationStore, images, dataPath });
    this.assets = assets ?? new MetadataImageAssets({ fileSystem, stateRoots: dataPath ? [dataPath] : [] });
  }
  getOptions({ includeLocation = false } = {}) {
    const { LoginDisclaimer, CustomCss, SplashscreenEnabled, SplashscreenLocation } = this.configurationStore.options;
    return { LoginDisclaimer, CustomCss, SplashscreenEnabled, ...(includeLocation && { SplashscreenLocation }) };
  }
  #mutate(operation) {
    if (this.#lifetime.signal.aborted) return Promise.reject(this.#lifetime.signal.reason);
    const task = this.#tail.then(() => { this.#lifetime.signal.throwIfAborted(); return operation(); });
    this.#active.add(task); this.#tail = task.catch(() => {});
    task.then(() => this.#active.delete(task), () => this.#active.delete(task));
    return task;
  }
  updateOptions(options) { return this.#mutate(() => this.configurationStore.save(options)); }
  async #exists(filename) {
    if (!imagePathApi(filename).isAbsolute(filename) || filename.includes('\0')) return false;
    try { return (await this.assets.stat(filename, { signal: this.#lifetime.signal })).kind === 'file'; }
    catch (error) { if (['not-found', 'ENOENT', 'ENOTDIR', 'permission-denied', 'EACCES', 'EPERM'].includes(error.code)) return false; throw error; }
  }
  async splashscreen(options, context) {
    this.#lifetime.signal.throwIfAborted();
    const branding = this.configurationStore.options;
    if (!branding.SplashscreenEnabled && !context.auth.IsAdministrator) return notFound();
    let filename = branding.SplashscreenLocation;
    if (!filename || clrTrim(filename) === '' || !await this.#exists(filename)) {
      if (!this.dataPath) return notFound();
      filename = path.join(this.dataPath, 'splashscreen.png');
      if (!await this.#exists(filename)) return notFound();
    }
    return this.images.result({ loaded: { item: {}, imageAssets: this.assets }, image: { Path: filename, DateModified: MIN_DATE },
      options: { ...options, quality: 90 }, context, dlna: false });
  }
  upload(request) {
    if (this.#lifetime.signal.aborted) return Promise.reject(this.#lifetime.signal.reason);
    this.#requests.add(request);
    return this.#mutate(async () => {
      const extension = imageUploadExtension(request.headers['content-type']);
      if (!extension) return new HttpResult(400, 'Incorrect ContentType.');
      if (!this.dataPath) throw Object.assign(new Error('Native instance data storage is unavailable.'), { status: 501 });
      const filename = path.join(this.dataPath, 'splashscreen-upload' + extension);
      await this.configurationStore.save({ SplashscreenLocation: filename });
      let file;
      try {
        await this.assets.resolve(filename);
        file = await this.assets.fileSystem.open(filename, 'w');
        for await (const bytes of decodeBase64Stream(request, { signal: this.#lifetime.signal })) await file.writeFile(bytes);
        return noContent();
      } catch (error) { if (error.code === 'ENOENT') error.status = 404; throw error; }
      finally { await file?.close(); }
    }).finally(() => this.#requests.delete(request));
  }
  deleteSplashscreen() {
    return this.#mutate(async () => {
      const filename = this.configurationStore.options.SplashscreenLocation;
      if (filename && await this.#exists(filename)) {
        const location = await this.assets.resolve(filename);
        if (location.localPath) {
          // libuv clears Windows read-only attributes when unlinking a file.
          if (process.platform === 'win32' && ((await this.assets.fileSystem.stat(location.localPath)).mode & 0o222) === 0) throw Object.assign(new Error('The custom splashscreen is read-only.'), { code: 'EPERM' });
          await this.assets.fileSystem.unlink(location.localPath);
        } else await this.assets.delete(filename);
        await this.configurationStore.save({ SplashscreenLocation: null });
      }
      return noContent();
    });
  }
  async close() {
    this.#lifetime.abort();
    for (const request of this.#requests) request.destroy(this.#lifetime.signal.reason);
    await Promise.allSettled(this.#active);
    await this.configurationStore.close();
  }
}
