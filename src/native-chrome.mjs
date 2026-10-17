import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';

// Only starts this project's dedicated profile. Never attaches to daily Chrome.
export async function startNativeChrome({ chromium, profilePath, proxy, executablePath, extensionPath }) {
  if (process.platform !== 'win32') throw new Error('chrome-cdp currently supports Windows only');
  const executable = executablePath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  await access(executable);
  const reservation = createServer();
  await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const endpoint = `http://127.0.0.1:${port}`;
  const args = [`--user-data-dir=${profilePath}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank'];
  if (extensionPath) args.unshift(`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`);
  if (proxy) args.unshift(`--proxy-server=${proxy}`, '--proxy-bypass-list=localhost;127.0.0.1');
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: false });
  let processError;
  child.once('error', error => { processError = error; });
  let connection;
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (processError) throw processError;
      if (child.exitCode !== null) throw new Error(`Chrome exited before connection: ${child.exitCode}`);
      try {
        const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { connection = await chromium.connectOverCDP(endpoint, { timeout: 5000, noDefaults: true }); break; }
      } catch { /* Wait for our own browser's loopback endpoint. */ }
      await new Promise(done => setTimeout(done, 250));
    }
    if (!connection) throw new Error('Dedicated Chrome debugging endpoint did not start');
    const context = connection.contexts()[0];
    if (!context) throw new Error('Chrome has no default context');
    let closed = false;
    const processStatus = () => ({ exited: child.exitCode !== null || child.signalCode !== null, exit_code: child.exitCode, signal: child.signalCode });
    const close = async () => {
      if (closed) return processStatus();
      closed = true;
      const exited = new Promise(done => { if (child.exitCode !== null) done(); else child.once('exit', done); });
      try { const session = await connection.newBrowserCDPSession(); await session.send('Browser.close'); } catch { /* Closing Chrome also closes the connection. */ }
      let timer;
      await Promise.race([exited, new Promise(done => { timer = setTimeout(done, 5000); })]);
      clearTimeout(timer);
      if (!processStatus().exited) {
        child.kill();
        let killTimer;
        await Promise.race([exited, new Promise(done => { killTimer = setTimeout(done, 2000); })]);
        clearTimeout(killTimer);
      }
      return processStatus();
    };
    return { context, close, endpoint, pid: child.pid, executable, args };
  } catch (error) { child.kill(); if (connection) await connection.close().catch(() => {}); throw error; }
}
