// 核验页专用客户端：固定环境/固定函数，单一动作，失败不回退。
//
// 任务：docs/WorkBuddy任务-两位参与者本人身份只读核验包-20261015.md §5
// - 显式固定环境与函数名，不接受调用方指定目标，不做全局重定向。
// - **禁止失败后回退旧函数/旧客户端/本机保存**，也不做任何本地重试。
// - 请求体只含 action、口令、**本轮轮次**与可选的完整 ID 请求开关；
//   不接受自报 openid/appId/userId/集合/角色。
// - R5：轮次由本页配置原样带回，不接受调用方覆盖；R2：完整内部 userId 只在
//   调用方显式请求且本次核验有效时才由服务端返回。
// - 手机提交轮次（2026-10-19 任务 §2.2）：构造完成、即将交给 wx.cloud.callFunction
//   的同一个 payload，在紧邻调用前采集不可变快照（仅公共字段，经严格格式校验）；
//   返回本地封套 {response, localRequestEvidence, transportOutcome}，与云函数 result
//   严格分开；迟到响应/后续配置变动不得改写快照。
// - R1（2026-10-20）：快照有效性是发送前置条件——previewBuildId 缺失/非法、轮次
//   非法、协议非 participant-identity-request/1、函数非 scheduleSandbox 一律在
//   调用前拒绝（零发送、无 handoffAttempted=true 假事实）。
// - C1 口径（2026-10-20）：transportOutcome='returned' 仅表示 SDK Promise 兑现，
//   不保证存在有效服务端结果（result 可为 null）；页面按失败/未知处理。

const cloudConfig = require('../config/cloud');

// ── 受控键诊断净化投影（C3/R4）────────────────────────────────────────────
// 服务端默认不返回诊断；仅诊断轮且全部准入门槛通过时才附带。客户端按固定 schema
// **严格**验证：任何必需字段缺失/类型错误/越界、标签非法或重复或超量、计数与分桶
// 不一致——整份诊断丢弃（不修补成默认值）；额外未知字段仅投影丢弃。不透传原键名或值。
// 截断契约（S2 已执行校验）：truncated=true 仅在候选标签数已达上限（8）且存在未列出
// 候选时才成立；合法标签仅取固定词表且无重复，故 labels.length ≤ 词表容量。当前词表
// 容量为 2（CANDIDATE_USERINFO、CANDIDATE_WX_CLOUD_API_TOKEN）仍 < 8，当前协议下
// truncated=true 必然矛盾，客户端整份拒绝；未来扩词表须同时满足「labels 数 === 上限」
// 与「词表容量 ≥ 上限」。candidateLabels 数组长度恒 ≤ 8。投影输出恒为 6 个固定字段、
// 内容有界（源码含序列化 <1KB 防御检查；固定字段与有限词表下合法投影结构上远小于 1KB）。
const KEY_DIAGNOSTIC_SCHEMA = 'participant-identity-key-diagnostic/1';
const KEY_DIAGNOSTIC_SCOPE = 'request-keys-only';
const KEY_DIAGNOSTIC_LABELS = ['CANDIDATE_USERINFO', 'CANDIDATE_WX_CLOUD_API_TOKEN'];
const KEY_DIAGNOSTIC_BUCKETS = ['len<=4', 'len5-8', 'len9-16', 'len17-32', 'lenOver32'];
const KEY_DIAGNOSTIC_MAX_LABELS = 8;

// 本机请求证据（手机提交轮次）：固定 schema 与字段集（任务 §2.2）。
const LOCAL_REQUEST_EVIDENCE_SCHEMA = 'participant-identity-local-request/1';
// 请求分层协议与目标函数为固定值（任务 §2.2，R1 收紧）：不与配置互相比对作为唯一依据，
// 必须精确等于固定常量；配置值本身也须等于固定值才允许发送。
const REQUEST_PROTOCOL = 'participant-identity-request/1';
const FIXED_FUNCTION_NAME = 'scheduleSandbox';
// 轮次/构建标识格式约束与打包器一致：轮次 4–64 位字母数字-_ 且不以符号开头；
// previewBuildId 为 64 位小写十六进制 SHA-256。
const ROUND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const BUILD_ID_RE = /^[0-9a-f]{64}$/;

function isNonNegativeSafeInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function sanitizeKeyDiagnostic(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.schema !== KEY_DIAGNOSTIC_SCHEMA || raw.diagnosticScope !== KEY_DIAGNOSTIC_SCOPE) return null;
  // 计数：非负安全整数；不修补、不缺省
  const count = raw.otherKeyCount;
  if (!isNonNegativeSafeInt(count)) return null;
  // 分桶：五桶齐备、非负安全整数，且**总和必须等于 otherKeyCount**（一致性，违约整份丢弃）
  const rawBuckets = raw.otherKeyNameLengthBuckets;
  if (!rawBuckets || typeof rawBuckets !== 'object' || Array.isArray(rawBuckets)) return null;
  const buckets = {};
  let bucketSum = 0;
  for (const b of KEY_DIAGNOSTIC_BUCKETS) {
    const v = rawBuckets[b];
    if (!isNonNegativeSafeInt(v)) return null;
    buckets[b] = v;
    bucketSum += v;
  }
  if (bucketSum !== count) return null;
  // 候选标签：必须是数组；元素仅取固定词表、不得重复、总数不得超过上限；违约整份丢弃
  if (!Array.isArray(raw.candidateLabels)) return null;
  if (raw.candidateLabels.length > KEY_DIAGNOSTIC_MAX_LABELS) return null;
  const labels = [];
  for (const l of raw.candidateLabels) {
    if (typeof l !== 'string' || KEY_DIAGNOSTIC_LABELS.indexOf(l) === -1) return null;
    if (labels.indexOf(l) !== -1) return null;
    labels.push(l);
  }
  // 截断契约一致性（S2）：truncated=true 仅在候选标签数已达上限（8）且存在未列出
  // 候选时才可能成立；合法标签只能来自固定词表且不得重复，故 labels.length ≤ 词表容量。
  // 当前词表容量为 1 < 8，labels.length 不可能达到上限，因此 truncated=true 与当前协议
  // 矛盾——整份丢弃（不修补）。若未来扩词表，须同步校验「labels 数 === 上限」且
  // 「词表容量 ≥ 上限」，两项缺一即拒绝。
  if (raw.truncated !== true && raw.truncated !== false) return null;
  if (raw.truncated === true) {
    if (labels.length !== KEY_DIAGNOSTIC_MAX_LABELS) return null;
    if (KEY_DIAGNOSTIC_LABELS.length < KEY_DIAGNOSTIC_MAX_LABELS) return null;
  }
  const projected = {
    schema: KEY_DIAGNOSTIC_SCHEMA,
    diagnosticScope: KEY_DIAGNOSTIC_SCOPE,
    otherKeyCount: count,
    otherKeyNameLengthBuckets: buckets,
    candidateLabels: labels,
    truncated: raw.truncated
  };
  // 输出上限硬约束：投影对象序列化超过 1KB 视为违反有界契约，整份丢弃
  try {
    if (JSON.stringify(projected).length > 1024) return null;
  } catch (_) {
    return null;
  }
  return projected;
}

/**
 * 本机请求证据（手机提交轮次）：从已构造、即将交给 wx.cloud.callFunction 的同一个
 * payload 采集不可变快照。仅保存经严格格式校验的公共字符串/布尔；绝不复制
 * payload/event/request，也不保存口令、用户编号、OPENID/UNIONID、身份、token、
 * 附带字段或原始异常。handoffAttempted=true 仅表示程序已走到即将调用 SDK 这一步，
 * 不是网络送达、云函数收到或数据库已读取的证明。校验失败返回 null
 * （调用 SDK 前本地参数验证失败不生成已尝试快照）。
 *
 * R1（2026-10-20 收紧）：本机证据有效性即发送前置条件——协议必须精确等于
 * participant-identity-request/1（payload.schema 与本页配置双向一致，且配置本身
 * 等于固定值，杜绝“配置自比”绕过）、函数必须精确等于 scheduleSandbox；
 * previewBuildId 缺失/非法、轮次非法同样判无效。返回 null 表示禁止发送。
 */
