import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

// Crashed holders release their pipe/socket; stale PID files do not own leases.
export async function acquireLease(key, { timeoutMs = 180000, onWait } = {}) {
  const hash = createHash('sha256').update(key).digest('hex');
  const port = 40000 + (Number.parseInt(hash.slice(0, 8), 16) % 10000);
  const address = process.platform === 'win32'
    ? { path: '\\\\.\\pipe\\ai-reader-' + hash, exclusive: true }
    : { host: '127.0.0.1', port, exclusive: true };
  const start = Date.now(); let reported = false;
  while (true) {
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise((done, reject) => { server.once('error', reject); server.listen(address, done); });
      let closed = false;
      return async () => { if (!closed) { closed = true; await new Promise(done => server.close(done)); } };
    } catch (error) {
      server.close();
      if (error.code !== 'EADDRINUSE' && !(process.platform === 'win32' && error.code === 'EACCES')) throw error;
      if (!reported) { onWait?.(); reported = true; }
      if (Date.now() - start >= timeoutMs) throw new Error('queue_wait_timeout: the dedicated session or job is still busy');
      await new Promise(done => setTimeout(done, 250));
    }
  }
}
