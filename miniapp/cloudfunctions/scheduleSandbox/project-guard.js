// 施工安排独立测试副本：本轮唯一项目与一致提交协议。
//
// 方案 §4.2 + Codex 复核 S2：
// - 本轮**唯一项目**、唯一性状态与回执组成**一致提交**：要么一起成功，要么一起回滚。
//   不允许"项目已建但回执没写"的半套状态。
// - **一个轮次只允许一个创建执行人/项目**：唯一键与项目ID **只由 roundId 决定**，
//   不含 actorUserId。这样即使本轮 primary 绑定变化，另一被允许账号也**不能**
//   再创建第二个项目（不依赖"primary 永远不变"的未声明假设）。
// - 幂等回放：同轮次同载荷返回**同一原业务结果**且不重复落库；不同载荷**明确拒绝**。
// - 回放**先重验当前权限**（账号启用 + 仍是本轮 primary 主管理员）。
// - 保留对已损坏状态的**停止**逻辑，但它**不是**正常故障恢复的替代。
// - U4：未收到事务成功返回**不等于**事务未提交（SDK 可能已提交但响应丢失），
//   错误信息只按"结果未确认"表述，不从本地布尔值推断未提交。
//
// 与已验收业务实现的关系：
// - `createProject`（memberAccess/service.js）没有 requestId 幂等；方案 §4.1 禁止改事务规则，
//   因此本包装层**只限定 createProject** 增加约束，**不改 vendor 与原业务算法**。
// - 做法：唯一记录 + 项目创建 + 回执放进**同一次** `db.runTransaction`。
//   业务实现内部会再调 `db.runTransaction`（`service.js` 的 `transaction(work)`），
//   适配层通过**事务复用**让内外层共用同一次真实事务，因此仍是**单层真实事务**，
//   原业务权限检查、操作预算与失败整体回滚全部保留。

'use strict';

const crypto = require('node:crypto');

const RECEIPT_PREFIX = 'sbx-create-project:';
const PROJECT_PREFIX = 'p_sbx_';

class SandboxProjectError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SandboxProjectError';
    this.code = code;
  }
}

