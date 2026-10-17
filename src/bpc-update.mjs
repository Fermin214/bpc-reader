import { readFile, readdir, mkdir, rename, unlink, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { acquireLease } from './reader-lease.mjs';
import { projectRoot, bpcPaths, pathExists, describeBpcDirectory, inspectBpcAssets, copyBpcDirectory,
  sameBpcAssets, verifyBpcAssets, verifyBpcAssetsLocked, withBpcAssetsLock, recoverBpcUpdateLocked,
  writeBpcJson, writeBpcText } from './bpc-assets.mjs';

const stamp = () => new Date().toISOString();
const makeId = () => 'bpc-' + stamp().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
const validId = id => { if (!/^bpc-[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid BPC update id'); return id; };
const compareVersion = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
function diff(before, after) {
  const old = new Map(before.entries.map(e => [e.name, e.sha256])), next = new Map(after.entries.map(e => [e.name, e.sha256]));
  const permissions = field => ({ added: (after.manifest[field] || []).filter(v => !(before.manifest[field] || []).includes(v)),
    removed: (before.manifest[field] || []).filter(v => !(after.manifest[field] || []).includes(v)) });
  return { added: [...next.keys()].filter(n => !old.has(n)), removed: [...old.keys()].filter(n => !next.has(n)),
    changed: [...next.keys()].filter(n => old.has(n) && old.get(n) !== next.get(n)),
    identity_changed: before.manifest.key !== after.manifest.key,
    permissions: permissions('permissions'), host_permissions: permissions('host_permissions'), optional_host_permissions: permissions('optional_host_permissions') };
}
async function current(root) {
  return await withBpcAssetsLock(root, async () => {
    const assets = await verifyBpcAssetsLocked(root), paths = bpcPaths(root);
    return { assets, details: await describeBpcDirectory(paths.extension), recordText: await readFile(paths.record, 'utf8') };
  });
}
async function planUpdate(source, root) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('Supply --source with the unpacked MV3 extension directory');
  source = resolve(source);
  const before = await current(root), candidate = await describeBpcDirectory(source, { excludeNestedBundles: true });
  const changes = diff(before.details, candidate);
  return { before, candidate, source, plan: { status: sameBpcAssets(before.assets, candidate.receipt) ? 'up_to_date' : 'update_available',
    current: before.details.receipt, candidate: candidate.receipt, changes, ignored: candidate.ignored,
    warnings: [ ...(compareVersion(candidate.receipt.version, before.assets.version) === 0 && candidate.receipt.sha256 !== before.assets.sha256 ? ['same_version_different_content'] : []),
      'local_integrity_and_compatibility_checks_do_not_verify_upstream_release_authenticity' ] } };
}
export async function previewBpcUpdate(source, { root = projectRoot } = {}) { return (await planUpdate(source, root)).plan; }

// Existing publisher smoke exercises the actual worker, session rules, local
// Reuters override and visible article pipeline, using only original fixtures.
export async function validateBpcCandidate(candidate, { out, expected, log = () => {}, timeoutMs = 300000 } = {}) {
  await mkdir(out, { recursive: true });
  const child = spawn(process.execPath, [join(projectRoot, 'scripts/publisher-smoke.mjs'), '--extension', candidate, '--out', out],
    { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let timedOut = false;
  child.stdout.on('data', bytes => { chunks.push(bytes); log(bytes.toString().trimEnd()); });
  child.stderr.on('data', bytes => { chunks.push(bytes); log(bytes.toString().trimEnd()); });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
    } else child.kill('SIGTERM');
  }, timeoutMs);
  let code;
  try { code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); }); }
  finally { clearTimeout(timer); await writeFile(join(out, 'candidate-validation.log'), Buffer.concat(chunks)); }
  if (timedOut || code !== 0) throw new Error(timedOut ? 'BPC candidate validation timed out' : 'BPC candidate validation failed; inspect ' + out);
  const receipt = JSON.parse(await readFile(join(out, 'verification.json'), 'utf8'));
  if (receipt.status !== 'passed' || !sameBpcAssets(receipt.bpc, expected)) throw new Error('BPC validation receipt does not match staged bytes');
  return { status: 'passed', bpc: expected, receipt_path: join(out, 'verification.json'), checks: receipt.checks };
}

