// 本地测试/证据辅助模块；不进入产品制品，不作为任意恶意代码的安全沙箱。
'use strict';
const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
// preload先加载本模块再拦公共API；此引用仅在下方固定Node/脚本runner内使用。
const privateSpawn = require('node:child_process').spawn;
const EXPECTED_PROBES = 2;
const RECEIPT_KEYS = ['exitCode', 'pid', 'unexpected'];
function validateChildResult(r) {
  const failures = [];
  if (!r || typeof r !== 'object') return { failures: ['缺少运行结果'], childUnexpected: 0 };
  if (r.spawnError) failures.push('spawn 错误：' + r.spawnError);
  if (r.timedOut) failures.push('子进程超时被杀');
  if (r.outBounded || r.errBounded) failures.push('输出超过上限被截断');
  if (!Number.isInteger(r.code) || r.code < 0 || r.code > 255 || r.signal) failures.push('无正常退出状态');
  const receipt = r.receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    failures.push('回执缺失或畸形');
  } else {
    if (Object.keys(receipt).sort().join(',') !== RECEIPT_KEYS.join(',')) failures.push('回执字段集不符');
    if (!Number.isSafeInteger(receipt.pid) || receipt.pid <= 0 || !Number.isSafeInteger(r.childPid) || receipt.pid !== r.childPid) failures.push('回执 pid 与实际子进程不符');
    if (!Array.isArray(receipt.unexpected) || !receipt.unexpected.every(x => typeof x === 'string' && x.length > 0 && x.length <= 120)) failures.push('回执 unexpected 格式错误');
    if (Array.isArray(receipt.unexpected) && receipt.unexpected.length) failures.push('子意外 ' + receipt.unexpected.length + ' 项');
    if (!(receipt.exitCode === null || (Number.isInteger(receipt.exitCode) && receipt.exitCode >= 0 && receipt.exitCode <= 255))) failures.push('回执 exitCode 格式错误');
    else if ((receipt.exitCode === null ? 0 : receipt.exitCode) !== r.code) failures.push('回执 exitCode 与实际退出状态不一致');
  }
  return { failures, childUnexpected: receipt && Array.isArray(receipt.unexpected) ? receipt.unexpected.length : 0 };
}
function verdictFor({ probes, parentUnexpected, childUnexpectedTotal, receiptFailures, expectedProbes = EXPECTED_PROBES }) {
  const ok = probes === expectedProbes && parentUnexpected === 0 && childUnexpectedTotal === 0 && receiptFailures === 0;
  return { ok, exitCode: ok ? 0 : 1 };
}
function buildGuardPreloadSource() {
  return [
    "'use strict';",
    'require(' + JSON.stringify(__filename) + ');',
    "const guardKey = Symbol.for('pic.offline.guard.preload.v2');",
    "if (!globalThis[guardKey]) {",
    "globalThis[guardKey] = true;",
    "const fs = require('node:fs'), hits = [];",
    "const blocked = name => { hits.push(name); throw new Error('CLI_OFFLINE_GUARD:' + name); };",
    "for (const m of ['http','https']) for(const k of ['get','request']) require(m)[k] = blocked.bind(null,m+'.'+k);",
    "require('node:tls').connect = blocked.bind(null,'tls.connect');",
    "if(typeof globalThis.fetch === 'function') globalThis.fetch = blocked.bind(null,'fetch');",
    "for(const obj of [require('node:dns'),require('node:dns').promises]) for(const k of ['lookup','resolve','resolve4','resolve6']) obj[k] = blocked.bind(null,'dns.'+k);",
    "const net = require('node:net'); for(const k of ['connect','createConnection']) net[k]=blocked.bind(null,'net.'+k);",
    "net.Socket.prototype.connect = blocked.bind(null,'socket.connect');",
    "for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) require('node:child_process')[k] = blocked.bind(null,'cp.'+k);",
    "process.on('exit', () => { try { fs.writeFileSync(process.env.PIC_CLI_GUARD_RECEIPT, JSON.stringify({pid:process.pid,unexpected:hits,exitCode:process.exitCode === undefined ? null : Number(process.exitCode)}), {flag:'wx'}); } catch (_) {} });",
    "}"
  ].join('\n');
}
function installParentGuards(opts) {
  if (!opts || !Array.isArray(opts.hits) || typeof opts.getPhase !== 'function' || !Array.isArray(opts.allowedScripts)) throw Error('缺少守卫配置');
  const allowed = new Set(opts.allowedScripts.map(p => path.resolve(p)));
  const restores = [], runs = [];
  const patch = (obj, k, api) => { const old=obj[k]; obj[k]=()=>{opts.hits.push({phase:opts.getPhase(),api});throw Error('OFFLINE_GUARD:'+api);}; restores.push(()=>{obj[k]=old;}); };
  for(const m of ['http','https'])for(const k of ['get','request'])patch(require(m),k,m+'.'+k);
  patch(require('tls'),'connect','tls.connect');
  if(typeof globalThis.fetch==='function')patch(globalThis,'fetch','fetch');
  for(const [obj,label] of [[require('dns'),'dns'],[require('dns').promises,'dns.promises']])for(const k of ['lookup','resolve','resolve4','resolve6'])patch(obj,k,label+'.'+k);
  for(const k of ['connect','createConnection'])patch(require('net'),k,'net.'+k);
  patch(require('net').Socket.prototype,'connect','socket.connect');
  for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])patch(require('child_process'),k,'cp.'+k);
  const artifactDir=path.resolve(__dirname,'../../../artifacts/schedule-sandbox/business-test');
  let bootstrapPath=null;
  function newReceiptPath(tag='x') {
    fs.mkdirSync(artifactDir,{recursive:true});
    return path.join(artifactDir,'cli-receipt-'+String(tag).replace(/[^a-zA-Z0-9_-]/g,'_')+'-'+crypto.randomBytes(8).toString('hex')+'.json');
  }
  function runCli({scriptPath,args,guardPreload,receiptPath,timeoutMs=60000,outputLimit=256*1024,group='normal',extraEnv={}}) {
    function finish(result) {
      result.validation=validateChildResult(result);
      runs.push({group,result}); return result;
    }
    const failure=reason=>Promise.resolve(finish({code:-1,out:'',err:'',outBytes:0,errBytes:0,outBounded:false,errBounded:false,timedOut:false,spawnError:reason,receipt:null,childPid:null,receiptPath}));
    if(typeof scriptPath!=='string'||!allowed.has(path.resolve(scriptPath)))return failure('脚本不在受控白名单');
    if(!Array.isArray(args)||!args.every(a=>typeof a==='string'))return failure('非法参数数组');
    if(!['normal','sensitivity'].includes(group))return failure('未知记账分组');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isSafeInteger(outputLimit)||outputLimit<1||outputLimit>256*1024)return failure('非法时限或输出上限');
    if(typeof guardPreload!=='string'||!path.isAbsolute(guardPreload)||!fs.existsSync(guardPreload))return failure('缺少守卫 preload');
    if(typeof receiptPath!=='string'||!path.isAbsolute(receiptPath)||fs.existsSync(receiptPath))return failure('回执路径必须是不存在的新绝对路径');
    if(Object.keys(extraEnv).some(k=>k!=='PIC_PREP_EVIDENCE_FAULT')||Object.values(extraEnv).some(v=>typeof v!=='string'))return failure('不允许的子进程环境覆盖');
    // 强制首个preload为本模块生成的完整守卫；测试附加preload不能省略基础守卫。
    if(!bootstrapPath){bootstrapPath=newReceiptPath('bootstrap')+'.cjs';fs.writeFileSync(bootstrapPath,buildGuardPreloadSource(),{flag:'wx'});}
    const env={...process.env,...extraEnv,PIC_CLI_GUARD_RECEIPT:receiptPath};
    delete env.NODE_OPTIONS; // 不继承未经本次runner审核的额外preload或Node参数。
    return new Promise(resolve=>{
      let child,timer,settled=false,out=[],err=[],outBytes=0,errBytes=0,outBounded=false,errBounded=false,timedOut=false,spawnError=null;
      const capture=(which,data)=>{
        const b=Buffer.isBuffer(data)?data:Buffer.from(data); const used=which==='out'?outBytes:errBytes;
        const take=Math.min(Math.max(outputLimit-used,0),b.length);
        if(take)(which==='out'?out:err).push(b.subarray(0,take));
        if(which==='out'){outBytes+=take;outBounded ||= take<b.length;}else{errBytes+=take;errBounded ||= take<b.length;}
      };
      const complete=(code,signal)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        let receipt=null,receiptError=null;
        try {const stat=fs.lstatSync(receiptPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw Error('回执文件类型或大小不符');receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));}catch(e){receiptError=e.message;}
        resolve(finish({code,signal:signal||null,out:new StringDecoder('utf8').write(Buffer.concat(out)),err:new StringDecoder('utf8').write(Buffer.concat(err)),outBytes,errBytes,outBounded,errBounded,timedOut,spawnError,receipt,receiptError,childPid:child&&child.pid,receiptPath}));
      };
      try {child=privateSpawn(process.execPath,['--require',bootstrapPath,'--require',guardPreload,scriptPath,...args],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});}
      catch(e){spawnError=String(e.message);complete(-1,null);return;}
      child.stdout.on('data',d=>capture('out',d));child.stderr.on('data',d=>capture('err',d));
      child.once('error',e=>{spawnError=String(e.message);});
      child.once('close',(code,signal)=>complete(code,signal));
      timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
    });
  }
  return Object.freeze({runCli,newReceiptPath,
    summary(group='normal'){const chosen=runs.filter(r=>r.group===group);return{runs:chosen.length,childUnexpectedTotal:chosen.reduce((n,r)=>n+r.result.validation.childUnexpected,0),receiptFailures:chosen.reduce((n,r)=>n+r.result.validation.failures.length,0)};},
    restoreAll(){restores.reverse().forEach(f=>f());}
  });
}
module.exports=Object.freeze({EXPECTED_PROBES,installParentGuards,buildGuardPreloadSource,validateChildResult,verdictFor});