function deny(code, message) {
  throw new SandboxProjectError(code, message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// 唯一键：**只由轮次决定**，不含执行人 → 一个轮次只允许一个项目。
function roundRecordId(roundId) {
  return `${RECEIPT_PREFIX}${sha256(String(roundId)).slice(0, 40)}`;
}

// 本轮唯一项目 ID：同样只由轮次决定。
// 换 requestId、换执行人都落到同一 projectId。
function roundProjectId(roundId) {
  return `${PROJECT_PREFIX}${sha256(String(roundId)).slice(0, 32)}`;
}

/**
 * 轮次状态一致性核验（Codex 复核 T3）。
 *
 * 这是**创建回放**与**范围解析**共享的最小状态核验：
 * 1. 记录主键必须等于由 roundId 推导的唯一键；
 * 2. 记录自身的 roundId / action / projectId / result 必须自洽；
 * 3. projectId 必须等于由 roundId 推导的确定性项目 ID；
 * 4. **该项目必须真实存在**——只有回执不算成功。
 *
 * 任何一项不符即视为损坏状态并停止；**不**用新项目覆盖损坏数据，
 * 也**不**据此判定"已成功"。
 *
 * @returns { state: 'absent' } | { state: 'ok', record, project }
 */
async function verifyRoundState(db, roundId) {
  const record = await readRoundRecord(db, roundId);
  if (!record) return { state: 'absent' };
  const expectedRecordId = roundRecordId(roundId);
  const expectedProjectId = roundProjectId(roundId);
  if (record._id !== expectedRecordId) {
    deny('SANDBOX_PROJECT_STATE_CONFLICT', '本轮唯一记录主键与轮次不一致，状态已损坏，已停止。');
  }
  if (record.roundId !== roundId) {
    deny('SANDBOX_PROJECT_STATE_CONFLICT', '本轮唯一记录轮次字段不一致，状态已损坏，已停止。');
  }
  if (record.action !== 'createProject') {
    deny('SANDBOX_PROJECT_STATE_CONFLICT', '本轮唯一记录动作字段不一致，状态已损坏，已停止。');
  }
  if (record.projectId !== expectedProjectId) {
    deny('SANDBOX_PROJECT_STATE_CONFLICT', '本轮唯一记录的项目与唯一键不一致，已停止。');
  }
  if (!record.result || record.result.projectId !== expectedProjectId) {
    deny('SANDBOX_PROJECT_STATE_CONFLICT', '本轮唯一记录的结果与唯一键不一致，已停止。');
  }
  // 记录真实存在才继续
  const project = await readProject(db, expectedProjectId);
  if (!project) {
    deny('SANDBOX_PROJECT_STATE_CONFLICT',
      '本轮唯一记录存在但对应项目已不存在，状态不一致，已停止而非宣称成功。');
  }
  return { state: 'ok', record, project };
}

// 输入摘要：只覆盖真正决定项目内容的字段。
function inputDigest(name) {
  return sha256(`name:${String(name === undefined || name === null ? '' : name)}`);
}

// 供 createService 使用的确定性 ID 生成器。
// 只接管 'p' 前缀（建项目），其余前缀沿用业务实现原有生成方式。
function createDeterministicIdFactory(roundId) {
  const projectId = roundProjectId(roundId);
  return function nextId(prefix) {
    if (prefix === 'p') return projectId;
    return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
  };
}

async function readDoc(db, collection, key) {
  const response = await db.collection(collection).doc(key).get();
  if (!response || !response.data) return null;
  return Array.isArray(response.data) ? response.data[0] || null : response.data;
}

function readRoundRecord(db, roundId) {
  return readDoc(db, 'schedule_receipts', roundRecordId(roundId));
}

function readProject(db, projectId) {
  return readDoc(db, 'projects', projectId);
}

/**
 * 读取本轮唯一项目 ID；未建立时返回 null。
 * 这是准备期与执行期**唯一**的项目范围依据（不再依赖配置里的静态 ID）。
 *
 * T3：与创建回放共享 `verifyRoundState`，核验记录字段、确定性 ID 与项目真实存在；
 * 状态损坏时**停止**，不返回未经核验的 ID。
 */
async function currentRoundProjectId(db, roundId) {
  if (!roundId) return null;
  const verified = await verifyRoundState(db, roundId);
  return verified.state === 'ok' ? verified.record.projectId : null;
}

/** 核验当前身份/权限：账号仍启用，且仍是本轮 primary 主管理员。受限只读。 */
async function assertReplayAllowed(db, userId) {
  const user = await readDoc(db, 'users', userId);
  if (!user || user.status !== 'active') {
    deny('SANDBOX_ACCOUNT_NOT_ACTIVE', '当前账号已停用，无法继续本次测试操作。');
  }
  const admin = await readDoc(db, 'app_admins', 'primary');
  if (!admin || admin.status !== 'active' || admin.userId !== userId) {
    deny('SANDBOX_NOT_PRIMARY_ADMIN', '当前账号已不是本轮主管理员，无法继续本次测试操作。');
  }
  return true;
}

const RETRYABLE = new Set(['TRANSACTION_CONFLICT', 'DUPLICATE_KEY']);

/**
 * 本轮唯一项目创建（一致提交 + 冲突重试 + 幂等回放）。
 *
 * @param db      已映射的数据库视图
 * @param options { roundId, actorUserId, name, requestId, nowIso,
 *                  runCreate(projectId, tx) }
 * @returns { projectId, replayed }
 *
 * 一致提交：唯一记录、项目、初始成员、创建审计与回执**全部在同一次真实事务内**。
 * 任一步失败（含真实回执写故障）→ 整体回滚，不留半套状态。
 */
async function createRoundProjectOnce(db, options) {
  const { roundId, actorUserId, name, requestId, runCreate } = options;
  if (!roundId) deny('SANDBOX_CONFIG_INCOMPLETE', '测试轮次未配置。');
  if (!actorUserId) deny('SANDBOX_APPID_UNVERIFIED', '无法确认执行人。');
  if (typeof requestId !== 'string' || !requestId.trim()) {
    deny('BAD_INPUT', '建立测试项目必须提供请求编号。');
  }
  if (typeof runCreate !== 'function') {
    deny('SANDBOX_CONFIG_INCOMPLETE', '缺少项目创建实现。');
  }

  const recordId = roundRecordId(roundId);
  const projectId = roundProjectId(roundId);
  const digest = inputDigest(name);
  const nowIso = options.nowIso || new Date().toISOString();

  /**
   * 回放的统一入口：**每次回放都重新核验当前身份权限与轮次状态**。
   * 正常回放与并发回放走同一条路径，不存在"并发回放绕过权限"的分支。
   */
  const replay = async () => {
    await assertReplayAllowed(db, actorUserId);
    const verified = await verifyRoundState(db, roundId);
    if (verified.state === 'absent') return null;
    if (verified.record.inputDigest !== digest) {
      deny('SANDBOX_PROJECT_PAYLOAD_MISMATCH',
        '本轮已用不同内容建立过测试项目，拒绝用同一轮次改写其内容。');
    }
    return { projectId: verified.record.projectId, replayed: true };
  };

  // 先读唯一记录（受限只读）。命中即为回放。
  const replayed = await replay();
  if (replayed) return replayed;

  // 首次创建：先核验权限
  await assertReplayAllowed(db, actorUserId);

  // 项目已存在但唯一记录缺失 → 停止（损坏状态检测，不是正常恢复路径）
  const orphan = await readProject(db, projectId);
  if (orphan) {
    deny('SANDBOX_PROJECT_STATE_CONFLICT', '本轮项目已存在但缺少唯一记录，已停止而非重复创建。');
  }

  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 是否**收到过**事务成功返回。这只是正向证据：
    // SDK 可能已完成提交但提交响应未被调用方收到，此时 Promise 拒绝而本标志仍为
    // false。因此 false **不代表**未提交（U4）。
    let commitAcked = false;
    try {
      // 把「本轮唯一记录 + 回执」 enlist 进**业务自己的**那一次事务：
      // 适配层会在业务事务回调内、业务工作之前执行它，
      // 因此唯一记录、项目、初始成员、创建审计与回执**同事务一致提交**，
      // 任一步失败整体回滚（不留半套状态），且仍是单层真实事务。
      const release = db.enlist(async tx => {
        // 事务内再读一次：并发下第二个请求会在这里看到已提交记录
        const inTx = await readDoc(tx, 'schedule_receipts', recordId);
        if (inTx) {
          const err = new SandboxProjectError('SANDBOX_PROJECT_STATE_CONFLICT', '并发请求已建立本轮项目。');
          err.concurrent = true;
          throw err;
        }
        await tx.collection('schedule_receipts').add({ data: {
          _id: recordId,
          projectId,
          actorUserId,
          roundId,
          action: 'createProject',
          inputDigest: digest,
          requestId: requestId.trim(),
          result: { projectId },
          createdAt: nowIso
        } });
      });

      let result;
      try {
        // 业务创建（业务实现自己开那一次真实事务，enlist 记录在同一事务内写入）
        result = await runCreate(projectId, db);
        // 收到了事务成功返回（正向证据）
        commitAcked = true;
      } finally {
        release();
      }
      if (result && result.projectId !== projectId) {
        deny('SANDBOX_PROJECT_STATE_CONFLICT', '项目创建结果与唯一键不一致，已停止。');
      }
      // 提交后读回确认，得到**原业务结果**。
      // 这里已经**收到过事务成功返回**，因此读失败是"结果待核对"，
      // 不能与"事务未提交"混为一谈（U4）。
      let verified;
      try {
        verified = await verifyRoundState(db, roundId);
      } catch (readError) {
        deny('SANDBOX_PROJECT_STATE_CONFLICT',
          '已收到事务成功返回，但随后读取本轮唯一记录失败：'
          + `${(readError && readError.message) || '未知原因'}。`
          + '结果待核对，请按同一请求编号重试取回原结果。');
      }
      if (verified.state === 'absent') {
        deny('SANDBOX_PROJECT_STATE_CONFLICT',
          '已收到事务成功返回，但随后未能读到本轮唯一记录；结果待核对，请按同一请求编号重试。');
      }
      if (verified.record.inputDigest !== digest) {
        deny('SANDBOX_PROJECT_PAYLOAD_MISMATCH', '并发建立的本轮项目内容不同，已停止。');
      }
      return { projectId: verified.record.projectId, replayed: false };
    } catch (error) {
      lastError = error;
      const rawCode = error && error.code;
      // 并发信号：唯一主键重复、显式并发标记，或事务冲突（另一请求已提交）。
      const isConcurrent = rawCode === 'DUPLICATE_KEY'
        || rawCode === 'TRANSACTION_CONFLICT'
        || (error instanceof SandboxProjectError && error.concurrent);
      if (isConcurrent) {
        // 并发已建立：**同样重新核验权限与状态**后再回放（不重复落库）。
        // 竞争失败方此刻可能还看不到记录，短暂重试后再读。
        for (let i = 0; i < 5; i++) {
          const outcome = await replay();
          if (outcome) return outcome;
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        continue;
      }
      if (error instanceof SandboxProjectError) throw error;
      // 错误信息**只陈述已证实的事实**（U4）。
      // `commitAcked === false` 只说明"没收到成功返回"，**不能**推出"未提交"：
      // SDK 可能已提交但提交响应丢失。因此统一按"结果未确认"表述，
      // 并提示按同一编号重试核对；不重复创建，也不自动修复云端。
      deny('SANDBOX_PROJECT_CREATE_FAILED',
        `建立本轮测试项目失败：${(error && error.message) || '未知原因'}。`
        + (commitAcked
          ? '已收到事务成功返回，但随后处理未完成；结果待核对，请按同一请求编号重试取回原结果。'
          : '未收到事务成功返回，**提交结果未确认**（可能已提交但响应未送达，也可能在事务内被拒绝）；'
            + '请按同一请求编号重试核对，系统不会重复创建。'));
    }
  }
  throw lastError || new SandboxProjectError('SANDBOX_PROJECT_CREATE_FAILED', '建立本轮测试项目反复冲突。');
}

module.exports = {
  RECEIPT_PREFIX,
  PROJECT_PREFIX,
  SandboxProjectError,
  roundRecordId,
  roundProjectId,
  inputDigest,
  createDeterministicIdFactory,
  readProject,
  readRoundRecord,
  verifyRoundState,
  currentRoundProjectId,
  assertReplayAllowed,
  createRoundProjectOnce
};
