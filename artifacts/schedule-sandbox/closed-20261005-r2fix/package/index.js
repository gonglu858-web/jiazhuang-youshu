// 施工安排独立测试副本：新云函数入口（本地实现，未部署）。
//
// 与原 memberAccess 的关系：
// - **不修改、不重部署** memberAccess / connectionCheck。
// - 业务实现来自 `./vendor` 下**由 scripts/build-sandbox.cjs 从已验收源码生成的副本**。
// - 集合访问全部经映射层，业务层拿不到未加前缀的集合。
//
// 门槛顺序（方案 §4.2 + Codex 复核 S1/S3）：
// 开关/环境/APPID/账号/窗口 → 阶段 → 动作 → 本轮项目解析（受限只读）
// → 记录归属核验（受限只读）→ 业务。
// **全部在 service.execute 之前**完成，防止 identify 先向 users 写入。

'use strict';

const cloud = require('wx-server-sdk');
const { createService, AppError } = require('./vendor/service');
const { createSandboxDb, SandboxConfigError } = require('./collection-map');
const projectGuard = require('./project-guard');
const gate = require('./gate');
const { SandboxProjectError } = projectGuard;

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 服务端配置。默认值全部为空/false：测试开关关闭，动态执行值不预填。
const SANDBOX_CONFIG = gate.readConfig({
  enabled: false,
  appId: '',
  envId: '',
  allowedUserIds: [],
  projectId: '',
  roundId: '',
  expiresAt: '',
  phase: gate.PHASE_PREPARE,
  projectReadyMarker: ''
});

// 可信运行信息（门控用）。只来自云函数运行环境与 getWXContext，不接受请求体自报。
function readTrustedRuntime() {
  let ctx = {};
  try {
    ctx = cloud.getWXContext() || {};
  } catch (error) {
    ctx = {};
  }
  const envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE || '';
  return {
    appId: typeof ctx.APPID === 'string' ? ctx.APPID : '',
    envId: typeof envId === 'string' ? envId.trim() : '',
    openid: typeof ctx.OPENID === 'string' ? ctx.OPENID : '',
    nowMs: Date.now()
  };
}

const crypto = require('node:crypto');
function userIdFromOpenid(appId, openid) {
  return `u_${crypto.createHash('sha256').update(`${appId}:${openid}`).digest('hex').slice(0, 40)}`;
}

// 门控上下文 → 业务层微信上下文的**显式转换**（业务实现读 APPID/OPENID）。
function toWechatContext(trusted) {
  return { APPID: trusted.appId, OPENID: trusted.openid };
}

function hashToken(appId, code) {
  return crypto.createHash('sha256').update(`${appId}:${code}`).digest('hex');
}

// 邀请码规范化：**必须与 vendor 一致**（service.js: trim().toUpperCase() 后哈希）。
function normalizeInvitationCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

// 按邀请码解析**记录真实归属**（受限只读，不写任何数据）。
async function resolveProjectByInvitationCode(db, code) {
  const normalized = normalizeInvitationCode(code);
  if (!normalized) return null;
  const response = await db.collection('invitations')
    .where({ tokenHash: hashToken(SANDBOX_CONFIG.appId, normalized) }).get();
  const rows = response && Array.isArray(response.data) ? response.data : [];
  if (rows.length === 0) return null;
  return rows[0].projectId || null;
}

