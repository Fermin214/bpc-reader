import { readFile, readdir, mkdir, copyFile, lstat, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLease } from './reader-lease.mjs';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const extensionRoot = fileURLToPath(new URL('../vendor/bpc/', import.meta.url));

const fields = ['version', 'manifest_version', 'files', 'sha256'];
export const sameBpcAssets = (a, b) => fields.every(key => a?.[key] === b?.[key]);
export function bpcPaths(root = projectRoot) {
  root = resolve(root);
  return { root, extension: join(root, 'vendor/bpc'), record: join(root, 'assets/bpc.json'),
    data: join(root, '.cache/bpc'), updates: join(root, '.cache/bpc/updates'), pending: join(root, '.cache/bpc/pending.json') };
}
export async function pathExists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export async function writeBpcText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp, value); await rename(temp, path); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function writeBpcJson(path, value) { return await writeBpcText(path, JSON.stringify(value, null, 2) + '\n'); }
export async function withBpcAssetsLock(root, work) {
  const release = await acquireLease(resolve(root).toLowerCase() + ':bpc-assets');
  try { return await work(); } finally { await release(); }
}

export async function describeBpcDirectory(folder, { excludeNestedBundles = false } = {}) {
  folder = resolve(folder);
  const files = [], ignored = [];
  const rootInfo = await lstat(folder);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('BPC source must be a regular directory, not a link');
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name), name = relative(folder, path).replaceAll('\\', '/');
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('BPC assets must contain regular files and directories: ' + name);
      if (entry.isDirectory()) {
        if (excludeNestedBundles && await pathExists(join(path, 'manifest.json')) && await pathExists(join(path, 'background.js')) && await pathExists(join(path, 'LICENSE'))) {
          const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
          if (manifest.name === 'Bypass Paywalls Clean') { ignored.push({ path: name, reason: 'nested_complete_extension', version: manifest.version }); continue; }
        }
        await visit(path);
      } else files.push({ path, name });
    }
  }
  await visit(folder); files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const hash = createHash('sha256'), entries = [];
  for (const file of files) {
    const bytes = await readFile(file.path); hash.update(file.name + '\n'); hash.update(bytes);
    entries.push({ name: file.name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
  const license = await readFile(join(folder, 'LICENSE'), 'utf8');
  if (manifest.manifest_version !== 3 || !license.includes('MIT License') || !license.includes('magnolia1234')) throw new Error('BPC manifest or license is missing');
  if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version) || manifest.version.split('.').some(v => +v > 65535)) throw new Error('Invalid BPC extension version');
  const worker = manifest.background?.service_worker;
  if (typeof worker !== 'string' || worker.includes('..') || worker.includes('\\') || worker.startsWith('/') || !entries.some(e => e.name === worker)) throw new Error('BPC service worker must be a bundled file');
  return { receipt: { version: manifest.version, manifest_version: manifest.manifest_version, files: entries.length, sha256: hash.digest('hex') }, manifest, entries, ignored };
}
export async function inspectBpcAssets(folder = extensionRoot) { return (await describeBpcDirectory(folder)).receipt; }
export async function copyBpcDirectory(source, target, description = null) {
  const details = description || await describeBpcDirectory(source);
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target); // Never overwrite a snapshot or an external directory.
  for (const entry of details.entries) {
    const from = join(source, entry.name), to = join(target, entry.name);
    const info = await lstat(from);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Source changed during BPC staging');
    await mkdir(dirname(to), { recursive: true }); await copyFile(from, to);
  }
  if (!sameBpcAssets(await inspectBpcAssets(target), details.receipt)) throw new Error('BPC source changed during copy');
  return details.receipt;
}
export async function recoverBpcUpdateLocked(root = projectRoot) {
  const paths = bpcPaths(root);
  if (!await pathExists(paths.pending)) return null;
  const journal = JSON.parse(await readFile(paths.pending, 'utf8'));
  if (!/^bpc-[a-zA-Z0-9_-]{1,80}$/.test(journal.id)) throw new Error('Invalid pending BPC update id');
  const folder = join(paths.updates, journal.id), recordPath = join(folder, 'receipt.json');
  const receipt = JSON.parse(await readFile(recordPath, 'utf8'));
  if (journal.phase === 'committed') {
    const live = JSON.parse(await readFile(paths.record, 'utf8'));
    if (!sameBpcAssets(live, receipt.after) || !sameBpcAssets(await inspectBpcAssets(paths.extension), receipt.after)) throw new Error('Committed BPC update does not match its receipt');
    await unlink(paths.pending); return { id: journal.id, action: 'finished_commit' };
  }
  if (journal.phase !== 'switching') throw new Error('Unknown pending BPC update phase');
  const backup = join(folder, 'backup/extension'), oldText = await readFile(join(folder, 'backup/bpc.json'), 'utf8'), oldRecord = JSON.parse(oldText);
  if (!sameBpcAssets(oldRecord, receipt.before) || !sameBpcAssets(await inspectBpcAssets(backup), receipt.before)) throw new Error('BPC recovery backup failed verification; live files were not changed');
  const stage = join(folder, 'recovery-' + randomUUID());
  await copyBpcDirectory(backup, stage);
  if (await pathExists(paths.extension)) await rename(paths.extension, join(folder, 'interrupted-live-' + randomUUID()));
  await rename(stage, paths.extension); await writeBpcText(paths.record, oldText);
  if (!sameBpcAssets(await inspectBpcAssets(paths.extension), receipt.before)) throw new Error('BPC recovery verification failed');
  await writeBpcJson(recordPath, { ...receipt, status: 'recovered_rollback', recovered_at: new Date().toISOString() });
  await unlink(paths.pending); return { id: journal.id, action: 'restored_previous_bundle' };
}
export async function verifyBpcAssetsLocked(root = projectRoot) {
  const paths = bpcPaths(root), recovery = await recoverBpcUpdateLocked(root);
  const pinned = JSON.parse(await readFile(paths.record, 'utf8')), actual = await inspectBpcAssets(paths.extension);
  for (const key of fields) if (actual[key] !== pinned[key]) throw new Error(`Bundled BPC asset mismatch: ${key}; update and validate the bundled asset record before using changed source`);
  return { ...actual, source: pinned.source, license: 'MIT', path: paths.extension, ...(recovery ? { recovery } : {}) };
}
export async function verifyBpcAssets(root = projectRoot) { return await withBpcAssetsLock(root, () => verifyBpcAssetsLocked(root)); }
export async function pinBpcAssets(root = projectRoot) {
  return await withBpcAssetsLock(root, async () => {
    const assets = await verifyBpcAssetsLocked(root), paths = bpcPaths(root), snapshot = join(paths.data, 'runtime', assets.sha256);
    if (!await pathExists(snapshot)) {
      const stage = snapshot + '.' + randomUUID() + '.tmp';
      await copyBpcDirectory(paths.extension, stage); await rename(stage, snapshot);
    }
    if (!sameBpcAssets(await inspectBpcAssets(snapshot), assets)) throw new Error('Pinned BPC runtime snapshot failed integrity verification');
    return { ...assets, runtime_path: snapshot };
  });
}
