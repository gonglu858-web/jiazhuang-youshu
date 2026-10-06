// 施工安排服务：新增、调整、改派、取消、只读查看、版本历史及责任师傅移出保护。
// 本文件仅含本地可测试逻辑，不直接依赖 wx-server-sdk；运行时由 memberAccess/service.js 注入 db。

const crypto = require('node:crypto');

const TRADES = ['拆改', '泥瓦', '水电', '防水', '木工', '油漆', '美缝', '安装', '保洁'];
// 阶段顺序：保洁在前，竣工验收与交付为最后阶段
const STAGES = ['拆改', '砌墙', '水电隐蔽工程', '防水与闭水试验', '泥瓦铺贴', '木工施工', '油漆施工', '美缝', '安装与收口', '保洁', '竣工验收与交付'];
const MAX_RANGE_DAYS = 365;
const MAX_CONTENT_LENGTH = 500;
const MAX_REASON_LENGTH = 200;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;
const DB_PAGE_LIMIT = 100; // 模拟云数据库 SDK 单次返回上限

// ===== 平台兼容常量 =====
// 应用层每次事务尝试的数据操作上限（工程余量）；平台限制为 100
const TXN_OP_BUDGET = 80;
const PLATFORM_TXN_OP_LIMIT = 100;
// 每月桶最多覆盖的自然月数（365 天跨 13 个月），改期时旧新并集最多 26 个桶
const MAX_MONTHS_SINGLE = 13;
const MAX_BUCKET_UNION = 26;
// 每项目每成员当前 active 目录条目数上限（隔离试验技术保护，非永久业务限制）
const MAX_ACTIVE_DIR_ENTRIES = 200;
// 目录 UTF-8 序列化字节上限（保守技术保护）
const MAX_DIR_BYTES = 32 * 1024;
// 扫描哨兵：读到第 201 项即判定超容量，不再继续翻页
const SCAN_SENTINEL = MAX_ACTIVE_DIR_ENTRIES + 1;
// 锚点与目录结构版本
const TASK_DIR_SCHEMA_VERSION = 1;
// 每次逻辑请求最多一次初扫 + 一次重扫
const MAX_SCAN_ROUNDS = 2;
// 目录字段名（锚点与 guard 两侧同名，必须精确匹配）
const ANCHOR_SCHEMA_FIELD = 'taskDirSchemaVersion';
const ANCHOR_GENERATION_FIELD = 'taskDirGeneration';
const GUARD_FENCE_FIELD = 'fenceVersion';
const GUARD_IDS_FIELD = 'activeScheduleIds';
const GUARD_SCHEMA_FIELD = 'schemaVersion';
const GUARD_GENERATION_FIELD = 'generation';
// 月桶结构版本；与旧逐日记录（无此字段）不兼容
const OCCUPANCY_SCHEMA_VERSION = 2;
const OCCUPANCY_SCHEMA_FIELD = 'schemaVersion';

