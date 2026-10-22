'use strict';
// v3：公共进程/网络接口始终拒绝、始终记账。仅允许固定本地Node证据/测试子进程。
// 产品本地能力在 participant-local-tools.cjs；不通过公共 API 白名单转发。
const path = require('node:path');
const fs = require('node:fs');
const shared = require('./pic-guard-runner.cjs');
const ROOT = path.resolve(__dirname, '../../..');
const TEST = path.join(ROOT, 'miniapp/tests/participant-self-registration.test.cjs');
const EVIDENCE = path.join(ROOT, 'docs/证据/CodeBuddy指定本人登记与私密输入本地实现v3-20261022.cjs');
const FAULTS = ['earlyRequire','publicGit','publicSpawn','publicExec','afterRestore'];
function installParentGuardsWithLocalTools(opts) {
  const guard = shared.installParentGuards({...opts, allowedScripts:[TEST,EVIDENCE]});
  function runVerified({scriptPath, args, guardPreload, receiptPath, group='normal'}) {
    const file = path.resolve(scriptPath);
    const good = (file === TEST && Array.isArray(args) && args.length === 0) ||
      (file === EVIDENCE && Array.isArray(args) && args.length === 2 && args[0] === '--worker' &&
        ['normal',...FAULTS].includes(args[1]));
    if (!good) throw new Error('固定子进程参数不符');
    const base=path.join(ROOT,'artifacts/schedule-sandbox/business-test');
    for(const file of [guardPreload,receiptPath]){
      if(typeof file!=='string'||path.dirname(path.resolve(file))!==base)throw new Error('运行文件边界不符');
    }
    const st=fs.lstatSync(guardPreload);
    if(!st.isFile()||st.isSymbolicLink()||fs.readFileSync(guardPreload,'utf8')!=="'use strict';\n")throw new Error('附加preload字节不符');
    return guard.runCli({scriptPath:file,args,guardPreload,receiptPath,group,
      timeoutMs:60000,outputLimit:256*1024});
  }
  return Object.freeze({guard:Object.freeze({runCli:runVerified,newReceiptPath:guard.newReceiptPath,
    summary:guard.summary}), toolCalls:[],
    restore(){ /* 禁止还原公共原始接口；守卫保持安装。 */ }});
}
module.exports=Object.freeze({installParentGuardsWithLocalTools,FAULTS});
