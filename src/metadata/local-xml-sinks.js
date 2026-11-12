import path from 'node:path';
import { localXmlBufferSize } from './local-xml-writer.js';
import { ownStorageDirectory } from '../storage/ownership.js';
import { operationFailure } from '../core/operation-failure.js';

const fileSink = handle => ({ async write(bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!bytesWritten) throw new Error('The XML sink made no write progress.');
    offset += bytesWritten;
  }
} });

export async function directFileXmlSink(target, fileSystem) {
  const handle = await fileSystem.open(target, 'w');
  return { sink: fileSink(handle), close: () => handle.close() };
}

/** A state-owned disk spool supplies the exact HTTP Content-Length without
 * retaining the document in Node memory. It is a network upload source, not a
 * claim that PUT provides native Create/truncate or exclusive file access. */
export async function validateXmlSpoolRoot(root, fileSystem) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('Network XML saves require an absolute authorized state spool root.');
  }
  const info = await fileSystem.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('The XML spool root must be a non-symbolic directory.');
  return fileSystem.realpath(root);
}

export async function networkXmlSpool(root, fileSystem) {
  const owner = ownStorageDirectory(fileSystem, root); fileSystem = owner.fileSystem;
  let directory, target, handle;
  try {
    directory = await fileSystem.mkdtemp(path.join(root, 'xml-save-'));
    target = path.join(directory, 'frame.xml'); handle = await fileSystem.open(target, 'wx');
  } catch (error) {
    const errors = [error];
    if (directory) try { await fileSystem.rmdir(directory); } catch (error) { errors.push(error); }
    try { await owner.close(); } catch (error) { errors.push(error); }
    if (errors.length > 1) throw new AggregateError(errors, 'The XML spool could not be opened.', { cause: error });
    throw error;
  }
  let closing, disposing;
  const readers = new Set(), opening = new Set(), uploads = new Set();
  const close = () => closing ??= Promise.resolve().then(() => handle.close());
  const dispose = () => disposing ??= (async () => {
    const errors = [];
    await Promise.allSettled([...uploads, ...opening]);
    try { await close(); } catch (error) { errors.push(error); }
    for (const reader of readers) {
      try { await reader.close(); } catch (error) { errors.push(error); }
      readers.delete(reader);
    }
    try { await fileSystem.unlink(target); } catch (error) { errors.push(error); }
    try { await fileSystem.rmdir(directory); } catch (error) { errors.push(error); }
    try { await owner.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'The XML spool could not be completely released.');
  })();
  const prepare = async () => {
    if (disposing) throw new Error('The XML spool has been released.');
    await close();
    const size = (await fileSystem.stat(target, { bigint: true })).size;
    async function* stream() {
      if (disposing) throw new Error('The XML spool has been released.');
      const pending = fileSystem.open(target, 'r').then(reader => { readers.add(reader); return reader; });
      opening.add(pending);
      let reader;
      try { reader = await pending; } finally { opening.delete(pending); }
      const errors = [];
      try {
        while (true) {
          const bytes = Buffer.allocUnsafe(localXmlBufferSize);
          const { bytesRead } = await reader.read(bytes, 0, bytes.length, null);
          if (!bytesRead) return;
          yield bytes.subarray(0, bytesRead);
        }
      } catch (error) { errors.push(error); }
      finally {
        try { if (readers.delete(reader)) await reader.close(); } catch (error) { errors.push(error); }
        if (errors.length) throw operationFailure(errors, 'The XML spool reader could not be released.');
      }
    }
    return Object.freeze({ size, stream, close: dispose });
  };
  return { sink: fileSink(handle), close, prepare, dispose,
    writeTextSync(value) {
      if(closing||disposing) throw new Error('The XML spool cannot accept more text.');
      for(let start=0;start<value.length;) {
        let end=Math.min(start+2048,value.length); if(end<value.length && /[\uD800-\uDBFF]/u.test(value[end-1]))end--;
        const bytes=Buffer.from(value.slice(start,end),'utf8');
        for(let offset=0;offset<bytes.length;) {const written=handle.writeSync(bytes.subarray(offset));if(!written)throw new Error('The XML spool made no write progress.');offset+=written;}
        start=end;
      }
    },
    upload(vfs, destination, options = {}) {
      const uploading = (async () => {
        const prepared = await prepare(), stream = prepared.stream();
        const errors = [];
        let result;
        try { result = await vfs.write(destination, stream, { ...options, size: prepared.size }); }
        catch (error) { errors.push(error); }
        try { await stream.return(); } catch (error) { errors.push(error); }
        if (errors.length) throw operationFailure(errors, 'The XML frame could not be uploaded.');
        return result;
      })();
      uploads.add(uploading);
      void uploading.then(() => uploads.delete(uploading), () => uploads.delete(uploading));
      return uploading;
    },
  };
}