function createScheduleService(db, options = {}) {
  const AppError = options.AppError || class AppError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  };
  const now = options.now || (() => new Date());
  const nextId = options.id || id;
  const audit = options.audit;

  function check(condition, code, message) {
    if (!condition) throw new AppError(code, message);
  }

  const get = async (name, key, source = db) => one(await source.collection(name).doc(key).get());
  const find = async (name, where, source = db, opts = {}) => {
    let query = source.collection(name).where(where);
    if (Array.isArray(opts.orderBy)) {
      for (const o of opts.orderBy) query = query.orderBy(o.field, o.direction || 'asc');
    }
    if (typeof opts.limit === 'number') query = query.limit(opts.limit);
    if (typeof opts.skip === 'number') query = query.skip(opts.skip);
    const result = await query.get();
    return many(result);
  };
  const add = async (name, value, source = db) => source.collection(name).add({ data: value });
  const update = async (name, key, value, source = db) => source.collection(name).doc(key).update({ data: value });
  const remove = async (name, key, source = db) => source.collection(name).doc(key).remove();

  // U3：产品侧逐 attempt 数据操作计数保护。
  // 计数器是"每次 SDK 事务回调"的私有闭包状态，由 wrapTx 传给该次回调的
  // 集合包装对象；因此同一服务实例上的并发事务、以及 SDK 因冲突重入的
  // 多次 attempt 各自独立计数，互不重置也不互相累计。
  // 边界语义：允许前 80 次数据操作；第 81 次在调用底层 SDK 之前拒绝。
  // 这是首写前预算预检（assertWithinBudget）之外的第二层保护。
  function createTxnOpCounter() {
    const counter = { ops: 0, peak: 0 };
    counter.count = function () {
      if (counter.ops >= TXN_OP_BUDGET) {
        const error = new AppError('SCHEDULE_OPERATION_BUDGET_EXCEEDED',
          `本次提交的数据操作已超过单次事务上限 ${TXN_OP_BUDGET} 次，已停止写入。`);
        error.isTxnOpBudgetError = true;
        throw error;
      }
      counter.ops++;
      if (counter.ops > counter.peak) counter.peak = counter.ops;
    };
    return counter;
  }
  // 最近一次 SDK 回调闭包内的峰值（供测试与文档核对；并发下不代表全局）
  let lastTxnOpPeak = 0;
  function currentAttemptPeak() { return lastTxnOpPeak; }

  // 事务内受控数据访问包装：只在事务源上计数，事务外查询不受影响。
  // 注意：这里只缓存集合包装对象（避免同一 attempt 内重复包装），
  // **不缓存任何文档读取结果**——每次 get/update/remove 都各计 1 次。
  function countedCollection(name, source, counter) {
    const inner = source.collection(name);
    return {
      doc: id => ({
        get: async () => { counter.count(); return inner.doc(id).get(); },
        update: async args => { counter.count(); return inner.doc(id).update(args); },
        remove: async () => { counter.count(); return inner.doc(id).remove(); }
      }),
      where: query => {
        // 事务内不允许条件查询；保持调用点显式失败，便于验证"事务内零 where"
        return inner.where(query);
      },
      add: async args => { counter.count(); return inner.add(args); }
    };
  }
  // 事务视图：counter 属于本次 attempt 的闭包；仅缓存集合包装对象
  function wrapTx(tx, counter) {
    const cache = new Map();
    return {
      counter,
      collection(name) {
        if (!cache.has(name)) cache.set(name, countedCollection(name, tx, counter));
        return cache.get(name);
      }
    };
  }

  async function transaction(work) {
    check(typeof db.runTransaction === 'function', 'TRANSACTION_UNAVAILABLE', '当前数据库不支持所需的原子操作，已停止写入。');
    // SDK 每调用一次回调就得到全新的计数器：重入/重试自然从 0 开始
    return db.runTransaction(async tx => {
      const counter = createTxnOpCounter();
      const view = wrapTx(tx, counter);
      try {
        return await work(view);
      } finally {
        if (counter.peak > lastTxnOpPeak) lastTxnOpPeak = counter.peak;
      }
    });
  }

  async function getReceipt(tx, requestId) {
    return await get('schedule_receipts', `receipt_${hash(requestId)}`, tx);
  }

  async function saveReceipt(tx, requestId, payload, result, actor) {
    await add('schedule_receipts', {
      _id: `receipt_${hash(requestId)}`,
      requestId,
      projectId: payload.projectId,
      action: payload.action,
      actorUserId: actor.user._id,
      payloadHash: payloadHash(payload),
      result,
      createdAt: at(now)
    }, tx);
  }

  async function checkIdempotency(tx, requestId, payload, actor) {
    const receipt = await getReceipt(tx, requestId);
    if (!receipt) return null;
    check(receipt.actorUserId === actor.user._id, 'NO_ACCESS', '该提交编号由其他账号使用，请重新生成。');
    check(receipt.projectId === payload.projectId, 'REQUEST_ID_REUSED_DIFFERENT_PAYLOAD', '同一提交编号已用于不同项目。');
    check(receipt.action === payload.action, 'REQUEST_ID_REUSED_DIFFERENT_PAYLOAD', '同一提交编号已用于不同操作。');
    check(receipt.payloadHash === payloadHash(payload), 'REQUEST_ID_REUSED_DIFFERENT_PAYLOAD', '同一提交编号已用于不同内容，请重新生成编号后重试。');
    return receipt.result;
  }

  function validateGuardRecord(guard) {
    return guard && Number.isInteger(guard.activeScheduleCount) && guard.activeScheduleCount >= 0 &&
      Number.isInteger(guard.version) && guard.version >= 1;
  }

  // ===== 目录/锚点状态机 =====
  // 严格类型校验：undefined、NaN、负数、零版本一律视为不合格，不做宽松转换
  function isNonNegativeInt(v) { return Number.isInteger(v) && v >= 0; }
  function isPositiveInt(v) { return Number.isInteger(v) && v >= 1; }

  function dirBytes(ids) {
    return Buffer.byteLength(JSON.stringify(ids), 'utf8');
  }

  // 目录条目合法校验：唯一、类型/长度合法、字节上限
  function validateDirIds(ids) {
    if (!Array.isArray(ids)) return 'activeScheduleIds 必须是数组';
    if (ids.length > MAX_ACTIVE_DIR_ENTRIES) return `当前测试容量已达上限（${MAX_ACTIVE_DIR_ENTRIES} 条），请联系管理员核对`;
    const seen = new Set();
    for (const id of ids) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) return '目录条目类型或长度不合法';
      if (seen.has(id)) return '目录条目存在重复编号';
      seen.add(id);
    }
    if (dirBytes(ids) > MAX_DIR_BYTES) return '任务目录体积超过本轮技术上限，请联系管理员核对';
    return null;
  }

  // 读取并校验 guard 目录文档（含 schemaVersion/generation/fenceVersion/目录）
  // 返回 null 表示文档不存在；抛错表示结构损坏
  function readGuardDoc(guard) {
    if (!guard) return null;
    const dirError = validateDirIds(guard[GUARD_IDS_FIELD]);
    if (dirError) throw new AppError('TASK_DIR_INCONSISTENT', `任务目录异常：${dirError}`);
    if (!isPositiveInt(guard[GUARD_SCHEMA_FIELD])) throw new AppError('TASK_DIR_INCONSISTENT', '任务目录结构版本缺失或不合法。');
    if (!isNonNegativeInt(guard[GUARD_GENERATION_FIELD])) throw new AppError('TASK_DIR_INCONSISTENT', '任务目录代际缺失或不合法。');
    if (!isNonNegativeInt(guard[GUARD_FENCE_FIELD])) throw new AppError('TASK_DIR_INCONSISTENT', '任务目录围栏版本缺失或不合法。');
    if (!validateGuardRecord(guard)) throw new AppError('TASK_DIR_INCONSISTENT', '任务保护记录损坏。');
    // 计数与目录长度必须自洽（自洽但与实际扫描不符由外层核对检出）
    if (guard.activeScheduleCount !== guard[GUARD_IDS_FIELD].length) {
      throw new AppError('TASK_DIR_INCONSISTENT',
        `任务保护计数（${guard.activeScheduleCount}）与目录条目数（${guard[GUARD_IDS_FIELD].length}）不一致。`);
    }
    return guard;
  }

  function anchorState(member) {
    // 锚点缺失/类型不合法一律视为未就绪，不做宽松转换
    if (!member) return { present: false, generation: null, schemaVersion: null };
    const gen = member[ANCHOR_GENERATION_FIELD];
    const schema = member[ANCHOR_SCHEMA_FIELD];
    const usable = isNonNegativeInt(gen) && isPositiveInt(schema);
    return { present: usable, generation: usable ? gen : null, schemaVersion: usable ? schema : null, raw: member };
  }

  // 事务外前置读取：锚点 + guard
  async function readDirPrecondition(projectId, userId) {
    const member = await get('project_members', memberKey(projectId, userId));
    const anchor = anchorState(member);
    const guard = readGuardDoc(await get('member_task_guard', guardKey(projectId, userId)));
    return { member, anchor, guard };
  }

  // 事务内前置复核：锚点与 guard 必须精确配对
  // 传入的是 snapshot.dirs.get(userId) 结构（含 pre/state/scanned/fence）
  function assertDirPairing(snap, txPre) {
    const outer = snap.pre;
    if (outer.anchor.present !== txPre.anchor.present) throw new AppError('STALE_SCAN', '任务目录状态已变化，请重试。');
    if (outer.anchor.present) {
      if (outer.anchor.generation !== txPre.anchor.generation || outer.anchor.schemaVersion !== txPre.anchor.schemaVersion) {
        throw new AppError('STALE_SCAN', '任务目录代际已变化，请重试。');
      }
    }
    const outerGen = outer.guard ? outer.guard[GUARD_GENERATION_FIELD] : null;
    const nowGen = txPre.guard ? txPre.guard[GUARD_GENERATION_FIELD] : null;
    if (outerGen !== nowGen) throw new AppError('STALE_SCAN', '任务目录代际已变化，请重试。');
    if (outer.guard && txPre.guard && outer.guard[GUARD_FENCE_FIELD] !== txPre.guard[GUARD_FENCE_FIELD]) {
      throw new AppError('STALE_SCAN', '任务目录围栏已变化，请重试。');
    }
  }

  // 结构状态判定（仅在围栏确认未变后调用，见 §2.2 实施顺序）
  // 返回 'ready' | 'first-use' | 'missing-guard'，结构问题直接抛错
  function classifyDirState(pre) {
    if (!pre.anchor.present) {
      // S1：历史成员无锚点，不可推断没有安排
      throw new AppError('TASK_DIR_NOT_READY', '该成员尚未完成施工任务初始化，请先由管理员完成准备。');
    }
    if (pre.anchor.generation === 0) {
      if (pre.guard) throw new AppError('TASK_DIR_INCONSISTENT', '任务目录代际为 0 但已存在目录记录，请联系管理员核对。');
      return 'first-use';
    }
    // generation >= 1
    if (!pre.guard) throw new AppError('TASK_DIR_INCONSISTENT', '任务目录记录缺失且成员曾初始化，请联系管理员核对。');
    // 目录归属校验：项目/成员标识必须与锚点一致，错代际/错误成员即使自洽也拒绝
    if (pre.guard.projectId !== pre.member.projectId || pre.guard.userId !== pre.member.userId) {
      throw new AppError('TASK_DIR_INCONSISTENT', '任务目录归属与成员不一致，请联系管理员核对。');
    }
    if (pre.guard[GUARD_SCHEMA_FIELD] !== pre.anchor.schemaVersion ||
      pre.guard[GUARD_GENERATION_FIELD] !== pre.anchor.generation) {
      throw new AppError('TASK_DIR_INCONSISTENT', '任务目录与成员锚点代际不匹配，请联系管理员核对。');
    }
    return 'ready';
  }

  // 围栏确认未变后，核对实际集合与目录一致性
  function assertDirMatchesScan(pre, scannedIds) {
    const dirIds = [...pre.guard[GUARD_IDS_FIELD]].sort();
    const actual = [...scannedIds].sort();
    if (dirIds.length !== actual.length || dirIds.some((id, i) => id !== actual[i])) {
      throw new AppError('GUARD_INCONSISTENT',
        `任务保护目录与实际未取消安排数不一致，请先核对或联系管理员。`);
    }
  }

  // ===== 事务外有界扫描 =====
  // 固定排序 + 有界读取；读到第 201 项作为超容量哨兵
  async function scanActiveSchedules(projectId, workerUserId) {
    const result = [];
    let skip = 0;
    while (true) {
      const page = await find('schedules',
        { projectId, workerUserId, status: 'active' },
        db,
        { limit: DB_PAGE_LIMIT, skip, orderBy: [{ field: '_id', direction: 'asc' }] });
      for (const item of page) result.push(item._id);
      if (result.length >= SCAN_SENTINEL) {
        throw new AppError('TASK_DIR_CAPACITY_EXCEEDED',
          `当前测试容量已达上限（${MAX_ACTIVE_DIR_ENTRIES} 条），请联系管理员核对`);
      }
      if (page.length < DB_PAGE_LIMIT) break;
      skip += page.length;
    }
    return result;
  }

  async function getGuard(tx, projectId, userId) {
    return readGuardDoc(await get('member_task_guard', guardKey(projectId, userId), tx));
  }

  // 首次初始化：原子建立 generation=1 的 guard 与锚点，围栏以首次值建档
  async function initDir(tx, projectId, userId, dirIds) {
    const key = guardKey(projectId, userId);
    const existing = await get('member_task_guard', key, tx);
    check(!existing, 'TASK_DIR_INCONSISTENT', '任务目录已存在，无法重复初始化。');
    const sorted = [...dirIds].sort();
    await add('member_task_guard', {
      _id: key, projectId, userId,
      activeScheduleCount: sorted.length,
      version: 1,
      [GUARD_FENCE_FIELD]: 1,
      [GUARD_IDS_FIELD]: sorted,
      [GUARD_SCHEMA_FIELD]: TASK_DIR_SCHEMA_VERSION,
      [GUARD_GENERATION_FIELD]: 1,
      updatedAt: at(now)
    }, tx);
    await update('project_members', memberKey(projectId, userId), {
      [ANCHOR_SCHEMA_FIELD]: TASK_DIR_SCHEMA_VERSION,
      [ANCHOR_GENERATION_FIELD]: 1
    }, tx);
    return { ids: sorted, fence: 1 };
  }

  // 已有目录：围栏递增与目录变更在同一次更新内完成
  async function writeDir(tx, projectId, userId, expectedFence, nextIds) {
    const key = guardKey(projectId, userId);
    const current = readGuardDoc(await get('member_task_guard', key, tx));
    check(current, 'TASK_DIR_INCONSISTENT', '任务目录记录缺失。');
    check(current[GUARD_FENCE_FIELD] === expectedFence, 'STALE_SCAN', '任务目录围栏已变化，请重试。');
    const sorted = [...nextIds].sort();
    const dirError = validateDirIds(sorted);
    if (dirError) throw new AppError('TASK_DIR_CAPACITY_EXCEEDED', dirError);
    await update('member_task_guard', key, {
      activeScheduleCount: sorted.length,
      version: current.version + 1,
      [GUARD_FENCE_FIELD]: current[GUARD_FENCE_FIELD] + 1,
      [GUARD_IDS_FIELD]: sorted,
      updatedAt: at(now)
    }, tx);
    return sorted;
  }

  // 容量保护：仅在增加条目时拒绝
  function assertCapacity(currentIds, nextIds) {
    if (nextIds.length > currentIds.length && nextIds.length > MAX_ACTIVE_DIR_ENTRIES) {
      throw new AppError('TASK_DIR_CAPACITY_EXCEEDED',
        `当前测试容量已达上限（${MAX_ACTIVE_DIR_ENTRIES} 条），请联系管理员核对`);
    }
  }

  async function hasActiveSchedules(tx, projectId, userId) {
    const guard = await getGuard(tx, projectId, userId);
    if (guard) return guard[GUARD_IDS_FIELD].length > 0;
    return false;
  }

  function publicSchedule(schedule) {
    return {
      id: schedule._id,
      projectId: schedule.projectId,
      stage: schedule.stage,
      trade: schedule.trade,
      workerUserId: schedule.workerUserId,
      startDate: schedule.startDate,
      endDate: schedule.endDate,
      expectedDate: schedule.expectedDate,
      restDays: schedule.restDays || [],
      content: schedule.content,
      status: schedule.status,
      version: schedule.version,
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
      updatedByUserId: schedule.updatedByUserId,
      updatedByRole: schedule.updatedByRole
    };
  }

  function publicRevision(rev) {
    const snap = rev.snapshot || {};
    return {
      beforeVersion: rev.beforeVersion,
      afterVersion: rev.afterVersion,
      changeType: rev.changeType,
      changeLabel: CHANGE_LABEL[rev.changeType] || rev.changeType,
      reason: rev.reason,
      actorUserId: rev.actorUserId,
      actorRole: rev.actorRole,
      actorLabel: rev.actorLabel,
      createdAt: rev.createdAt,
      snapshot: {
        stage: snap.stage,
        trade: snap.trade,
        workerUserId: snap.workerUserId,
        startDate: snap.startDate,
        endDate: snap.endDate,
        expectedDate: snap.expectedDate,
        restDays: snap.restDays,
        content: snap.content,
        status: snap.status,
        version: snap.version
      }
    };
  }

  async function getScheduleContext(projectId, actor) {
    check(typeof projectId === 'string' && projectId.length < 100, 'BAD_INPUT', '项目编号无效。');
    const project = await get('projects', projectId);
    check(project && project.status === 'active' && project.scope === 'identity-test', 'NO_ACCESS', '无法访问此测试项目。');
    const member = actor.isAdmin ? null : await get('project_members', `m_${hash(`${projectId}:${actor.user._id}`).slice(0, 40)}`);
    check(actor.isAdmin || (member && member.status === 'active'), 'NO_ACCESS', '当前账号不是该项目成员。');
    const isManager = actor.isAdmin ? false : member.roles.includes('管家');
    const members = await paginatedFetch('project_members', { projectId, status: 'active' });
    const workers = members
      .filter(item => item.roles.includes('师傅') && Array.isArray(item.trades) && item.trades.length > 0)
      .map(item => ({ userId: item.userId, label: `成员 ${item.userId.slice(-6)}`, roles: item.roles, trades: item.trades }));
    const trades = [...new Set(workers.reduce((all, item) => all.concat(item.trades), []))];
    return {
      project: { id: project._id, name: project.name, status: project.status },
      isManager,
      trades,
      workers
    };
  }

  function normalizeListOptions(filters = {}) {
    const options = {};
    if (filters.status === 'active' || filters.status === 'cancelled') options.status = filters.status;
    if (typeof filters.trade === 'string' && TRADES.includes(filters.trade)) options.trade = filters.trade;
    if (typeof filters.date === 'string' && parseDate(filters.date)) options.date = filters.date;
    let limit = Number(filters.limit) || DEFAULT_PAGE_LIMIT;
    if (limit < 1) limit = 1;
    if (limit > MAX_PAGE_LIMIT) limit = MAX_PAGE_LIMIT;
    options.limit = limit;
    if (typeof filters.cursor === 'string') options.cursor = filters.cursor;
    return options;
  }

  function sortByCreatedAtThenId(a, b) {
    if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
    return a._id.localeCompare(b._id);
  }

  async function listSchedules(projectId, filters = {}) {
    check(typeof projectId === 'string' && projectId.length < 100, 'BAD_INPUT', '项目编号无效。');
    const opts = normalizeListOptions(filters);

    let query = { projectId };
    if (opts.status) query.status = opts.status;
    if (opts.trade) query.trade = opts.trade;

    const all = await paginatedFetch('schedules', query, { orderBy: [{ field: 'createdAt', direction: 'asc' }, { field: '_id', direction: 'asc' }] });
    let schedules = all;

    // 按日期查询时，按安排自身日期/休息日计算，确保已取消记录仍可被查找到
    if (opts.date) {
      schedules = schedules.filter(item => {
        const days = workingDays(item.startDate, item.endDate, item.restDays || []);
        return days.includes(opts.date);
      });
    }

    // 按稳定排序内存切片分页
    schedules.sort(sortByCreatedAtThenId);
    let startIndex = 0;
    if (opts.cursor) {
      const cursorIndex = schedules.findIndex(s => s._id === opts.cursor);
      if (cursorIndex >= 0) startIndex = cursorIndex + 1;
      else {
        // cursor 不存在：返回空，避免循环或重复
        return { schedules: [], pagination: { limit: opts.limit, hasMore: false, nextCursor: null } };
      }
    }
    const page = schedules.slice(startIndex, startIndex + opts.limit + 1);
    const hasMore = page.length > opts.limit;
    const items = page.slice(0, opts.limit).map(publicSchedule);
    return {
      schedules: items,
      pagination: { limit: opts.limit, hasMore, nextCursor: hasMore ? items[items.length - 1].id : null }
    };
  }

  async function getSchedule(projectId, scheduleId) {
    check(typeof projectId === 'string' && projectId.length < 100, 'BAD_INPUT', '项目编号无效。');
    check(typeof scheduleId === 'string', 'BAD_INPUT', '安排编号无效。');
    const schedule = await get('schedules', scheduleId);
    check(schedule && schedule.projectId === projectId, 'NO_ACCESS', '找不到此安排或项目不匹配。');
    return publicSchedule(schedule);
  }

  function normalizeRevisionOptions(filters = {}) {
    const options = {};
    let limit = Number(filters.limit) || DEFAULT_PAGE_LIMIT;
    if (limit < 1) limit = 1;
    if (limit > MAX_PAGE_LIMIT) limit = MAX_PAGE_LIMIT;
    options.limit = limit;
    if (typeof filters.cursor === 'string') options.cursor = filters.cursor;
    return options;
  }

  async function listScheduleRevisions(projectId, scheduleId, filters = {}) {
    check(typeof projectId === 'string' && projectId.length < 100, 'BAD_INPUT', '项目编号无效。');
    check(typeof scheduleId === 'string', 'BAD_INPUT', '安排编号无效。');
    const schedule = await get('schedules', scheduleId);
    check(schedule && schedule.projectId === projectId, 'NO_ACCESS', '找不到此安排或项目不匹配。');
    const opts = normalizeRevisionOptions(filters);

    const all = await paginatedFetch('schedule_revisions', { scheduleId }, { orderBy: [{ field: 'afterVersion', direction: 'asc' }] });
    // 稳定排序：优先 afterVersion；兼容旧 revision 缺少 afterVersion 的情况（实际不会出现）
    all.sort((a, b) => {
      const av = a.afterVersion !== undefined ? a.afterVersion : (a.beforeVersion !== undefined ? a.beforeVersion : (a.version || 0));
      const bv = b.afterVersion !== undefined ? b.afterVersion : (b.beforeVersion !== undefined ? b.beforeVersion : (b.version || 0));
      return av - bv;
    });

    let startIndex = 0;
    if (opts.cursor) {
      const cursorIndex = all.findIndex(r => String(r.afterVersion !== undefined ? r.afterVersion : (r.beforeVersion !== undefined ? r.beforeVersion : (r.version || 0))) === opts.cursor);
      if (cursorIndex >= 0) startIndex = cursorIndex + 1;
      else {
        return { revisions: [], pagination: { limit: opts.limit, hasMore: false, nextCursor: null } };
      }
    }
    const page = all.slice(startIndex, startIndex + opts.limit + 1);
    const hasMore = page.length > opts.limit;
    const items = page.slice(0, opts.limit).map(publicRevision);
    return {
      revisions: items,
      pagination: { limit: opts.limit, hasMore, nextCursor: hasMore ? String(items[items.length - 1].afterVersion) : null }
    };
  }

  async function fetchAll(name, query, opts = {}) {
    // 模拟真实环境：受 SDK 单次上限限制，超过一页时递归 skip 取后续页
    // 事务内调用必须传入 opts.source = tx，确保读到事务视图
    const source = opts.source || db;
    const result = [];
    let skip = 0;
    while (true) {
      const pageOpts = { limit: DB_PAGE_LIMIT, skip, orderBy: [{ field: '_id', direction: 'asc' }] };
      const page = await find(name, query, source, pageOpts);
      if (!page.length) break;
      result.push(...page);
      if (page.length < DB_PAGE_LIMIT) break;
      skip += page.length;
    }
    return result;
  }

  async function paginatedFetch(name, query, opts = {}) {
    // 返回按稳定排序的完整结果（在本地测试中受 DB_PAGE_LIMIT 分页模拟）
    // 事务内调用必须传入 opts.source = tx
    const source = opts.source || db;
    const orderBy = opts.orderBy || [{ field: '_id', direction: 'asc' }];
    const result = [];
    let skip = 0;
    while (true) {
      const pageOpts = { limit: DB_PAGE_LIMIT, skip, orderBy };
      const page = await find(name, query, source, pageOpts);
      if (!page.length) break;
      result.push(...page);
      if (page.length < DB_PAGE_LIMIT) break;
      skip += page.length;
    }
    return result;
  }

  function validateForm(form, expectedConfirmed) {
    check(form && typeof form === 'object', 'BAD_INPUT', '表单数据无效。');
    check(STAGES.includes(form.stage), 'BAD_INPUT', '请选择施工阶段。');
    check(TRADES.includes(form.trade), 'BAD_INPUT', '请选择有效工种。');
    check(typeof form.content === 'string' && form.content.trim().length > 0 && form.content.length <= MAX_CONTENT_LENGTH,
      'BAD_INPUT', '请填写本次施工内容（最多 500 字）。');
    const startDate = parseDate(form.startDate);
    const endDate = parseDate(form.endDate);
    const expectedDate = parseDate(form.expectedDate);
    check(startDate && endDate && startDate <= endDate, 'BAD_INPUT', '施工结束日期不能早于开始日期。');
    check(expectedDate && expectedDate >= startDate, 'BAD_INPUT', '预计完成日期不能早于开始日期。');
    const rangeDays = Math.round((endDate - startDate) / (24 * 60 * 60 * 1000)) + 1;
    check(rangeDays <= MAX_RANGE_DAYS, 'SCHEDULE_RANGE_TOO_LONG', `施工日期范围不能超过 ${MAX_RANGE_DAYS} 天。`);
    check(Array.isArray(form.restDays), 'BAD_INPUT', '休息／停工日期须为数组。');
    check(form.restDays.every(date => typeof date === 'string'), 'BAD_INPUT', '休息／停工日期须为字符串。');
    const restDays = [...new Set(form.restDays)].filter(date => typeof date === 'string').sort();
    check(restDays.every(date => {
      const d = parseDate(date);
      return d && d >= startDate && d <= endDate;
    }), 'BAD_INPUT', '休息／停工日期必须在施工日期范围内。');
    const days = workingDays(form.startDate, form.endDate, restDays);
    check(days.length > 0, 'SCHEDULE_NO_WORKING_DAY', '排除休息日后没有实际施工日，请调整日期。');
    if (expectedDate.getTime() !== endDate.getTime()) {
      check(expectedConfirmed === true, 'EXPECTED_DATE_MISMATCH', '预计完成日期与结束日期不同，请确认。');
    }
    return { restDays, days };
  }

  async function validateWorker(tx, projectId, workerUserId, trade) {
    const user = await get('users', workerUserId, tx);
    check(user && user.status === 'active', 'WORKER_INVALID', '责任人账号不可用。');
    const member = await get('project_members', `m_${hash(`${projectId}:${workerUserId}`).slice(0, 40)}`, tx);
    check(member && member.status === 'active' && member.roles.includes('师傅'),
      'WORKER_INVALID', '责任人须为当前项目有效师傅。');
    check(Array.isArray(member.trades) && member.trades.includes(trade),
      'WORKER_INVALID', '责任人须具备对应工种。');
    return member;
  }

  async function verifyActorInTransaction(tx, actor, projectId) {
    // 事务内重新复核执行人账号状态、项目可用性、成员管家权限
    const actorUser = await get('users', actor.user._id, tx);
    check(actorUser && actorUser.status === 'active', 'IDENTITY_DISABLED', '当前微信账号已停用，无法执行此操作。');
    const project = await get('projects', projectId, tx);
    check(project && project.status === 'active' && project.scope === 'identity-test', 'NO_ACCESS', '项目不可用。');
    const member = await get('project_members', memberKey(projectId, actor.user._id), tx);
    check(member && member.status === 'active' && member.roles.includes('管家'),
      'NO_ACCESS', '仅项目管家可维护施工安排。');
    return { project, member };
  }

  // ===== 项目模式 / schema / epoch =====
  // projects 字段缺失视为未就绪；这会阻止未准备项目的所有写动作（含 removeMember）
  function assertProjectWritable(project) {
    check(project, 'NO_ACCESS', '项目不可用。');
    if (project.scheduleWriteMode !== 'ready') {
      throw new AppError('PROJECT_NOT_WRITABLE', '项目当前处于维护或未就绪状态，暂不能提交写操作，请联系管理员。');
    }
    if (!isPositiveInt(project.scheduleSchemaVersion)) {
      throw new AppError('PROJECT_NOT_WRITABLE', '项目尚未完成施工安排结构准备，请联系管理员。');
    }
    if (project.scheduleSchemaVersion < TASK_DIR_SCHEMA_VERSION) {
      throw new AppError('PROJECT_NOT_WRITABLE', '项目施工安排结构版本较旧，需先完成迁移，请联系管理员。');
    }
    if (!isNonNegativeInt(project.scheduleEpoch)) {
      throw new AppError('PROJECT_NOT_WRITABLE', '项目并发版本缺失或不合法，请联系管理员。');
    }
    return project.scheduleEpoch;
  }

  // 维护切换也写同一 projects 文档，与业务事务形成真实写冲突
  async function bumpProjectEpoch(tx, projectId, expectedEpoch) {
    const project = await get('projects', projectId, tx);
    if (expectedEpoch !== undefined) {
      check(project.scheduleEpoch === expectedEpoch, 'STALE_SCAN', '项目并发版本已变化，请重试。');
    }
    await update('projects', projectId, {
      scheduleEpoch: (project.scheduleEpoch || 0) + 1,
      version: (project.version || 0) + 1
    }, tx);
  }

  // U2 维护切换：必须接收执行人，并在事务内重新核验账号状态、角色与项目有效范围。
  // 不能凭事务外的旧身份切换，也不能由不带执行人的内部调用绕过鉴权。
  // 恢复 ready 一律封闭：就绪核验/迁移流程尚未实现，普通接口不得放行，
  // 拒绝后项目必须仍停留在 maintenance（不写任何字段）。
  async function setMaintenanceMode(projectId, mode, actor) {
    check(mode === 'ready' || mode === 'maintenance', 'BAD_INPUT', '模式须为 ready 或 maintenance。');
    if (mode === 'ready') {
      throw new AppError('MAINTENANCE_RESTORE_BLOCKED',
        '项目结构核验与迁移流程尚未接入，本接口不接受恢复可写；请联系管理员在核验完成后重新开放。');
    }
    return transaction(async tx => {
      // 事务内重新鉴权：账号仍启用、仍是对应项目的管家、项目仍有效且范围正确
      const { project } = await verifyActorInTransaction(tx, actor, projectId);
      // 幂等：已处于目标模式时不重复递增 epoch，也不产生额外写入
      if (project.scheduleWriteMode === mode) {
        return { projectId, scheduleWriteMode: mode, scheduleEpoch: project.scheduleEpoch, changed: false };
      }
      await update('projects', projectId, {
        scheduleWriteMode: mode,
        scheduleEpoch: (project.scheduleEpoch || 0) + 1,
        version: (project.version || 0) + 1,
        updatedAt: at(now)
      }, tx);
      return { projectId, scheduleWriteMode: mode, scheduleEpoch: (project.scheduleEpoch || 0) + 1, changed: true };
    });
  }

  // 事务外读取项目写策略与 epoch
  async function readProjectWriteState(projectId) {
    const project = await get('projects', projectId);
    check(project && project.status === 'active' && project.scope === 'identity-test', 'NO_ACCESS', '项目不可用。');
    assertProjectWritable(project);
    return { epoch: project.scheduleEpoch };
  }

  // ===== 月度桶占用 =====
  function monthOf(date) { return date.slice(0, 7).replace('-', ''); }
  function bucketKey(projectId, trade, date) { return `${projectId}:${trade}:${monthOf(date)}`; }
  function monthsBetween(days) {
    return [...new Set(days.map(monthOf))].sort();
  }

  // 桶结构校验：date/month/key/projectId/trade 互相匹配，非法键或超 31 合法日内容拒绝
  function validateBucket(bucket, projectId, trade, month) {
    if (!bucket) return null;
    if (bucket[OCCUPANCY_SCHEMA_FIELD] !== OCCUPANCY_SCHEMA_VERSION) {
      throw new AppError('OCCUPANCY_INCONSISTENT', '占用记录结构版本不符，请联系管理员核对。');
    }
    if (bucket.projectId !== projectId || bucket.trade !== trade || bucket.month !== month) {
      throw new AppError('OCCUPANCY_INCONSISTENT', '占用记录归属不符，请联系管理员核对。');
    }
    const days = bucket.days;
    if (!days || typeof days !== 'object' || Array.isArray(days)) {
      throw new AppError('OCCUPANCY_INCONSISTENT', '占用记录日映射不合法。');
    }
    for (const [date, holder] of Object.entries(days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parseDate(date)) {
        throw new AppError('OCCUPANCY_INCONSISTENT', `占用记录日期键不合法：${date}`);
      }
      if (monthOf(date) !== month) {
        throw new AppError('OCCUPANCY_INCONSISTENT', `占用记录日期与月份不符：${date}`);
      }
      if (typeof holder !== 'string' || !holder) {
        throw new AppError('OCCUPANCY_INCONSISTENT', `占用记录归属编号不合法：${date}`);
      }
    }
    return days;
  }

  // 读取旧/新桶并集，返回 Map<bucketKey, {trade, month, days}>
  // T2：以 (projectId, trade, month) 完整键建并集；旧工种只取旧日期所需桶，新工种只取新日期所需桶
  async function readBucketsForKeys(tx, projectId, keys) {
    const map = new Map();
    for (const { trade, month } of keys) {
      const id = `${projectId}:${trade}:${month}`;
      if (map.has(id)) continue; // 同键去重，每桶只读一次
      const bucket = await get('schedule_occupancy', id, tx);
      const days = validateBucket(bucket, projectId, trade, month);
      map.set(id, { trade, month, days: days ? { ...days } : {}, existed: !!bucket });
    }
    return map;
  }

  // 读取单一工种+日期集合所需桶
  async function readBuckets(tx, projectId, trade, daysList) {
    const keys = monthsBetween(daysList.flat()).map(month => ({ trade, month }));
    return await readBucketsForKeys(tx, projectId, keys);
  }

  // T2：建立旧/新实际占用的完整桶键并集
  // 旧工种只取旧日期所需桶，新工种只取新日期所需桶；同键去重，不做"所有工种×所有月份"的扩大
  function buildBucketKeys(projectId, { oldDays, oldTrade, newDays, newTrade }) {
    const keys = [];
    const seen = new Set();
    const add = (trade, dayList) => {
      for (const month of monthsBetween(dayList || [])) {
        const id = `${projectId}:${trade}:${month}`;
        if (seen.has(id)) continue;
        seen.add(id);
        keys.push({ trade, month });
      }
    };
    add(oldTrade, oldDays);
    add(newTrade, newDays);
    return keys;
  }

  // 内存合并：先释放本安排旧日期，再获取新日期；缺失或异主占用同样视为不一致
  function mergeBuckets(bucketMap, { oldDays, oldTrade, newDays, newTrade, scheduleId, projectId }) {
    const release = (trade, days) => {
      if (!days || !days.length) return;
      for (const date of days) {
        const month = monthOf(date);
        const id = `${projectId}:${trade}:${month}`;
        const entry = bucketMap.get(id);
        if (!entry) throw new AppError('OCCUPANCY_INCONSISTENT', `占用记录缺失：${date}，请联系管理员核对。`);
        const holder = entry.days[date];
        // 缺失与异主占用同样属于不一致，不得静默继续
        if (holder === undefined) {
          throw new AppError('OCCUPANCY_INCONSISTENT', `占用记录缺失：${date}，请联系管理员核对。`);
        }
        if (holder !== scheduleId) {
          throw new AppError('OCCUPANCY_INCONSISTENT', `占用记录归属不符：${date}，请联系管理员核对。`);
        }
        delete entry.days[date];
      }
    };
    const acquire = (trade, days) => {
      if (!days || !days.length) return;
      for (const date of days) {
        const month = monthOf(date);
        const id = `${projectId}:${trade}:${month}`;
        const entry = bucketMap.get(id);
        if (!entry) throw new AppError('OCCUPANCY_INCONSISTENT', `占用记录缺失：${date}，请联系管理员核对。`);
        const holder = entry.days[date];
        if (holder !== undefined && holder !== scheduleId) {
          throw new AppError('SCHEDULE_CONFLICT', `该工种 ${date} 已有有效安排。`);
        }
        entry.days[date] = scheduleId;
      }
    };
    if (oldDays && oldDays.length) release(oldTrade, oldDays);
    if (newDays && newDays.length) acquire(newTrade, newDays);
    return bucketMap;
  }

  // 写回：每桶写一次；空桶统一保留（写空 days）
  // T3：复用 readBucketsForKeys 已读到的存在性，不再二次读桶（每桶 1 读 1 写）
  async function writeBuckets(tx, projectId, bucketMap) {
    for (const [id, entry] of bucketMap) {
      const payload = {
        [OCCUPANCY_SCHEMA_FIELD]: OCCUPANCY_SCHEMA_VERSION,
        projectId, trade: entry.trade, month: entry.month, days: entry.days, updatedAt: at(now)
      };
      if (entry.existed) await update('schedule_occupancy', id, payload, tx);
      else await add('schedule_occupancy', { _id: id, ...payload }, tx);
    }
  }

  // ===== 预算 =====
  // U3 逐动作预算预检：在首个数据写之前判定，作为第二层计数保护之外的提前拦截。
  //
  // 计数口径（与产品计数完全一致）：
  //   · 每类文档的读/写各计 1 次；wrapTx 只缓存集合包装对象，不缓存文档读取结果，
  //     因此同一 attempt 内对同一文档的重复 get 也各计 1 次。
  //   · 桶按完整键 (projectId, trade, month) 计数，每桶读一次 + 写一次；
  //     writeBuckets 复用 readBucketsForKeys 已读到的存在性，不再二次读。
  //
  // 取值方式：下列固定开销不是估算，而是 T3d 分支测量中各动作**实测最大 base**
  // （已扣除桶操作），逐分支取最大值得到，因此预检值是真实上界而非低估值：
  //   create      首用 18 / 已初始化 17  -> 18
  //   update      不换人 18 / 换人 23     -> 18 (+5 换人)
  //   reassign    23（双方锚点 + 双方 guard 读写）
  //   cancel      16
  //   removeMember 13
  const FIXED_CREATE = 18;
  const FIXED_UPDATE_BASE = 18;
  const UPDATE_WORKER_CHANGED_EXTRA = 5; // 新责任人的锚点读 + guard 读写 + 成员重读
  const FIXED_REASSIGN = 23;
  const FIXED_CANCEL = 16;
  const FIXED_REMOVE_MEMBER = 13;

  function countBucketOps(bucketKeyCount) { return bucketKeyCount * 2; } // 每桶读一次 + 写一次

  function computeBudget(action, ctx) {
    switch (action) {
      case 'createSchedule':
        return FIXED_CREATE + countBucketOps(ctx.bucketKeyCount || 0);
      case 'updateSchedule':
        return FIXED_UPDATE_BASE + (ctx.workerChanged ? UPDATE_WORKER_CHANGED_EXTRA : 0) +
          countBucketOps(ctx.bucketKeyCount || 0);
      case 'reassignSchedule':
        return FIXED_REASSIGN;
      case 'cancelSchedule':
        return FIXED_CANCEL + countBucketOps(ctx.bucketKeyCount || 0);
      case 'removeMember':
        return FIXED_REMOVE_MEMBER;
      default:
        // 未知动作按最大固定开销 + 最大单侧桶数保守估计
        return FIXED_REASSIGN + countBucketOps(MAX_MONTHS_SINGLE);
    }
  }

  function assertWithinBudget(action, ctx) {
    const ops = computeBudget(action, ctx);
    if (ops > TXN_OP_BUDGET) {
      throw new AppError('SCHEDULE_OPERATION_BUDGET_EXCEEDED',
        `本次提交预计需要 ${ops} 次数据操作，超过单次事务上限 ${TXN_OP_BUDGET} 次，请缩短施工日期范围或改派后重试。`);
    }
    return ops;
  }

  async function writeRevision(tx, scheduleId, projectId, beforeVersion, afterVersion, changeType, reason, snapshot, actor) {
    await add('schedule_revisions', {
      _id: nextId('sr'),
      scheduleId,
      projectId,
      beforeVersion,
      afterVersion,
      version: beforeVersion, // 保留兼容旧字段
      changeType,
      reason: reason || '',
      snapshot,
      actorUserId: actor.user._id,
      actorRole: actor.role,
      actorLabel: `成员 ${actor.user._id.slice(-6)}`,
      createdAt: at(now)
    }, tx);
  }

  function snapshotWithoutHistory(schedule) {
    const copy = { ...schedule };
    delete copy._openid;
    return copy;
  }

  function scheduleUpdatePatch(current, form, restDays, actor, timestamp, nextVersion) {
    return {
      stage: form.stage,
      trade: form.trade,
      workerUserId: form.workerUserId,
      startDate: form.startDate,
      endDate: form.endDate,
      expectedDate: form.expectedDate,
      restDays,
      content: form.content.trim(),
      version: nextVersion,
      updatedAt: timestamp,
      updatedByUserId: actor.user._id,
      updatedByRole: actor.role
    };
  }

  // ===== 两轮扫描外层控制 =====
  // T6 回执优先：先在独立事务内核验可信身份、项目权限与维护策略，
  // 再优先处理已有回执。回放不依赖新写所需的目录/容量/旧业务版本。
  // 新请求才进入完整的扫描/预算/业务检查（runWithScanRounds）。
  async function tryReceiptReplay({ projectId, requestId, payload, actor }) {
    return await transaction(async tx => {
      // 事务内核对当前身份与项目权限（含维护策略），确保失权与维护状态不被回放绕过
      const { project } = await verifyActorInTransaction(tx, actor, projectId);
      assertProjectWritable(project);
      // 再核验幂等回执：已有则直接返回原结果
      const previousResult = await checkIdempotency(tx, requestId, payload, actor);
      return previousResult || null;
    });
  }

  // 写动作统一入口：先尝试回执优先路径；无回执才进入两轮扫描的完整检查
  async function withReceiptFirst(options) {
    const replayed = await tryReceiptReplay(options);
    if (replayed) return replayed;
    return await runWithScanRounds({
      collect: options.collect,
      run: options.run
    });
  }

  // 每次逻辑请求最多 MAX_SCAN_ROUNDS 轮（1 初扫 + 1 重扫）；双方责任人的采集算同一轮。
  // STALE_SCAN 退出当前事务后在外层重新采集全部前置状态（不只重查 schedules）。
  // 事务回调重入时前置围栏不符立即抛业务停止码，不会被误当作事务冲突自动重试。
  // T5：collect 期的结构判定也必须以版本稳定性为依据；采集期出现版本矛盾时
  // 抛 STALE_SCAN 进入同一最多两轮预算，而不是在 collect 外直接结束请求。
  async function runWithScanRounds(handler) {
    let lastError = null;
    for (let round = 1; round <= MAX_SCAN_ROUNDS; round++) {
      let snapshot;
      try {
        snapshot = await handler.collect(round);
      } catch (error) {
        // 采集期的版本矛盾（混合快照）视为过期，进入下一轮重采
        if (error && error.code === 'STALE_SCAN') { lastError = error; continue; }
        throw error;
      }
      try {
        return await transaction(tx => handler.run(tx, snapshot, round));
      } catch (error) {
        if (error && error.code === 'STALE_SCAN') { lastError = error; continue; }
        throw error;
      }
    }
    throw lastError || new AppError('STALE_SCAN', '并发变化过多，请稍后重试。');
  }

  // 采集一次前置状态：项目写策略 + 相关成员锚点/guard + 实际安排有界扫描
  // T1：first-use 也必须做真实有界扫描，不能假定没有安排
  // T5：读取锚点与 guard 之间若发生版本矛盾，按 STALE_SCAN 处理
  async function collectPreconditions(projectId, userIds) {
    const projectState = await readProjectWriteState(projectId);
    const dirs = new Map();
    for (const userId of userIds) {
      const pre = await readDirPrecondition(projectId, userId);
      // 先记录扫描前的围栏与代际，再扫描；扫描后复核，确保不是混合快照
      const fenceBefore = pre.guard ? pre.guard[GUARD_FENCE_FIELD] : null;
      const genBefore = pre.guard ? pre.guard[GUARD_GENERATION_FIELD] : null;
      // T1：无论是否首次使用，都做真实有界扫描
      const scanned = await scanActiveSchedules(projectId, userId);
      // 扫描期间若目录被建立/删除/变更，按过期处理交外层重采
      const post = await readDirPrecondition(projectId, userId);
      const fenceAfter = post.guard ? post.guard[GUARD_FENCE_FIELD] : null;
      const genAfter = post.guard ? post.guard[GUARD_GENERATION_FIELD] : null;
      if (fenceBefore !== fenceAfter || genBefore !== genAfter) {
        throw new AppError('STALE_SCAN', '任务目录在采集期间已变化，请重试。');
      }
      // 结构判定放在复核之后；此时若出现"未初始化却有目录"等确属损坏的情形才拒绝
      const state = classifyDirState(post);
      dirs.set(userId, {
        pre: post, state, scanned,
        fence: fenceAfter
      });
    }
    return { epoch: projectState.epoch, dirs };
  }

  // 事务内复核：先判过期（STALE_SCAN），仅在围栏确认未变时判一致性（GUARD_INCONSISTENT）
  // T1：first-use 也必须确认真实集合为空，才允许建立空目录
  async function verifyPreconditions(tx, projectId, snapshot, userIds) {
    const project = await get('projects', projectId, tx);
    check(project && project.status === 'active' && project.scope === 'identity-test', 'NO_ACCESS', '项目不可用。');
    assertProjectWritable(project);
    check(project.scheduleEpoch === snapshot.epoch, 'STALE_SCAN', '项目并发版本已变化，请重试。');
    for (const userId of userIds) {
      const snap = snapshot.dirs.get(userId);
      const txPre = await readDirPreconditionInTx(tx, projectId, userId);
      assertDirPairing(snap, txPre);
      const state = classifyDirState(txPre);
      if (state === 'ready') {
        // 仅当围栏确认未变，才判目录与实际集合是否一致
        assertDirMatchesScan(txPre, snap.scanned);
      } else if (snap.scanned.length !== 0) {
        // T1：未初始化却已有 active 安排，停止；不得建立覆盖事实的空目录
        throw new AppError('GUARD_INCONSISTENT',
          '该成员尚有未取消的施工安排，任务目录未初始化，请联系管理员核对。');
      }
    }
    return project;
  }

  async function readDirPreconditionInTx(tx, projectId, userId) {
    const member = await get('project_members', memberKey(projectId, userId), tx);
    const anchor = anchorState(member);
    const guard = readGuardDoc(await get('member_task_guard', guardKey(projectId, userId), tx));
    return { member, anchor, guard };
  }

  // 目录变更统一入口：首用建档 / 已有目录围栏递增
  // 首次使用时目录为空，本次新增的唯一条目即该安排本身，属合法首建
  async function applyDirChange(tx, projectId, userId, snap, nextIds) {
    if (snap.state === 'first-use') {
      await initDir(tx, projectId, userId, nextIds);
      return nextIds;
    }
    assertCapacity(snap.pre.guard[GUARD_IDS_FIELD], nextIds);
    return await writeDir(tx, projectId, userId, snap.fence, nextIds);
  }

  async function createSchedule(projectId, requestId, form, actor, options = {}) {
    check(typeof requestId === 'string' && requestId.length > 0, 'BAD_INPUT', '提交编号缺失。');
    const payload = { projectId, action: 'createSchedule', form: sanitizeForm(form), expectedConfirmed: options.expectedConfirmed === true };
    const { restDays, days } = validateForm(form, options.expectedConfirmed);
    // 桶键按 (trade, month) 完整键计数：create 只涉及单一工种
    const bucketKeys = buildBucketKeys(projectId, { newDays: days, newTrade: form.trade });
    check(bucketKeys.length <= MAX_MONTHS_SINGLE, 'SCHEDULE_RANGE_TOO_LONG', '施工日期跨月过多，请缩短范围。');
    return withReceiptFirst({
      projectId, requestId, payload, actor,
      collect: () => collectPreconditions(projectId, [form.workerUserId]),
      run: async (tx, snapshot) => {
        // U1：实际写事务内必须重新核验回执。同号并发的两个请求可能都先在快速路径
        // 查到"无回执"，因此本事务在身份/权限/维护核验之后、目录/容量/业务版本/
        // 占用检查之前再查一次：命中即返回原成功结果，不把已成功的提交报成业务失败。
        // 同号不同载荷、失权与维护状态仍由 checkIdempotency / assertProjectWritable 拒绝。
        const { project: writeProject } = await verifyActorInTransaction(tx, actor, projectId);
        assertProjectWritable(writeProject);
        const committed = await checkIdempotency(tx, requestId, payload, actor);
        if (committed) return committed;
        await verifyPreconditions(tx, projectId, snapshot, [form.workerUserId]);
        await validateWorker(tx, projectId, form.workerUserId, form.trade);
        // 预算预检：必须在首个数据写之前
        assertWithinBudget('createSchedule', { bucketKeyCount: bucketKeys.length });
        await bumpProjectEpoch(tx, projectId, snapshot.epoch);
        const snap = snapshot.dirs.get(form.workerUserId);
        const scheduleId = nextId('s');
        const nextIds = snap.state === 'first-use' ? [scheduleId] : [...snap.pre.guard[GUARD_IDS_FIELD], scheduleId];
        const timestamp = at(now);
        const schedule = {
          _id: scheduleId, projectId,
          stage: form.stage, trade: form.trade, workerUserId: form.workerUserId,
          startDate: form.startDate, endDate: form.endDate, expectedDate: form.expectedDate,
          restDays, content: form.content.trim(), status: 'active', version: 1,
          createdAt: timestamp, updatedAt: timestamp,
          createdByUserId: actor.user._id, updatedByUserId: actor.user._id,
          createdByRole: actor.role, updatedByRole: actor.role
        };
        // 先建立/更新目录，再写安排；首用时原子建立 generation=1 的 guard 与锚点
        await applyDirChange(tx, projectId, form.workerUserId, snap, nextIds);
        await add('schedules', schedule, tx);
        await writeRevision(tx, scheduleId, projectId, 0, 1, 'create', '', snapshotWithoutHistory(schedule), actor);
        const buckets = await readBuckets(tx, projectId, form.trade, days);
        mergeBuckets(buckets, { newDays: days, newTrade: form.trade, scheduleId, projectId });
        await writeBuckets(tx, projectId, buckets);
        if (audit) await audit(tx, actor.user, actor.role, 'createSchedule', projectId, form.workerUserId, null, { scheduleId, trade: form.trade });
        const result = { scheduleId, version: 1, status: 'active' };
        await saveReceipt(tx, requestId, payload, result, actor);
        return result;
      }
    });
  }

  async function updateSchedule(projectId, scheduleId, expectedVersion, requestId, form, reason, actor, options = {}) {
    check(typeof requestId === 'string' && requestId.length > 0, 'BAD_INPUT', '提交编号缺失。');
    check(typeof reason === 'string' && reason.trim().length > 0 && reason.length <= MAX_REASON_LENGTH,
      'BAD_INPUT', '请填写调整原因（1-200 字）。');
    const payload = { projectId, scheduleId, action: 'updateSchedule', form: sanitizeForm(form), reason, expectedVersion, expectedConfirmed: options.expectedConfirmed === true };
    const { restDays, days } = validateForm(form, options.expectedConfirmed);
    const outside = await get('schedules', scheduleId);
    check(outside && outside.projectId === projectId, 'NO_ACCESS', '找不到此安排或项目不匹配。');
    const outsideWorker = outside.workerUserId;
    const workerChanged = outsideWorker !== form.workerUserId;
    const tradeChanged = outside.trade !== form.trade;
    const oldDaysOutside = workingDays(outside.startDate, outside.endDate, outside.restDays || []);
    const daysChanged = outside.startDate !== form.startDate || outside.endDate !== form.endDate || !sameRestDays(outside.restDays, restDays);
    // 旧新桶并集：日期或工种变化时涉及，最多 26 个
    let bucketKeyCount = 0;
    if (daysChanged || tradeChanged) {
      // T3：按完整桶键 (projectId, trade, month) 计数，同月不同工种算两个键
      const keys = buildBucketKeys(projectId, {
        oldDays: oldDaysOutside, oldTrade: outside.trade, newDays: days, newTrade: form.trade
      });
      bucketKeyCount = keys.length;
      check(bucketKeyCount <= MAX_BUCKET_UNION, 'SCHEDULE_RANGE_TOO_LONG', '施工日期跨月过多，请缩短范围。');
    }
    const userIds = workerChanged ? [outsideWorker, form.workerUserId] : [outsideWorker];
    return withReceiptFirst({
      projectId, requestId, payload, actor,
      collect: () => collectPreconditions(projectId, userIds),
      run: async (tx, snapshot) => {
        // U1：实际写事务内必须重新核验回执。同号并发的两个请求可能都先在快速路径
        // 查到"无回执"，因此本事务在身份/权限/维护核验之后、目录/容量/业务版本/
        // 占用检查之前再查一次：命中即返回原成功结果，不把已成功的提交报成业务失败。
        // 同号不同载荷、失权与维护状态仍由 checkIdempotency / assertProjectWritable 拒绝。
        const { project: writeProject } = await verifyActorInTransaction(tx, actor, projectId);
        assertProjectWritable(writeProject);
        const committed = await checkIdempotency(tx, requestId, payload, actor);
        if (committed) return committed;
        const live = await get('schedules', scheduleId, tx);
        check(live && live.projectId === projectId, 'NO_ACCESS', '找不到此安排或项目不匹配。');
        check(live.status === 'active', 'BAD_INPUT', '已取消的安排不能调整。');
        check(live.version === expectedVersion, 'VERSION_MISMATCH', '安排已变化，请重新加载后编辑。');
        // 预算须在读到权威版本之后、首个数据写之前判定
        assertWithinBudget('updateSchedule', { bucketKeyCount, workerChanged });
        await verifyPreconditions(tx, projectId, snapshot, userIds);
        await validateWorker(tx, projectId, form.workerUserId, form.trade);
        await bumpProjectEpoch(tx, projectId, snapshot.epoch);
        const oldSnapshot = snapshotWithoutHistory(live);
        const nextVersion = live.version + 1;
        const patch = scheduleUpdatePatch(live, form, restDays, actor, at(now), nextVersion);
        const oldDays = workingDays(live.startDate, live.endDate, live.restDays || []);
        const liveWorkerChanged = live.workerUserId !== form.workerUserId;
        const liveTradeChanged = live.trade !== form.trade;
        const liveDaysChanged = live.startDate !== form.startDate || live.endDate !== form.endDate || !sameRestDays(live.restDays, restDays);
        if (liveWorkerChanged) {
          const oldSnap = snapshot.dirs.get(live.workerUserId);
          const newSnap = snapshot.dirs.get(form.workerUserId);
          await applyDirChange(tx, projectId, live.workerUserId, oldSnap,
            oldSnap.pre.guard ? oldSnap.pre.guard[GUARD_IDS_FIELD].filter(id => id !== scheduleId) : []);
          await applyDirChange(tx, projectId, form.workerUserId, newSnap,
            newSnap.pre.guard ? [...newSnap.pre.guard[GUARD_IDS_FIELD], scheduleId] : [scheduleId]);
        } else {
          // 仅改内容/日期/工种也递增围栏，防止分页漏读被静默接受
          const selfSnap = snapshot.dirs.get(live.workerUserId);
          await applyDirChange(tx, projectId, live.workerUserId, selfSnap,
            selfSnap.pre.guard ? [...selfSnap.pre.guard[GUARD_IDS_FIELD]] : []);
        }
        await update('schedules', scheduleId, patch, tx);
        const updated = { ...live, ...patch };
        await writeRevision(tx, scheduleId, projectId, live.version, nextVersion, 'update', reason.trim(), oldSnapshot, actor);
        if (liveDaysChanged || liveTradeChanged) {
          // T2：以 (projectId, trade, month) 完整键建并集；旧工种取旧日期桶、新工种取新日期桶
          const keys = buildBucketKeys(projectId, {
            oldDays, oldTrade: live.trade, newDays: days, newTrade: form.trade
          });
          const buckets = await readBucketsForKeys(tx, projectId, keys);
          mergeBuckets(buckets, {
            oldDays, oldTrade: live.trade, newDays: days, newTrade: form.trade, scheduleId, projectId
          });
          await writeBuckets(tx, projectId, buckets);
        }
        if (audit) await audit(tx, actor.user, actor.role, 'updateSchedule', projectId, form.workerUserId, oldSnapshot, snapshotWithoutHistory(updated));
        const result = { scheduleId, version: nextVersion, status: updated.status };
        await saveReceipt(tx, requestId, payload, result, actor);
        return result;
      }
    });
  }

  async function reassignSchedule(projectId, scheduleId, expectedVersion, requestId, workerUserId, reason, actor) {
    check(typeof requestId === 'string' && requestId.length > 0, 'BAD_INPUT', '提交编号缺失。');
    check(typeof reason === 'string' && reason.trim().length > 0 && reason.length <= MAX_REASON_LENGTH,
      'BAD_INPUT', '请填写改派原因（1-200 字）。');
    const payload = { projectId, scheduleId, action: 'reassignSchedule', workerUserId, reason, expectedVersion };
    const outside = await get('schedules', scheduleId);
    check(outside && outside.projectId === projectId, 'NO_ACCESS', '找不到此安排或项目不匹配。');
    const userIds = [outside.workerUserId, workerUserId];
    return withReceiptFirst({
      projectId, requestId, payload, actor,
      collect: () => collectPreconditions(projectId, userIds),
      run: async (tx, snapshot) => {
        // U1：实际写事务内必须重新核验回执。同号并发的两个请求可能都先在快速路径
        // 查到"无回执"，因此本事务在身份/权限/维护核验之后、目录/容量/业务版本/
        // 占用检查之前再查一次：命中即返回原成功结果，不把已成功的提交报成业务失败。
        // 同号不同载荷、失权与维护状态仍由 checkIdempotency / assertProjectWritable 拒绝。
        const { project: writeProject } = await verifyActorInTransaction(tx, actor, projectId);
        assertProjectWritable(writeProject);
        const committed = await checkIdempotency(tx, requestId, payload, actor);
        if (committed) return committed;
        const live = await get('schedules', scheduleId, tx);
        check(live && live.projectId === projectId, 'NO_ACCESS', '找不到此安排或项目不匹配。');
        check(live.status === 'active', 'BAD_INPUT', '已取消的安排不能改派。');
        check(live.version === expectedVersion, 'VERSION_MISMATCH', '安排已变化，请重新加载后编辑。');
        check(live.workerUserId !== workerUserId, 'BAD_INPUT', '新责任人不能与当前责任人相同。');
        assertWithinBudget('reassignSchedule', {});
        await verifyPreconditions(tx, projectId, snapshot, userIds);
        await validateWorker(tx, projectId, workerUserId, live.trade);
        await bumpProjectEpoch(tx, projectId, snapshot.epoch);
        const oldSnap = snapshot.dirs.get(live.workerUserId);
        const newSnap = snapshot.dirs.get(workerUserId);
        await applyDirChange(tx, projectId, live.workerUserId, oldSnap,
          oldSnap.pre.guard ? oldSnap.pre.guard[GUARD_IDS_FIELD].filter(id => id !== scheduleId) : []);
        await applyDirChange(tx, projectId, workerUserId, newSnap,
          newSnap.pre.guard ? [...newSnap.pre.guard[GUARD_IDS_FIELD], scheduleId] : [scheduleId]);
        const oldSnapshot = snapshotWithoutHistory(live);
        const nextVersion = live.version + 1;
        const patch = { workerUserId, version: nextVersion, updatedAt: at(now), updatedByUserId: actor.user._id, updatedByRole: actor.role };
        await update('schedules', scheduleId, patch, tx);
        const updated = { ...live, ...patch };
        await writeRevision(tx, scheduleId, projectId, live.version, nextVersion, 'reassign', reason.trim(), oldSnapshot, actor);
        if (audit) await audit(tx, actor.user, actor.role, 'reassignSchedule', projectId, workerUserId, oldSnapshot, snapshotWithoutHistory(updated));
        const result = { scheduleId, version: nextVersion, status: updated.status };
        await saveReceipt(tx, requestId, payload, result, actor);
        return result;
      }
    });
  }

  async function cancelSchedule(projectId, scheduleId, expectedVersion, requestId, reason, actor) {
    check(typeof requestId === 'string' && requestId.length > 0, 'BAD_INPUT', '提交编号缺失。');
    check(typeof reason === 'string' && reason.trim().length > 0 && reason.length <= MAX_REASON_LENGTH,
      'BAD_INPUT', '请填写取消原因（1-200 字）。');
    const payload = { projectId, scheduleId, action: 'cancelSchedule', reason, expectedVersion };
    const outside = await get('schedules', scheduleId);
    check(outside && outside.projectId === projectId, 'NO_ACCESS', '找不到此安排或项目不匹配。');
    const userIds = [outside.workerUserId];
    return withReceiptFirst({
      projectId, requestId, payload, actor,
      collect: () => collectPreconditions(projectId, userIds),
      run: async (tx, snapshot) => {
        // U1：实际写事务内必须重新核验回执。同号并发的两个请求可能都先在快速路径
        // 查到"无回执"，因此本事务在身份/权限/维护核验之后、目录/容量/业务版本/
        // 占用检查之前再查一次：命中即返回原成功结果，不把已成功的提交报成业务失败。
        // 同号不同载荷、失权与维护状态仍由 checkIdempotency / assertProjectWritable 拒绝。
        const { project: writeProject } = await verifyActorInTransaction(tx, actor, projectId);
        assertProjectWritable(writeProject);
        const committed = await checkIdempotency(tx, requestId, payload, actor);
        if (committed) return committed;
        const live = await get('schedules', scheduleId, tx);
        check(live && live.projectId === projectId, 'NO_ACCESS', '找不到此安排或项目不匹配。');
        check(live.status === 'active', 'BAD_INPUT', '该安排已取消。');
        check(live.version === expectedVersion, 'VERSION_MISMATCH', '安排已变化，请重新加载。');
        const liveDays = workingDays(live.startDate, live.endDate, live.restDays || []);
        const bucketKeys = buildBucketKeys(projectId, { oldDays: liveDays, oldTrade: live.trade });
        assertWithinBudget('cancelSchedule', { bucketKeyCount: bucketKeys.length });
        await verifyPreconditions(tx, projectId, snapshot, [live.workerUserId]);
        await bumpProjectEpoch(tx, projectId, snapshot.epoch);
        const snap = snapshot.dirs.get(live.workerUserId);
        await applyDirChange(tx, projectId, live.workerUserId, snap,
          snap.pre.guard ? snap.pre.guard[GUARD_IDS_FIELD].filter(id => id !== scheduleId) : []);
        const oldSnapshot = snapshotWithoutHistory(live);
        const nextVersion = live.version + 1;
        const patch = { status: 'cancelled', version: nextVersion, updatedAt: at(now), updatedByUserId: actor.user._id, updatedByRole: actor.role };
        await update('schedules', scheduleId, patch, tx);
        const updated = { ...live, ...patch };
        await writeRevision(tx, scheduleId, projectId, live.version, nextVersion, 'cancel', reason.trim(), oldSnapshot, actor);
        const buckets = await readBuckets(tx, projectId, live.trade, liveDays);
        mergeBuckets(buckets, { oldDays: liveDays, oldTrade: live.trade, scheduleId, projectId });
        await writeBuckets(tx, projectId, buckets);
        if (audit) await audit(tx, actor.user, actor.role, 'cancelSchedule', projectId, live.workerUserId, oldSnapshot, snapshotWithoutHistory(updated));
        const result = { scheduleId, version: nextVersion, status: 'cancelled' };
        await saveReceipt(tx, requestId, payload, result, actor);
        return result;
      }
    });
  }

  // 只读移出校验（供诊断与测试使用）：事务外有界扫描 + 目录/围栏一致性核对
  // 不做任何写入；正式 removeMember 路由走 runWithScanRounds + lockDirForRemoval
  async function assertRemovable(projectId, userId) {
    return runWithScanRounds({
      collect: () => collectPreconditions(projectId, [userId]),
      run: async (tx, snapshot) => {
        const snap = snapshot.dirs.get(userId);
        if (snap.state === 'ready') {
          assertDirMatchesScan(snap.pre, snap.scanned);
          if (snap.scanned.length > 0) {
            throw new AppError('WORKER_HAS_ACTIVE_SCHEDULES', '该成员仍有未取消的施工安排，须先改派或取消后才能移出。');
          }
        } else if (snap.scanned.length !== 0) {
          throw new AppError('STALE_SCAN', '任务目录状态已变化，请重试。');
        }
        return { snapshot, snap };
      }
    });
  }

  // 移出锁定：同一事务内复核围栏/一致性/epoch 并递增（建立与创建/改派的写冲突点）
  // 仍有 active 安排时抛 WORKER_HAS_ACTIVE_SCHEDULES（业务拒绝，不触发重扫）
  async function lockDirForRemoval(tx, projectId, userId, snapshot) {
    // 预算预检必须在首个数据写之前
    assertWithinBudget('removeMember', {});
    // 先复核项目 epoch、锚点配对与围栏（不符 → STALE_SCAN 由外层重扫）；
    // 结构问题（目录误删/错代际/重复ID）在此抛出，不得被业务拒绝掩盖
    await verifyPreconditions(tx, projectId, snapshot, [userId]);
    const snap = snapshot.dirs.get(userId);
    // 仅当结构与围栏均确认无误后，才以业务原因拒绝仍有 active 安排的移出
    if (snap.scanned.length > 0) {
      throw new AppError('WORKER_HAS_ACTIVE_SCHEDULES', '该成员仍有未取消的施工安排，须先改派或取消后才能移出。');
    }
    if (snap.state === 'first-use') await initDir(tx, projectId, userId, []);
    else await writeDir(tx, projectId, userId, snap.fence, [...snap.pre.guard[GUARD_IDS_FIELD]]);
    return snap;
  }

  return {
    getScheduleContext, listSchedules, getSchedule, listScheduleRevisions,
    createSchedule, updateSchedule, reassignSchedule, cancelSchedule,
    hasActiveSchedules, assertRemovable, lockDirForRemoval,
    setMaintenanceMode, readProjectWriteState, readDirPrecondition,
    scanActiveSchedules, collectPreconditions, computeBudget, assertWithinBudget,
    verifyPreconditions, runWithScanRounds, readDirPreconditionInTx,
    // U3 暴露产品事务包装与计数器工厂，用于隔离验证产品自身的 80 次边界
    transaction, createTxnOpCounter, currentAttemptPeak,
    TXN_OP_BUDGET, PLATFORM_TXN_OP_LIMIT, MAX_ACTIVE_DIR_ENTRIES, MAX_DIR_BYTES,
    SCAN_SENTINEL, MAX_SCAN_ROUNDS, TASK_DIR_SCHEMA_VERSION, OCCUPANCY_SCHEMA_VERSION,
    bucketKey, monthOf, assertProjectWritable, validateBucket, mergeBuckets,
    classifyDirState, anchorState, readGuardDoc, validateDirIds, dirBytes
  };
}

