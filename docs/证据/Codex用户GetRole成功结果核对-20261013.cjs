'use strict';
// 仅重验用户回传材料的净化投影与既有基线；不执行CLI、不联网，不冒充重新获取平台响应。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const base='Codex管理员稳定身份只读基线-20261013.json';
const bytes=fs.readFileSync(path.join(__dirname,base));
assert.equal(sha(bytes),'8ac5c2a9bf60004f65933b48d3a8881a789f4dd30775e4d538c7730c305e3579');
const b=JSON.parse(bytes);
// 以下摘要由本轮会话所贴完整RoleId与RoleArn中的UIN本地计算；原标识不纳入证据文件。
const supplied={roleIdSha256:'95f28ff80d93e08863ba897bfe303a39ef7a5c150204fce069d0b96aaa3af0da',
  ownerUinSha256:'065d5f01761a7e7af6fab1413a369395661b692393e04f091092e517a99ea7c0',
  roleName:'TCB_QcsRole',roleType:'system',roleIdTail:'2941',ownerTail:'7053',
  roleArnShape:'qcs::cam::uin/<ownerUin>:roleName/TCB_QcsRole',
  requestId:'2511d0fd-f9af-4fae-a3bc-fa27d12cb621',addTime:'2026-09-23 16:51:43',updateTime:'2026-09-23 16:51:43',
  consoleLogin:0,sessionDuration:7200,
  trustPolicy:{version:'2.0',statement:[{action:'sts:AssumeRole',effect:'allow',principal:{service:['scf.qcloud.com','tcb.cloud.tencent.com','cvm.qcloud.com']}}]}};
assert.equal(supplied.roleIdSha256,b.first.fields.RoleId.sha256);
assert.equal(supplied.ownerUinSha256,b.first.fields.AccountId.sha256);
assert.match(supplied.requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const result={schema:'user-get-role-corroboration/1',recordedAt:new Date().toISOString(),
  source:'USER_PASTED_API_EXPLORER_RESPONSE',sourceCommit:'5eaabf4',
  scriptSha256:sha(fs.readFileSync(__filename)),baselineFile:base,baselineSha256:sha(bytes),supplied,
  checks:{fullRoleIdDigestMatches:true,fullOwnerUinDigestMatches:true,cloudBaseServiceInTrustPolicy:true},
  status:'ROLE_ENTITY_IDENTIFIED_PRINCIPAL_SOURCE_PENDING',roleTrustApproved:false,principalSourceConfirmed:false,writeAuthorized:false,
  assistantAuthenticatedApiCalls:0,workerStarted:false,databaseAttempted:false,
  officialRoleReference:'https://cloud.tencent.com/document/product/876/47056',
  limitations:['用户人工运行平台API并粘贴返回，助手未独立重新请求或验证回包签名',
    'PolicyDocument为角色信任策略，不等于角色关联权限策略或临时会话有效权限',
    '服务域名不能直接映射为PrincipalId尾5386；申请主体映射与轮换机制仍未确认',
    'GetRole成功RequestId与旧CLI失败请求不同；未解释控制台列表可见性原因',
    'SessionDuration为本次角色详情字段，不据此推断此前凭据有效期',
    'CAM RoleArn与STS assumed-role Arn结构不同，核对RoleId和所属账号，不要求两ARN字面相等']};
const args=process.argv.slice(2);
assert(args.length===0||(args.length===2&&args[0]==='--out'));
if(args.length)fs.writeFileSync(path.resolve(args[1]),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,checks:result.checks,writeAuthorized:false}));
