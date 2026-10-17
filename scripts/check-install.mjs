// Verify the actual configured stdio entry, not an in-process imitation.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mcpConfiguration } from './mcp-config.mjs';

const client = new Client({ name: 'bpc-reader-install-check', version: '0.1.0' });
const entry = mcpConfiguration().mcpServers.bpc_reader;
const transport = new StdioClientTransport({ ...entry, cwd: tmpdir(), stderr: 'inherit' });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const expected = ['reader_health', 'search_articles', 'read_article', 'start_reading_job', 'get_reading_job', 'resume_reading_job', 'discover_feed_articles'];
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), expected.sort());
  const health = (await client.callTool({ name: 'reader_health', arguments: {} })).structuredContent;
  assert.equal(health.status, 'ready');
  assert.equal(health.app_id, 'bpc-reader');
  const prompts = await client.listPrompts();
  assert(prompts.prompts.some(prompt => prompt.name === 'research_topic'));
  console.log(JSON.stringify({ status: 'passed', check: 'real_stdio_from_external_working_directory', tools: expected, health }, null, 2));
} finally { await client.close(); }