function id(prefix) { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function at(now) { return now().toISOString(); }

function one(response) {
  if (!response || !response.data) return null;
  return Array.isArray(response.data) ? response.data[0] || null : response.data;
}
function many(response) { return response && Array.isArray(response.data) ? response.data : []; }

function occupancyKey(projectId, trade, date) { return `${projectId}:${trade}:${date}`; }
function guardKey(projectId, userId) { return `${projectId}:${userId}`; }
function memberKey(projectId, userId) { return `m_${hash(`${projectId}:${userId}`).slice(0, 40)}`; }

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function workingDays(startDate, endDate, restDays) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (!start || !end || start > end) return [];
  const rest = new Set(Array.isArray(restDays) ? restDays : []);
  const days = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    if (!rest.has(iso)) days.push(iso);
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function sameRestDays(a, b) {
  const sa = [...new Set(a || [])].sort().join(',');
  const sb = [...new Set(b || [])].sort().join(',');
  return sa === sb;
}

function payloadHash(payload) {
  function normalize(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(normalize);
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = normalize(value[key]);
    }
    return sorted;
  }
  return hash(JSON.stringify(normalize(payload)));
}

function sanitizeForm(form) {
  if (!form || typeof form !== 'object') return form;
  return {
    stage: form.stage,
    trade: form.trade,
    workerUserId: form.workerUserId,
    startDate: form.startDate,
    endDate: form.endDate,
    expectedDate: form.expectedDate,
    restDays: Array.isArray(form.restDays) ? [...new Set(form.restDays.filter(d => typeof d === 'string'))].sort() : [],
    content: typeof form.content === 'string' ? form.content.trim() : form.content
  };
}

const CHANGE_LABEL = { create: '创建', update: '调整', reassign: '改派', cancel: '取消' };

module.exports = {
  createScheduleService, workingDays, parseDate, occupancyKey, guardKey, memberKey,
  TRADES, STAGES,
  TXN_OP_BUDGET, PLATFORM_TXN_OP_LIMIT, MAX_ACTIVE_DIR_ENTRIES, MAX_DIR_BYTES,
  MAX_SCAN_ROUNDS, MAX_MONTHS_SINGLE, MAX_BUCKET_UNION, SCAN_SENTINEL,
  TASK_DIR_SCHEMA_VERSION, OCCUPANCY_SCHEMA_VERSION,
  ANCHOR_SCHEMA_FIELD, ANCHOR_GENERATION_FIELD,
  GUARD_FENCE_FIELD, GUARD_IDS_FIELD, GUARD_SCHEMA_FIELD, GUARD_GENERATION_FIELD
};
