import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './reader-config.mjs';
export { acquireLease } from './reader-lease.mjs';

export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, JSON.stringify(value, null, 2)); await rename(temporary, file); }
  finally { await unlink(temporary).catch(() => {}); }
}
export async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }

export class ArticleCache {
  constructor(root, ttlMs = 86400000) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('cache TTL must be non-negative');
    this.root = root; this.ttlMs = ttlMs;
  }
  async get(key, { refresh = false } = {}) {
    if (refresh || !this.ttlMs) return { hit: false, reason: refresh ? 'refresh' : 'disabled', key };
    try {
      const record = await readJson(join(this.root, key + '.json'));
      if (record.schema !== 1 || record.key !== key || record.result.status !== 'ok' || digest(record.result.content_markdown) !== record.result.content_sha256) return { hit: false, reason: 'corrupt', key };
      const age = Date.now() - Date.parse(record.saved_at);
      if (!Number.isFinite(age) || age < 0 || age >= this.ttlMs) return { hit: false, reason: 'expired', key };
      return { hit: true, key, saved_at: record.saved_at, age_ms: age, result: record.result };
    } catch (error) {
      if (error.code === 'ENOENT') return { hit: false, reason: 'missing', key };
      if (error instanceof SyntaxError || error instanceof TypeError) return { hit: false, reason: 'corrupt', key };
      throw error;
    }
  }
  async put(key, result) {
    if (!this.ttlMs || result.status !== 'ok') return;
    await writeJson(join(this.root, key + '.json'), { schema: 1, key, saved_at: new Date().toISOString(), result });
  }
}
