#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadSettings } from './reader-settings.mjs';

const { values } = parseArgs({ options: { session: { type: 'string' }, proxy: { type: 'string' }, driver: { type: 'string' } } });
const settings = await loadSettings();
const [{ serveStdio }, { ReaderEngine }, { createReaderMcpServer }] = await Promise.all([
  import('@modelcontextprotocol/server/stdio'), import('./reader-engine.mjs'), import('./reader-mcp.mjs'),
]);
const engine = new ReaderEngine({ session: values.session || settings.session, proxy: values.proxy ?? settings.proxy, driver: values.driver || settings.driver,
  cacheTtlMs: settings.cacheTtlHours * 3600000, log: text => console.error(text) });
serveStdio(() => createReaderMcpServer({ engine }));
// Draining stdin/SIGTERM preserves in-flight job receipts and closes our browser.
// It cannot affect daily Chrome. Interrupted processes leave resumable jobs.
const finish = () => { engine.tail.finally(() => process.exit(0)); };
process.stdin.once('end', finish);
process.once('SIGINT', finish); process.once('SIGTERM', finish);