function captureLocalRequestEvidence(payload) {
  const pic = payload && payload.picRequest;
  const requestRoundId = pic && typeof pic.checkRoundId === 'string' ? pic.checkRoundId : '';
  const schema = pic && typeof pic.schema === 'string' ? pic.schema : '';
  const configProtocol = typeof cloudConfig.requestProtocol === 'string' ? cloudConfig.requestProtocol : '';
  const previewBuildId = typeof cloudConfig.previewBuildId === 'string' ? cloudConfig.previewBuildId : '';
  const functionName = typeof cloudConfig.identityCheckFunction === 'string' ? cloudConfig.identityCheckFunction : '';
  if (!ROUND_ID_RE.test(requestRoundId)) return null;
  if (!BUILD_ID_RE.test(previewBuildId)) return null;
  // R1：协议与函数精确等于固定常量；payload.schema 须与本页配置一致且两者都是固定值
  if (configProtocol !== REQUEST_PROTOCOL) return null;
  if (schema !== configProtocol || schema !== REQUEST_PROTOCOL) return null;
  if (functionName !== FIXED_FUNCTION_NAME) return null;
  // 逐字段脱离引用并冻结：迟到响应/后续配置变动不得改写已捕获快照
  return Object.freeze({
    schema: LOCAL_REQUEST_EVIDENCE_SCHEMA,
    previewBuildId: previewBuildId,
    requestRoundId: requestRoundId,
    requestProtocol: cloudConfig.requestProtocol,
    functionName: functionName,
    handoffAttempted: true
  });
}

function callIdentityCheck(request) {
  if (!request || typeof request !== 'object') {
    return Promise.reject(new Error('请求参数无效'));
  }
  if (request.action !== 'inspectSelf') {
    // 非核验动作零请求。
    return Promise.reject(new Error('本客户端只提供本人身份只读核验'));
  }
  if (!wx.cloud) {
    return Promise.reject(new Error('运行环境不可用'));
  }
  // 只初始化一次固定环境；不读取任何本机缓存或历史目标。
  if (!wx.cloud._identityCheckEnvInited) {
    wx.cloud.init({ env: cloudConfig.envId, traceUser: false });
    wx.cloud._identityCheckEnvInited = true;
  }
  // 请求分层协议（participant-identity-request/1）：业务四字段固定放入 picRequest
  // 内层对象；外层由平台/传输附带的信息不读取、不采信。schema 取自本页配置绑定。
  const payload = {
    picRequest: {
      schema: cloudConfig.requestProtocol,
      action: request.action,
      passphrase: request.passphrase,
      // 轮次固定取自本页配置：调用方无法伪造或省略
      checkRoundId: cloudConfig.checkRoundId
    }
  };
  if (request.includeFullUserId === true) payload.picRequest.includeFullUserId = true;
  // 本机提交轮次快照：构造完成后、紧邻 SDK 调用前，从同一个 payload 采集；
  // 此后不再修改 payload（快照与交给 SDK 的请求字段值精确一致）。
  const localRequestEvidence = captureLocalRequestEvidence(payload);
  // R1（2026-10-20）：本机证据无效（buildId 缺失/非法、轮次非法、协议或函数不是
  // 固定值）时，在调用 wx.cloud.callFunction **之前**拒绝——零发送、无
  // handoffAttempted=true 的假事实，不消耗本轮唯一一次核验。
  if (!localRequestEvidence) {
    return Promise.reject(new Error('本机核验参数校验未通过，本次未发送请求'));
  }
  const envelope = transportOutcome => Object.freeze({
    response: null,
    localRequestEvidence: localRequestEvidence,
    transportOutcome: transportOutcome
  });
  const onSettled = res => {
    const result = (res && res.result) || null;
    // 只投影经过固定 schema 验证的净化诊断；无效或未提供时不携带该字段。
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const diagnostic = sanitizeKeyDiagnostic(result.keyDiagnostic);
      if (diagnostic) result.keyDiagnostic = diagnostic;
      else delete result.keyDiagnostic;
    }
    // 本地封套：response 是未改服务端结果；服务端任何同名字段都不进入本机证据。
    // C1 口径（2026-10-20）：transportOutcome='returned' 仅表示 wx.cloud.callFunction
    // 的 SDK Promise 正常兑现，**不保证存在有效服务端结果**（result 可能为 null 或
    // 云函数自身错误结构）；是否有效由 response 与页面状态判断，页面此时仍按
    // 失败/未知处理，不描述为云端处理成功。'failed' 表示调用未完成（同步抛错/拒绝）。
    return Object.freeze({ response: result, localRequestEvidence: localRequestEvidence, transportOutcome: 'returned' });
  };
  const onFailed = () => envelope('failed');
  try {
    return wx.cloud.callFunction({
      name: cloudConfig.identityCheckFunction,
      data: payload
    }).then(onSettled, onFailed);
  } catch (_) {
    // 同步抛错同样保留「已尝试交给 SDK」的本机事实；不携带原始错误。
    return Promise.resolve(onFailed());
  }
}

module.exports = { callIdentityCheck };
