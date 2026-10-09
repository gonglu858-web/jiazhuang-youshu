'use strict';
// Offline review only. stdout only; no historical evidence writes or real CLI/cloud calls.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../..');
const source = path.join(root, 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs');
const o = require(source);
const w = require(path.join(root, 'miniapp/scripts/lib/cloudbase-sdk-readonly-worker.cjs'));
const results = [];
const add = (id, observed) => results.push({ id, observed });
function child() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
  c.stdin.write = () => true; c.stdin.end = () => {}; c.kills = 0;
  c.kill = () => { c.kills++; return false; }; return c;
}
const snap = { secretId: 'SYNTHETIC_ID', secretKey: 'SYNTHETIC_KEY', sessionToken: 'SYNTHETIC_TOKEN', expiresAtMs: Date.now()+600000 };
async function main() {
  const sdk = require(path.join(w.SDK_ROOT, '@cloudbase/node-sdk'));
  let constructorError = null;
  try { new sdk(w.buildSdkConfig(snap, {})); } catch(e) { constructorError = e.name; }
  add('R1-sdk-export', { exportType: typeof sdk, initType: typeof sdk.init, constructorError, regionSupplied: Object.hasOwn(w.buildSdkConfig(snap, {}), 'region') });
  const calls = [];
  const association = await o.runCliAssociation(snap, 'C:/offline-only', { spawn: (bin,args) => {
    calls.push({ bin, firstArg: args[0] }); const c = child();
    setImmediate(() => { c.emit('exit',1,null); c.emit('close',1,null); }); return c;
  }, baseEnv: {} });
  add('R1-cli-bin-and-stop', { calls, matched: association.matched });

  const timers = [];
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source,'utf8'), {
    module: mod, exports: mod.exports, require: createRequire(source), process, Buffer,
    setTimeout: (fn,ms) => { const t={fn,ms}; timers.push(t); return t; }, clearTimeout: ()=>{}
  }, {filename:source});
  const timedChild = child(); let settled = false;
  const promise = mod.exports.runWorker(snap,null,{spawn:()=>timedChild}).then(x=>{settled=true;return x;});
  timers[0].fn(); await Promise.resolve(); await Promise.resolve();
  add('R2-timeout-no-close', { configuredMs:timers[0].ms, settledAfterTimer:settled, kills:timedChild.kills });
  timedChild.emit('close',1,null); await promise;

  const combinedChild = child();
  const combined = o.runWorker(snap,null,{spawn:()=>combinedChild});
  combinedChild.stdout.emit('data',Buffer.from(' '.repeat(700000)+JSON.stringify({ok:true,writeAttemptsCount:0})));
  combinedChild.stderr.emit('data',Buffer.alloc(700000,120));
  combinedChild.emit('exit',1,null); combinedChild.emit('close',1,null);
  add('R2-combined-and-nonzero', { combinedBytesOverLimit:true, exitCodeSent:1, result:await combined, kills:combinedChild.kills });
  add('R2-timeout-valid-json', o.interpretWorkerOutput({stdout:Buffer.from('{"ok":true,"writeAttemptsCount":0}'),overflow:false,killRequested:true,exitObserved:true,closeObserved:true}));

  add('R3-missing-primary-fields',o.interpretPrimary({primary:{classification:'OBSERVED',docId:'primary',userId:null,status:null,userIdShapeValid:null,statusValid:null}},'u_'+'a'.repeat(40)));
  add('R3-missing-user-fields',o.interpretTargetUser({targetUser:{classification:'OBSERVED',status:null,statusValid:null,derivationMatches:null}},'u_'+'a'.repeat(40)));
  add('R3-platform-error-with-empty-data',w.normalizeReadResult({code:'SYNTHETIC_DENIED',data:[]},'primary'));
  const marker='SYNTHETIC_PRIVATE_MARKER';
  add('R3-invalid-field-output', { leaked:o.interpretPrimary({primary:{classification:'OBSERVED',docId:'primary',userId:marker,status:'active',userIdShapeValid:false,statusValid:true}},null).userId===marker });
  const isolated=o.buildIsolatedEnv({xdg_config_home:'C:/outside',UserProfile:'C:/outside',HTTP_PROXY:'http://outside'},snap,'C:/isolate');
  add('R4-inherited-overrides',{lowercaseXdgRetained:Object.hasOwn(isolated,'xdg_config_home'),mixedCaseProfileRetained:Object.hasOwn(isolated,'UserProfile'),proxyRetained:Object.hasOwn(isolated,'HTTP_PROXY')});
  const db={collection:()=>({doc:()=>({set:()=> 'write-reachable',field:()=>({get:async()=>({data:[]}),set:()=> 'write-reachable'})})})};
  const handles=w.installWriteTraps(db,[w.ADMIN_COLLECTION,w.USER_COLLECTION]);
  add('R5-field-trap-bypass',{fieldSetReturns:handles.primary.doc('primary').field(w.PRIMARY_PROJECTION).set()});
  process.stdout.write(JSON.stringify({scope:'local synthetic only',realCliExecuted:false,realCredentialFetched:false,realCloudCalls:0,results},null,2)+'\n');
}
main().catch(()=>{process.stdout.write('{"harnessError":true}\n');process.exitCode=1;});
