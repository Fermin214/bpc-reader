import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localRoot } from '../src/reader-settings.mjs';

export function mcpConfiguration() {
  return { mcpServers: { bpc_reader: { command: process.execPath, args: [resolve(localRoot, 'src/mcp-cli.mjs')] } } };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(mcpConfiguration(), null, 2));
}
