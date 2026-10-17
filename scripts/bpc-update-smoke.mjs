import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { previewBpcUpdate, applyBpcUpdate, rollbackBpcUpdate } from '../src/bpc-update.mjs';
import { bpcPaths, inspectBpcAssets, verifyBpcAssets, pinBpcAssets, copyBpcDirectory, writeBpcJson, sameBpcAssets } from '../src/bpc-assets.mjs';

// Original inert extension fixtures. Browser compatibility is separately gated
// by the real publisher smoke for each actual candidate, never by this stub.
const out = resolve('output/bpc-update-smoke-' + Date.now()), checks = [];
const check = (name, pass) => { assert(pass, name); checks.push(name); console.log('PASS:', name); };
async function extension(path, version, content = version) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Bypass Paywalls Clean', version, key: 'original-test-key', background: { service_worker: 'background.js' }, permissions:['storage'] }));
  await writeFile(join(path, 'LICENSE'), 'MIT License\nOriginal inert fixture. License marker: magnolia1234\n');
  await writeFile(join(path, 'background.js'), '// Original inert fixture: ' + content);
}
async function installation(name) {
  const root = join(out, name), paths = bpcPaths(root);
  await extension(paths.extension, '1.0.0');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(paths.record, JSON.stringify({ ...await inspectBpcAssets(paths.extension), source: 'https://example.invalid/original-fixture' }));
  return root;
}
let probes = 0;
const probe = async (candidate,{expected}) => { probes++; return {status:'passed',bpc:await inspectBpcAssets(candidate),original_inert_fixture:true}; };
const root = await installation('main'), paths = bpcPaths(root), source = join(out,'source');
await extension(source,'1.0.1');await extension(join(source,'nested-copy'),'1.0.0');
const originalRecord=await readFile(paths.record,'utf8'), original=await verifyBpcAssets(root), oldPin=await pinBpcAssets(root);
const preview=await previewBpcUpdate(source,{root});
check('Preview excludes complete nested bundles and leaves live assets unchanged',preview.candidate.files===3&&preview.ignored.length===1&&(await verifyBpcAssets(root)).sha256===original.sha256&&await readFile(paths.record,'utf8')===originalRecord);
await assert.rejects(applyBpcUpdate(source,{root,probe:async()=>{throw Error('Original rejected candidate');}}));
check('Rejected validation cannot activate staged bytes',sameBpcAssets(await verifyBpcAssets(root),original)&&await readFile(paths.record,'utf8')===originalRecord);
const sourceBefore=await readFile(join(source,'background.js'),'utf8');
const applied=await applyBpcUpdate(source,{root,probe}), newer=await pinBpcAssets(root);
check('Validated bundle and record switch together with a verified backup',applied.status==='applied'&&newer.version==='1.0.1'&&sameBpcAssets(await inspectBpcAssets(join(paths.updates,applied.id,'backup/extension')),original));
check('Running pin remains old while later pin is a different immutable path',oldPin.runtime_path!==newer.runtime_path&&(await inspectBpcAssets(oldPin.runtime_path)).version==='1.0.0'&&(await inspectBpcAssets(newer.runtime_path)).version==='1.0.1');
check('Import does not modify the user source or install its nested copy',await readFile(join(source,'background.js'),'utf8')===sourceBefore&&(await inspectBpcAssets(paths.extension)).files===3);
const calls=probes;
check('Same bytes are a no-op without another probe', (await applyBpcUpdate(source,{root,probe})).status==='up_to_date'&&probes===calls);
await extension(source,'1.0.2');const second=await applyBpcUpdate(source,{root,probe});
await assert.rejects(rollbackBpcUpdate(applied.id,{root,probe}));
check('Stale rollback cannot overwrite a newer active bundle',(await verifyBpcAssets(root)).version==='1.0.2');
await rollbackBpcUpdate(second.id,{root,probe});await rollbackBpcUpdate(applied.id,{root,probe});
check('Rollback validates, restores exact record bytes and keeps runtime pins',sameBpcAssets(await verifyBpcAssets(root),original)&&await readFile(paths.record,'utf8')===originalRecord&&(await inspectBpcAssets(newer.runtime_path)).version==='1.0.1');
await writeFile(join(oldPin.runtime_path,'background.js'),'TAMPERED_RUNTIME');await assert.rejects(pinBpcAssets(root));
check('Tampered runtime snapshot is rejected rather than silently reused',sameBpcAssets(await verifyBpcAssets(root),original));

for(const phase of ['before-move','after-move','after-record','committed','bad-backup','bad-id']) {
  const fixture=await installation('crash-'+phase), p=bpcPaths(fixture), before=await verifyBpcAssets(fixture), id='bpc-original-crash-fixture', tx=join(p.updates,id);
  await copyBpcDirectory(p.extension,join(tx,'backup/extension'));
  await writeFile(join(tx,'backup/bpc.json'),await readFile(p.record));
  const next=join(tx,'candidate');await extension(next,'1.0.1');const after=await inspectBpcAssets(next);
  await writeBpcJson(join(tx,'receipt.json'),{id,status:'validated',before,after});
  if(phase!=='before-move'&&phase!=='bad-id') {await rename(p.extension,join(tx,'retired'));await rename(next,p.extension);}
  if(['after-record','committed'].includes(phase))await writeBpcJson(p.record,after);
  if(phase==='bad-backup')await writeFile(join(tx,'backup/extension/background.js'),'TAMPERED_BACKUP');
  await writeBpcJson(p.pending,{id:phase==='bad-id'?'../../outside':id,phase:phase==='committed'?'committed':'switching'});
  if(['bad-backup','bad-id'].includes(phase)) {
    const live=await inspectBpcAssets(p.extension);await assert.rejects(verifyBpcAssets(fixture));
    check('Corrupt recovery input fails closed without touching live files: '+phase,sameBpcAssets(await inspectBpcAssets(p.extension),live));
  }else{
    const restored=await verifyBpcAssets(fixture);
    check('Interrupted pair recovery: '+phase,restored.version===(phase==='committed'?'1.0.1':'1.0.0')&&restored.recovery?.action===(phase==='committed'?'finished_commit':'restored_previous_bundle'));
  }
}
const invalid=join(out,'invalid');await extension(invalid,'1.0.1');await writeFile(join(invalid,'LICENSE'),'Not an accepted license');
await assert.rejects(previewBpcUpdate(invalid,{root}));
check('Invalid extension metadata/license cannot enter the updater',true);
const downgrade=join(out,'downgrade');await extension(downgrade,'0.9.0');await assert.rejects(applyBpcUpdate(downgrade,{root,probe}));
check('Unrecorded downgrade is not mistaken for an upgrade',(await verifyBpcAssets(root)).version==='1.0.0');
const cli=spawn(process.execPath,[resolve('scripts/update-bpc.mjs'),'rollback','../../outside'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let cliText='';cli.stdout.on('data',b=>cliText+=b);const code=await new Promise(done=>cli.once('exit',done));
check('Actual CLI rejects path traversal before filesystem mutation',code===1&&JSON.parse(cliText).error==='Invalid BPC update id');
await writeBpcJson(join(out,'verification.json'),{status:'passed',checks,actual_browser_validation:'run separately for the actual candidate'});
console.log('BPC update smoke passed:',out);
