'use strict';
// Fixed local read-only module diagnosis. No policy, environment or ACL mutation.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const cp = require('node:child_process'), rawSync = cp.spawnSync;
const repo = path.resolve(__dirname, '../..');
const observed = { probes: 0, unexpected: 0, processes: [] }; let probing = false;
function deny() { observed[probing ? 'probes' : 'unexpected']++; throw Error('CAPABILITY_BLOCKED'); }
for (const key of Object.keys(cp)) if (typeof cp[key] === 'function') cp[key] = deny;
for (const m of [require('node:http'), require('node:https'), require('node:tls'), require('node:dns'), require('node:dns').promises]) {
  for (const key of Object.keys(m)) if (typeof m[key] === 'function') Object.defineProperty(m, key, { value: deny });
}
const net = require('node:net'); net.connect = net.createConnection = net.createServer = net.Socket.prototype.connect = deny; global.fetch = deny;
const command = String.raw`
$ErrorActionPreference='Stop'
$r=[ordered]@{powershellVersion=$PSVersionTable.PSVersion.ToString();languageMode=$ExecutionContext.SessionState.LanguageMode.ToString()}
try {
 $r.modules=@(Get-Module -ListAvailable Microsoft.PowerShell.Security | ForEach-Object { [pscustomobject]@{version=$_.Version.ToString();minimumPowerShell=[string]$_.PowerShellVersion;underPSHome=$_.Path.StartsWith($PSHOME,[StringComparison]::OrdinalIgnoreCase)} })
 $r.modulePathFacts=[pscustomobject]@{hasPSHome=(@($env:PSModulePath -split ';' | Where-Object { $_ -eq ($PSHOME+'\Modules') }).Count -gt 0); hasPowerShell7=($env:PSModulePath -match '\\PowerShell\\7\\')}
 Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
 $r.moduleImported=$true
 $r.effectivePolicy=[string](Get-ExecutionPolicy)
} catch {
 $r.moduleImported=$false
 $r.errorId=[string]$_.FullyQualifiedErrorId
 $r.category=[string]$_.CategoryInfo.Category
 $r.exceptionType=$_.Exception.GetType().FullName
 $r.baseExceptionType=$_.Exception.GetBaseException().GetType().FullName
 $message=$_.ToString()+' '+$_.Exception.ToString()
 $r.failureMarkers=[pscustomobject]@{requiresVersion=($message -match 'requires.*version|需要.*版本|版本.*高于');policy=($message -match 'PSSecurityException|execution policy|执行策略|禁止运行脚本|running scripts is disabled');assembly=($message -match 'assembly|程序集');formatData=($message -match 'format.*data|格式.*数据|FormatXml');accessDenied=($message -match 'Access.*denied|拒绝访问');missingFile=($message -match 'FileNotFound|找不到.*文件');manifest=($message -match 'manifest|清单')}
}
$r | ConvertTo-Json -Compress -Depth 5
`;
const result = { schema:'codex-module-diagnosis/1', basis:'d56eff4', recordedAt:new Date().toISOString(), observed, aclModified:false, policyModified:false, environmentModified:false, privateRecordsRead:0, cloudOperations:0, temporaryFiles:[] };
let out;
try {
 const args=process.argv.slice(2);
 if(args.length && !(args.length===2 && args[0]==='--out' && args[1])) throw Error('ARGUMENT_INVALID');
 if(args.length) { out=path.resolve(args[1]); if(path.dirname(out)!==__dirname || path.basename(out)!=='Codex模块加载诊断-20261024.json' || fs.existsSync(out)) throw Error('OUTPUT_INVALID'); }
 probing=true; try{cp.execSync('synthetic-denied');}catch(_){} try{require('node:https').request('https://synthetic.invalid');}catch(_){} probing=false;
 const env={...process.env}; delete env.NODE_OPTIONS;
 const r=rawSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{cwd:repo,shell:false,windowsHide:true,env,timeout:10000,maxBuffer:131072,encoding:null});
 observed.processes.push({kind:'security-module-readonly-diagnosis',pid:r.pid||null,status:r.status,signal:r.signal||null,launchError:Boolean(r.error),stdoutBytes:r.stdout?.length||0,stderrBytes:r.stderr?.length||0});
 if(r.error||r.signal||r.status!==0||r.stderr.length) throw Error('QUERY_FAILED');
 const m=JSON.parse(r.stdout.toString('utf8').replace(/^\uFEFF/,''));
 const identifier=s=>typeof s==='string' && /^[A-Za-z0-9_.,-]{1,200}$/.test(s)?s:null;
 result.query={powershellVersion:identifier(m.powershellVersion),languageMode:identifier(m.languageMode),modules:m.modules.map(v=>({version:identifier(v.version),minimumPowerShell:identifier(v.minimumPowerShell),underPSHome:v.underPSHome===true})),modulePathFacts:{hasPSHome:m.modulePathFacts.hasPSHome===true,hasPowerShell7:m.modulePathFacts.hasPowerShell7===true},moduleImported:m.moduleImported===true};
 if(m.moduleImported) result.query.effectivePolicy=identifier(m.effectivePolicy);
 else { for(const k of ['errorId','category','exceptionType','baseExceptionType'])result.query[k]=identifier(m[k]); result.query.failureMarkers={};for(const k of ['requiresVersion','policy','assembly','formatData','accessDenied','missingFile','manifest'])result.query.failureMarkers[k]=m.failureMarkers?.[k]===true; }
 result.ok=observed.probes===2 && observed.unexpected===0;
}catch(e){result.ok=false;result.failureCode=/^[A-Z_]+$/.test(e.message)?e.message:'DIAGNOSTIC_FAILED';}
result.preflightPassed=false;result.scriptSha256=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');result.exitCode=result.ok?0:1;
const output=JSON.stringify(result,null,2)+'\n';if(out&&!result.failureCode)fs.writeFileSync(out,output,{flag:'wx'});process.stdout.write(output);process.exitCode=result.exitCode;
