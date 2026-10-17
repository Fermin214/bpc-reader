// Run explicitly after npm ci; MCP startup never installs dependencies.
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSettings, saveSettings, validateSettings, localRoot } from '../src/reader-settings.mjs';
import { mcpConfiguration } from './mcp-config.mjs';

try {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const supported = major >= 26 || major === 24 && minor >= 15 || major === 22 && (minor > 22 || minor === 22 && patch >= 2);
  if (!supported) throw new Error('Node.js must satisfy ^22.22.2 || ^24.15.0 || >=26.0.0 (matching jsdom).');
  const { values } = parseArgs({ options: { proxy: { type: 'string' }, session: { type: 'string' },
    'no-proxy': { type: 'boolean' }, 'skip-init': { type: 'boolean' } } });
  if (values.proxy && values['no-proxy']) throw new Error('Choose --proxy or --no-proxy.');
  const previous = await loadSettings();
  const settings = validateSettings({ ...previous, ...(values.session ? { session: values.session } : {}),
    ...(values['no-proxy'] ? { proxy: null } : values.proxy ? { proxy: values.proxy } : {}) });
  const { prepareRuntime } = await import('../src/managed-reader.mjs');
  const runtime = await prepareRuntime({ proxy: settings.proxy, log: text => console.error(text) });
  let initialized = null;
  if (!values['skip-init']) {
    const { ReaderEngine } = await import('../src/reader-engine.mjs');
    initialized = await new ReaderEngine({ ...settings, log: text => console.error(text) }).initialize();
  }
  // Preserve the profile; persist settings only after preparation succeeds.
  await saveSettings(settings);
  const config = mcpConfiguration();
  const configPath = join(localRoot, '.cache/reader/mcp.json');
  await mkdir(join(localRoot, '.cache/reader'), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(JSON.stringify({ status: initialized ? 'ready' : 'runtime_prepared', browser: runtime.executable,
    bpc_version: runtime.assets.version, session: settings.session, driver: settings.driver,
    profile_id: initialized?.runtime.profile?.id || null, mcp_config_path: configPath, ...config,
    suggested_timeouts: { startup_timeout_sec: 30, tool_timeout_sec: 700 } }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'error', error: error.message }));
  process.exitCode = 1;
}
