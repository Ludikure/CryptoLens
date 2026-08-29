// R2Bucket shape implemented over the filesystem.
//
// At runtime the worker only calls MODELS.head('crypto/model-v3.json') and
// .head('stock/model-v3.json') (index.ts:1252-1253) to report model metadata via
// /ml-models/version. get()/put() are implemented minimally for future use (e.g. uploading
// new models from the Mac mini). Objects live under <root>/ preserving key prefixes.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class R2Adapter {
  constructor(private root: string) {}

  // Resolve a key to a path and refuse anything that escapes the root (path-traversal guard).
  private p(key: string) {
    const root = path.resolve(this.root);
    const full = path.resolve(root, key);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('bad key');
    return full;
  }

  async head(key: string) {
    try {
      const st = await fs.stat(this.p(key));
      return {
        key,
        size: st.size,
        uploaded: st.mtime,
        etag: crypto.createHash('md5').update(`${st.size}-${st.mtimeMs}`).digest('hex'),
        httpEtag: '',
      };
    } catch {
      return null; // R2 head() returns null for a missing object
    }
  }

  async get(key: string) {
    try {
      const buf = await fs.readFile(this.p(key));
      const meta = await this.head(key);
      return {
        ...meta!,
        arrayBuffer: async () =>
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        text: async () => buf.toString('utf8'),
        json: async () => JSON.parse(buf.toString('utf8')),
        body: null,
      };
    } catch {
      return null;
    }
  }

  async put(key: string, value: ArrayBuffer | string) {
    const full = this.p(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, typeof value === 'string' ? value : Buffer.from(value));
  }
}
