import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { acquireLease, writeJson } from '../src/reader-storage.mjs';

if (process.argv[2] === '--worker') {
  const release = await acquireLease(process.argv[3], { timeoutMs: 10000 });
  process.send({ state: 'held', pid: process.pid });
  process.once('message', async () => { await release(); process.disconnect(); });
} else {
  // Browser E2E cannot prove that an OS lease is released after a process crash.
  const key = 'bpc-lease-crash-check-' + process.pid;
  const start = () => spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', key], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
  const first = start();
  let second, timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Lease subprocess check timed out')), 15000); });
    await Promise.race([once(first, 'message'), timeout]);
    second = start();
    let acquiredWhileFirstAlive = false;
    second.on('message', () => { acquiredWhileFirstAlive = first.exitCode === null && first.signalCode === null; });
    const next = once(second, 'message');
    await new Promise(done => setTimeout(done, 700));
    assert.equal(acquiredWhileFirstAlive, false, 'second process must wait');
    const exited = once(first, 'exit'); first.kill(); await exited;
    await Promise.race([next, timeout]);
    assert.equal(acquiredWhileFirstAlive, false);
    const secondExit = once(second, 'exit'); second.send({ state: 'release' }); await secondExit;
    const result = { status: 'passed', cross_process_mutual_exclusion: true, lease_released_after_process_termination: true, checked_at: new Date().toISOString() };
    await writeJson('output/playwright/mvp-complete/lease-check.json', result);
    console.log(JSON.stringify(result, null, 2));
  } finally { clearTimeout(timer); first.kill(); second?.kill(); }
}