async function installCandidate({ root, folder, id, before, afterRecordText, probe, log, kind, rollbackOf }) {
  const paths = bpcPaths(root), candidate = join(folder, 'candidate'), after = JSON.parse(afterRecordText);
  let receipt = { id, kind, ...(rollbackOf ? { rollback_of: rollbackOf } : {}), status: 'staged', created_at: stamp(),
    before: before.details.receipt, after: Object.fromEntries(['version', 'manifest_version', 'files', 'sha256'].map(k => [k, after[k]])),
    ...(await pathExists(join(folder, 'plan.json')) ? { plan_path: join(folder, 'plan.json') } : {}) };
  await writeBpcJson(join(folder, 'receipt.json'), receipt);
  try {
    log('Validating staged BPC ' + receipt.after.version + ' before activation...');
    const validation = await probe(candidate, { out: join(folder, 'validation'), expected: receipt.after, log });
    if (validation.status !== 'passed' || !sameBpcAssets(validation.bpc, receipt.after)
      || !sameBpcAssets(await inspectBpcAssets(candidate), receipt.after)) throw new Error('Candidate changed or did not pass validation');
    receipt = { ...receipt, validation, status: 'validated' }; await writeBpcJson(join(folder, 'receipt.json'), receipt);
    await withBpcAssetsLock(root, async () => {
      const live = await verifyBpcAssetsLocked(root);
      if (!sameBpcAssets(live, receipt.before) || await readFile(paths.record, 'utf8') !== before.recordText) throw new Error('BPC changed since staging; rerun preview');
      await copyBpcDirectory(paths.extension, join(folder, 'backup/extension'));
      await writeBpcText(join(folder, 'backup/bpc.json'), before.recordText);
      // Every reader holds this gate while pinning. Existing runtimes use
      // immutable snapshots, so no reader sees half of this pair switch.
      await writeBpcJson(paths.pending, { id, phase: 'switching' });
      try {
        await rename(paths.extension, join(folder, 'retired'));
        await rename(candidate, paths.extension); await writeBpcText(paths.record, afterRecordText);
        if (!sameBpcAssets(await inspectBpcAssets(paths.extension), receipt.after)) throw new Error('Installed BPC verification failed');
        receipt = { ...receipt, status: 'applied', applied_at: stamp() }; await writeBpcJson(join(folder, 'receipt.json'), receipt);
        await writeBpcJson(paths.pending, { id, phase: 'committed' }); await unlink(paths.pending);
      } catch (error) {
        const recovery = await recoverBpcUpdateLocked(root);
        if (recovery?.action === 'finished_commit') {
          receipt = { ...receipt, status: 'applied', recovery, cleanup_warning: error.message };
          await writeBpcJson(join(folder, 'receipt.json'), receipt);
        } else {
          receipt = { ...receipt, status: 'failed_rolled_back', error: error.message, recovery };
          await writeBpcJson(join(folder, 'receipt.json'), receipt); throw error;
        }
      }
    });
    // Only a verified, redundant copy inside this generated transaction is
    // removed. The actual backup and any running version remain untouched.
    const retired = resolve(folder, 'retired');
    if (!retired.startsWith(resolve(paths.updates) + sep)) throw new Error('BPC cleanup escaped update storage');
    try { if (sameBpcAssets(await inspectBpcAssets(retired), receipt.before)) await rm(retired, { recursive: true }); }
    catch (error) { receipt = { ...receipt, cleanup_warning: error.message }; await writeBpcJson(join(folder, 'receipt.json'), receipt); }
    return { ...receipt, receipt_path: join(folder, 'receipt.json'), rollback_command: 'npm run bpc-update -- rollback ' + id,
      cache: 'BPC SHA-256 changes article cache keys; old cache and completed jobs are retained' };
  } catch (error) {
    if (receipt.status !== 'failed_rolled_back' && receipt.status !== 'applied') {
      receipt = { ...receipt, status: 'validation_or_staging_failed', error: error.message }; await writeBpcJson(join(folder, 'receipt.json'), receipt);
    }
    error.receipt_path = join(folder, 'receipt.json'); throw error;
  }
}

