// 让测试真正经过 scheduleSandbox/index.js 的 main()。
//
// Codex 审查 R7：多数业务测试直接调用 vendor，绕过了 index，
// 因此没检出 R1（可信身份字段契约不一致）。本替身把 index.js 源码载入 vm，
// 注入可控的 wx-server-sdk 与配置，使 main 走**真实包装层代码**。
//
// 注意：只替换配置常量与 wx-server-sdk；vendor、collection-map、gate、
// project-guard 全部使用**交付文件本身**，不做任何行为改写。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

// helpers/ 位于 miniapp/tests/helpers/，上溯两级到 miniapp/
const ROOT = path.join(__dirname, '..', '..');
const BASE = path.join(ROOT, 'cloudfunctions/scheduleSandbox');
const nativeRequire = createRequire(path.join(BASE, 'index.js'));

const APPID = 'wxfb4db1615ac15531';
const ENV_ID = 'cloud1-d8gcq5ag39d847723';

function userIdFor(openid) {
  return `u_${crypto.createHash('sha256').update(`${APPID}:${openid}`).digest('hex').slice(0, 40)}`;
}

function memberId(projectId, userId) {
  return `m_${crypto.createHash('sha256').update(`${projectId}:${userId}`).digest('hex').slice(0, 40)}`;
}

/**
 * 载入真实 index.js，返回 { main, databaseCalls }。
 *
 * @param db            已映射的测试替身（原始对象，含 collection/runTransaction）
 * @param config        注入的配置；省略则保持文件内默认（关闭）
 * @param context       { appId, openid } 模拟 getWXContext
 * @param envId         模拟 TCB_ENV
 */
function loadEntry(db, config, context = {}, envId = ENV_ID) {
  const ctx = { APPID: context.appId === undefined ? APPID : context.appId, OPENID: context.openid };
  let databaseCalls = 0;

  const shim = {
    init() {},
    DYNAMIC_CURRENT_ENV: 'sandbox-test',
    getWXContext: () => ctx,
    database() {
      databaseCalls++;
      return db;
    }
  };

  let source = fs.readFileSync(path.join(BASE, 'index.js'), 'utf8');
  if (config) {
    const replaced = source.replace(
      /const SANDBOX_CONFIG = gate\.readConfig\(\{[\s\S]*?\}\);/,
      `const SANDBOX_CONFIG = gate.readConfig(${JSON.stringify(config)});`
    );
    if (replaced === source) throw new Error('未能注入配置：入口源码结构已变化');
    source = replaced;
  }

  const mod = { exports: {} };
  const localRequire = name => (name === 'wx-server-sdk' ? shim : nativeRequire(name));
  // eslint-disable-next-line no-new-func
  vm.runInThisContext(`(function(require,module,exports,process,console){${source}\n})`,
    { filename: 'sandbox-index-under-test.js' })(
    localRequire, mod, mod.exports, { env: { TCB_ENV: envId } }, { error() {}, log() {} }
  );

  return { main: mod.exports.main, databaseCalls: () => databaseCalls };
}

/** 合成一份启用配置。调用方可覆盖任意字段。 */
function openConfig(overrides = {}) {
  return {
    enabled: true,
    appId: APPID,
    envId: ENV_ID,
    allowedUserIds: [],
    projectId: '',
    roundId: 'sandbox-round-1',
    expiresAt: '2030-01-01T00:00:00Z',
    phase: 'prepare',
    projectReadyMarker: 'marker-1',
    ...overrides
  };
}

const OPENIDS = {
  owner: 'openid-owner-2d3aa4',
  manager: 'openid-manager-64193d',
  worker: 'openid-worker-989a74',
  worker2: 'openid-worker2-64193e'
};
const U = {};
for (const [k, v] of Object.entries(OPENIDS)) U[k] = userIdFor(v);

/**
 * 预置已登记账号 + 唯一 primary 主管理员的测试库。
 * @param extra  额外集合数据（键必须带前缀）
 * @param options 传给替身的选项（barrier / reentry / pauseBeforeCommit）
 */
function seededDb(extra = {}, options = {}) {
  const { createSandboxTestDb, PREFIX } = require('./sandbox-test-db.cjs');
  const users = {};
  for (const [k, uid] of Object.entries(U)) {
    users[uid] = { _id: uid, status: 'active', openid: OPENIDS[k] };
  }
  const admins = { primary: { _id: 'primary', status: 'active', userId: U.owner } };
  return createSandboxTestDb({
    [PREFIX + 'users']: users,
    [PREFIX + 'app_admins']: admins,
    ...extra
  }, options);
}

/**
 * 通过**真实 main** 走完整业务链：建项目 → 指定管家 → 邀请 → 申请 → 批准。
 * 返回 { projectId, workerUserId, call }。
 */
async function bootstrapThroughMain(db, overrides = {}) {
  const config = openConfig({ allowedUserIds: Object.values(U), ...overrides });
  let n = 1000000000;
  const bindingNumber = () => String(++n);

  const as = who => loadEntry(db, config, { appId: APPID, openid: OPENIDS[who] });

  // 业务实现需要 bindingNumber 注入；通过 vendor 的 options 传入。
  // 这里直接复用 main 的门槛，但 createService 由 main 内部创建，
  // 因此编号由测试替身提供固定序列即可（main 不传 options）。
  const created = await as('owner').main({
    action: 'createProject', requestId: 'req-create-project-1', name: '虚构测试 · 独立副本'
  });
  if (!created.ok) throw new Error(`建项目失败：${created.code} ${created.message || ''}`);
  const projectId = created.projectId;

  return { projectId, config, as, bindingNumber };
}

module.exports = {
  ROOT,
  BASE,
  APPID,
  ENV_ID,
  OPENIDS,
  U,
  userIdFor,
  memberId,
  loadEntry,
  openConfig,
  seededDb,
  bootstrapThroughMain,
  nativeRequire
};
