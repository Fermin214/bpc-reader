import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const localRoot = fileURLToPath(new URL('../', import.meta.url));
export const settingsFile = join(localRoot, '.cache/reader/settings.json');
export const workspaceId = createHash('sha256').update(process.platform === 'win32' ? localRoot.toLowerCase() : localRoot).digest('hex').slice(0, 16);
export const defaultSettings = { version: 1, session: 'reader', driver: process.platform === 'win32' ? 'chromium-cdp' : 'chromium', proxy: null, port: 8787, cacheTtlHours: 24 };
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置必须是 JSON 对象。');
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaultSettings, key)) throw new Error('未知设置：' + key);
  const settings = { ...defaultSettings, ...value };
  if (settings.version !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(settings.session)) throw new Error('专用会话名称无效。');
  if (!['chromium', 'chromium-cdp'].includes(settings.driver) || process.platform !== 'win32' && settings.driver === 'chromium-cdp') throw new Error('浏览器驱动无效。');
  if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) throw new Error('本地端口应为 1024～65535 的整数。');
  if (!Number.isFinite(settings.cacheTtlHours) || settings.cacheTtlHours < 0 || settings.cacheTtlHours > 720) throw new Error('缓存时长应为 0～720 小时。');
  if (settings.proxy !== null) {
    const proxy = new URL(settings.proxy);
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error('代理应为不含账号密码的 HTTP(S) 地址。');
    settings.proxy = proxy.origin;
  }
  return settings;
}
export async function loadSettings() {
  try { return validateSettings(JSON.parse((await readFile(settingsFile, 'utf8')).replace(/^\uFEFF/, ''))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { ...defaultSettings }; }
}
export async function saveSettings(value) {
  const settings = validateSettings(value);
  await mkdir(dirname(settingsFile), { recursive: true });
  const temporary = settingsFile + '.' + process.pid + '.tmp';
  try { await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n'); await rename(temporary, settingsFile); }
  finally { await unlink(temporary).catch(() => {}); }
  return settings;
}
export function profileFolder(settings) { return join(localRoot, '.cache/profiles', `${settings.driver}-bpc-${settings.session}`); }
