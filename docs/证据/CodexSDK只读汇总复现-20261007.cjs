'use strict';
// All process responses and credentials are synthetic. No CLI, SDK network or auth cache access.
const o=require('../../miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs');
const {EventEmitter}=require('node:events');
const os=require('node:os'); const path=require('node:path'); const crypto=require('node:crypto');
const account='123456789012'; const calls=[];
const responses={
 GetCallerIdentity:{Type:'CAMRole',AccountId:account,UserId:'test-user',PrincipalId:'test-principal',Arn:'synthetic-arn',RequestId:'synthetic-sts'},
 DescribeEnvs:{EnvList:[{EnvId:o.FIXED.envId,Region:o.FIXED.region,Status:'NORMAL'}],RequestId:'synthetic-envs'},
 DescribeEnvInfo:{EnvInfo:{EnvBaseInfo:{EnvId:o.FIXED.envId,Region:o.FIXED.region,Status:'NORMAL'},UserInfo:{Uin:account,WxAppId:o.FIXED.wxAppId}},RequestId:'synthetic-info'}
};
const spawn=(bin,args)=>{
 const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();c.stdin.write=()=>true;c.stdin.end=()=>{};c.kill=()=>true;
 const api=args[0]==='api';calls.push(api?args[2]:'worker');
 setImmediate(()=>{c.stdout.emit('data',Buffer.from(JSON.stringify(api?responses[args[2]]:{ok:false,errorCode:'SDK_UNAVAILABLE',writeAttemptsCount:0})));c.emit('exit',0,null);c.emit('close',0,null);});return c;
};
o.runReadOnlyObservation({targetUserId:'u_'+'a'.repeat(40)},{spawn,baseEnv:{},fixed:{isolationRoot:path.join(os.tmpdir(),'codex-sdk-review-'+crypto.randomUUID())},fetchCredential:async()=>JSON.stringify({secretId:'SYNTHETIC_ID',secretKey:'SYNTHETIC_KEY',token:'SYNTHETIC_TOKEN',isTemporary:true,expiredAt:new Date(Date.now()+600000).toISOString()})})
.then(r=>process.stdout.write(JSON.stringify({realCloudCalls:0,allApiAndWorkerProcessesSynthetic:true,case:'worker ok:false SDK_UNAVAILABLE',calls,result:{status:r.status,sameBatchCredential:r.sameBatchCredential,primaryObservation:r.primaryObservation,targetUserObservation:r.targetUserObservation,incomplete:r.incomplete,writeAuthorized:r.writeAuthorized}},null,2)+'\n'))
.catch(()=>{process.stdout.write('{"harnessError":true}\n');process.exitCode=1;});
