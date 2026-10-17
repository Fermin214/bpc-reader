// Local source-clone acceptance. No remote, GitHub, package publication or user config writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { localRoot } from '../src/reader-settings.mjs';

const { values } = parseArgs({ options: { proxy: { type: 'string' } } });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run with npm run distribution-check [-- --proxy http://host:port].');
const outputRoot = resolve(localRoot, 'output');
const root = join(outputRoot, 'distribution-' + Date.now());
const seed = join(root, 'source');
const checkout = join(root, '干净 安装', 'BPC-Reader');
await mkdir(seed, { recursive: true });
const env = { ...process.env, ...(values.proxy ? { HTTP_PROXY: values.proxy, HTTPS_PROXY: values.proxy,
  npm_config_proxy: values.proxy, npm_config_https_proxy: values.proxy } : {}) };
delete env.PLAYWRIGHT_BROWSERS_PATH; // Test a real fresh runtime download, not the developer cache.
let sequence = 0;
async function run(label, command, args, cwd = checkout) {
  console.log('RUN:', label);
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  await writeFile(join(root, String(++sequence).padStart(2, '0') + '-' + label + '.log'), stdout + '\n' + stderr);
  if (code !== 0) throw new Error(`${label} exited ${code}: ${(stderr || stdout).slice(-2500)}`);
  return stdout;
}
const cases = [];
function check(label, passed) { assert(passed, label); cases.push(label); console.log('PASS:', label); }
try {
  await run('temporary-git-init', 'git', ['init', '--quiet', '-b', 'main'], seed);
  // Use the real .gitignore without creating a repository in the development root.
  const names = (await run('source-list', 'git', ['--git-dir=' + join(seed, '.git'), '--work-tree=' + resolve(localRoot),
    'ls-files', '--others', '--exclude-standard', '-z'], localRoot)).split('\0').filter(Boolean);
  check('Source excludes browser sessions, bodies, dependencies and local history', names.length > 70
    && !names.some(name => /(^|\/)(\.cache|output|node_modules|\.local-history)(\/|$)/.test(name)));
  check('Source includes lockfile, Agent skill, installer and BPC license', ['package-lock.json', 'skills/bpc-reader/SKILL.md',
    'scripts/install-browser.mjs', 'vendor/bpc/LICENSE'].every(name => names.includes(name)));
  const hash = createHash('sha256');
  for (const name of names.sort()) {
    const source = resolve(localRoot, name), target = resolve(seed, name);
    if (!source.startsWith(resolve(localRoot) + sep) || !target.startsWith(seed + sep)) throw new Error('Source path escaped workspace');
    hash.update(name + '\n'); hash.update(await readFile(source));
    await mkdir(resolve(target, '..'), { recursive: true });
    await cp(source, target);
  }
  await run('stage-local-source', 'git', ['add', '.'], seed);
  await run('commit-local-fixture', 'git', ['-c', 'user.name=BPC Reader Local Test', '-c', 'user.email=local-test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Local source installation fixture'], seed);
  await mkdir(resolve(checkout, '..'), { recursive: true });
  await run('clone-source', 'git', ['clone', '--quiet', '--no-hardlinks', seed, checkout], root);
  const commit = (await run('source-revision', 'git', ['rev-parse', 'HEAD'])).trim();
  await assert.rejects(access(join(checkout, '.cache')));
  await assert.rejects(access(join(checkout, 'node_modules')));
  check('Clean Git clone in a Chinese path with spaces has no developer state', true);
  await run('npm-ci', process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund']);
  const setupArgs = ['scripts/install-browser.mjs', ...(values.proxy ? ['--proxy', values.proxy] : [])];
  const setup = JSON.parse(await run('fresh-browser-setup', process.execPath, setupArgs));
  const bundled = JSON.parse(await readFile(join(checkout, 'assets/bpc.json'), 'utf8'));
  check('Fresh download and initialization load bundled BPC with a new independent profile', setup.status === 'ready'
    && setup.bpc_version === bundled.version && setup.profile_id && setup.browser.startsWith(checkout + sep));
  const second = JSON.parse(await run('repeat-setup', process.execPath, setupArgs));
  check('Repeated setup preserves the same dedicated profile', second.profile_id === setup.profile_id);
  const config = JSON.parse(await run('mcp-config', process.execPath, ['scripts/mcp-config.mjs']));
  check('Generated MCP configuration points at this installation', config.mcpServers.bpc_reader.args[0] === join(checkout, 'src/mcp-cli.mjs'));
  const verified = JSON.parse(await run('real-mcp-entry', process.execPath, ['scripts/check-install.mjs']));
  check('Real stdio entry works from another working directory and exposes seven tools', verified.status === 'passed'
    && verified.tools.length === 7 && verified.tools.includes('discover_feed_articles') && verified.health.status === 'ready' && verified.health.session === 'reader');
  const smoke = await run('mcp-browser-e2e', process.execPath, ['scripts/mcp-smoke.mjs']);
  const smokeCases = smoke.split('\n').filter(line => line.startsWith('PASS:')).length;
  check('Clean installation completes MCP search, batch body, preview isolation, cache and resume', smokeCases >= 16 && smoke.includes('MCP smoke passed:'));
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', cases, source_files: names,
    source_sha256: hash.digest('hex'), fixture_commit: commit, browser_download: 'fresh', profile_id: setup.profile_id,
    mcp_e2e_cases: smokeCases, github_created: false, user_agent_config_changed: false }, null, 2) + '\n');
  // Keep compact receipts, remove the disposable Git clones, downloaded browser and dependencies.
  if (!resolve(root).startsWith(outputRoot + sep)) throw new Error('Cleanup root escaped output');
  for (const folder of [seed, checkout]) {
    if (!resolve(folder).startsWith(root + sep)) throw new Error('Cleanup target escaped fixture');
    await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
  console.log('Source installation passed:', join(root, 'verification.json'));
} catch (error) {
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'failed', cases, error: error.message }, null, 2));
  console.error(error.message, '\nInspect:', root);
  process.exitCode = 1;
}
