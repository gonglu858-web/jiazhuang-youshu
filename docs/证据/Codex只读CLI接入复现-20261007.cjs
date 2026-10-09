'use strict';
// 离线审查：真实被审模块，合成文件和进程事件；不执行 CLI、不访问登录态。
// 只写 stdout，调用者另存新证据，脚本自身不覆盖任何历史文件。
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');
const o = require('../../miniapp/scripts/lib/cloudbase-readonly-observer.cjs');
const findings = [];
function child() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kills = 0;
  c.kill = () => { c.kills++; return false; };
  return c;
}
function ready(entry, apiText) {
  let apiCalls = 0;
  const bundle = 'synthetic-bundle';
  return {
    count: () => apiCalls,
    deps: {
      fixed: { nodeBin:'/fake/node', cliEntry:'/fake/bin/tcb', cliBundle:'/fake/bundle',
        cliBundleSha256:crypto.createHash('sha256').update(bundle).digest('hex'), authSessionDir:'/fake/auth' },
      fs: {
        existsSync: () => true, statSync: () => ({isFile:()=>true}),
        readFileSync: (p) => p==='/fake/bin/tcb' ? entry : p==='/fake/bundle' ? bundle : JSON.stringify({version:'3.8.4'})
      }, path, crypto, baseEnv:{},
      spawn: (bin,args) => {
        const c=child();
        if(args[0]!=='-e') apiCalls++;
        setImmediate(()=>{
          c.stdout.emit('data',Buffer.from(args[0]==='-e'?'/fake/auth':apiText));
          c.emit('close',0,null);
        });
        return c;
      }
    }
  };
}
(async()=>{
  const altered="require('../dist/standalone/cli.js');\nthrow new Error('synthetic added code');";
  const d=ready(altered,'{}');
  const r=await o.checkLocalReadiness(d.deps);
  findings.push({id:'R1-entry-extra-code',unexpectedAccepted:r.ok,entryCheck:r.checks.find(c=>c.name==='cli-entry-content'),
    note:'合成入口多出可执行语句仍通过；未实际执行篡改入口。'});
  const commented=ready("// require('../dist/standalone/cli.js')\nprocess.stdout.write('synthetic');",'{}');
  const r2=await o.checkLocalReadiness(commented.deps);
  findings.push({id:'R1-entry-comment-only',unexpectedAccepted:r2.ok});

  let c=child();
  const p=o.spawnBounded('fake',[],{}, {spawn:()=>c,__limits:{timeoutMs:100,maxOutputBytes:100}});
  c.stdout.emit('data',Buffer.alloc(60,120)); c.stderr.emit('data',Buffer.alloc(60,121)); c.emit('close',0,null);
  const combined=await p;
  findings.push({id:'R2-combined-output',totalBytes:Buffer.byteLength(combined.stdout)+Buffer.byteLength(combined.stderr),
    configuredLimit:100,overflow:combined.overflow,kills:c.kills});

  c=child();
  const p2=o.spawnBounded('fake',[],{}, {spawn:()=>c,__limits:{timeoutMs:100,maxOutputBytes:100}});
  c.stdout.emit('data',Buffer.alloc(101,120));
  const exceeded=await p2;
  const killsBefore=c.kills;
  c.stdout.emit('data',Buffer.alloc(101,120));
  findings.push({id:'R2-after-finish-data',retainedBytes:Buffer.byteLength(exceeded.stdout),configuredLimit:100,
    killsBefore,killsAfter:c.kills,dataListenerCount:c.stdout.listenerCount('data'),
    note:'已settle后仍处理data并再次kill；kill=false未记录为终止未确认。'});

  c=child();
  const timeout=o.spawnBounded('fake',[],{}, {spawn:()=>c,__limits:{timeoutMs:5,maxOutputBytes:100}});
  const timed=await timeout;
  c.stdout.emit('data',Buffer.alloc(101,120));
  findings.push({id:'R2-timeout-unconfirmed',timedOut:timed.timedOut,reportedSignal:timed.signal,
    closeEmitted:false,killReturned:false,killsAfterLateData:c.kills});

  const broken='{\n"Type":\nℹ → STS.GetCallerIdentity\n"CAMRole"\n}';
  let originalValid=true; try{JSON.parse(broken);}catch{originalValid=false;}
  let accepted=false; try{accepted=o.parseCliJson(broken,'sts','GetCallerIdentity').Type==='CAMRole';}catch{}
  findings.push({id:'R3-hint-inside-json',originalValid,unexpectedAccepted:accepted});

  const bad=ready("require('../dist/standalone/cli.js')",'{broken');
  const badReport=await o.runReadOnlyObservation(bad.deps);
  findings.push({id:'R4-first-query-parse-failure',apiProcessesStarted:bad.count(),cloudObservationPerformed:badReport.cloudObservationPerformed,
    stoppedAt:badReport.stoppedAt,errorCode:badReport.errorCode});
  let invalidCode;
  try{o.assertDescribeEnvs({EnvList:null},'describeEnvs');}catch(e){invalidCode=e.code;}
  findings.push({id:'R4-missing-enum-code',hasDefinedCode:typeof invalidCode==='string',
    existingTestComparesToUndefined:o.ERR.ENVS_FIELD_INVALID===undefined});
  process.stdout.write(JSON.stringify({schema:1,observedAt:new Date().toISOString(),realNetworkCalls:0,
    sourceSha256:crypto.createHash('sha256').update(require('node:fs').readFileSync(require.resolve('../../miniapp/scripts/lib/cloudbase-readonly-observer.cjs'))).digest('hex'),findings},null,2)+'\n');
})().catch(()=>{process.stderr.write('OFFLINE_REPRODUCTION_FAILED\n');process.exitCode=1;});
