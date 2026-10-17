import { parseArgs } from 'node:util';
import { previewBpcUpdate, applyBpcUpdate, rollbackBpcUpdate, bpcUpdateStatus } from '../src/bpc-update.mjs';

const help = `BPC local updater (no scheduled downloads)
  npm run bpc-update -- status
  npm run bpc-update -- inspect --source "<unpacked extension directory>"
  npm run bpc-update -- apply --source "<unpacked extension directory>"
  npm run bpc-update -- rollback <update-id>
Apply/rollback validate an isolated copy before activation. Output is JSON;
progress goes to stderr. Backups and receipts are in .cache/bpc/updates/.
Running jobs retain their pinned BPC version. Profiles and old caches stay.`;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { source: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log(help); }
  else {
    const options = { log: text => console.error(text) };
    const command = positionals[0] || 'status'; let result;
    if (command === 'status' && positionals.length <= 1 && !values.source) result = await bpcUpdateStatus();
    else if (command === 'inspect' && positionals.length === 1) result = await previewBpcUpdate(values.source);
    else if (command === 'apply' && positionals.length === 1) result = await applyBpcUpdate(values.source, options);
    else if (command === 'rollback' && positionals.length === 2 && !values.source) result = await rollbackBpcUpdate(positionals[1], options);
    else throw new Error('Use status, inspect --source, apply --source or rollback <update-id>; see --help');
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.log(JSON.stringify({ status: 'error', error: error.message, ...(error.receipt_path ? { receipt_path: error.receipt_path } : {}) }, null, 2));
  process.exitCode = 1;
}
