'use strict';
// Only inspect local text. Never load the driver or launch the helper.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path'),assert=require('node:assert/strict');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=name=>fs.readFileSync(path.join(__dirname,name));
const driver=read('CodexL2成员诊断驱动v2-20261028.cjs'),bytes=read('CodexL2成员诊断运行v2-20261028.json'),result=JSON.parse(bytes);
assert.equal(hash(driver),'d24940701486bbdc2f62915e079fb92f1495f714fb08656c0c44d67061959407');
assert.equal(hash(bytes),'0f9423ecec57af58bb3bab19c989d60dc8a9d75a05bba9e6133f437337cf7c0d');
const nodeHash=hash(fs.readFileSync(process.execPath));
assert.equal(nodeHash,'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19');
assert.equal(result.ok,false);assert.equal(result.exitCode,1);assert.equal(result.failure.code,'START_FAILED');
assert.equal(result.observations.unexpected,1);assert.equal(result.observations.attempts.length,1);
assert.equal(result.receipt,null);assert.equal(result.treeCleanupConfirmed,false);
const natives=process.binding('natives'),internal=natives['internal/child_process'],outer=natives.child_process;
const spawn=internal.indexOf('const err = this._handle.spawn(options);');
const pipe=internal.indexOf('stream.socket = createSocket(this.pid !== 0 ?');
assert(spawn>=0&&pipe>spawn);
assert(internal.includes('return net.Socket({ handle: pipe, readable });'));
assert(outer.includes('child.spawn(options);'));
assert(driver.toString().includes("Object.defineProperty(m,k,{value:deny,configurable:true})"));
assert(driver.toString().includes("'node:net'"));
function anchor(s,t){const p=s.indexOf(t);assert(p>=0);return {line:s.slice(0,p).split('\n').length,text:t};}
const report={schema:'codex-l2-member-start-source-analysis/1',basisCommit:'366cf72',sourceAnalysisPassed:true,
 executionResult:{ok:false,exitCode:1,guardUnexpected:1,attempts:1,receiptAvailable:false,treeCleanupConfirmed:false},
 digests:{node:nodeHash,driver:hash(driver),executionResult:hash(bytes),internalChildProcess:hash(internal),publicChildProcess:hash(outer),script:hash(fs.readFileSync(__filename))},
 anchors:[anchor(internal,'return net.Socket({ handle: pipe, readable });'),anchor(internal,'const err = this._handle.spawn(options);'),anchor(internal,'this.pid = this._handle.pid;'),anchor(internal,'stream.socket = createSocket(this.pid !== 0 ?'),anchor(outer,'child.spawn(options);')],
 conclusion:'The guard replaces net.Socket, which Node uses for child stdio after the native spawn call. START_FAILED and null recorded pid do not prove no OS child was created.',
 limitations:['No original exception stack was retained: source-level causal analysis, not a complete dynamic trace.','No helper retry, process enumeration or cleanup operation.','spawnFailed is the runner catch classification, not evidence of zero native process creation.','Parent command completion does not confirm Job cleanup.'],
 l2Approved:false,realInputApproved:false};
const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--out');
const text=JSON.stringify(report,null,2)+'\n';if(args.length)fs.writeFileSync(path.resolve(args[1]),text,{flag:'wx'});process.stdout.write(text);
