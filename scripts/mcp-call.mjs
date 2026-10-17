// Protocol-level client for reproducible local calls and retained receipts.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { projectRoot } from '../src/bpc-assets.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { session: { type: 'string' },
  proxy: { type: 'string' }, input: { type: 'string' }, out: { type: 'string' }, wait: { type: 'boolean', default: false }, compact: { type: 'boolean', default: false } } });
const client = new Client({ name: 'reader-local-verification', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(projectRoot, 'src/mcp-cli.mjs'), ...(values.session ? ['--session', values.session] : []),
  ...(values.proxy ? ['--proxy', values.proxy] : [])], cwd: projectRoot, stderr: 'inherit' });
try {
  await client.connect(transport);
  const tool = positionals[0] || 'list';
  const args = values.input ? JSON.parse((await readFile(resolve(values.input), 'utf8')).replace(/^\uFEFF/, '')) : {};
  let reply = tool === 'list' ? await client.listTools() : tool === 'prompts' ? await client.listPrompts()
    : tool === 'prompt' ? await client.getPrompt({ name: 'research_topic', arguments: args })
    : await client.callTool({ name: tool, arguments: args }, { timeout: 700000 });
  if (values.wait && tool === 'start_reading_job' && !reply.isError) {
    const id = reply.structuredContent.job_id;
    let phase;
    do {
      reply = await client.callTool({ name: 'get_reading_job', arguments: { job_id: id, include_content: true } });
      const current = reply.structuredContent;
      if (current.phase !== phase) { phase = current.phase; console.error('MCP job:', id, phase); }
      if (['completed', 'failed'].includes(current.state)) break;
      await new Promise(done => setTimeout(done, 1000));
    } while (true);
  }
  if (values.out) { await mkdir(dirname(resolve(values.out)), { recursive: true }); await writeFile(resolve(values.out), JSON.stringify(reply, null, 2)); }
  if (values.compact && reply.structuredContent) {
    const { items, ...metadata } = reply.structuredContent;
    console.log(JSON.stringify({ ...metadata, ...(items ? { items: items.map(({ article, ...item }) => ({ ...item, ...(article ? { article: { ...article, content_markdown: undefined, content_text: undefined } } : {}) })) } : {}) }, null, 2));
  } else console.log(JSON.stringify(reply, null, 2));
  if (reply.isError) process.exitCode = 2;
} finally { await client.close(); }
