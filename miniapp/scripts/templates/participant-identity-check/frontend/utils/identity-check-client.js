// 核验页专用客户端：固定环境/固定函数，单一动作，失败不回退。
//
// 任务：docs/WorkBuddy任务-两位参与者本人身份只读核验包-20261015.md §5
// - 显式固定环境与函数名，不接受调用方指定目标，不做全局重定向。
// - **禁止失败后回退旧函数/旧客户端/本机保存**，也不做任何本地重试。
// - 请求体只含 action、口令、**本轮轮次**与可选的完整 ID 请求开关；
//   不接受自报 openid/appId/userId/集合/角色。
// - R5：轮次由本页配置原样带回，不接受调用方覆盖；R2：完整内部 userId 只在
//   调用方显式请求且本次核验有效时才由服务端返回。

const cloudConfig = require('../config/cloud');

// ── 受控键诊断净化投影（C3/R4）────────────────────────────────────────────
// 服务端默认不返回诊断；仅诊断轮且全部准入门槛通过时才附带。客户端按固定 schema
// **严格**验证：任何必需字段缺失/类型错误/越界、标签非法或重复或超量、计数与分桶
// 不一致——整份诊断丢弃（不修补成默认值）；额外未知字段仅投影丢弃。不透传原键名或值。
// 截断契约：truncated=true 表示服务端候选标签数已达上限（8）且存在未列出候选；
// candidateLabels 数组长度恒 ≤ 8、元素仅取固定词表且无重复。投影输出恒为 6 个固定
// 字段、内容有界（序列化 < 1KB）。
const KEY_DIAGNOSTIC_SCHEMA = 'participant-identity-key-diagnostic/1';
const KEY_DIAGNOSTIC_SCOPE = 'request-keys-only';
const KEY_DIAGNOSTIC_LABELS = ['CANDIDATE_USERINFO'];
const KEY_DIAGNOSTIC_BUCKETS = ['len<=4', 'len5-8', 'len9-16', 'len17-32', 'lenOver32'];
const KEY_DIAGNOSTIC_MAX_LABELS = 8;

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
  // 截断标志：必须为布尔（截断契约见上）
  if (raw.truncated !== true && raw.truncated !== false) return null;
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
  const payload = {
    action: request.action,
    passphrase: request.passphrase,
    // 轮次固定取自本页配置：调用方无法伪造或省略
    checkRoundId: cloudConfig.checkRoundId
  };
  if (request.includeFullUserId === true) payload.includeFullUserId = true;
  return wx.cloud.callFunction({
    name: cloudConfig.identityCheckFunction,
    data: payload
  }).then(res => {
    const result = (res && res.result) || null;
    // 只投影经过固定 schema 验证的净化诊断；无效或未提供时不携带该字段。
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const diagnostic = sanitizeKeyDiagnostic(result.keyDiagnostic);
      if (diagnostic) result.keyDiagnostic = diagnostic;
      else delete result.keyDiagnostic;
    }
    return result;
  });
}

module.exports = { callIdentityCheck };