export async function applyBpcUpdate(source, { root = projectRoot, probe = validateBpcCandidate, log = () => {} } = {}) {
  root = resolve(root);
  const release = await acquireLease(root.toLowerCase() + ':bpc-updater', { onWait: () => log('Another BPC update is in progress; waiting...') });
  try {
    const prepared = await planUpdate(source, root), { plan, before, candidate } = prepared;
    if (plan.status === 'up_to_date') return plan;
    if (plan.changes.identity_changed) throw new Error('BPC extension identity changed; the existing profile cannot be migrated by this updater');
    if (compareVersion(candidate.receipt.version, before.assets.version) < 0) throw new Error('Use rollback with an update id to restore an older bundle');
    const paths = bpcPaths(root), id = makeId(), folder = join(paths.updates, id);
    await mkdir(folder, { recursive: true });
    await writeBpcJson(join(folder, 'plan.json'), { ...plan, source: prepared.source });
    await copyBpcDirectory(prepared.source, join(folder, 'candidate'), candidate);
    const record = { ...JSON.parse(before.recordText), ...candidate.receipt, provenance: 'local source snapshot; staged compatibility validation' };
    return await installCandidate({ root, folder, id, before, afterRecordText: JSON.stringify(record, null, 2) + '\n', probe, log, kind: 'update' });
  } finally { await release(); }
}

export async function rollbackBpcUpdate(updateId, { root = projectRoot, probe = validateBpcCandidate, log = () => {} } = {}) {
  root = resolve(root); validId(updateId);
  const release = await acquireLease(root.toLowerCase() + ':bpc-updater');
  try {
    const paths = bpcPaths(root), target = join(paths.updates, updateId), previous = JSON.parse(await readFile(join(target, 'receipt.json'), 'utf8'));
    const before = await current(root);
    if (previous.status !== 'applied' || !sameBpcAssets(before.assets, previous.after)) throw new Error('Rollback id is not the currently applied bundle; select the latest applicable update');
    const oldRecordText = await readFile(join(target, 'backup/bpc.json'), 'utf8'), oldRecord = JSON.parse(oldRecordText);
    if (!sameBpcAssets(await inspectBpcAssets(join(target, 'backup/extension')), previous.before) || !sameBpcAssets(oldRecord, previous.before)) throw new Error('Rollback backup failed integrity verification');
    const id = makeId(), folder = join(paths.updates, id); await mkdir(folder, { recursive: true });
    await copyBpcDirectory(join(target, 'backup/extension'), join(folder, 'candidate'));
    return await installCandidate({ root, folder, id, before, afterRecordText: oldRecordText, probe, log, kind: 'rollback', rollbackOf: updateId });
  } finally { await release(); }
}

export async function bpcUpdateStatus({ root = projectRoot } = {}) {
  const assets = await verifyBpcAssets(root), paths = bpcPaths(root);
  const ids = await readdir(paths.updates).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const history = [];
  for (const id of ids.filter(id => /^bpc-[a-zA-Z0-9_-]{1,80}$/.test(id)).sort().reverse().slice(0, 10)) {
    try { const r = JSON.parse(await readFile(join(paths.updates, id, 'receipt.json'), 'utf8'));
      history.push({ id, status: r.status, kind: r.kind, before: r.before?.version, after: r.after?.version, sha256: r.after?.sha256,
        applicable_rollback: r.status === 'applied' && r.after?.sha256 === assets.sha256 });
    } catch (error) { history.push({ id, status: 'incomplete_receipt', error: error.message }); }
  }
  return { status: 'ok', current: assets, history };
}