exports.main = async event => {
  try {
    const trusted = readTrustedRuntime();
    const payload = { ...(event || {}) };

    // 1) 能在访问数据库之前判定的条件：零数据库访问。
    gate.checkPreDatabase(SANDBOX_CONFIG, trusted);
    // 2) 阶段（缺失/未识别即拒绝）与动作（按阶段允许清单）。
    gate.checkPhase(SANDBOX_CONFIG);
    const action = gate.assertActionAllowed(SANDBOX_CONFIG, payload.action);

    // 3) 身份：真实 APPID + OPENID 缺一不可；允许列表只是附加限制。
    if (!trusted.appId) {
      return { ok: false, code: 'SANDBOX_APPID_UNVERIFIED', message: '无法确认当前小程序身份。' };
    }
    if (!trusted.openid) {
      return { ok: false, code: 'IDENTITY_UNAVAILABLE', message: '无法确认当前微信身份，请重新进入。' };
    }
    const userId = userIdFromOpenid(trusted.appId, trusted.openid);
    if (!SANDBOX_CONFIG.allowedUserIds.includes(userId)) {
      return { ok: false, code: 'SANDBOX_ACCOUNT_NOT_ALLOWED', message: '当前账号不在测试副本允许范围内。' };
    }

    // 4) 到达此处才建立数据库视图并执行业务。
    const rawDb = cloud.database({ throwOnNotFound: false });
    const db = createSandboxDb(rawDb);
    const wechatContext = toWechatContext(trusted);

    // 5) 建项目：本轮唯一项目 + 一致提交 + 幂等回放（S2）。
    if (action === 'createProject') {
      gate.assertCreateProjectAllowed(SANDBOX_CONFIG);
      const outcome = await projectGuard.createRoundProjectOnce(db, {
        roundId: SANDBOX_CONFIG.roundId,
        actorUserId: userId,
        name: payload.name,
        requestId: payload.requestId,
        nowIso: new Date(trusted.nowMs).toISOString(),
        // 业务创建在**同一事务**内完成（适配层复用事务）
        runCreate: async (projectId, businessDb) => {
          const service = createService(businessDb, {
            id: projectGuard.createDeterministicIdFactory(SANDBOX_CONFIG.roundId)
          });
          const result = await service.execute({ ...payload, action, projectId }, wechatContext);
          if (!result || result.projectId !== projectId) {
            throw new SandboxProjectError('SANDBOX_PROJECT_STATE_CONFLICT', '项目创建结果与唯一键不一致，已停止。');
          }
          return result;
        }
      });
      return { ok: true, sandbox: true, projectId: outcome.projectId, replayed: outcome.replayed };
    }

    // 6) 解析本轮唯一项目（受限只读）。这是**唯一**的项目范围依据。
    const roundProjectId = await projectGuard.currentRoundProjectId(db, SANDBOX_CONFIG.roundId);

    // 7) 项目范围：请求 ID 不得覆盖本轮唯一项目；受保护 ID 硬拒绝。
    const requestedProjectId = typeof payload.projectId === 'string' ? payload.projectId : '';
    let effectiveProjectId = gate.assertProjectScope(
      SANDBOX_CONFIG, requestedProjectId, roundProjectId, action
    );

    // 8) 记录归属核验（受限只读）：始终以**记录真实归属**为准。
    if (action === 'applyInvitation') {
      // 按邀请码解析真实归属；请求 ID 若存在必须与之一致
      const resolved = await resolveProjectByInvitationCode(db, payload.invitationCode);
      if (!resolved) {
        return { ok: false, code: 'CODE_INVALID', message: '邀请不存在或无法解析归属。' };
      }
      effectiveProjectId = gate.assertRecordOwnership(roundProjectId, requestedProjectId, resolved);
    }

    const service = createService(db);
    const result = await service.execute({ ...payload, action, projectId: effectiveProjectId }, wechatContext);

    // 9) 列表结果只限本轮目标项目（S3）。
    if (action === 'listMyProjects' && result && Array.isArray(result.projects)) {
      return { ok: true, sandbox: true, ...result, projects: gate.filterRoundProjects(roundProjectId, result.projects) };
    }
    return { ok: true, sandbox: true, ...result };
  } catch (error) {
    if (error instanceof SandboxConfigError) {
      return { ok: false, code: error.code, message: error.message };
    }
    if (error instanceof SandboxProjectError) {
      return { ok: false, code: error.code, message: error.message };
    }
    if (error instanceof AppError) {
      return { ok: false, code: error.code, message: error.message };
    }
    console.error('scheduleSandbox failed', error && error.stack ? error.stack : error);
    return { ok: false, code: 'SERVER_ERROR', message: '云端处理失败，请稍后重试。' };
  }
};
