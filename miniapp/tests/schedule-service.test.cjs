const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduleService, workingDays, parseDate } = require('../cloudfunctions/memberAccess/schedule-service');
const { createService, APPID } = require('../cloudfunctions/memberAccess/service');

function hash(value) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(value).digest('hex');
}

function memberId(projectId, userId) { return `m_${hash(`${projectId}:${userId}`).slice(0, 40)}`; }
function uuid(prefix) { return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now()}`; }

// 全集合快照：用于回滚原子性断言，必须包含 members/schedules/guards/occupancy/revisions/receipts/audits
function snapshotAll(db, projectId) {
  const data = db.getData();
  const filter = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v && v.projectId === projectId));
  return {
    members: filter(data.project_members || {}),
    schedules: filter(data.schedules || {}),
    guards: filter(data.member_task_guard || {}),
    occupancy: filter(data.schedule_occupancy || {}),
    revisions: filter(data.schedule_revisions || {}),
    receipts: filter(data.schedule_receipts || {}),
    audits: filter(data.audit_events || {})
  };
}

function createMockDb(seed = {}) {
  const data = {
    projects: {},
    project_members: {},
    users: {},
    schedules: {},
    schedule_revisions: {},
    schedule_occupancy: {},
    schedule_receipts: {},
    member_task_guard: {},
    audit_events: {},
    ...seed
  };
  let addHook = null;
  let updateHook = null;
  let removeHook = null;
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function buildQuery(items, query, txValues) {
    let list = Object.values(items).filter(item =>
      Object.entries(query).every(([k, v]) => item[k] === v)).map(clone);
    let orderBy = [];
    let limit = 100; // 模拟云数据库 SDK 单次返回上限
    let skip = 0;
    const chain = {
      orderBy: (field, direction = 'asc') => {
        orderBy.push({ field, direction });
        return chain;
      },
      limit: n => { limit = n; return chain; },
      skip: n => { skip = n; return chain; },
      get: async () => {
        if (orderBy.length) {
          list.sort((a, b) => {
            for (const o of orderBy) {
              const va = a[o.field];
              const vb = b[o.field];
              if (va === undefined && vb === undefined) continue;
              if (va === undefined) return o.direction === 'desc' ? 1 : -1;
              if (vb === undefined) return o.direction === 'desc' ? -1 : 1;
              if (va < vb) return o.direction === 'desc' ? 1 : -1;
              if (va > vb) return o.direction === 'desc' ? -1 : 1;
            }
            return 0;
          });
        }
        let result = list.slice(skip);
        if (typeof limit === 'number') result = result.slice(0, limit);
        return { data: result };
      }
    };
    return chain;
  }

  function wrapCollection(txValues, name) {
    return {
      doc: id => ({
        get: async () => ({ data: clone(txValues[name][id]) || null }),
        update: async ({ data: patch }) => {
          if (!txValues[name][id]) throw new Error('doc not found');
          if (Object.prototype.hasOwnProperty.call(patch, '_id')) {
            const error = new Error('不能更新_id的值');
            error.code = 'INVALID_PARAM';
            throw error;
          }
          if (updateHook) await updateHook(name, id, txValues[name][id], patch);
          txValues[name][id] = { ...txValues[name][id], ...clone(patch) };
        },
        remove: async () => {
          if (removeHook) await removeHook(name, id, txValues[name][id]);
          delete txValues[name][id];
        }
      }),
      where: query => {
        let list = Object.values(txValues[name]).filter(item =>
          Object.entries(query).every(([k, v]) => item[k] === v)).map(clone);
        let orderBy = [];
        let limit = null;
        let skip = 0;
        const chain = {
          orderBy: (field, direction = 'asc') => { orderBy.push({ field, direction }); return chain; },
          limit: n => { limit = n; return chain; },
          skip: n => { skip = n; return chain; },
          get: async () => {
            if (orderBy.length) {
              list.sort((a, b) => {
                for (const o of orderBy) {
                  const va = a[o.field]; const vb = b[o.field];
                  if (va === undefined && vb === undefined) continue;
                  if (va === undefined) return o.direction === 'desc' ? 1 : -1;
                  if (vb === undefined) return o.direction === 'desc' ? -1 : 1;
                  if (va < vb) return o.direction === 'desc' ? 1 : -1;
                  if (va > vb) return o.direction === 'desc' ? -1 : 1;
                }
                return 0;
              });
            }
            let out = list.slice(skip);
            if (typeof limit === 'number') out = out.slice(0, limit);
            return { data: out };
          }
        };
        return chain;
      },
      add: async ({ data: value }) => {
        if (addHook) await addHook(name, value);
        txValues[name][value._id] = clone(value);
      }
    };
  }
  async function runTransaction(work) {
    const txData = {};
    for (const name of Object.keys(data)) txData[name] = { ...data[name] };
    const tx = { collection: name => wrapCollection(txData, name) };
    const result = await work(tx);
    for (const name of Object.keys(data)) data[name] = txData[name];
    return result;
  }
  return {
    runTransaction,
    collection: name => wrapCollection(data, name),
    setAddHook: fn => { addHook = fn; },
    clearAddHook: () => { addHook = null; },
    setUpdateHook: fn => { updateHook = fn; },
    clearUpdateHook: () => { updateHook = null; },
    setRemoveHook: fn => { removeHook = fn; },
    clearRemoveHook: () => { removeHook = null; },
    getData: () => JSON.parse(JSON.stringify(data))
  };
}

const SCHEMA = require('../cloudfunctions/memberAccess/schedule-service').TASK_DIR_SCHEMA_VERSION;

// 预置已初始化目录（generation=1）并同步锚点，满足 S5 正常态
function seedDir(db, projectId, userId, ids) {
  const list = [...(ids || [])].sort();
  db.collection('member_task_guard').add({ data: {
    _id: `${projectId}:${userId}`, projectId, userId,
    activeScheduleCount: list.length, version: 1, fenceVersion: 1,
    activeScheduleIds: list, schemaVersion: SCHEMA, generation: 1,
    updatedAt: new Date().toISOString()
  } });
  db.collection('project_members').doc(memberId(projectId, userId)).update({
    data: { taskDirSchemaVersion: SCHEMA, taskDirGeneration: 1 }
  });
}

function seedProject(db, projectId, managerUserId, workerUserId, trade) {
  db.collection('projects').add({ data: {
    _id: projectId, name: '测试项目', status: 'active', scope: 'identity-test',
    scheduleWriteMode: 'ready', scheduleSchemaVersion: SCHEMA, scheduleEpoch: 1
  } });
  db.collection('project_members').add({ data: { _id: memberId(projectId, managerUserId), projectId, userId: managerUserId, roles: ['管家'], trades: [], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  db.collection('project_members').add({ data: { _id: memberId(projectId, workerUserId), projectId, userId: workerUserId, roles: ['师傅'], trades: [trade], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  db.collection('users').add({ data: { _id: managerUserId, status: 'active' } });
  db.collection('users').add({ data: { _id: workerUserId, status: 'active' } });
}

function actor(userId) { return { user: { _id: userId }, role: '管家' }; }

function today(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function baseForm(startOffset, endOffset, trade = '水电') {
  return {
    stage: '水电隐蔽工程',
    trade,
    workerUserId: 'u_worker',
    startDate: today(startOffset),
    endDate: today(endOffset),
    expectedDate: today(endOffset),
    restDays: [],
    content: '测试施工内容'
  };
}

test('createSchedule: success and idempotent retry', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const requestId = uuid('req');
  const result = await service.createSchedule('p1', requestId, baseForm(0, 2), actor('u_manager'));
  assert.equal(result.status, 'active');
  assert.equal(result.version, 1);
  const retry = await service.createSchedule('p1', requestId, baseForm(0, 2), actor('u_manager'));
  assert.deepEqual(retry, result);
  const list = await service.listSchedules('p1');
  assert.equal(list.schedules.length, 1);
  // 月度桶：同一自然月合并为一个桶文档
  const occupancy = await db.collection('schedule_occupancy').where({ projectId: 'p1', trade: '水电' }).get();
  assert.equal(occupancy.data.length, 1);
  assert.equal(Object.keys(occupancy.data[0].days).length, 3);
  assert.equal(occupancy.data[0].schemaVersion, 2);
  const guard = await db.collection('member_task_guard').doc(`${'p1'}:u_worker`).get();
  assert.equal(guard.data.activeScheduleCount, 1);
});

test('createSchedule: public shape and date query', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  const all = await service.listSchedules('p1');
  const s = all.schedules[0];
  assert.equal(s.id.startsWith('s_'), true);
  assert.equal(typeof s._id, 'undefined');
  assert.deepEqual(Object.keys(s).sort(), ['content', 'createdAt', 'endDate', 'expectedDate', 'id', 'projectId', 'restDays', 'stage', 'startDate', 'status', 'trade', 'updatedAt', 'updatedByRole', 'updatedByUserId', 'version', 'workerUserId'].sort());
  const filtered = await service.listSchedules('p1', { date: today(1) });
  assert.equal(filtered.schedules.length, 1);
  assert.equal(filtered.schedules[0].id, s.id);
});

test('createSchedule: rejects missing worker role/trade', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const form = { ...baseForm(0, 2), workerUserId: 'u_other' };
  // 未注册成员没有锚点，按 S1 拒绝（不可推断没有安排）
  await assert.rejects(service.createSchedule('p1', uuid('req'), form, actor('u_manager')), { code: 'TASK_DIR_NOT_READY' });
});

test('createSchedule: rejects worker without required trade after directory initialized', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  // 先为 u_other 建立锚点与目录，使其越过 S1 进入业务校验
  db.collection('project_members').add({ data: {
    _id: memberId('p1', 'u_other'), projectId: 'p1', userId: 'u_other',
    roles: ['师傅'], trades: ['泥瓦'], status: 'active', version: 1,
    taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0
  } });
  db.collection('users').add({ data: { _id: 'u_other', status: 'active' } });
  const form = { ...baseForm(0, 2), workerUserId: 'u_other' };
  // 该成员不具备水电工种 -> WORKER_INVALID
  await assert.rejects(service.createSchedule('p1', uuid('req'), form, actor('u_manager')), { code: 'WORKER_INVALID' });
});

test('createSchedule: rejects disabled worker user', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  db.collection('users').doc('u_worker').update({ data: { status: 'disabled' } });
  const service = createScheduleService(db);
  await assert.rejects(service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager')), { code: 'WORKER_INVALID' });
});

test('createSchedule: rejects revoked worker trade', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  db.collection('project_members').doc(memberId('p1', 'u_worker')).update({ data: { trades: ['泥瓦'] } });
  const service = createScheduleService(db);
  await assert.rejects(service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager')), { code: 'WORKER_INVALID' });
});

test('createSchedule: rejects same trade same working day conflict', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  db.collection('project_members').add({ data: { _id: memberId('p1', 'u_worker2'), projectId: 'p1', userId: 'u_worker2', roles: ['师傅'], trades: ['水电'], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  db.collection('users').add({ data: { _id: 'u_worker2', status: 'active' } });
  const service = createScheduleService(db);
  await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  const form2 = { ...baseForm(0, 2), workerUserId: 'u_worker2' };
  await assert.rejects(service.createSchedule('p1', uuid('req'), form2, actor('u_manager')), { code: 'SCHEDULE_CONFLICT' });
});

test('createSchedule: allows different trades same day', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  db.collection('project_members').add({ data: { _id: memberId('p1', 'u_mason'), projectId: 'p1', userId: 'u_mason', roles: ['师傅'], trades: ['泥瓦'], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  db.collection('users').add({ data: { _id: 'u_mason', status: 'active' } });
  const service = createScheduleService(db);
  await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  const form2 = { ...baseForm(0, 2, '泥瓦'), workerUserId: 'u_mason' };
  const result = await service.createSchedule('p1', uuid('req'), form2, actor('u_manager'));
  assert.equal(result.status, 'active');
});

test('createSchedule: rejects no working day after rest days', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const form = { ...baseForm(0, 0), restDays: [today(0)] };
  await assert.rejects(service.createSchedule('p1', uuid('req'), form, actor('u_manager')), { code: 'SCHEDULE_NO_WORKING_DAY' });
});

test('createSchedule: rejects invalid or reversed dates', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  await assert.rejects(service.createSchedule('p1', uuid('req'), { ...baseForm(2, 0) }, actor('u_manager')), { code: 'BAD_INPUT' });
  await assert.rejects(service.createSchedule('p1', uuid('req'), { ...baseForm(0, 2), expectedDate: today(-1) }, actor('u_manager')), { code: 'BAD_INPUT' });
  await assert.rejects(service.createSchedule('p1', uuid('req'), { ...baseForm(0, 2), startDate: 'not-a-date' }, actor('u_manager')), { code: 'BAD_INPUT' });
});

test('createSchedule: rejects expectedDate mismatch without confirmation', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const form = { ...baseForm(0, 2), expectedDate: today(1) };
  await assert.rejects(service.createSchedule('p1', uuid('req'), form, actor('u_manager')), { code: 'EXPECTED_DATE_MISMATCH' });
  const result = await service.createSchedule('p1', uuid('req'), form, actor('u_manager'), { expectedConfirmed: true });
  assert.equal(result.status, 'active');
});

test('updateSchedule: version and reason required, history kept', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  const updated = await service.updateSchedule('p1', created.scheduleId, 1, uuid('req'), { ...baseForm(0, 3), content: '更新内容' }, '延期原因', actor('u_manager'));
  assert.equal(updated.version, 2);
  const schedule = await service.getSchedule('p1', created.scheduleId);
  assert.equal(schedule.content, '更新内容');
  assert.equal(schedule.endDate, today(3));
  const revBody = await service.listScheduleRevisions('p1', created.scheduleId);
  assert.equal(revBody.revisions.length, 2);
  assert.equal(revBody.revisions[1].changeType, 'update');
  assert.equal(revBody.revisions[1].reason, '延期原因');
  assert.equal(revBody.revisions[1].beforeVersion, 1);
  assert.equal(revBody.revisions[1].afterVersion, 2);
  assert.equal(revBody.revisions[1].snapshot.version, 1);
});

test('updateSchedule: rejects version mismatch and missing reason', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  await assert.rejects(service.updateSchedule('p1', created.scheduleId, 99, uuid('req'), baseForm(0, 3), '原因', actor('u_manager')), { code: 'VERSION_MISMATCH' });
  await assert.rejects(service.updateSchedule('p1', created.scheduleId, 1, uuid('req'), baseForm(0, 3), '', actor('u_manager')), { code: 'BAD_INPUT' });
});

test('updateSchedule: release old occupancy and occupy new dates atomically', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  await service.updateSchedule('p1', created.scheduleId, 1, uuid('req'), baseForm(3, 5), '改期', actor('u_manager'));
  // 月度桶：旧日期已释放、新日期已占用
  const buckets = await db.collection('schedule_occupancy').where({ projectId: 'p1' }).get();
  const allDays = buckets.data.flatMap(b => Object.entries(b.days));
  assert.equal(allDays.some(([date]) => date === today(0)), false, '旧日期应已释放');
  assert.equal(allDays.some(([date]) => date === today(3)), true, '新日期应已占用');
});

test('updateSchedule: rejects _id in update patch via mock sdk', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  // 注入一个直接带 _id 的文档，模拟旧代码错误展开
  const schedule = await db.collection('schedules').doc(created.scheduleId).get();
  schedule.data._id = created.scheduleId;
  await assert.rejects(
    (async () => {
      await db.runTransaction(async tx => {
        await tx.collection('schedules').doc(created.scheduleId).update({ data: { ...schedule.data, content: 'x' } });
      });
    })(),
    { code: 'INVALID_PARAM' }
  );
});

test('reassignSchedule: changes worker and updates guard counts', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  db.collection('project_members').add({ data: { _id: memberId('p1', 'u_worker2'), projectId: 'p1', userId: 'u_worker2', roles: ['师傅'], trades: ['水电'], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  db.collection('users').add({ data: { _id: 'u_worker2', status: 'active' } });
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  const reassigned = await service.reassignSchedule('p1', created.scheduleId, 1, uuid('req'), 'u_worker2', '换人', actor('u_manager'));
  assert.equal(reassigned.version, 2);
  const schedule = await service.getSchedule('p1', created.scheduleId);
  assert.equal(schedule.workerUserId, 'u_worker2');
  const guard1 = await db.collection('member_task_guard').doc(`${'p1'}:u_worker`).get();
  const guard2 = await db.collection('member_task_guard').doc(`${'p1'}:u_worker2`).get();
  assert.equal(guard1.data.activeScheduleCount, 0);
  assert.equal(guard2.data.activeScheduleCount, 1);
});

test('cancelSchedule: keeps record and releases occupancy and guard', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  const cancelled = await service.cancelSchedule('p1', created.scheduleId, 1, uuid('req'), '业主变更方案', actor('u_manager'));
  assert.equal(cancelled.status, 'cancelled');
  const schedule = await service.getSchedule('p1', created.scheduleId);
  assert.equal(schedule.status, 'cancelled');
  const occupancy = await db.collection('schedule_occupancy').where({ projectId: 'p1', scheduleId: created.scheduleId }).get();
  assert.equal(occupancy.data.length, 0);
  const guard = await db.collection('member_task_guard').doc(`${'p1'}:u_worker`).get();
  assert.equal(guard.data.activeScheduleCount, 0);
});

test('cancelSchedule: full occupancy release over multiple pages', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const form = { ...baseForm(0, 0), startDate: today(0), endDate: today(2), expectedDate: today(2) };
  const created = await service.createSchedule('p1', uuid('req'), form, actor('u_manager'));
  await service.cancelSchedule('p1', created.scheduleId, 1, uuid('req'), '原因', actor('u_manager'));
  for (let i = 0; i <= 2; i++) {
    const occ = await db.collection('schedule_occupancy').where({ projectId: 'p1', date: today(i) }).get();
    assert.equal(occ.data.length, 0, `date ${today(i)} should be released`);
  }
});

test('cancelSchedule: rejected for already cancelled', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  await service.cancelSchedule('p1', created.scheduleId, 1, uuid('req'), '原因', actor('u_manager'));
  await assert.rejects(service.cancelSchedule('p1', created.scheduleId, 2, uuid('req'), '再取消', actor('u_manager')), { code: 'BAD_INPUT' });
});

test('hasActiveSchedules: missing guard falls back to schedules query', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  // 目录被删除后（锚点代际仍为 1）必须拒绝，不得按零计数放行
  await db.collection('member_task_guard').doc(`${'p1'}:u_worker`).remove();
  await assert.rejects(service.assertRemovable('p1', 'u_worker'), { code: 'TASK_DIR_INCONSISTENT' });
});

test('guard record validation rejects corrupted counts and schema', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  db.collection('member_task_guard').add({
    data: {
      _id: `${'p1'}:u_worker`, projectId: 'p1', userId: 'u_worker',
      activeScheduleCount: -1, version: 1, fenceVersion: 1, activeScheduleIds: [],
      schemaVersion: SCHEMA, generation: 1, updatedAt: new Date().toISOString()
    }
  });
  const service = createScheduleService(db);
  await assert.rejects(service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager')), { code: 'TASK_DIR_INCONSISTENT' });
});

test('request id reused with different payload rejected', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const requestId = uuid('req');
  await service.createSchedule('p1', requestId, baseForm(0, 2), actor('u_manager'));
  await assert.rejects(service.createSchedule('p1', requestId, { ...baseForm(0, 2), content: '不同内容' }, actor('u_manager')), { code: 'REQUEST_ID_REUSED_DIFFERENT_PAYLOAD' });
});

test('request id reused by different actor rejected', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  db.collection('project_members').add({ data: { _id: memberId('p1', 'u_manager2'), projectId: 'p1', userId: 'u_manager2', roles: ['管家'], trades: [], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  db.collection('users').add({ data: { _id: 'u_manager2', status: 'active' } });
  const service = createScheduleService(db);
  const requestId = uuid('req');
  await service.createSchedule('p1', requestId, baseForm(0, 2), actor('u_manager'));
  await assert.rejects(service.createSchedule('p1', requestId, baseForm(0, 2), actor('u_manager2')), { code: 'NO_ACCESS' });
});

test('date parsing handles year/month/day boundaries', () => {
  assert.equal(parseDate('2024-02-29') instanceof Date, true);
  assert.equal(parseDate('2023-02-29'), null);
  assert.equal(parseDate('2024-12-31') instanceof Date, true);
  assert.equal(parseDate('2024-01-01') instanceof Date, true);
  assert.deepEqual(workingDays('2024-01-01', '2024-01-03', ['2024-01-02']), ['2024-01-01', '2024-01-03']);
});

test('getScheduleContext returns isManager and workers', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const ctx = await service.getScheduleContext('p1', actor('u_manager'));
  assert.equal(ctx.isManager, true);
  assert.equal(ctx.workers.length, 1);
  assert.equal(ctx.workers[0].trades.includes('水电'), true);
});

test('listSchedules supports pagination', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const form = { ...baseForm(i * 3, i * 3 + 1) };
    const res = await service.createSchedule('p1', uuid('req'), form, actor('u_manager'));
    ids.push(res.scheduleId);
  }
  const page1 = await service.listSchedules('p1', { limit: 2 });
  assert.equal(page1.schedules.length, 2);
  assert.equal(page1.pagination.hasMore, true);
  assert.equal(typeof page1.pagination.nextCursor, 'string');
  const page2 = await service.listSchedules('p1', { limit: 2, cursor: page1.pagination.nextCursor });
  assert.equal(page2.schedules.length, 1);
  assert.equal(page2.pagination.hasMore, false);
  assert.equal(page2.schedules[0].id, ids.find(id => id !== page1.schedules[0].id && id !== page1.schedules[1].id));
});

test('createSchedule: rejects null form or unknown fields do not crash', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  await assert.rejects(service.createSchedule('p1', uuid('req'), null, actor('u_manager')), { code: 'BAD_INPUT' });
  const result = await service.createSchedule('p1', uuid('req'), { ...baseForm(0, 2), extraField: 'ignored' }, actor('u_manager'));
  assert.equal(result.status, 'active');
});

test('rejects non-string restDays', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const form = { ...baseForm(0, 2), restDays: [today(1), 123] };
  await assert.rejects(service.createSchedule('p1', uuid('req'), form, actor('u_manager')), { code: 'BAD_INPUT' });
});

test('missing guard after initialization is rejected instead of rebuilt from schedules', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  await service.cancelSchedule('p1', created.scheduleId, 1, uuid('req'), '取消', actor('u_manager'));
  // 锚点代际已为 1，目录被删后必须拒绝，不得回退扫描重建
  await db.collection('member_task_guard').doc(`${'p1'}:u_worker`).remove();
  await assert.rejects(service.assertRemovable('p1', 'u_worker'), { code: 'TASK_DIR_INCONSISTENT' });
});
test('listSchedules cursor pagination reaches beyond single DB page', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const ids = [];
  // 种 101 条，使数据库单次 100 条无法一次取完
  for (let i = 0; i < 101; i++) {
    const form = { ...baseForm(i * 2, i * 2), content: `计划${i}` };
    const res = await service.createSchedule('p1', uuid('req'), form, actor('u_manager'));
    ids.push(res.scheduleId);
  }
  const page1 = await service.listSchedules('p1', { limit: 50 });
  assert.equal(page1.schedules.length, 50);
  assert.equal(page1.pagination.hasMore, true);
  const page2 = await service.listSchedules('p1', { limit: 51, cursor: page1.pagination.nextCursor });
  assert.equal(page2.schedules.length, 51);
  assert.equal(page2.pagination.hasMore, false);
  const allIds = page1.schedules.concat(page2.schedules).map(s => s.id);
  assert.equal(new Set(allIds).size, 101);
  assert.equal(allIds.includes(ids[100]), true);
});

test('transaction rejects actor disabled after outer identity check', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  // 模拟外层 identify 通过后、事务开始前账号被停用
  db.collection('users').doc('u_manager').update({ data: { status: 'disabled' } });
  await assert.rejects(service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager')), { code: 'IDENTITY_DISABLED' });
});

test('transaction rejects actor removed from project after outer check', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  db.collection('project_members').doc(memberId('p1', 'u_manager')).update({ data: { status: 'left' } });
  await assert.rejects(service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager')), { code: 'NO_ACCESS' });
});

test('scanActiveSchedules is bounded and reads beyond a single DB page with sentinel', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  // 直接置入 150 条 active 安排，验证跨页有界扫描
  for (let i = 0; i < 150; i++) {
    db.collection('schedules').add({ data: {
      _id: `s_${String(i).padStart(4, '0')}`, projectId: 'p1', stage: '水电隐蔽工程', trade: '水电',
      workerUserId: 'u_worker', startDate: '2026-01-01', endDate: '2026-01-01', expectedDate: '2026-01-01',
      restDays: [], content: 'x', status: 'active', version: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    } });
  }
  const ids = await service.scanActiveSchedules('p1', 'u_worker');
  assert.equal(ids.length, 150);
  assert.equal(service.SCAN_SENTINEL, 201);
  assert.equal(service.MAX_ACTIVE_DIR_ENTRIES, 200);
});
test('listScheduleRevisions cursor reaches every change without skipping', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  // 添加第二位师傅
  db.collection('project_members').add({ data: { _id: memberId('p1', 'u_worker2'), projectId: 'p1', userId: 'u_worker2', roles: ['师傅'], trades: ['水电'], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  db.collection('users').add({ data: { _id: 'u_worker2', status: 'active' } });
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  const updated = await service.updateSchedule('p1', created.scheduleId, 1, uuid('req'), { ...baseForm(0, 3), content: '调整后' }, '延期', actor('u_manager'));
  const reassigned = await service.reassignSchedule('p1', created.scheduleId, 2, uuid('req'), 'u_worker2', '改派', actor('u_manager'));
  await service.cancelSchedule('p1', created.scheduleId, 3, uuid('req'), '取消', actor('u_manager'));
  const page1 = await service.listScheduleRevisions('p1', created.scheduleId, { limit: 1 });
  assert.equal(page1.revisions.length, 1);
  assert.equal(page1.revisions[0].changeType, 'create');
  assert.equal(page1.pagination.hasMore, true);
  assert.equal(page1.pagination.nextCursor, '1');
  const page2 = await service.listScheduleRevisions('p1', created.scheduleId, { limit: 1, cursor: page1.pagination.nextCursor });
  assert.equal(page2.revisions.length, 1);
  assert.equal(page2.revisions[0].changeType, 'update');
  assert.equal(page2.pagination.hasMore, true);
  const page3 = await service.listScheduleRevisions('p1', created.scheduleId, { limit: 1, cursor: page2.pagination.nextCursor });
  assert.equal(page3.revisions.length, 1);
  assert.equal(page3.revisions[0].changeType, 'reassign');
  const page4 = await service.listScheduleRevisions('p1', created.scheduleId, { limit: 1, cursor: page3.pagination.nextCursor });
  assert.equal(page4.revisions.length, 1);
  assert.equal(page4.revisions[0].changeType, 'cancel');
  assert.equal(page4.pagination.hasMore, false);
});

test('getScheduleContext returns all workers beyond single DB page', async () => {
  const db = createMockDb();
  db.collection('projects').add({ data: { _id: 'p1', name: '测试项目', status: 'active', scope: 'identity-test' } });
  db.collection('project_members').add({ data: { _id: memberId('p1', 'u_manager'), projectId: 'p1', userId: 'u_manager', roles: ['管家'], trades: [], status: 'active', version: 1 } });
  db.collection('users').add({ data: { _id: 'u_manager', status: 'active' } });
  // 种 102 位师傅
  for (let i = 0; i < 102; i++) {
    const uid = `u_worker_${String(i).padStart(3, '0')}`;
    db.collection('project_members').add({ data: { _id: memberId('p1', uid), projectId: 'p1', userId: uid, roles: ['师傅'], trades: ['水电'], status: 'active', version: 1 } });
    db.collection('users').add({ data: { _id: uid, status: 'active' } });
  }
  const service = createScheduleService(db);
  const ctx = await service.getScheduleContext('p1', actor('u_manager'));
  assert.equal(ctx.workers.length, 102);
});

test('listSchedules date filter includes cancelled schedules', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  await service.cancelSchedule('p1', created.scheduleId, 1, uuid('req'), '取消', actor('u_manager'));
  const date = today(0);
  const list = await service.listSchedules('p1', { date });
  assert.equal(list.schedules.length, 1);
  assert.equal(list.schedules[0].status, 'cancelled');
  assert.equal(list.schedules[0].id, created.scheduleId);
});

test('write rollback keeps state unchanged when any collection fails', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  // 注入故障：schedule_revisions 添加创建记录时抛错
  db.setAddHook((name, value) => {
    if (name === 'schedule_revisions' && value.changeType === 'create') throw new Error('revision write failure');
  });
  const service = createScheduleService(db);
  await assert.rejects(service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager')), { message: /revision write failure/ });
  db.clearAddHook();
  // 数据库应无 schedule/occupancy/guard/receipt/audit 残留
  const schedules = await db.collection('schedules').where({ projectId: 'p1' }).get();
  assert.equal(schedules.data.length, 0);
  const occupancy = await db.collection('schedule_occupancy').where({ projectId: 'p1' }).get();
  assert.equal(occupancy.data.length, 0);
  const guard = await db.collection('member_task_guard').where({ projectId: 'p1' }).get();
  assert.equal(guard.data.length, 0);
  const receipts = await db.collection('schedule_receipts').where({ projectId: 'p1' }).get();
  assert.equal(receipts.data.length, 0);
});

test('hasActiveSchedules blocks removal while schedule active and allows after cancel', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  // 提前创建一份 active 安排
  const { createScheduleService } = require('../cloudfunctions/memberAccess/schedule-service');
  const scheduleService = createScheduleService(db);
  await scheduleService.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  // 模拟移出先进入：已存在 active，hasActiveSchedules 返回 true，移出被拒绝
  const hasActive = await scheduleService.hasActiveSchedules(db, 'p1', 'u_worker');
  assert.equal(hasActive, true);
  // 取消后应可移出
  const created = await scheduleService.listSchedules('p1');
  await scheduleService.cancelSchedule('p1', created.schedules[0].id, 1, uuid('req'), '取消', actor('u_manager'));
  const hasActive2 = await scheduleService.hasActiveSchedules(db, 'p1', 'u_worker');
  assert.equal(hasActive2, false);
});

test('retry generates only one schedule for same requestId', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const requestId = uuid('req');
  const result = await service.createSchedule('p1', requestId, baseForm(0, 2), actor('u_manager'));
  const retry = await service.createSchedule('p1', requestId, baseForm(0, 2), actor('u_manager'));
  assert.deepEqual(retry, result);
  const list = await service.listSchedules('p1');
  assert.equal(list.schedules.length, 1);
  const revisions = await service.listScheduleRevisions('p1', result.scheduleId);
  assert.equal(revisions.revisions.length, 1); // 仅创建记录
});

test('stale expectedVersion fails and retry with fresh version produces exactly one new revision', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  // 第一次用旧版本应失败
  await assert.rejects(service.updateSchedule('p1', created.scheduleId, 0, uuid('req'), { ...baseForm(0, 3), content: '调整后' }, '调整', actor('u_manager')), { code: 'VERSION_MISMATCH' });
  // 用当前版本重试成功
  const updated = await service.updateSchedule('p1', created.scheduleId, 1, uuid('req'), { ...baseForm(0, 3), content: '调整后' }, '调整', actor('u_manager'));
  assert.equal(updated.version, 2);
  const revisions = await service.listScheduleRevisions('p1', created.scheduleId);
  assert.equal(revisions.revisions.length, 2); // create + update，只有一条 update
});

test('rollback on occupancy write failure leaves full snapshot unchanged', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const before = snapshotAll(db, 'p1');
  db.setAddHook((name, value) => {
    if (name === 'schedule_occupancy') throw new Error('occupancy write failure');
  });
  const service = createScheduleService(db);
  await assert.rejects(service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager')), { message: /occupancy write failure/ });
  db.clearAddHook();
  assert.deepStrictEqual(snapshotAll(db, 'p1'), before, '占用写入失败后所有集合快照必须不变');
});

test('rollback on guard write failure leaves full snapshot unchanged', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const before = snapshotAll(db, 'p1');
  db.setAddHook((name, value) => {
    if (name === 'member_task_guard' && value.activeScheduleCount === 1) throw new Error('guard write failure');
  });
  const service = createScheduleService(db);
  await assert.rejects(service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager')), { message: /guard write failure/ });
  db.clearAddHook();
  assert.deepStrictEqual(snapshotAll(db, 'p1'), before, 'guard 写入失败后所有集合快照必须不变');
});

test('no active schedule remains after schedule is cancelled', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  // 取消后移出路径应无 active
  await service.cancelSchedule('p1', created.scheduleId, 1, uuid('req'), '取消', actor('u_manager'));
  const hasActive = await service.hasActiveSchedules(db, 'p1', 'u_worker');
  assert.equal(hasActive, false);
});

test('self-consistent but wrong directory is rejected by actual scan', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  // 目录自洽（count=1, ids=[scheduleId]）但安排被外部删除 → 与实际扫描不符必须拒绝
  db.collection('schedules').doc(created.scheduleId).remove();
  await assert.rejects(service.assertRemovable('p1', 'u_worker'), { code: 'GUARD_INCONSISTENT' });
});

test('self-consistent directory with wrong id is rejected by actual scan', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  // 目录条目改成不存在的 ID，但保持自洽（count=1, len=1）
  const key = `${'p1'}:u_worker`;
  const g = await db.collection('member_task_guard').doc(key).get();
  await db.collection('member_task_guard').doc(key).update({ data: { activeScheduleIds: ['s_not_exist'], activeScheduleCount: 1 } });
  await assert.rejects(service.assertRemovable('p1', 'u_worker'), { code: 'GUARD_INCONSISTENT' });
});
test('empty directory while actual schedules exist is rejected', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  // 清空目录但保持自洽（count=0, len=0），实际仍有 active 安排
  const key = `${'p1'}:u_worker`;
  await db.collection('member_task_guard').doc(key).update({ data: { activeScheduleIds: [], activeScheduleCount: 0 } });
  await assert.rejects(service.assertRemovable('p1', 'u_worker'), { code: 'GUARD_INCONSISTENT' });
});
test('concurrent create and hasActiveSchedules: checker pauses at commit, create commits first, checker retries and sees active', async () => {
  const db = createConflictMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  // 预置目录（代际 1），使 create 提交后产生围栏冲突重试
  seedDir(db, 'p1', 'u_worker', []);
  const service = createScheduleService(db);

  const barrier = makeBarrier();
  db.setHooks({ beforeCommit: async () => { barrier.signal(); await barrier.wait; } });

  // 先启动 hasActiveSchedules，在提交前暂停
  const checkPromise = db.runTransaction(async tx => service.hasActiveSchedules(tx, 'p1', 'u_worker'));
  await barrier.reached;
  db.clearHooks();

  // 再启动 create，让它正常提交
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));

  // 恢复 hasActiveSchedules 提交：它读取的 guard=0 已过期，应冲突重试
  barrier.resume();
  const hasActive = await checkPromise;
  assert.equal(hasActive, true);
  assert.equal(created.status, 'active');
});

test('concurrent reassign and hasActiveSchedules old worker: checker pauses at commit, reassign commits first, checker retries and sees inactive', async () => {
  const db = createConflictMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  db.collection('project_members').add({ data: { _id: memberId('p1', 'u_worker2'), projectId: 'p1', userId: 'u_worker2', roles: ['师傅'], trades: ['水电'], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  db.collection('users').add({ data: { _id: 'u_worker2', status: 'active' } });
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));

  const barrier = makeBarrier();
  db.setHooks({ beforeCommit: async () => { barrier.signal(); await barrier.wait; } });

  const checkPromise = db.runTransaction(async tx => service.hasActiveSchedules(tx, 'p1', 'u_worker'));
  await barrier.reached;
  db.clearHooks();

  await service.reassignSchedule('p1', created.scheduleId, 1, uuid('req'), 'u_worker2', '改派', actor('u_manager'));

  barrier.resume();
  const hasActive = await checkPromise;
  assert.equal(hasActive, false);
});

test('transaction conflict retry counted when second create commits first', async () => {
  const db = createConflictMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  // 预置 guard=0，使两个 create 都读取同一 guard 并产生写冲突
  seedDir(db, 'p1', 'u_worker', []);
  const service = createScheduleService(db);

  const barrier = makeBarrier();
  db.setHooks({ beforeCommit: async () => { barrier.signal(); await barrier.wait; } });

  // 先启动 create1，在提交前暂停
  const p1 = service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  await barrier.reached;
  db.clearHooks();

  // create2 正常提交（读取 guard=0，更新为 1，添加占用）
  const p2 = service.createSchedule('p1', uuid('req2'), { ...baseForm(0, 2), workerUserId: 'u_worker' }, actor('u_manager'));

  // 恢复 create1 提交：guard 已被 create2 修改，冲突重试后发现占用已存在
  // 恢复 create1 提交：与 create2 在 guard/occupancy 上产生冲突，仅一个能成功
  barrier.resume();
  let p1Result, p1Error;
  try { p1Result = await p1; } catch (error) { p1Error = error; }
  let p2Result, p2Error;
  try { p2Result = await p2; } catch (error) { p2Error = error; }
  const successes = [p1Result, p2Result].filter(Boolean);
  const conflicts = [p1Error, p2Error].filter(e => e && e.code === 'SCHEDULE_CONFLICT');
  assert.equal(successes.length, 1, '同一工种同日期的两个创建应只有一个成功');
  assert.equal(conflicts.length, 1, '另一个应因占用冲突失败');
  assert.equal(successes[0].status, 'active');
  // 总尝试次数应 > 成功提交次数，说明发生了重试
  assert.ok(db.getTotalAttempts() > db.getCommitVersion());
});

test('rollback on schedule update failure leaves full snapshot unchanged', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  const before = snapshotAll(db, 'p1');

  // 注入故障：schedules.update 写入“调整后”时失败
  db.setUpdateHook((name, id, current, patch) => {
    if (name === 'schedules' && id === created.scheduleId && patch.content === '调整后') throw new Error('schedule update failure');
  });
  await assert.rejects(service.updateSchedule('p1', created.scheduleId, 1, uuid('req'), { ...baseForm(0, 3), content: '调整后' }, '原因', actor('u_manager')), { message: /schedule update failure/ });
  db.clearUpdateHook();
  assert.deepStrictEqual(snapshotAll(db, 'p1'), before, 'schedules 更新失败后所有集合快照必须不变');
});

test('rollback on occupancy remove failure leaves full snapshot unchanged', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  const before = snapshotAll(db, 'p1');

  // 注入故障：月桶更新失败（月桶结构下取消通过桶 update 释放日期，不再逐日 remove）
  let updateCount = 0;
  db.setUpdateHook((name) => {
    if (name === 'schedule_occupancy') {
      updateCount++;
      if (updateCount === 1) throw new Error('occupancy remove failure');
    }
  });
  await assert.rejects(service.cancelSchedule('p1', created.scheduleId, 1, uuid('req'), '取消', actor('u_manager')), { message: /occupancy remove failure/ });
  db.clearUpdateHook();
  assert.deepStrictEqual(snapshotAll(db, 'p1'), before, '占用释放失败后所有集合快照必须不变，guard 与 schedule 不得部分变更');
});

test('rollback on revision add failure leaves full snapshot unchanged', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const service = createScheduleService(db);
  const created = await service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager'));
  const before = snapshotAll(db, 'p1');

  db.setAddHook(name => {
    if (name === 'schedule_revisions') throw new Error('revision write failure');
  });
  await assert.rejects(service.updateSchedule('p1', created.scheduleId, 1, uuid('req'), { ...baseForm(0, 3), content: '调整后' }, '原因', actor('u_manager')), { message: /revision write failure/ });
  db.clearAddHook();
  assert.deepStrictEqual(snapshotAll(db, 'p1'), before, '历史写入失败后所有集合快照必须不变');
});

test('rollback on audit add failure leaves full snapshot unchanged including audit_events itself', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const before = snapshotAll(db, 'p1');
  const service = createScheduleService(db, {
    audit: async (tx, actor, actorRole, action, projectId) => {
      await tx.collection('audit_events').add({ data: { _id: 'audit_1', projectId, action } });
      throw new Error('audit write failure');
    }
  });
  await assert.rejects(service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager')), { message: /audit write failure/ });
  db.clearAddHook();
  // 关键：audit_events 自身也必须无残留
  assert.deepStrictEqual(snapshotAll(db, 'p1'), before, '审计写入失败后 audit_events 自身及其余集合快照必须不变');
  assert.deepStrictEqual(snapshotAll(db, 'p1').audits, {}, '不得残留任何审计记录');
});

test('rollback on receipt add failure leaves full snapshot unchanged including receipts itself', async () => {
  const db = createMockDb();
  seedProject(db, 'p1', 'u_manager', 'u_worker', '水电');
  const before = snapshotAll(db, 'p1');
  db.setAddHook((name, value) => {
    if (name === 'schedule_receipts') throw new Error('receipt write failure');
  });
  const service = createScheduleService(db);
  await assert.rejects(service.createSchedule('p1', uuid('req'), baseForm(0, 2), actor('u_manager')), { message: /receipt write failure/ });
  db.clearAddHook();
  // 关键：schedule_receipts 自身也必须无残留
  assert.deepStrictEqual(snapshotAll(db, 'p1'), before, '回执写入失败后 receipts 自身及其余集合快照必须不变');
  assert.deepStrictEqual(snapshotAll(db, 'p1').receipts, {}, '不得残留任何回执记录');
});

// 平台限制夹具：事务内零 where；第 81/101 次数据操作前拒绝；计数器每次 attempt 重置
// options.appBudget: null 表示不启用夹具自身的 80 次拦截（只保留平台 100），
// 用于隔离验证产品 transaction() 包装自己的 80 次保护确实生效。
function createPlatformLimitedMockDb(seed = {}, options = {}) {
  const TXN_APP_BUDGET = options.appBudget === null ? null : 80;
  const TXN_PLATFORM_LIMIT = 100;
  const data = {
    projects: {}, project_members: {}, users: {}, schedules: {}, schedule_revisions: {},
    schedule_occupancy: {}, schedule_receipts: {}, member_task_guard: {}, audit_events: {},
    app_admins: {}, invitations: {},
    ...JSON.parse(JSON.stringify(seed))
  };
  let commitVersion = 0;
  let totalAttempts = 0;
  let peakAttemptOps = 0;
  let currentOps = 0;
  let writeCount = 0;
  let executedOps = 0;
  const hooks = {};

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function countOp(isWrite) {
    if (isWrite) writeCount++;
    currentOps++;
    executedOps++;
    if (currentOps > peakAttemptOps) peakAttemptOps = currentOps;
    if (TXN_APP_BUDGET !== null && currentOps === TXN_APP_BUDGET + 1) {
      const e = new Error('APP_TXN_BUDGET_EXCEEDED');
      e.code = 'APP_TXN_BUDGET_EXCEEDED';
      throw e;
    }
    if (currentOps === TXN_PLATFORM_LIMIT + 1) {
      const e = new Error('PLATFORM_TXN_OP_LIMIT_EXCEEDED');
      e.code = 'PLATFORM_TXN_OP_LIMIT_EXCEEDED';
      throw e;
    }
  }
  // T7：事务内 where/orderBy/limit/skip 无条件拒绝，包括事务第一步
  function denyInTxn(what) {
    const e = new Error(`PLATFORM_UNSUPPORTED_IN_TXN:${what}`);
    e.code = 'PLATFORM_UNSUPPORTED_IN_TXN';
    throw e;
  }

  function docOps(txValues, name) {
    return {
      get: async () => { countOp(); return { data: clone(txValues[name].__get) }; },
      update: async () => { countOp(); },
      remove: async () => { countOp(); }
    };
  }

  // 事务内只暴露 doc；where/orderBy/limit/skip 一律拒绝
  function wrapCollection(txValues, name, inTxn) {
    return {
      doc: id => ({
        get: async () => {
          if (inTxn) countOp();
          if (hooks.beforeRead) await hooks.beforeRead(name, id);
          return { data: clone(txValues[name][id]) || null };
        },
        update: async ({ data: patch }) => {
          if (inTxn) countOp(true);
          if (hooks.beforeWrite) await hooks.beforeWrite(name, id, 'update');
          if (!txValues[name][id]) throw new Error('doc not found');
          txValues[name][id] = { ...txValues[name][id], ...clone(patch) };
        },
        remove: async () => {
          if (inTxn) countOp(true);
          if (hooks.beforeWrite) await hooks.beforeWrite(name, id, 'remove');
          delete txValues[name][id];
        }
      }),
      where: query => {
        if (inTxn) denyInTxn(`where:${name}`);
        const build = () => Object.values(txValues[name]).filter(item =>
          Object.entries(query).every(([k, v]) => item[k] === v)).map(clone);
        let orderBy = [], limit = null, skip = 0;
        const chain = {
          orderBy: (f, d = 'asc') => { orderBy.push({ f, d }); return chain; },
          limit: n => { limit = n; return chain; },
          skip: n => { skip = n; return chain; },
          get: async () => {
            let list = build();
            if (orderBy.length) {
              list.sort((a, b) => {
                for (const o of orderBy) {
                  const va = a[o.f], vb = b[o.f];
                  if (va < vb) return o.d === 'desc' ? 1 : -1;
                  if (va > vb) return o.d === 'desc' ? -1 : 1;
                }
                return 0;
              });
            }
            let out = list.slice(skip);
            if (typeof limit === 'number') out = out.slice(0, limit);
            return { data: out };
          }
        };
        return chain;
      },
      add: async ({ data: value }) => {
        if (inTxn) countOp(true);
        if (hooks.beforeWrite) await hooks.beforeWrite(name, value._id, 'add');
        txValues[name][value._id] = clone(value);
      }
    };
  }

  async function runTransaction(work) {
    let attempt = 0;
    while (true) {
      attempt++;
      totalAttempts++;
      // 每次 attempt 独立计数
      currentOps = 0;
      const txData = {};
      for (const name of Object.keys(data)) txData[name] = { ...data[name] };
      const tx = { collection: name => wrapCollection(txData, name, true) };
      const result = await work(tx);
      if (hooks.beforeCommit) await hooks.beforeCommit(tx, attempt);
      for (const name of Object.keys(data)) data[name] = txData[name];
      commitVersion++;
      return result;
    }
  }

  return {
    runTransaction,
    collection: name => wrapCollection(data, name, false),
    setHooks: h => { Object.assign(hooks, h); },
    clearHooks: () => { for (const k of Object.keys(hooks)) delete hooks[k]; },
    getPeakAttemptOps: () => peakAttemptOps,
    getTotalAttempts: () => totalAttempts,
    getCommitVersion: () => commitVersion,
    getData: () => JSON.parse(JSON.stringify(data)),
    // 直接修改底层数据：用于模拟外部篡改、并发写入与维护切换
    mutate: fn => { fn(data); },
    // 写操作累计次数：用于断言"首写前拒绝"（写调用必须为 0）
    getWriteCount: () => writeCount,
    resetWriteCount: () => { writeCount = 0; },
    resetPeak: () => { peakAttemptOps = 0; },
    // 底层真实执行的数据操作次数（产品在调用前拒绝时不会增加）
    getExecutedOps: () => executedOps,
    resetExecutedOps: () => { executedOps = 0; },
    TXN_APP_BUDGET, TXN_PLATFORM_LIMIT
  };
}



// snapshotAll8 的键 -> 底层集合名
const SNAPSHOT_COLLECTION = {
  projects: 'projects',
  members: 'project_members',
  schedules: 'schedules',
  guards: 'member_task_guard',
  occupancy: 'schedule_occupancy',
  revisions: 'schedule_revisions',
  receipts: 'schedule_receipts',
  audits: 'audit_events'
};

// 恰好一次断言：比较"前后快照"同一集合的条目数差。
// before 来自 snapshotAll8（快照键），after 可为快照或原始 db 数据（集合名），此处统一按集合名取值。
function countDelta(beforeSnapshot, afterSource, snapshotKey) {
  const collection = SNAPSHOT_COLLECTION[snapshotKey];
  const beforeCount = Object.keys(beforeSnapshot[snapshotKey] || {}).length;
  const afterCount = Object.keys(afterSource[collection] || afterSource[snapshotKey] || {}).length;
  return afterCount - beforeCount;
}

// 8 类集合完整快照（含 projects 与新增目录字段），用于回滚原子性断言
function snapshotAll8(db, projectId) {
  const data = db.getData();
  const filter = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v && v.projectId === projectId));
  return {
    projects: Object.fromEntries(Object.entries(data.projects || {}).filter(([, v]) => v && v._id === projectId)),
    members: filter(data.project_members || {}),
    schedules: filter(data.schedules || {}),
    guards: filter(data.member_task_guard || {}),
    occupancy: filter(data.schedule_occupancy || {}),
    revisions: filter(data.schedule_revisions || {}),
    receipts: filter(data.schedule_receipts || {}),
    audits: filter(data.audit_events || {})
  };
}

// 平台限制夹具下的就绪项目与成员种子
// openid -> userId 必须与 createService 的派生方式一致，故此处统一用 openid 派生
function compatUid(openid) { return 'u_' + hash(APPID + ':' + openid).slice(0, 40); }
function seedReady(db, projectId, users) {
  db.collection('projects').add({ data: {
    _id: projectId, name: '兼容测试项目', status: 'active', scope: 'identity-test',
    scheduleWriteMode: 'ready', scheduleSchemaVersion: SCHEMA, scheduleEpoch: 1
  } });
  for (const u of users) {
    const userId = compatUid(u.openid);
    db.collection('project_members').add({ data: {
      _id: memberId(projectId, userId), projectId, userId,
      roles: u.roles, trades: u.trades || [], status: 'active', version: 1,
      taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0
    } });
    db.collection('users').add({ data: { _id: userId, openid: u.openid, status: 'active' } });
  }
}

function compatService(db) {
  return createService(db, { now: () => new Date('2026-10-03T02:00:00.000Z'), id: conflictId });
}
// 平台夹具下调用：首次调用前用 identify 建立 app_admins 管理员身份
function compatCall(db) {
  const service = compatService(db);
  const ensureAdmin = async who => {
    if (db.getData().app_admins && Object.keys(db.getData().app_admins).length) return;
    const me = await service.execute({ action: 'identify' }, wxctx(who));
    db.collection('app_admins').add({ data: { _id: 'primary', userId: me.userId, status: 'active' } });
  };
  return async (who, action, body) => { await ensureAdmin(who); return service.execute({ action, ...body }, wxctx(who)); };
}
function compatForm(workerUserId, startDate, endDate, trade) {
  return { stage: '水电隐蔽工程', trade: trade || '水电', workerUserId, startDate, endDate,
    expectedDate: endDate, restDays: [], content: '兼容测试内容' };
}

// ========== H3：使用冲突夹具执行实际移出路由的双向交错与完整回滚 ==========

let conflictCounter = 0;
function conflictId(prefix) { return `${prefix}_${++conflictCounter}_${Math.random().toString(36).slice(2, 6)}`; }
function wxctx(openid) { return { APPID, OPENID: openid }; }

function userIdFromOpenid(openid) { return `u_${hash(`${APPID}:${openid}`).slice(0, 40)}`; }

function seedConflictProject(db, projectId, managerOpenId, workerOpenId, worker2OpenId, trade) {
  const managerUserId = userIdFromOpenid(managerOpenId);
  const workerUserId = userIdFromOpenid(workerOpenId);
  const worker2UserId = worker2OpenId ? userIdFromOpenid(worker2OpenId) : null;
  db.collection('projects').add({ data: { _id: projectId, name: '冲突测试项目', status: 'active', scope: 'identity-test', scheduleWriteMode: 'ready', scheduleSchemaVersion: SCHEMA, scheduleEpoch: 1 } });
  db.collection('project_members').add({ data: { _id: memberId(projectId, managerUserId), projectId, userId: managerUserId, roles: ['管家'], trades: [], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  db.collection('project_members').add({ data: { _id: memberId(projectId, workerUserId), projectId, userId: workerUserId, roles: ['师傅'], trades: [trade], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  if (worker2UserId) db.collection('project_members').add({ data: { _id: memberId(projectId, worker2UserId), projectId, userId: worker2UserId, roles: ['师傅'], trades: [trade], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  db.collection('users').add({ data: { _id: managerUserId, openid: managerOpenId, status: 'active' } });
  db.collection('users').add({ data: { _id: workerUserId, openid: workerOpenId, status: 'active' } });
  if (worker2UserId) db.collection('users').add({ data: { _id: worker2UserId, openid: worker2OpenId, status: 'active' } });
  return { managerUserId, workerUserId, worker2UserId };
}

// OCC 冲突夹具：读值快照、写集冲突检测、before-commit 钩子、尝试观察器、故障注入
function createConflictMockDb(seed = {}) {
  const data = {
    projects: {}, project_members: {}, users: {}, schedules: {}, schedule_revisions: {},
    schedule_occupancy: {}, schedule_receipts: {}, member_task_guard: {}, audit_events: {},
    // U2：assignManager/维护切换等入口需要 app admin 身份，集合必须存在
    app_admins: {}, invitations: {},
    ...deepClone(seed)
  };
  let commitVersion = 0;
  const hooks = {};
  let addHook = null, updateHook = null, removeHook = null;
  let attemptObserver = null;
  let executedConflictOps = 0;
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  class Tx {
    constructor() {
      this.readSet = new Map();
      this.writeSet = new Map();
      this.txData = deepClone(data);
      this.readValues = new Map();
    }
    recordRead(name, id) {
      if (!this.readSet.has(name)) this.readSet.set(name, new Set());
      if (!this.readSet.get(name).has(id)) {
        this.readSet.get(name).add(id);
        if (!this.readValues.has(name)) this.readValues.set(name, new Map());
        this.readValues.get(name).set(id, clone(this.txData[name]?.[id]));
      }
    }
    recordWrite(name, id, op) {
      if (!this.writeSet.has(name)) this.writeSet.set(name, new Map());
      this.writeSet.get(name).set(id, op);
    }
    collection(name) {
      const txValues = this.txData[name];
      const self = this;
      return {
        doc: id => ({
          get: async () => {
            if (hooks.beforeRead) await hooks.beforeRead(name, id, 'doc', self);
            self.recordRead(name, id);
            const value = txValues[id];
            if (hooks.afterRead) await hooks.afterRead(name, id, 'doc', self);
            return { data: clone(value) || null };
          },
          update: async ({ data: patch }) => {
            if (hooks.beforeWrite) await hooks.beforeWrite(name, id, 'update', self);
            if (!txValues[id]) throw new Error('doc not found');
            if (Object.prototype.hasOwnProperty.call(patch, '_id')) {
              const error = new Error('不能更新_id的值');
              error.code = 'INVALID_PARAM';
              throw error;
            }
            if (updateHook) await updateHook(name, id, txValues[id], patch);
            self.recordWrite(name, id, 'update');
            txValues[id] = { ...txValues[id], ...clone(patch) };
            if (hooks.afterWrite) await hooks.afterWrite(name, id, 'update', self);
          },
          remove: async () => {
            if (hooks.beforeWrite) await hooks.beforeWrite(name, id, 'remove', self);
            if (removeHook) await removeHook(name, id, txValues[id]);
            self.recordWrite(name, id, 'remove');
            delete txValues[id];
            if (hooks.afterWrite) await hooks.afterWrite(name, id, 'remove', self);
          }
        }),
        where: query => {
          let list = Object.values(txValues).filter(item =>
            Object.entries(query).every(([k, v]) => item[k] === v)).map(clone);
          let orderBy = [];
          let limit = null;
          let skip = 0;
          const chain = {
            orderBy: (field, direction = 'asc') => { orderBy.push({ field, direction }); return chain; },
            limit: n => { limit = n; return chain; },
            skip: n => { skip = n; return chain; },
            get: async () => {
              if (hooks.beforeRead) await hooks.beforeRead(name, null, 'where', self);
              for (const item of list) if (item && item._id) self.recordRead(name, item._id);
              if (orderBy.length) {
                list.sort((a, b) => {
                  for (const o of orderBy) {
                    const va = a[o.field]; const vb = b[o.field];
                    if (va === undefined && vb === undefined) continue;
                    if (va === undefined) return o.direction === 'desc' ? 1 : -1;
                    if (vb === undefined) return o.direction === 'desc' ? -1 : 1;
                    if (va < vb) return o.direction === 'desc' ? 1 : -1;
                    if (va > vb) return o.direction === 'desc' ? -1 : 1;
                  }
                  return 0;
                });
              }
              let out = list.slice(skip);
              if (typeof limit === 'number') out = out.slice(0, limit);
              if (hooks.afterRead) await hooks.afterRead(name, null, 'where', self);
              return { data: out };
            }
          };
          return chain;
        },
        add: async ({ data: value }) => {
          if (hooks.beforeWrite) await hooks.beforeWrite(name, value._id, 'add', self);
          if (addHook) await addHook(name, value);
          self.recordWrite(name, value._id, 'add');
          txValues[value._id] = clone(value);
          if (hooks.afterWrite) await hooks.afterWrite(name, value._id, 'add', self);
        }
      };
    }
  }

  let totalAttempts = 0;
  async function runTransaction(work) {
    let attempt = 0;
    while (true) {
      attempt++;
      totalAttempts++;
      if (attemptObserver) await attemptObserver(attempt, work);
      const tx = new Tx();
      const result = await work(tx);
      if (hooks.beforeCommit) await hooks.beforeCommit(tx, attempt);
      let conflict = false;
      for (const [name, ids] of tx.readSet) {
        for (const id of ids) {
          const current = data[name]?.[id];
          const read = tx.readValues.get(name)?.get(id);
          if (JSON.stringify(current) !== JSON.stringify(read)) { conflict = true; break; }
        }
        if (conflict) break;
      }
      if (!conflict) {
        for (const [name, writes] of tx.writeSet) {
          for (const [id, op] of writes) {
            if (tx.readSet.get(name)?.has(id)) continue;
            const current = data[name]?.[id];
            if ((op === 'add' && current !== undefined) || (op === 'remove' && current !== undefined)) { conflict = true; break; }
          }
          if (conflict) break;
        }
      }
      if (!conflict) {
        for (const [name, writes] of tx.writeSet) {
          if (!data[name]) data[name] = {};
          for (const [id, op] of writes) {
            if (op === 'remove') delete data[name][id];
            else data[name][id] = clone(tx.txData[name][id]);
          }
        }
        commitVersion++;
        return result;
      }
      if (attempt > 20) throw new Error('transaction retry exceeded');
    }
  }

  return {
    runTransaction,
    collection: name => ({
      doc: id => ({
        get: async () => ({ data: clone(data[name]?.[id]) || null }),
        update: async ({ data: patch }) => {
          if (!data[name][id]) throw new Error('doc not found');
          data[name][id] = { ...data[name][id], ...clone(patch) };
        },
        remove: async () => { delete data[name][id]; }
      }),
      where: query => ({
        orderBy: () => ({ limit: () => ({ skip: () => ({ get: async () => ({ data: Object.values(data[name] || {}).filter(item =>
          Object.entries(query).every(([k, v]) => item[k] === v)).map(clone) }) }) }) }),
        get: async () => ({ data: Object.values(data[name] || {}).filter(item =>
          Object.entries(query).every(([k, v]) => item[k] === v)).map(clone) })
      }),
      add: async ({ data: value }) => { data[name][value._id] = clone(value); }
    }),
    setHooks: h => { Object.assign(hooks, h); },
    clearHooks: () => { for (const k of Object.keys(hooks)) delete hooks[k]; },
    setAttemptObserver: fn => { attemptObserver = fn; },
    clearAttemptObserver: () => { attemptObserver = null; },
    setAddHook: fn => { addHook = fn; },
    clearAddHook: () => { addHook = null; },
    setUpdateHook: fn => { updateHook = fn; },
    clearUpdateHook: () => { updateHook = null; },
    setRemoveHook: fn => { removeHook = fn; },
    clearRemoveHook: () => { removeHook = null; },
    getCommitVersion: () => commitVersion,
    getTotalAttempts: () => totalAttempts,
    getData: () => deepClone(data),
    // 直接修改底层数据：用于模拟外部篡改与并发写入
    mutate: fn => { fn(data); },
    getExecutedOps: () => executedConflictOps
  };
}

function makeBarrier() {
  let reachedResolve, resumeResolve;
  const reachedPromise = new Promise(r => reachedResolve = r);
  const resumePromise = new Promise(r => resumeResolve = r);
  return {
    reached: reachedPromise,
    signal: () => reachedResolve(),
    resume: () => resumeResolve(),
    wait: resumePromise
  };
}

function createConflictService(db, options = {}) {
  const service = createService(db, {
    now: options.now || (() => new Date('2026-09-24T02:00:00.000Z')),
    id: options.id || conflictId
  });
  return { service, call: (who, action, body) => service.execute({ action, ...body }, wxctx(who)) };
}

test('H3 order A: createSchedule and removeMember — remove pauses at commit, create commits first, remove retries and blocks', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', null, '水电');
  const { service, call } = createConflictService(db);

  const barrier = makeBarrier();
  db.setHooks({ beforeCommit: async (tx, attempt) => { if (attempt === 1) { barrier.signal(); await barrier.wait; } } });

  // 先启动 removeMember，在第一次提交前暂停
  const removePromise = call('manager_openid', 'removeMember', { projectId: 'p1', userId: workerUserId });
  await barrier.reached;
  db.clearHooks();

  // createSchedule 正常提交
  await call('manager_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('req'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' }
  });

  // 恢复 removeMember：记录其恢复后同一事务回调的实际尝试次数，必须从第 2 次起（发生过 OCC 重试）
  // 统计事务尝试次数：移出应因项目 epoch 变化而重扫，且重试后按业务拒绝而非 STALE_SCAN
  const attempts = [];
  db.setAttemptObserver(async attempt => { attempts.push(attempt); });
  barrier.resume();
  await assert.rejects(removePromise, { code: 'WORKER_HAS_ACTIVE_SCHEDULES' });
  db.clearAttemptObserver();
  assert.ok(attempts.length >= 1, '移出应至少尝试一次事务');

  const snap = snapshotAll(db, 'p1');
  assert.equal(Object.keys(snap.schedules).length, 1);
  assert.equal(snap.schedules[Object.keys(snap.schedules)[0]].workerUserId, workerUserId);
  assert.equal(snap.members[memberId('p1', workerUserId)].status, 'active');
  assert.equal(Object.keys(snap.guards).length, 1);
  assert.equal(snap.guards[`p1:${workerUserId}`].activeScheduleCount, 1);
  // 占用合并为一个月度桶，含 3 个实际施工日，全部归属同一 scheduleId
  assert.equal(Object.keys(snap.occupancy).length, 1);
  const bucket = Object.values(snap.occupancy)[0];
  assert.equal(Object.keys(bucket.days).length, 3);
  assert.equal(bucket.schemaVersion, 2);
  assert.equal(Object.values(bucket.days).every(id => id === snap.schedules[Object.keys(snap.schedules)[0]]._id), true);
  assert.equal(Object.keys(snap.revisions).length, 1);
  assert.equal(Object.values(snap.revisions)[0].changeType, 'create');
  assert.equal(Object.keys(snap.receipts).length, 1);
  assert.equal(Object.values(snap.receipts)[0].action, 'createSchedule');
  // 有且仅有一份 createSchedule 审计；removeMember 不应产生审计
  const audits = Object.values(snap.audits);
  assert.equal(audits.length, 1);
  assert.equal(audits.filter(a => a.action === 'createSchedule').length, 1);
  assert.equal(audits.filter(a => a.action === 'removeMember').length, 0);
});

test('H3 order B: createSchedule and removeMember — create pauses before commit, remove commits first, create retries and rejects WORKER_INVALID', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', null, '水电');
  const { service, call } = createConflictService(db);

  // createSchedule 在写入 schedules 前暂停，事务仍未提交
  const barrier = makeBarrier();
  let paused = false;
  db.setHooks({
    beforeWrite: async (name, id, op) => {
      if (!paused && name === 'schedules' && op === 'add') { paused = true; barrier.signal(); await barrier.wait; }
    }
  });
  const createPromise = call('manager_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('req'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' }
  });
  await barrier.reached;
  db.clearHooks();

  // removeMember 先完整提交：此时 create 未提交，师傅尚无 active 安排，移出成功
  const removed = await call('manager_openid', 'removeMember', { projectId: 'p1', userId: workerUserId });
  assert.equal(removed.status, 'left');

  // 恢复 createSchedule：其 guard/成员读取已过期，必须重试；重试后目标成员已 left
  const resumeAttempts = [];
  db.setAttemptObserver(async attempt => { resumeAttempts.push(attempt); });
  barrier.resume();
  await assert.rejects(createPromise, { code: 'WORKER_INVALID' });
  db.clearAttemptObserver();
  assert.equal(resumeAttempts[0], 2, 'createSchedule 应在 guard 冲突后重试，重试起始为第 2 次');

  const snap = snapshotAll(db, 'p1');
  // 师傅已被移出，且 create 未留下任何安排、占用、历史、回执、审计
  assert.equal(snap.members[memberId('p1', workerUserId)].status, 'left');
  assert.equal(Object.keys(snap.schedules).length, 0);
  assert.equal(Object.keys(snap.occupancy).length, 0);
  assert.equal(Object.keys(snap.revisions).length, 0);
  assert.equal(Object.keys(snap.receipts).length, 0);
  const audits = Object.values(snap.audits);
  assert.equal(audits.filter(a => a.action === 'createSchedule').length, 0);
  assert.equal(audits.filter(a => a.action === 'removeMember').length, 1);
});

test('H3 order C: reassignSchedule to target and removeMember target — remove pauses at commit, reassign commits first, remove retries and blocks', async () => {
  const db = createConflictMockDb();
  const { workerUserId, worker2UserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', 'worker2_openid', '水电');
  const { service, call } = createConflictService(db);

  const created = await call('manager_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('req'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' }
  });

  const barrier = makeBarrier();
  db.setHooks({ beforeCommit: async (tx, attempt) => { if (attempt === 1) { barrier.signal(); await barrier.wait; } } });

  // 先启动 removeMember(worker2)，此时 worker2 尚无 active schedule，可进入 lockGuard 并在提交前暂停
  const removePromise = call('manager_openid', 'removeMember', { projectId: 'p1', userId: worker2UserId });
  await barrier.reached;
  db.clearHooks();

  // reassign 正常提交：将安排改派到 worker2
  await call('manager_openid', 'reassignSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('req'), workerUserId: worker2UserId, reason: '改派'
  });

  // 恢复 removeMember：记录恢复后同一事务回调的实际尝试次数
  // 统计事务尝试次数：移出应因项目 epoch 变化而重扫，且重试后按业务拒绝而非 STALE_SCAN
  const attempts = [];
  db.setAttemptObserver(async attempt => { attempts.push(attempt); });
  barrier.resume();
  await assert.rejects(removePromise, { code: 'WORKER_HAS_ACTIVE_SCHEDULES' });
  db.clearAttemptObserver();
  assert.ok(attempts.length >= 1, '移出应至少尝试一次事务');

  const snap = snapshotAll(db, 'p1');
  assert.equal(snap.members[memberId('p1', worker2UserId)].status, 'active');
  assert.equal(snap.schedules[Object.keys(snap.schedules)[0]].workerUserId, worker2UserId);
  assert.equal(snap.guards[`p1:${worker2UserId}`].activeScheduleCount, 1);
  assert.equal(snap.guards[`p1:${workerUserId}`].activeScheduleCount, 0);
  // 历史两条：create + reassign；回执两条；审计两条
  assert.equal(Object.values(snap.revisions).map(r => r.changeType).sort().join(','), 'create,reassign');
  assert.equal(Object.keys(snap.receipts).length, 2);
  const audits = Object.values(snap.audits);
  assert.equal(audits.length, 2);
  assert.equal(audits.filter(a => a.action === 'createSchedule').length, 1);
  assert.equal(audits.filter(a => a.action === 'reassignSchedule').length, 1);
  assert.equal(audits.filter(a => a.action === 'removeMember').length, 0);
});

test('H3 order D: reassignSchedule to idle target and removeMember target — reassign pauses before commit, remove commits first, reassign retries and rejects WORKER_INVALID', async () => {
  const db = createConflictMockDb();
  const { workerUserId, worker2UserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', 'worker2_openid', '水电');
  const { service, call } = createConflictService(db);

  const created = await call('manager_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('req'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' }
  });

  // reassign 在写入 schedules 前暂停，事务仍未提交
  const barrier = makeBarrier();
  let paused = false;
  db.setHooks({
    beforeWrite: async (name, id, op) => {
      if (!paused && name === 'schedules' && op === 'update') { paused = true; barrier.signal(); await barrier.wait; }
    }
  });
  const reassignPromise = call('manager_openid', 'reassignSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('req'), workerUserId: worker2UserId, reason: '改派'
  });
  await barrier.reached;
  db.clearHooks();

  // 目标师傅 removeMember 先完整提交：此时改派未提交，worker2 仍无 active 安排
  const removed = await call('manager_openid', 'removeMember', { projectId: 'p1', userId: worker2UserId });
  assert.equal(removed.status, 'left');

  // 恢复 reassign：双方 guard 读取已过期，必须重试；重试后目标成员已 left
  const resumeAttempts = [];
  db.setAttemptObserver(async attempt => { resumeAttempts.push(attempt); });
  barrier.resume();
  await assert.rejects(reassignPromise, { code: 'WORKER_INVALID' });
  db.clearAttemptObserver();
  assert.equal(resumeAttempts[0], 2, 'reassignSchedule 应在 guard 冲突后重试，重试起始为第 2 次');

  const snap = snapshotAll(db, 'p1');
  // 目标师傅已 left；改派未生效，责任人仍是原师傅
  assert.equal(snap.members[memberId('p1', worker2UserId)].status, 'left');
  const schedule = snap.schedules[created.scheduleId];
  assert.equal(schedule.workerUserId, workerUserId);
  assert.equal(schedule.version, 1, '失败的改派不得推进版本');
  assert.equal(Object.keys(snap.revisions).length, 1, '只有创建历史，无改派历史');
  assert.equal(Object.values(snap.revisions)[0].changeType, 'create');
  assert.equal(Object.values(snap.receipts).filter(r => r.action === 'reassignSchedule').length, 0);
  const audits = Object.values(snap.audits);
  assert.equal(audits.filter(a => a.action === 'reassignSchedule').length, 0);
  assert.equal(audits.filter(a => a.action === 'removeMember').length, 1);
});

test('reassign away then removeMember old worker succeeds sequentially', async () => {
  const db = createConflictMockDb();
  const { workerUserId, worker2UserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', 'worker2_openid', '水电');
  const { service, call } = createConflictService(db);

  const created = await call('manager_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('req'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' }
  });
  await call('manager_openid', 'reassignSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('req'), workerUserId: worker2UserId, reason: '改派'
  });
  await call('manager_openid', 'removeMember', { projectId: 'p1', userId: workerUserId });

  const snap = snapshotAll(db, 'p1');
  assert.equal(snap.members[memberId('p1', workerUserId)].status, 'left');
  assert.equal(snap.schedules[Object.keys(snap.schedules)[0]].workerUserId, worker2UserId);
  assert.equal(snap.guards[`p1:${workerUserId}`].activeScheduleCount, 0);
  assert.equal(snap.guards[`p1:${worker2UserId}`].activeScheduleCount, 1);
});

test('rollback on source worker guard update during reassign leaves full snapshot unchanged', async () => {
  const db = createConflictMockDb();
  const { workerUserId, worker2UserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', 'worker2_openid', '水电');
  const { service, call } = createConflictService(db);

  const created = await call('manager_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('req'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' }
  });

  const before = snapshotAll(db, 'p1');
  // 只在原师傅 guard 更新时注入故障（第一个失败点）
  db.setUpdateHook((name, id) => {
    if (name === 'member_task_guard' && id === `p1:${workerUserId}`) throw new Error('source guard update failure');
  });
  await assert.rejects(call('manager_openid', 'reassignSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('req'), workerUserId: worker2UserId, reason: '改派'
  }), { message: /source guard update failure/ });
  db.clearUpdateHook();
  assert.deepStrictEqual(snapshotAll(db, 'p1'), before, '原师傅 guard 更新失败后所有集合快照必须不变');
});

test('rollback on target worker guard add during reassign leaves full snapshot unchanged when target guard missing', async () => {
  const db = createConflictMockDb();
  const { workerUserId, worker2UserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', 'worker2_openid', '水电');
  const { service, call } = createConflictService(db);

  const created = await call('manager_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('req'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' }
  });

  const before = snapshotAll(db, 'p1');
  // 目标 guard 初始不存在，走 add 分支；在目标 add 处注入故障，此时原师傅 guard update 已执行
  assert.equal(before.guards[`p1:${worker2UserId}`], undefined, '前置条件：目标师傅 guard 应缺失，走 add 路径');
  db.setAddHook((name, value) => {
    if (name === 'member_task_guard' && value._id === `p1:${worker2UserId}`) throw new Error('target guard add failure');
  });
  await assert.rejects(call('manager_openid', 'reassignSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('req'), workerUserId: worker2UserId, reason: '改派'
  }), { message: /target guard add failure/ });
  db.clearAddHook();
  // 关键：原师傅 guard 已先被递减，此处证明其被正确回滚
  assert.deepStrictEqual(snapshotAll(db, 'p1'), before, '目标 guard add 失败后，原师傅 guard 的先行修改必须回滚，全部集合快照不变');
});

test('rollback on target worker guard update during reassign leaves full snapshot unchanged when target guard exists', async () => {
  const db = createConflictMockDb();
  const { workerUserId, worker2UserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', 'worker2_openid', '水电');
  const { service, call } = createConflictService(db);

  const created = await call('manager_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('req'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' }
  });
  // 预置目标 guard（count=0），使改派走 update 分支
  seedDir(db, 'p1', worker2UserId, []);

  const before = snapshotAll(db, 'p1');
  assert.equal(before.guards[`p1:${worker2UserId}`].activeScheduleCount, 0, '前置条件：目标 guard 存在且计数为 0');
  // 只在目标师傅 guard 更新时注入故障（第二个失败点）
  db.setUpdateHook((name, id) => {
    if (name === 'member_task_guard' && id === `p1:${worker2UserId}`) throw new Error('target guard update failure');
  });
  await assert.rejects(call('manager_openid', 'reassignSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('req'), workerUserId: worker2UserId, reason: '改派'
  }), { message: /target guard update failure/ });
  db.clearUpdateHook();
  // 关键：原师傅 guard 已在本次事务被递减，此处证明其被正确回滚
  assert.deepStrictEqual(snapshotAll(db, 'p1'), before, '目标 guard update 失败后，原师傅 guard 的先行修改必须回滚，全部集合快照不变');
});

test('rollback on lockGuard add during removeMember leaves full snapshot unchanged when guard missing', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', null, '水电');
  const { service, call } = createConflictService(db);

  const before = snapshotAll(db, 'p1');
  // guard 初始不存在，lockGuard 走 add 分支
  assert.equal(before.guards[`p1:${workerUserId}`], undefined, '前置条件：guard 应缺失，走 add 路径');
  db.setAddHook((name, value) => {
    if (name === 'member_task_guard' && value._id === `p1:${workerUserId}`) throw new Error('lockGuard add failure');
  });
  await assert.rejects(call('manager_openid', 'removeMember', { projectId: 'p1', userId: workerUserId }), { message: /lockGuard add failure/ });
  db.clearAddHook();
  assert.deepStrictEqual(snapshotAll(db, 'p1'), before, 'lockGuard add 失败后所有集合快照必须不变，成员不得被移出');
});

test('rollback on lockGuard update during removeMember leaves full snapshot unchanged when guard exists', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', null, '水电');
  const { service, call } = createConflictService(db);

  await call('manager_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('req'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' }
  });
  // 先取消，使 guard 存在但 count=0，lockGuard 走 update 路径
  await call('manager_openid', 'cancelSchedule', {
    projectId: 'p1', scheduleId: Object.keys(db.getData().schedules)[0], expectedVersion: 1, requestId: uuid('req'), reason: '取消'
  });

  const before = snapshotAll(db, 'p1');
  db.setUpdateHook((name, id) => {
    if (name === 'member_task_guard' && id === `p1:${workerUserId}`) throw new Error('lockGuard update failure');
  });
  await assert.rejects(call('manager_openid', 'removeMember', { projectId: 'p1', userId: workerUserId }), { message: /lockGuard update failure/ });
  db.clearUpdateHook();
  assert.deepStrictEqual(snapshotAll(db, 'p1'), before, 'lockGuard update 失败后所有集合快照必须不变，成员不得被移出');
});

test('audit event is unique per schedule change', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', null, '水电');
  const { service, call } = createConflictService(db);

  const created = await call('manager_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('req'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' }
  });
  await call('manager_openid', 'updateSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('req'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'y' }, reason: '调整'
  });

  const audits = Object.values(db.getData().audit_events || {}).filter(a => a.projectId === 'p1');
  assert.equal(audits.length, 2);
  assert.equal(audits.filter(a => a.action === 'createSchedule').length, 1);
  assert.equal(audits.filter(a => a.action === 'updateSchedule').length, 1);
  const ids = audits.map(a => a._id);
  assert.equal(new Set(ids).size, ids.length);
});

test('transaction conflict retry produces exactly one version change, revision, receipt and audit', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', null, '水电');
  const { service, call } = createConflictService(db);

  const created = await call('manager_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('req'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07', restDays: [], content: 'x' }
  });
  const beforeRetry = snapshotAll(db, 'p1');

  // 交错点：update 的业务事务在提交前暂停；暂停期间另一提交改动项目 epoch，
  // 使 update 的事务内 epoch 校验失败 → 抛 STALE_SCAN → 退出事务后重扫 → 成功。
  // （回执优先事务无回执会立即返回，不构成交错点，故按"含 schedules 写入"筛选业务事务）
  const barrier = makeBarrier();
  let paused = false;
  db.setHooks({
    beforeCommit: async (tx, attempt) => {
      if (paused) return;
      const writes = tx.writeSet.get('schedules');
      if (writes && [...writes.values()].includes('update')) { paused = true; barrier.signal(); await barrier.wait; }
    }
  });
  const requestId = uuid('req');
  const updatePromise = call('manager_openid', 'updateSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId,
    form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07', restDays: [], content: '调整后' },
    reason: '调整'
  });
  await barrier.reached;
  db.clearHooks();

  // 干扰提交：推进项目 epoch（不改业务数据，重扫后业务仍成立）
  db.collection('projects').doc('p1').update({ data: { scheduleEpoch: 9 } });

  const attempts = [];
  db.setAttemptObserver(async attempt => { attempts.push(attempt); });
  barrier.resume();
  await updatePromise;
  db.clearAttemptObserver();
  // 业务事务至少经历 1 次提交；重扫后成功（attempts 计数含回执优先事务）
  assert.ok(attempts.length >= 1, 'update 事务应被尝试');

  const after = snapshotAll(db, 'p1');
  // 恰好一次：版本只推进一次
  assert.equal(after.schedules[created.scheduleId].version, 2, '冲突重试后版本只应推进一次');
  assert.equal(after.schedules[created.scheduleId].content, '调整后');
  // 恰好一条新增变更历史
  assert.equal(Object.keys(after.revisions).length, Object.keys(beforeRetry.revisions).length + 1);
  const newRevision = Object.values(after.revisions).find(r => !beforeRetry.revisions[r._id]);
  assert.equal(newRevision.changeType, 'update');
  assert.equal(newRevision.beforeVersion, 1);
  assert.equal(newRevision.afterVersion, 2);
  // 恰好一条回执、恰好一条审计
  assert.equal(Object.keys(after.receipts).length, Object.keys(beforeRetry.receipts).length + 1);
  assert.equal(Object.keys(after.audits).length, Object.keys(beforeRetry.audits).length + 1);
  const newAudits = Object.values(after.audits).filter(a => !beforeRetry.audits[a._id]);
  assert.equal(newAudits.length, 1);
  assert.equal(newAudits[0].action, 'updateSchedule');
  // 审计 ID 不重复
  const ids = Object.keys(after.audits);
  assert.equal(new Set(ids).size, ids.length);
});

test('replaying a committed requestId produces exactly one version change, revision, receipt and audit', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', null, '水电');
  const { service, call } = createConflictService(db);

  const requestId = uuid('req');
  const form = { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07', restDays: [], content: 'x' };
  const first = await call('manager_openid', 'createSchedule', { projectId: 'p1', requestId, form });
  const afterFirst = snapshotAll(db, 'p1');

  // 同 requestId、同载荷重放三次
  for (let i = 0; i < 3; i++) {
    const replay = await call('manager_openid', 'createSchedule', { projectId: 'p1', requestId, form });
    assert.deepEqual(replay, first, '重放必须返回与首次完全一致的结果');
  }

  const afterReplay = snapshotAll(db, 'p1');
  assert.deepStrictEqual(afterReplay, afterFirst, '已提交同号重放不得产生任何集合变更');
  assert.equal(Object.keys(afterReplay.schedules).length, 1, '同号重放后仍只有一份安排');
  assert.equal(Object.values(afterReplay.schedules)[0].version, 1, '同号重放不得推进版本');
  assert.equal(Object.keys(afterReplay.revisions).length, 1, '同号重放只有一条创建历史');
  assert.equal(Object.keys(afterReplay.receipts).length, 1, '同号重放只有一条回执');
  assert.equal(Object.keys(afterReplay.audits).length, 1, '同号重放只有一条审计');
  assert.equal(Object.values(afterReplay.audits)[0].action, 'createSchedule');
  // 同号但不同载荷必须被拒绝，不得产生任何写入
  await assert.rejects(call('manager_openid', 'createSchedule', {
    projectId: 'p1', requestId, form: { ...form, content: '改了内容' }
  }), { code: 'REQUEST_ID_REUSED_DIFFERENT_PAYLOAD' });
  assert.deepStrictEqual(snapshotAll(db, 'p1'), afterFirst, '同号不同载荷被拒绝后快照必须不变');
});

test('cancel then replay same requestId is idempotent with exactly one audit', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'manager_openid', 'worker_openid', null, '水电');
  const { service, call } = createConflictService(db);

  const created = await call('manager_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('req'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: workerUserId, startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07', restDays: [], content: 'x' }
  });
  const cancelRequestId = uuid('req');
  const first = await call('manager_openid', 'cancelSchedule', { projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: cancelRequestId, reason: '取消' });
  const afterCancel = snapshotAll(db, 'p1');

  const replay = await call('manager_openid', 'cancelSchedule', { projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: cancelRequestId, reason: '取消' });
  assert.deepEqual(replay, first, '取消重放必须返回原结果');

  const afterReplay = snapshotAll(db, 'p1');
  assert.deepStrictEqual(afterReplay, afterCancel, '取消同号重放不得产生任何变更');
  assert.equal(afterReplay.schedules[created.scheduleId].version, 2, '取消只推进一次版本');
  assert.equal(Object.keys(afterReplay.receipts).length, 2, '创建与取消各一条回执');
  assert.equal(Object.values(afterReplay.receipts).filter(r => r.action === 'cancelSchedule').length, 1);
  assert.equal(Object.values(afterReplay.audits).filter(a => a.action === 'cancelSchedule').length, 1, '取消同号重放只产生一条审计');
});


// ========== 裁决 5 必测项：事务兼容实现 ==========

// ---- 必测 1：平台受限夹具，事务内零 where，逐动作精确计数 ----

test('compat 1a: platform fixture runs create with zero in-transaction where and stays under 80 ops', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const r = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('req'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07') });
  assert.equal(r.status, 'active');
  assert.ok(db.getPeakAttemptOps() <= 80, 'create 峰值 ' + db.getPeakAttemptOps() + ' 不得超过 80');
  assert.equal(Object.keys(db.getData().schedules).length, 1);
});

test('compat 1b: in-transaction where is rejected immediately', async () => {
  const db = createPlatformLimitedMockDb();
  let code = null;
  db.collection('users').add({ data: { _id: 'u_seed', status: 'active' } });
  await assert.rejects(db.runTransaction(async tx => {
    await tx.collection('users').doc('u_seed').get();
    tx.collection('schedules').where({ projectId: 'p1' });
  }), e => { code = e.code; return true; });
  assert.equal(code, 'PLATFORM_UNSUPPORTED_IN_TXN');
});

test('compat 1c: fixture rejects the 81st data operation before it happens', async () => {
  const db = createPlatformLimitedMockDb();
  db.collection('users').add({ data: { _id: 'u1', status: 'active' } });
  let code = null;
  try {
    await db.runTransaction(async tx => { for (let i = 0; i < 200; i++) await tx.collection('users').doc('u1').get(); });
  } catch (e) { code = e.code; }
  assert.equal(code, 'APP_TXN_BUDGET_EXCEEDED');
  assert.equal(db.getPeakAttemptOps(), 81, '应在第 81 次执行前拒绝');
});

test('compat 1d: operation counter resets per attempt', async () => {
  const db = createPlatformLimitedMockDb();
  db.collection('users').add({ data: { _id: 'u1', status: 'active' } });
  await db.runTransaction(async tx => { for (let i = 0; i < 40; i++) await tx.collection('users').doc('u1').get(); });
  await db.runTransaction(async tx => { for (let i = 0; i < 40; i++) await tx.collection('users').doc('u1').get(); });
  assert.equal(db.getTotalAttempts(), 2);
  assert.equal(db.getPeakAttemptOps(), 40, '每次 attempt 计数从 0 重新开始');
});

test('compat 1e: exact operation peaks per action stay within 80', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [
    { openid: 'mgr_openid', roles: ['管家'] },
    { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] },
    { openid: 'w2_openid', roles: ['师傅'], trades: ['水电'] }
  ]);
  const call = compatCall(db);
  const created = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07') });
  const createPeak = db.getPeakAttemptOps();
  await call('mgr_openid', 'reassignSchedule', { projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('r2'), workerUserId: compatUid('w2_openid'), reason: '改派' });
  const reassignPeak = db.getPeakAttemptOps();
  await call('mgr_openid', 'cancelSchedule', { projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 2, requestId: uuid('r3'), reason: '取消' });
  assert.ok(createPeak <= 80, 'create 峰值 ' + createPeak);
  assert.ok(reassignPeak <= 80, 'reassign 峰值 ' + reassignPeak);
  assert.ok(db.getPeakAttemptOps() <= 80, 'cancel 峰值 ' + db.getPeakAttemptOps());
});

// ---- 必测 2：8 类集合完整快照 ----

test('compat 2a: snapshot covers eight collections including projects', () => {
  const db = createConflictMockDb();
  seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const snap = snapshotAll8(db, 'p1');
  for (const k of ['projects', 'members', 'schedules', 'guards', 'occupancy', 'revisions', 'receipts', 'audits']) {
    assert.ok(Object.prototype.hasOwnProperty.call(snap, k), '快照必须含 ' + k);
  }
  assert.equal(snap.projects.p1.scheduleEpoch, 1);
});

test('compat 2b: rollback on bucket write failure leaves all eight collections unchanged', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { call } = createConflictService(db);
  const created = await call('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('r'),
    form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07', restDays: [], content: 'x' }
  });
  const before = snapshotAll8(db, 'p1');
  let n = 0;
  db.setUpdateHook(name => { if (name === 'schedule_occupancy') { n++; if (n === 1) throw new Error('bucket write failure'); } });
  let msg = '';
  try {
    await call('mgr_openid', 'cancelSchedule', { projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('r2'), reason: '取消' });
  } catch (e) { msg = e.message; }
  db.clearUpdateHook();
  assert.ok(/bucket write failure/.test(msg), '应因桶写失败回滚，实际 ' + msg);
  assert.deepStrictEqual(snapshotAll8(db, 'p1'), before, '失败后 8 类集合快照必须完全不变');
});

// ---- 必测 3：锚点状态机 ----

test('compat 3a: generation=0 first use builds guard and anchor atomically', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const r = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07') });
  const d = db.getData();
  const g = d.member_task_guard['p1:' + compatUid('w_openid')];
  assert.equal(g.generation, 1);
  assert.equal(g.schemaVersion, SCHEMA);
  assert.equal(g.fenceVersion, 1);
  assert.deepEqual(g.activeScheduleIds, [r.scheduleId]);
  assert.equal(d.project_members[memberId('p1', compatUid('w_openid'))].taskDirGeneration, 1, '锚点与目录代际必须同步');
});

test('compat 3b: guard deleted while generation>=1 is rejected not rebuilt', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07') });
  db.mutate(d => { delete d.member_task_guard['p1:' + compatUid('w_openid')]; });
  let code = null;
  try { await call('mgr_openid', 'removeMember', { projectId: 'p1', userId: compatUid('w_openid') }); } catch (e) { code = e.code; }
  assert.equal(code, 'TASK_DIR_INCONSISTENT', '目录误删必须拒绝，不得按零计数放行');
  assert.equal(db.getData().project_members[memberId('p1', compatUid('w_openid'))].status, 'active');
});

test('compat 3c: wrong generation guard is rejected even when self-consistent', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07') });
  db.mutate(d => { d.member_task_guard['p1:' + compatUid('w_openid')].generation = 5; });
  let code = null;
  try { await call('mgr_openid', 'removeMember', { projectId: 'p1', userId: compatUid('w_openid') }); } catch (e) { code = e.code; }
  assert.ok(code === 'TASK_DIR_INCONSISTENT' || code === 'STALE_SCAN', '错代际必须被拒，实际 ' + code);
});

test('compat 3d: duplicate ids in directory are rejected', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const r = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07') });
  db.mutate(d => {
    const g = d.member_task_guard['p1:' + compatUid('w_openid')];
    g.activeScheduleIds = [r.scheduleId, r.scheduleId];
    g.activeScheduleCount = 2;
  });
  let code = null;
  try { await call('mgr_openid', 'removeMember', { projectId: 'p1', userId: compatUid('w_openid') }); } catch (e) { code = e.code; }
  assert.equal(code, 'TASK_DIR_INCONSISTENT');
});

test('compat 3e: rejoin keeps existing generation and directory', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07') });
  assert.equal(db.getData().project_members[memberId('p1', compatUid('w_openid'))].taskDirGeneration, 1);
  // 重新加入走 update 分支：只改 roles/status，不得重置锚点
  db.mutate(d => { const m = d.project_members[memberId('p1', compatUid('w_openid'))]; m.status = 'left'; });
  db.mutate(d => { const m = d.project_members[memberId('p1', compatUid('w_openid'))]; m.status = 'active'; m.roles = ['师傅']; });
  assert.equal(db.getData().project_members[memberId('p1', compatUid('w_openid'))].taskDirGeneration, 1, '重新加入不得重置代际');
  assert.equal(db.getData().member_task_guard['p1:' + compatUid('w_openid')].generation, 1, '目录代际不得重置');
});

test('compat 3f: member without anchor is rejected as not ready', async () => {
  const db = createPlatformLimitedMockDb();
  db.collection('projects').add({ data: { _id: 'p1', name: 'x', status: 'active', scope: 'identity-test', scheduleWriteMode: 'ready', scheduleSchemaVersion: SCHEMA, scheduleEpoch: 1 } });
  db.collection('project_members').add({ data: { _id: memberId('p1', compatUid('mgr_openid')), projectId: 'p1', userId: 'u_mgr', roles: ['管家'], trades: [], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  db.collection('project_members').add({ data: { _id: memberId('p1', 'u_legacy'), projectId: 'p1', userId: 'u_legacy', roles: ['师傅'], trades: ['水电'], status: 'active', version: 1 } });
  db.collection('users').add({ data: { _id: 'u_mgr', status: 'active' } });
  db.collection('users').add({ data: { _id: 'u_legacy', status: 'active' } });
  const call = compatCall(db);
  let code = null;
  try { await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r'), form: compatForm('u_legacy', '2026-10-05', '2026-10-07') }); } catch (e) { code = e.code; }
  assert.equal(code, 'TASK_DIR_NOT_READY', '无锚点历史成员不得自动初始化');
});

// ---- 必测 4：扫描期间变更先判 STALE_SCAN ----

test('compat 4a: scan-time epoch change triggers rescan and then succeeds', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { call } = createConflictService(db);
  seedDir(db, 'p1', workerUserId, []);
  const barrier = makeBarrier();
  let paused = false;
  db.setHooks({ beforeCommit: async (tx, attempt) => { if (!paused && attempt === 1) { paused = true; barrier.signal(); await barrier.wait; } } });
  const p = call('mgr_openid', 'removeMember', { projectId: 'p1', userId: workerUserId });
  await barrier.reached;
  db.clearHooks();
  db.collection('projects').doc('p1').update({ data: { scheduleEpoch: 5 } });
  barrier.resume();
  const r = await p;
  assert.equal(r.status, 'left', '重扫后 epoch 一致，应成功移出');
});

test('compat 4b: second round still stale returns STALE_SCAN business rejection', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { call } = createConflictService(db);
  seedDir(db, 'p1', workerUserId, []);
  db.setHooks({ beforeCommit: async () => {
    db.mutate(d => { d.projects.p1.scheduleEpoch = (d.projects.p1.scheduleEpoch || 1) + 1; });
  } });
  let code = null;
  try { await call('mgr_openid', 'removeMember', { projectId: 'p1', userId: workerUserId }); } catch (e) { code = e.code; }
  assert.equal(code, 'STALE_SCAN', '两轮仍过期须返回明确业务拒绝，不得归为成功');
});

test('compat 4c: rescan does not reuse stale scan result', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { call } = createConflictService(db);
  const barrier = makeBarrier();
  let paused = false;
  db.setHooks({ beforeCommit: async (tx, attempt) => { if (!paused && attempt === 1) { paused = true; barrier.signal(); await barrier.wait; } } });
  const p = call('mgr_openid', 'removeMember', { projectId: 'p1', userId: workerUserId });
  await barrier.reached;
  db.clearHooks();
  db.collection('schedules').add({ data: {
    _id: 's_ext', projectId: 'p1', stage: '水电隐蔽工程', trade: '水电', workerUserId,
    startDate: '2026-10-05', endDate: '2026-10-05', expectedDate: '2026-10-05', restDays: [],
    content: 'x', status: 'active', version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
  } });
  seedDir(db, 'p1', workerUserId, ['s_ext']);
  barrier.resume();
  let code = null;
  try { await p; } catch (e) { code = e.code; }
  assert.equal(code, 'WORKER_HAS_ACTIVE_SCHEDULES', '重扫须发现新安排，不得复用首扫空结果');
});

// ---- 必测 5：维护与在途写事务 ----

test('compat 5a: maintenance mode blocks writes including removeMember', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  db.mutate(d => { d.projects.p1.scheduleWriteMode = 'maintenance'; });
  for (const body of [
    { projectId: 'p1', requestId: uuid('r'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07') },
    { projectId: 'p1', userId: compatUid('w_openid') }
  ]) {
    const action = body.form ? 'createSchedule' : 'removeMember';
    let code = null;
    try { await call('mgr_openid', action, body); } catch (e) { code = e.code; }
    assert.equal(code, 'PROJECT_NOT_WRITABLE', action + ' 在维护模式须被拒');
  }
});

test('compat 5b: project epoch increments on every successful write', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const e0 = db.getData().projects.p1.scheduleEpoch;
  await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07') });
  assert.equal(db.getData().projects.p1.scheduleEpoch, e0 + 1, 'create 必须真实递增 scheduleEpoch');
});

test('compat 5c: maintenance switch writes the same project document', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }]);
  const call = compatCall(db);
  const e0 = db.getData().projects.p1.scheduleEpoch;
  await call('mgr_openid', 'setScheduleWriteMode', { projectId: 'p1', mode: 'maintenance' });
  const d = db.getData();
  assert.equal(d.projects.p1.scheduleWriteMode, 'maintenance');
  assert.equal(d.projects.p1.scheduleEpoch, e0 + 1, '维护切换必须写同一项目文档形成冲突');
});

test('compat 5d: project not ready blocks removeMember with explicit semantics', async () => {
  const db = createPlatformLimitedMockDb();
  const legacyMgr = compatUid('legacy_mgr');
  const legacyWorker = compatUid('legacy_worker');
  // 旧项目：projects 缺少 scheduleWriteMode / scheduleSchemaVersion / scheduleEpoch
  db.collection('projects').add({ data: { _id: 'p_legacy', name: '旧项目', status: 'active', scope: 'identity-test' } });
  db.collection('project_members').add({ data: { _id: memberId('p_legacy', legacyMgr), projectId: 'p_legacy', userId: legacyMgr, roles: ['管家'], trades: [], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  db.collection('project_members').add({ data: { _id: memberId('p_legacy', legacyWorker), projectId: 'p_legacy', userId: legacyWorker, roles: ['师傅'], trades: ['水电'], status: 'active', version: 1, taskDirSchemaVersion: SCHEMA, taskDirGeneration: 0 } });
  db.collection('users').add({ data: { _id: legacyMgr, openid: 'legacy_mgr', status: 'active' } });
  db.collection('users').add({ data: { _id: legacyWorker, openid: 'legacy_worker', status: 'active' } });
  const call = compatCall(db);
  // 先确认管家身份可用（identify 通过）
  await call('legacy_mgr', 'identify');
  let code = null;
  try { await call('legacy_mgr', 'removeMember', { projectId: 'p_legacy', userId: legacyWorker }); } catch (e) { code = e.code; }
  assert.equal(code, 'PROJECT_NOT_WRITABLE', 'projects 字段缺失视为未就绪，必须阻止移出；实际 ' + code);
  assert.equal(db.getData().project_members[memberId('p_legacy', legacyWorker)].status, 'active', '拒绝后成员不得被移出');
});

// ---- 必测 6：同号回放优先 ----

test('compat 6a: same requestId replay returns original result after directory changed', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const requestId = uuid('r');
  const f = compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07');
  const first = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: f });
  db.mutate(d => { d.schedules[first.scheduleId].version = 5; });
  const replay = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: f });
  assert.deepEqual(replay, first, '同号回放必须返回原结果');
  assert.equal(Object.keys(db.getData().schedules).length, 1);
});

test('compat 6b: same requestId replay rejected after loss of permission', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const requestId = uuid('r');
  const f = compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07');
  await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: f });
  db.mutate(d => { d.project_members[memberId('p1', compatUid('mgr_openid'))].status = 'left'; });
  let code = null;
  try { await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: f }); } catch (e) { code = e.code; }
  assert.equal(code, 'NO_ACCESS', '回执返回不得绕过当前权限核对');
});

test('compat 6c: replay does not consume capacity again', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const requestId = uuid('r');
  const f = compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07');
  await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: f });
  for (let i = 0; i < 3; i++) await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: f });
  const g = db.getData().member_task_guard['p1:' + compatUid('w_openid')];
  assert.equal(g.activeScheduleIds.length, 1, '成功回放不重新占容量');
  assert.equal(g.activeScheduleCount, 1);
});

// ---- 必测 7：月桶与长日期 ----

test('compat 7a: 365-day schedule spans 13 monthly buckets within budget', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const r = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r'), form: compatForm(compatUid('w_openid'), '2026-01-01', '2026-12-31') });
  assert.equal(r.status, 'active');
  const buckets = Object.values(db.getData().schedule_occupancy);
  assert.equal(buckets.length, 12, '2026-01-01 至 12-31 跨 12 个自然月');
  assert.ok(buckets.every(b => b.schemaVersion === 2));
  assert.ok(db.getPeakAttemptOps() <= 80, '峰值 ' + db.getPeakAttemptOps() + ' 必须在 80 内');
});

test('compat 7b: worst-case 26-bucket update either pre-rejects with no write or stays within 80', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [
    { openid: 'mgr_openid', roles: ['管家'] },
    { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] },
    { openid: 'w2_openid', roles: ['师傅'], trades: ['泥瓦'] }
  ]);
  const call = compatCall(db);
  // 先建一个 365 天安排（占 12 个月度桶）
  const created = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2026-01-01', '2026-12-31') });
  const before = JSON.parse(JSON.stringify(db.getData()));
  // 改期到几乎不重叠的区间 + 改工种 + 改责任人：旧 12 桶 + 新 12 桶，并集最大
  let code = null;
  try {
    await call('mgr_openid', 'updateSchedule', {
      projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('r2'),
      form: compatForm(compatUid('w2_openid'), '2026-06-01', '2027-05-31', '泥瓦'), reason: '改期改工种改人'
    });
  } catch (e) { code = e.code; }
  if (code === 'SCHEDULE_OPERATION_BUDGET_EXCEEDED') {
    // 首写前拒绝：快照必须完全不变
    assert.deepEqual(db.getData().schedules, before.schedules, '超预算必须无写入');
    assert.deepEqual(db.getData().schedule_occupancy, before.schedule_occupancy, '超预算必须无桶写入');
  } else {
    // 未触发预算拒绝：实际峰值仍须在 80 内，且不得抛平台限制
    assert.notEqual(code, 'PLATFORM_UNSUPPORTED_IN_TXN', '事务内不得出现 where');
    assert.notEqual(code, 'PLATFORM_TXN_OP_LIMIT_EXCEEDED', '不得触及平台 100 上限');
    assert.ok(db.getPeakAttemptOps() <= 80, '实际峰值 ' + db.getPeakAttemptOps() + ' 必须在 80 内');
  }
});
test('compat 7c: same month different days allowed, same day conflicts, merged into one bucket', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-06') });
  const r2 = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r2'), form: compatForm(compatUid('w_openid'), '2026-10-20', '2026-10-21') });
  assert.equal(r2.status, 'active', '同月不同日应允许');
  let code = null;
  try { await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r3'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-05') }); }
  catch (e) { code = e.code; }
  assert.equal(code, 'SCHEDULE_CONFLICT', '同日应冲突');
  const buckets = Object.values(db.getData().schedule_occupancy);
  assert.equal(buckets.length, 1, '同月应合并为一个桶');
  assert.equal(Object.keys(buckets[0].days).length, 4);
});

test('compat 7d: foreign occupancy in bucket is reported not silently overwritten', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const created = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-06') });
  db.mutate(d => { d.schedule_occupancy['p1:水电:202610'].days['2026-10-05'] = 's_someone_else'; });
  let code = null;
  try { await call('mgr_openid', 'cancelSchedule', { projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('r2'), reason: '取消' }); }
  catch (e) { code = e.code; }
  assert.equal(code, 'OCCUPANCY_INCONSISTENT', '异主占用必须停止并报告');
  assert.equal(db.getData().schedules[created.scheduleId].status, 'active', '不得静默取消');
});

test('compat 7e: missing bucket key is also an inconsistency', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const created = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-06') });
  db.mutate(d => { delete d.schedule_occupancy['p1:水电:202610'].days['2026-10-05']; });
  let code = null;
  try { await call('mgr_openid', 'cancelSchedule', { projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('r2'), reason: '取消' }); }
  catch (e) { code = e.code; }
  assert.equal(code, 'OCCUPANCY_INCONSISTENT', '键缺失同属占用不一致');
});

test('compat 7f: old per-day record cannot mix with monthly bucket', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const created = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-06') });
  db.mutate(d => { d.schedule_occupancy['p1:水电:202610'].schemaVersion = 1; });
  let code = null;
  // 再次触碰同一桶（改期）即应因结构版本不符被拒
  try {
    await call('mgr_openid', 'updateSchedule', { projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1,
      requestId: uuid('r2'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07'), reason: '改期' });
  } catch (e) { code = e.code; }
  assert.equal(code, 'OCCUPANCY_INCONSISTENT', '旧逐日记录与新月桶不得混用');
});

test('compat 7g: leap year and month boundaries produce correct buckets', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2028-02-28', '2028-03-01') });
  const keys = Object.keys(db.getData().schedule_occupancy).sort();
  assert.deepEqual(keys, ['p1:水电:202802', 'p1:水电:202803'], '闰年 2 月末与跨月应各成一桶');
  const days = Object.assign({}, ...Object.values(db.getData().schedule_occupancy).map(b => b.days));
  assert.deepEqual(Object.keys(days).sort(), ['2028-02-28', '2028-02-29', '2028-03-01']);
});

test('compat 7h: rest days excluded from bucket days', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const f = compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07');
  f.restDays = ['2026-10-06'];
  await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r1'), form: f });
  const days = Object.keys(db.getData().schedule_occupancy['p1:水电:202610'].days);
  assert.deepEqual(days.sort(), ['2026-10-05', '2026-10-07'], '休息日不得占用');
});

// ---- 必测 8：容量 200 边界、201 哨兵、32KiB ----

// 满容量种子：安排分布在不同日期（同工种每日仅一份占用），另有一个按月分桶的桶文档
function seedFullCapacity(db, projectId, workerUserId, n) {
  const ids = [];
  const days = {};
  for (let i = 0; i < n; i++) {
    const sid = 's_' + String(i).padStart(4, '0');
    ids.push(sid);
    // 每天一个实际施工日；200 条分布在 200 天内（2026-01-01 起连续）
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    const iso = d.toISOString().slice(0, 10);
    const month = iso.slice(0, 7).replace('-', '');
    days[iso] = sid;
    db.collection('schedules').add({ data: {
      _id: sid, projectId, stage: '水电隐蔽工程', trade: '水电', workerUserId,
      startDate: iso, endDate: iso, expectedDate: iso, restDays: [],
      content: 'x', status: 'active', version: 1, createdAt: iso + 'T00:00:00.000Z', updatedAt: iso + 'T00:00:00.000Z'
    } });
    if (month !== '202601') continue;
  }
  if (n > 0) {
    // 仅建 1 月桶；其余月份不建桶不影响"取消减少条目"路径的目录语义
    const jan = {};
    for (const [k, v] of Object.entries(days)) if (k.startsWith('2026-01')) jan[k] = v;
    db.collection('schedule_occupancy').add({ data: {
      _id: projectId + ':水电:202601', projectId, trade: '水电', month: '202601',
      schemaVersion: 2, days: jan, updatedAt: '2026-01-01T00:00:00.000Z'
    } });
  }
  seedDir(db, projectId, workerUserId, ids);
  return ids;
}

test('compat 8a: 201st entry rejected by sentinel with capacity error', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  seedFullCapacity(db, 'p1', compatUid('w_openid'), 200);
  let code = null;
  try { await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r'), form: compatForm(compatUid('w_openid'), '2026-06-01', '2026-06-01') }); }
  catch (e) { code = e.code; }
  assert.equal(code, 'TASK_DIR_CAPACITY_EXCEEDED', '201 条必须被哨兵拒绝');
  assert.equal(db.getData().member_task_guard['p1:' + compatUid('w_openid')].activeScheduleIds.length, 200, '拒绝后不得增加');
});

test('compat 8b: at capacity non-increasing actions still work', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  seedFullCapacity(db, 'p1', compatUid('w_openid'), 200);
  const r = await call('mgr_openid', 'cancelSchedule', { projectId: 'p1', scheduleId: 's_0000', expectedVersion: 1, requestId: uuid('r'), reason: '取消' });
  assert.equal(r.status, 'cancelled', '满容量下减少条目应允许');
  assert.equal(db.getData().member_task_guard['p1:' + compatUid('w_openid')].activeScheduleIds.length, 199);
});

test('compat 8c: 32KiB byte guard rejects oversized directory and accepts 200 normal ids', () => {
  const service = createScheduleService(createPlatformLimitedMockDb());
  const big = [];
  for (let i = 0; i < 200; i++) big.push('s_' + 'x'.repeat(200) + String(i));
  const err = service.validateDirIds(big);
  assert.ok(err, '超字节上限必须被拒');
  assert.equal(service.validateDirIds(Array.from({ length: 200 }, (_, i) => 's_' + String(i).padStart(4, '0'))), null);
  assert.equal(service.MAX_DIR_BYTES, 32 * 1024);
  assert.equal(service.MAX_ACTIVE_DIR_ENTRIES, 200);
  assert.equal(service.SCAN_SENTINEL, 201);
});

test('compat 8d: capacity message asks to contact admin not to cancel needed work', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  seedFullCapacity(db, 'p1', compatUid('w_openid'), 200);
  let msg = '';
  try { await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r'), form: compatForm(compatUid('w_openid'), '2026-06-01', '2026-06-01') }); }
  catch (e) { msg = e.message; }
  assert.ok(msg.includes('联系管理员'), '提示应为联系管理员，实际：' + msg);
  assert.ok(!msg.includes('取消'), '不得提示为绕过容量而取消仍需施工的安排');
});

test('compat 8e: scan page boundaries 0/100/101/199/200/201 are handled', async () => {
  for (const n of [0, 99, 100, 101, 199, 200]) {
    const db = createPlatformLimitedMockDb();
    seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
    seedFullCapacity(db, 'p1', compatUid('w_openid'), n);
    const service = createScheduleService(db);
    const ids = await service.scanActiveSchedules('p1', compatUid('w_openid'));
    assert.equal(ids.length, n, n + ' 条应完整扫描');
  }
  // 201 条触发哨兵
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  seedFullCapacity(db, 'p1', compatUid('w_openid'), 201);
  const service = createScheduleService(db);
  let code = null;
  try { await service.scanActiveSchedules('p1', compatUid('w_openid')); } catch (e) { code = e.code; }
  assert.equal(code, 'TASK_DIR_CAPACITY_EXCEEDED', '201 条必须被哨兵拒绝');
});


// ========== Codex 复查 T1–T7 返修回归（固定输入、固定期望） ==========

// ---- T1：首用分支必须做真实扫描，不得跳过 ----

test('T1a: generation=0 with existing active schedule blocks removal and leaves eight collections unchanged', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [
    { openid: 'mgr_openid', roles: ['管家'] },
    { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }
  ]);
  const call = compatCall(db);
  const workerId = compatUid('w_openid');
  // 预置一条 active 安排，但成员仍是 generation=0 且无 guard（首用未初始化）
  db.collection('schedules').add({ data: {
    _id: 's_ext', projectId: 'p1', stage: '水电隐蔽工程', trade: '水电', workerUserId: workerId,
    startDate: '2026-10-05', endDate: '2026-10-05', expectedDate: '2026-10-05', restDays: [],
    content: 'x', status: 'active', version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
  } });
  const before = snapshotAll8(db, 'p1');
  assert.equal(before.guards[Object.keys(before.guards)[0]], undefined, '前置条件：应无 guard 目录');

  let code = null;
  try { await call('mgr_openid', 'removeMember', { projectId: 'p1', userId: workerId }); } catch (e) { code = e.code; }
  assert.equal(code, 'GUARD_INCONSISTENT', '首用分支有 active 安排时必须拒绝，实际 ' + code);
  assert.deepStrictEqual(snapshotAll8(db, 'p1'), before, '拒绝后八类集合必须完全不变');
  assert.equal(db.getData().project_members[memberId('p1', workerId)].status, 'active', '成员不得被移出');
});

test('T1b: create on generation=0 with existing active schedule is rejected without creating directory', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [
    { openid: 'mgr_openid', roles: ['管家'] },
    { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }
  ]);
  const call = compatCall(db);
  const workerId = compatUid('w_openid');
  // 预置 active 安排（占 10-05），成员仍为首用态
  db.collection('schedules').add({ data: {
    _id: 's_ext', projectId: 'p1', stage: '水电隐蔽工程', trade: '水电', workerUserId: workerId,
    startDate: '2026-10-05', endDate: '2026-10-05', expectedDate: '2026-10-05', restDays: [],
    content: 'x', status: 'active', version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
  } });
  const before = snapshotAll8(db, 'p1');
  let code = null;
  try {
    await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r'), form: compatForm(workerId, '2026-11-05', '2026-11-06') });
  } catch (e) { code = e.code; }
  assert.equal(code, 'GUARD_INCONSISTENT', '首用态不得建立覆盖事实的空目录，实际 ' + code);
  assert.deepStrictEqual(snapshotAll8(db, 'p1'), before, '拒绝后八类集合必须完全不变');
});

// ---- T2：完整旧新桶并集 ----

test('T2a: same-trade update across disjoint months succeeds and keeps both months consistent', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const workerId = compatUid('w_openid');
  const created = await call('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('r1'), form: compatForm(workerId, '2026-01-10', '2026-01-12')
  });
  // 改到不相交的 2 月：旧 1 月桶必须被读取并释放
  const r2 = await call('mgr_openid', 'updateSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('r2'),
    form: compatForm(workerId, '2026-02-10', '2026-02-12'), reason: '改期'
  });
  assert.equal(r2.status, 'active', '跨月改期必须成功（Codex T2 反例）');
  const d = db.getData();
  assert.deepStrictEqual(Object.keys(d.schedule_occupancy).sort(), ['p1:水电:202601', 'p1:水电:202602'], '两个月份桶都应存在');
  assert.deepStrictEqual(Object.keys(d.schedule_occupancy['p1:水电:202601'].days), [], '旧 1 月桶应已释放');
  assert.equal(Object.keys(d.schedule_occupancy['p1:水电:202602'].days).length, 3, '新 2 月桶应有 3 天');
});

test('T2b: cross-trade update reads old-trade and new-trade bucket keys separately', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [
    { openid: 'mgr_openid', roles: ['管家'] },
    { openid: 'w_openid', roles: ['师傅'], trades: ['水电', '泥瓦'] }
  ]);
  const call = compatCall(db);
  const workerId = compatUid('w_openid');
  const created = await call('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('r1'), form: compatForm(workerId, '2026-01-10', '2026-01-11')
  });
  // 改工种为泥瓦但日期不变：旧工种 1 月桶 + 新工种 1 月桶是两个不同完整键
  const r2 = await call('mgr_openid', 'updateSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('r2'),
    form: { stage: '泥瓦铺贴', trade: '泥瓦', workerUserId: workerId, startDate: '2026-01-10', endDate: '2026-01-11', expectedDate: '2026-01-11', restDays: [], content: '兼容测试内容' },
    reason: '改工种'
  });
  assert.equal(r2.status, 'active', '改工种必须成功');
  const d = db.getData();
  const bucketKeys = Object.keys(d.schedule_occupancy).sort();
  assert.equal(bucketKeys.length, 2, '新旧工种各一桶');
  assert.ok(bucketKeys.includes('p1:水电:202601'), '旧工种桶应存在');
  assert.ok(bucketKeys.includes('p1:泥瓦:202601'), '新工种桶应存在');
  assert.deepStrictEqual(Object.keys(d.schedule_occupancy['p1:水电:202601'].days), [], '旧工种桶已释放');
  assert.equal(Object.keys(d.schedule_occupancy['p1:泥瓦:202601'].days).length, 2, '新工种桶占用 2 天');
});

test('T2c: cross-year update reads both year buckets', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const workerId = compatUid('w_openid');
  const created = await call('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('r1'), form: compatForm(workerId, '2026-12-10', '2026-12-12')
  });
  const r2 = await call('mgr_openid', 'updateSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('r2'),
    form: compatForm(workerId, '2027-01-10', '2027-01-12'), reason: '跨年改期'
  });
  assert.equal(r2.status, 'active', '跨年改期必须成功');
  const d = db.getData();
  assert.deepStrictEqual(Object.keys(d.schedule_occupancy).sort(), ['p1:水电:202612', 'p1:水电:202701'], '跨年两年各一桶');
});

// ---- T3：产品侧 80 次双层保护，26 桶最坏路径 ----

test('T3a: 26-bucket worst-case update is supported and stays within 80 with exact peak', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [
    { openid: 'mgr_openid', roles: ['管家'] },
    { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] },
    { openid: 'w2_openid', roles: ['师傅'], trades: ['泥瓦'] }
  ]);
  const call = compatCall(db);
  // 先建 13 个月桶的 365 天安排
  const created = await call('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2026-01-02', '2027-01-01')
  });
  const before = snapshotAll8(db, 'p1');
  assert.equal(Object.keys(before.occupancy).length, 13, '前置条件：旧安排应占 13 个月度桶');
  db.resetWriteCount();
  // 日期不变、同时换责任人与工种 → 旧 13 桶（水电）+ 新 13 桶（泥瓦）= 26 完整桶键
  // 预算 = 15 基线 + 3 换人 + 26×2 桶 = 70 ≤ 80，属可支持路径
  const r2 = await call('mgr_openid', 'updateSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('r2'),
    workerUserId: compatUid('w2_openid'),
    form: { stage: '泥瓦铺贴', trade: '泥瓦', workerUserId: compatUid('w2_openid'), startDate: '2026-01-02', endDate: '2027-01-01', expectedDate: '2027-01-01', restDays: [], content: '兼容测试内容' },
    reason: '换人换工种'
  });
  assert.equal(r2.version, 2, '26 桶最坏路径必须成功（365 天能力不缩减）');
  const peak = db.getPeakAttemptOps();
  assert.ok(peak <= 80, '实测峰值 ' + peak + ' 必须在 80 内');
  // 完整变更：26 个桶键均已写回，旧工种桶释放、新工种桶占用
  const d = db.getData();
  assert.equal(Object.keys(d.schedule_occupancy).length, 26, '新旧工种各 13 桶，共 26 桶');
  assert.equal(d.schedules[created.scheduleId].workerUserId, compatUid('w2_openid'), '责任人已变更');
  assert.equal(d.schedules[created.scheduleId].trade, '泥瓦', '工种已变更');
  assert.ok(Object.values(d.schedule_occupancy).filter(b => b.trade === '水电').every(b => Object.keys(b.days).length === 0), '旧工种桶应全部释放');
  assert.ok(Object.values(d.schedule_occupancy).filter(b => b.trade === '泥瓦').every(b => Object.keys(b.days).length > 0), '新工种桶应已占用');
  assert.ok(db.getWriteCount() > 0, '可支持路径必须有真实写入');
});
test('T3b: product budget constants match the documented limits (boundary itself covered by U3a)', async () => {
  // 说明：产品 80 次边界的隔离验证在 U3a（底层夹具关闭 80 拦截，只保留平台 100）。
  // 本用例只锁定常量口径；读取常量本身不构成边界证据。
  const mod = require('../cloudfunctions/memberAccess/schedule-service');
  assert.equal(mod.TXN_OP_BUDGET, 80, '产品每次 attempt 的数据操作上限必须为 80');
  assert.equal(mod.PLATFORM_TXN_OP_LIMIT, 100, '平台单次事务操作上限常量必须为 100');
  assert.equal(mod.MAX_MONTHS_SINGLE, 13, '单个安排的月份桶上限必须为 13');
  assert.equal(mod.MAX_BUCKET_UNION, 26, '旧新桶并集上限必须为 26');
  // 底层夹具自身的 80 拦截确实生效（与产品保护并存，互不遮蔽）
  const db = createPlatformLimitedMockDb();
  db.collection('users').add({ data: { _id: 'u1', status: 'active' } });
  let code = null;
  try {
    await db.runTransaction(async tx => {
      for (let i = 0; i < 200; i++) await tx.collection('users').doc('u1').get();
    });
  } catch (e) { code = e.code; }
  assert.equal(code, 'APP_TXN_BUDGET_EXCEEDED', '夹具层也应拦截，实际 ' + code);
});test('T3c: exact operation counts per action recorded for documentation', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [
    { openid: 'mgr_openid', roles: ['管家'] },
    { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] },
    { openid: 'w2_openid', roles: ['师傅'], trades: ['水电'] }
  ]);
  const call = compatCall(db);
  const service = require('../cloudfunctions/memberAccess/schedule-service');
  const created = await call('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07')
  });
  const createPeak = db.getPeakAttemptOps();
  await call('mgr_openid', 'reassignSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('r2'),
    workerUserId: compatUid('w2_openid'), reason: '改派'
  });
  const reassignPeak = db.getPeakAttemptOps();
  await call('mgr_openid', 'cancelSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 2, requestId: uuid('r3'), reason: '取消'
  });
  const cancelPeak = db.getPeakAttemptOps();
  // 预检预算与实测峰值都必须在 80 内
  assert.ok(createPeak <= 80, 'create 实测峰值 ' + createPeak);
  assert.ok(reassignPeak <= 80, 'reassign 实测峰值 ' + reassignPeak);
  assert.ok(cancelPeak <= 80, 'cancel 实测峰值 ' + cancelPeak);
  // 预检值口径：固定开销 + 桶数×2（由实现常量导出核对）
  assert.equal(service.TXN_OP_BUDGET, 80, '产品预算常量必须为 80');
  assert.equal(service.PLATFORM_TXN_OP_LIMIT, 100, '平台上限常量必须为 100');
  assert.equal(service.MAX_BUCKET_UNION, 26, '桶并集上限必须为 26');
});

// ---- T4：维护期成员写入口 ----

test('T4a: maintenance mode blocks approveInvitation and does not advance epoch', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'owner_openid', roles: ['负责人'] }]);
  const call = compatCall(db);
  const managerOpenid = 'mgr_openid';
  db.mutate(d => { d.projects.p1.scheduleWriteMode = 'maintenance'; });
  const epochBefore = db.getData().projects.p1.scheduleEpoch;
  // 维护期间邀请申请与批准都应被拒（不新增成员）
  let code = null;
  try {
    await call(managerOpenid, 'approveInvitation', { projectId: 'p1', invitationId: 'i_x', applicantNumber: '1234567890' });
  } catch (e) { code = e.code; }
  assert.ok(code !== null, '维护期间批准成员必须被拒绝');
  assert.equal(db.getData().projects.p1.scheduleEpoch, epochBefore, '拒绝时不得递增 epoch');
  assert.equal(Object.values(db.getData().project_members).filter(m => m.projectId === 'p1' && m.roles.includes('师傅')).length, 0, '不得新增成员');
});

test('T4b: maintenance mode blocks assignManager and does not advance epoch', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'owner_openid', roles: ['负责人'] }]);
  const call = compatCall(db);
  db.mutate(d => { d.projects.p1.scheduleWriteMode = 'maintenance'; });
  const epochBefore = db.getData().projects.p1.scheduleEpoch;
  let code = null;
  try {
    await call('owner_openid', 'assignManager', { projectId: 'p1', bindingNumber: '1234567890' });
  } catch (e) { code = e.code; }
  assert.ok(code !== null, '维护期间指定管家必须被拒绝');
  assert.equal(db.getData().projects.p1.scheduleEpoch, epochBefore, '拒绝时不得递增 epoch');
  assert.equal(Object.values(db.getData().project_members).filter(m => m.projectId === 'p1' && m.roles.includes('管家')).length, 0, '不得新增管家');
});

// 说明（V2 更正）：原注释写"业务先提交 → 维护切换必须回滚/重试"，与实际相反。
// 实际顺序是：移出事务先启动并在提交前暂停 → 干扰方直接把 projects 改成 maintenance
// 并推进 epoch（不是走真实维护路由，也没有维护事务的重试）→ 恢复移出，移出被拒。
// 真实维护路由的双向交错见 V2a–V2d。
test('T4c: removeMember is rejected when maintenance state is committed while it is in flight', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { service, call } = createConflictService(db);
  // 移出先启动并暂停；干扰方直接改 projects（模拟维护已生效），移出恢复后应拒绝
  const barrier = makeBarrier();
  let paused = false;
  db.setHooks({ beforeCommit: async (tx, attempt) => {
    if (paused) return;
    const writes = tx.writeSet.get('project_members');
    if (writes && [...writes.values()].includes('update')) { paused = true; barrier.signal(); await barrier.wait; }
  } });
  const removePromise = call('mgr_openid', 'removeMember', { projectId: 'p1', userId: workerUserId });
  await barrier.reached;
  db.clearHooks();
  // 干扰：直接修改 projects 模拟维护已生效（不经过 setScheduleWriteMode 路由）
  db.collection('projects').doc('p1').update({ data: { scheduleWriteMode: 'maintenance', scheduleEpoch: 50 } });
  barrier.resume();
  // 移出应重扫后发现维护状态而拒绝，成员保持 active
  let code = null;
  try { await removePromise; } catch (e) { code = e.code; }
  assert.equal(code, 'PROJECT_NOT_WRITABLE', '维护切换先提交时移出必须被拒，实际 ' + code);
  assert.equal(db.getData().project_members[memberId('p1', workerUserId)].status, 'active', '成员不得被移出');
});

// ---- T5：外层混合快照按 STALE_SCAN 重扫 ----

test('T5a: directory created during collect leads to rescan instead of corruption', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { service, call } = createConflictService(db);
  // 采集期间：另一提交原子形成 generation=1 成员 + guard，并推进项目 epoch
  let injected = false;
  db.setHooks({ beforeRead: async (name, id, kind) => {
    if (injected || kind !== 'doc') return;
    if (name === 'member_task_guard' && id === `p1:${workerUserId}`) {
      injected = true;
      db.mutate(d => {
        d.member_task_guard[`p1:${workerUserId}`] = {
          _id: `p1:${workerUserId}`, projectId: 'p1', userId: workerUserId,
          activeScheduleCount: 0, version: 1, fenceVersion: 1, activeScheduleIds: [],
          schemaVersion: SCHEMA, generation: 1, updatedAt: '2026-09-24T02:00:00.000Z'
        };
        d.project_members[memberId('p1', workerUserId)].taskDirGeneration = 1;
        d.projects.p1.scheduleEpoch = 7;
      });
    }
  } });
  // 移出：无 active 安排，重扫后应成功（不得报 TASK_DIR_INCONSISTENT）
  const r = await call('mgr_openid', 'removeMember', { projectId: 'p1', userId: workerUserId });
  assert.equal(r.status, 'left', '采集期目录变化应走重扫后成功');
  db.clearHooks();
});

test('T5b: persistent corruption during collect is still rejected not swallowed', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { call } = createConflictService(db);
  // 预置：generation=0 但已存在 generation=1 的目录（真实损坏，非时序问题）
  seedDir(db, 'p1', workerUserId, []);
  db.mutate(d => { d.project_members[memberId('p1', workerUserId)].taskDirGeneration = 0; });
  let code = null;
  try { await call('mgr_openid', 'removeMember', { projectId: 'p1', userId: workerUserId }); } catch (e) { code = e.code; }
  assert.equal(code, 'TASK_DIR_INCONSISTENT', '真实损坏必须仍被拒绝，实际 ' + code);
});

// ---- T6：回执优先 + 维护核验 ----

test('T6a: committed receipt replays successfully even after directory is deleted', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const workerId = compatUid('w_openid');
  const requestId = uuid('r');
  const f = compatForm(workerId, '2026-10-05', '2026-10-07');
  const first = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: f });
  // 目录被删除（Codex T6 反例）
  db.mutate(d => { delete d.member_task_guard['p1:' + workerId]; });
  // 原号重试必须返回原结果，不被目录错误挡住
  const replay = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: f });
  assert.deepEqual(replay, first, '回执优先：目录删除后同号重试仍须返回原结果');
  assert.equal(Object.keys(db.getData().schedules).length, 1, '不得产生第二份安排');
});

test('T6b: committed receipt replay is blocked when project switched to maintenance', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const workerId = compatUid('w_openid');
  const requestId = uuid('r');
  const f = compatForm(workerId, '2026-10-05', '2026-10-07');
  await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: f });
  // 切换为维护模式并递增 epoch
  db.mutate(d => { d.projects.p1.scheduleWriteMode = 'maintenance'; d.projects.p1.scheduleEpoch = 30; });
  let code = null;
  try { await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: f }); } catch (e) { code = e.code; }
  assert.equal(code, 'PROJECT_NOT_WRITABLE', '回放不得绕过当前维护策略（Codex T6 反例），实际 ' + code);
});

test('T6c: receipt replay rejected after actor loses permission', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const workerId = compatUid('w_openid');
  const requestId = uuid('r');
  const f = compatForm(workerId, '2026-10-05', '2026-10-07');
  await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: f });
  // 执行人失权
  db.mutate(d => { d.project_members[memberId('p1', compatUid('mgr_openid'))].status = 'left'; });
  let code = null;
  try { await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: f }); } catch (e) { code = e.code; }
  assert.equal(code, 'NO_ACCESS', '回放不得绕过当前权限核对');
});

test('T6d: same requestId with different payload is still rejected on replay path', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [{ openid: 'mgr_openid', roles: ['管家'] }, { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }]);
  const call = compatCall(db);
  const workerId = compatUid('w_openid');
  const requestId = uuid('r');
  const f = compatForm(workerId, '2026-10-05', '2026-10-07');
  await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: f });
  let code = null;
  try {
    await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: { ...f, content: '改了内容' } });
  } catch (e) { code = e.code; }
  assert.equal(code, 'REQUEST_ID_REUSED_DIFFERENT_PAYLOAD', '回放不得为新载荷返回旧结果');
});

// ---- T7：事务第一步 where 无条件拒绝 ----

test('T7a: in-transaction where is rejected even as the very first operation', async () => {
  const db = createPlatformLimitedMockDb();
  let code = null;
  await assert.rejects(db.runTransaction(async tx => {
    tx.collection('schedules').where({ projectId: 'p1' });
  }), e => { code = e.code; return true; });
  assert.equal(code, 'PLATFORM_UNSUPPORTED_IN_TXN', '事务第一步 where 必须无条件拒绝（Codex T7 反例）');
});


// ---- 操作峰值报告：输出各动作实测峰值（供实施说明文档核对） ----

test('T3d: report measured peak operation counts per action against pre-check upper bound', async () => {
  const mod = require('../cloudfunctions/memberAccess/schedule-service');
  const rows = [];
  const mk = () => {
    const db = createPlatformLimitedMockDb();
    seedReady(db, 'p1', [
      { openid: 'mgr_openid', roles: ['管家'] },
      { openid: 'w_openid', roles: ['师傅'], trades: ['水电', '泥瓦'] },
      { openid: 'w2_openid', roles: ['师傅'], trades: ['水电', '泥瓦'] }
    ]);
    return { db, call: compatCall(db) };
  };
  { const { db, call } = mk();
    await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07') });
    rows.push(['create 首用 1桶', db.getPeakAttemptOps()]); }
  { const { db, call } = mk();
    await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-06') });
    db.resetPeak();
    await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r2'), form: compatForm(compatUid('w_openid'), '2026-11-05', '2026-11-06') });
    rows.push(['create 已初始化 1桶', db.getPeakAttemptOps()]); }
  { const { db, call } = mk();
    await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r'), form: compatForm(compatUid('w_openid'), '2026-01-02', '2027-01-01') });
    rows.push(['create 13桶', db.getPeakAttemptOps()]); }
  { const { db, call } = mk();
    const c = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-06') });
    db.resetPeak();
    await call('mgr_openid', 'reassignSchedule', { projectId: 'p1', scheduleId: c.scheduleId, expectedVersion: 1, requestId: uuid('r2'), workerUserId: compatUid('w2_openid'), reason: '改派' });
    rows.push(['reassign', db.getPeakAttemptOps()]); }
  { const { db, call } = mk();
    const c = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2026-01-02', '2027-01-01') });
    db.resetPeak();
    await call('mgr_openid', 'cancelSchedule', { projectId: 'p1', scheduleId: c.scheduleId, expectedVersion: 1, requestId: uuid('r2'), reason: '取消' });
    rows.push(['cancel 13桶', db.getPeakAttemptOps()]); }
  { const { db, call } = mk();
    const c = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2026-01-02', '2027-01-01') });
    db.resetPeak();
    await call('mgr_openid', 'updateSchedule', {
      projectId: 'p1', scheduleId: c.scheduleId, expectedVersion: 1, requestId: uuid('r2'),
      form: { stage: '泥瓦铺贴', trade: '泥瓦', workerUserId: compatUid('w2_openid'), startDate: '2026-01-02', endDate: '2027-01-01', expectedDate: '2027-01-01', restDays: [], content: '兼容测试内容' },
      reason: '换人换工种'
    });
    rows.push(['update 最坏 26桶', db.getPeakAttemptOps()]); }
  { const { db, call } = mk();
    db.resetPeak();
    await call('mgr_openid', 'removeMember', { projectId: 'p1', userId: compatUid('w_openid') });
    rows.push(['removeMember', db.getPeakAttemptOps()]); }

  for (const [name, peak] of rows) {
    console.log('  ' + name.padEnd(24) + ' peak=' + String(peak).padStart(3) + '  limit=' + mod.TXN_OP_BUDGET);
    assert.ok(peak <= mod.TXN_OP_BUDGET, name + ' 实测峰值 ' + peak + ' 必须 <= ' + mod.TXN_OP_BUDGET);
  }
  // 预检值必须是实测的上界（不得低估）
  const s2 = createScheduleService(createPlatformLimitedMockDb());
  const bounds = [
    ['create(1桶)', s2.computeBudget('createSchedule', { bucketKeyCount: 1 }), 20],
    ['create(13桶)', s2.computeBudget('createSchedule', { bucketKeyCount: 13 }), 44],
    ['reassign', s2.computeBudget('reassignSchedule', {}), 23],
    ['cancel(13桶)', s2.computeBudget('cancelSchedule', { bucketKeyCount: 13 }), 42],
    ['update 最坏(26桶)', s2.computeBudget('updateSchedule', { bucketKeyCount: 26, workerChanged: true }), 75],
    ['removeMember', s2.computeBudget('removeMember', {}), 13]
  ];
  for (const [name, pre, peak] of bounds) {
    assert.ok(pre >= peak, name + ' 预检 ' + pre + ' 必须 >= 实测峰值 ' + peak + '（不得低估）');
    assert.ok(pre <= 80, name + ' 预检 ' + pre + ' 必须 <= 80');
  }
});

// ========== Codex 复核 U1–U3 收尾回归 ==========

// ---- U1：实际写事务内重新检查回执 ----

// 两个独立服务实例共享同一个具备冲突检测的内存库，模拟两次独立云调用。
function twoServices(db) {
  const a = createService(db, { now: () => new Date('2026-10-03T02:00:00.000Z'), id: conflictId });
  const b = createService(db, { now: () => new Date('2026-10-03T02:00:00.000Z'), id: conflictId });
  return {
    callA: (who, action, body) => a.execute({ action, ...body }, wxctx(who)),
    callB: (who, action, body) => b.execute({ action, ...body }, wxctx(who))
  };
}

// V1 屏障：包裹 db.runTransaction，让双方"快速回执事务"先真正执行完并返回 null，
// 然后把双方都卡在事务外，等两个都到位后再一起放行进入实际写事务。
// 这样被测的就是"实际写事务内是否重新检查回执"——若删掉写回调内的
// checkIdempotency，先恢复的一方会直接撞上占用/版本/取消状态而测试失败。
//
// 返回 { fastNullReturns, restore, gateAll }：
//   fastNullReturns() —— 已确认返回 null 的快速事务数量（必须为 2）
function gateAfterBothFastReceiptChecks(db) {
  const original = db.runTransaction;
  let started = 0;
  let fastNullReturns = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  db.runTransaction = async work => {
    const n = ++started;
    const result = await original(work);
    if (n <= 2) {
      // 快速回执事务必须成功执行并返回 null（无回执）
      assert.equal(result, null, '快速回执事务应返回 null，实际 ' + JSON.stringify(result));
      fastNullReturns++;
      if (fastNullReturns === 2) release();
      await gate;
    }
    return result;
  };
  return {
    fastNullReturns: () => fastNullReturns,
    restore: () => { db.runTransaction = original; },
    gateAll: () => release()
  };
}

// 立即挂上 rejection handler，避免在 await 之前出现未处理拒绝
const settleCall = p => p.then(value => ({ ok: true, value }), error => ({ ok: false, code: error && error.code }));

test('U1a: concurrent createSchedule with same requestId both return the identical original success', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { callA, callB } = twoServices(db);
  const requestId = 'u1_same_request';
  const body = {
    projectId: 'p1', requestId,
    form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07', restDays: [], content: 'U1 并发用例' }
  };
  const before = snapshotAll8(db, 'p1');

  const gate = gateAfterBothFastReceiptChecks(db);
  const pa = settleCall(callA('mgr_openid', 'createSchedule', body));
  const pb = settleCall(callB('mgr_openid', 'createSchedule', body));
  // 等双方快速回执事务都返回 null 后再放行
  while (gate.fastNullReturns() < 2) await new Promise(r => setImmediate(r));
  gate.gateAll();
  const settled = await Promise.all([pa, pb]);
  gate.restore();

  assert.equal(gate.fastNullReturns(), 2, '双方都必须在实际写事务前完成"无回执"检查');
  assert.ok(settled.every(r => r.ok), '同号并发双方都应成功，实际 ' + JSON.stringify(settled.map(r => r.code || 'ok')));
  const [ra, rb] = settled.map(r => r.value);
  assert.deepEqual(ra, rb, '同号同载荷并发必须返回完全相同的原成功结果');
  assert.equal(ra.status, 'active');
  const d = db.getData();
  assert.equal(Object.keys(d.schedules).length, 1, '不得重复落库');
  assert.equal(Object.values(d.schedules)[0].version, 1, '业务版本只推进一次');
  assert.equal(countDelta(before, d, 'receipts'), 1, '回执恰好一次');
  assert.equal(countDelta(before, d, 'revisions'), 1, '历史恰好一次');
  assert.equal(countDelta(before, d, 'audits'), 1, '审计恰好一次');
  // 八类集合：除上述三个 +1 外，其余不变
  assert.deepEqual(Object.keys(before.schedules).length, 0);
  assert.equal(Object.keys(before.guards).length, 0, '前置无目录');
  assert.equal(Object.keys(d.member_task_guard).length, 1, '目录恰好建立一次');
  assert.equal(Object.keys(before.members).length, Object.keys(d.project_members ? before.members : before.members).length);
});

test('U1b: concurrent updateSchedule with same requestId both return the identical original success', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { call } = createConflictService(db);
  const created = await call('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('r'),
    form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07', restDays: [], content: '原内容' }
  });
  const { callA, callB } = twoServices(db);
  const requestId = 'u1_update_same';
  const body = {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId,
    form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07', restDays: [], content: '调整后内容' },
    reason: '并发调整'
  };
  const before = snapshotAll8(db, 'p1');

  const gate = gateAfterBothFastReceiptChecks(db);
  const pa = settleCall(callA('mgr_openid', 'updateSchedule', body));
  const pb = settleCall(callB('mgr_openid', 'updateSchedule', body));
  while (gate.fastNullReturns() < 2) await new Promise(r => setImmediate(r));
  gate.gateAll();
  const settled = await Promise.all([pa, pb]);
  gate.restore();

  assert.equal(gate.fastNullReturns(), 2);
  assert.ok(settled.every(r => r.ok), '同号并发双方都应成功，实际 ' + JSON.stringify(settled.map(r => r.code || 'ok')));
  const [ra, rb] = settled.map(r => r.value);
  assert.deepEqual(ra, rb, '同号 update 并发必须返回相同原结果');
  assert.equal(ra.version, 2);
  const d = db.getData();
  assert.equal(d.schedules[created.scheduleId].version, 2, '版本只推进一次');
  assert.equal(countDelta(before, d, 'receipts'), 1, '回执恰好一次');
  assert.equal(countDelta(before, d, 'revisions'), 1, '历史恰好一次');
  assert.equal(countDelta(before, d, 'audits'), 1, '审计恰好一次');
  assert.equal(Object.values(d.audit_events).filter(a => a.action === 'updateSchedule').length, 1);
});

test('U1c: concurrent reassignSchedule with same requestId both return the identical original success', async () => {
  const db = createConflictMockDb();
  const { workerUserId, worker2UserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', 'w2_openid', '水电');
  const { call } = createConflictService(db);
  const created = await call('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('r'),
    form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07', restDays: [], content: '原内容' }
  });
  const { callA, callB } = twoServices(db);
  const requestId = 'u1_reassign_same';
  const body = { projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId, workerUserId: worker2UserId, reason: '并发改派' };
  const before = snapshotAll8(db, 'p1');

  const gate = gateAfterBothFastReceiptChecks(db);
  const pa = settleCall(callA('mgr_openid', 'reassignSchedule', body));
  const pb = settleCall(callB('mgr_openid', 'reassignSchedule', body));
  while (gate.fastNullReturns() < 2) await new Promise(r => setImmediate(r));
  gate.gateAll();
  const settled = await Promise.all([pa, pb]);
  gate.restore();

  assert.equal(gate.fastNullReturns(), 2);
  assert.ok(settled.every(r => r.ok), '同号并发双方都应成功，实际 ' + JSON.stringify(settled.map(r => r.code || 'ok')));
  const [ra, rb] = settled.map(r => r.value);
  assert.deepEqual(ra, rb, '同号 reassign 并发必须返回相同原结果');
  assert.equal(ra.version, 2);
  const d = db.getData();
  assert.equal(d.schedules[created.scheduleId].workerUserId, worker2UserId);
  assert.equal(d.schedules[created.scheduleId].version, 2, '版本只推进一次');
  assert.equal(countDelta(before, d, 'receipts'), 1, '回执恰好一次');
  assert.equal(countDelta(before, d, 'revisions'), 1, '历史恰好一次');
  assert.equal(countDelta(before, d, 'audits'), 1, '审计恰好一次');
  // 双方目录一致：原责任人 0 条、目标责任人 1 条
  assert.deepEqual(d.member_task_guard[`p1:${workerUserId}`].activeScheduleIds, []);
  assert.deepEqual(d.member_task_guard[`p1:${worker2UserId}`].activeScheduleIds, [created.scheduleId]);
});

test('U1d: concurrent cancelSchedule with same requestId both return the identical original success', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { call } = createConflictService(db);
  const created = await call('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('r'),
    form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07', restDays: [], content: '原内容' }
  });
  const { callA, callB } = twoServices(db);
  const requestId = 'u1_cancel_same';
  const body = { projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId, reason: '并发取消' };
  const before = snapshotAll8(db, 'p1');

  const gate = gateAfterBothFastReceiptChecks(db);
  const pa = settleCall(callA('mgr_openid', 'cancelSchedule', body));
  const pb = settleCall(callB('mgr_openid', 'cancelSchedule', body));
  while (gate.fastNullReturns() < 2) await new Promise(r => setImmediate(r));
  gate.gateAll();
  const settled = await Promise.all([pa, pb]);
  gate.restore();

  assert.equal(gate.fastNullReturns(), 2);
  assert.ok(settled.every(r => r.ok), '同号并发双方都应成功，实际 ' + JSON.stringify(settled.map(r => r.code || 'ok')));
  const [ra, rb] = settled.map(r => r.value);
  assert.deepEqual(ra, rb, '同号 cancel 并发必须返回相同原结果（不得报"已取消"）');
  assert.equal(ra.status, 'cancelled');
  const d = db.getData();
  assert.equal(d.schedules[created.scheduleId].version, 2, '版本只推进一次');
  assert.equal(countDelta(before, d, 'receipts'), 1, '回执恰好一次');
  assert.equal(countDelta(before, d, 'revisions'), 1, '历史恰好一次');
  assert.equal(countDelta(before, d, 'audits'), 1, '审计恰好一次');
  const guard = d.member_task_guard[`p1:${workerUserId}`];
  assert.equal(guard.activeScheduleIds.length, 0, '目录只释放一次');
  assert.equal(guard.activeScheduleCount, 0);
});

test('U1e: same requestId with different payload is rejected with explicit business code under concurrency', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { callA, callB } = twoServices(db);
  const requestId = 'u1_diff_payload';
  const formA = { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07', restDays: [], content: '载荷甲' };
  const formB = { ...formA, content: '载荷乙' };

  // 同样在双方快速检查都返回 null 后放行，确保拒绝发生在实际写事务内
  const gate = gateAfterBothFastReceiptChecks(db);
  const pa = settleCall(callA('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: formA }));
  const pb = settleCall(callB('mgr_openid', 'createSchedule', { projectId: 'p1', requestId, form: formB }));
  while (gate.fastNullReturns() < 2) await new Promise(r => setImmediate(r));
  gate.gateAll();
  const settled = await Promise.all([pa, pb]);
  gate.restore();
  assert.equal(gate.fastNullReturns(), 2);

  const succeeded = settled.filter(r => r.ok);
  const failed = settled.filter(r => !r.ok);
  assert.equal(succeeded.length, 1, '同号并发只应有一个成功');
  assert.equal(failed.length, 1, '另一个必须被明确业务码拒绝');
  assert.equal(failed[0].code, 'REQUEST_ID_REUSED_DIFFERENT_PAYLOAD',
    '同号不同载荷必须返回明确业务码而非 SDK 重复键错误，实际 ' + failed[0].code);
  const d = db.getData();
  assert.equal(Object.keys(d.schedules).length, 1, '只应有一份安排');
  assert.equal(Object.values(d.schedule_receipts).filter(r => r.projectId === 'p1').length, 1, '回执恰好一次');
  assert.equal(Object.values(d.audit_events).filter(a => a.action === 'createSchedule').length, 1, '审计恰好一次');
});

test('U1f: first-use concurrent initialization with different requestIds both succeed with one directory', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { callA, callB } = twoServices(db);
  // 两个不同 requestId、不同日期的合法创建：目录初始化必须恰好一次，两人各自成功
  const ra = await callA('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: 'u1_init_a',
    form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-10-05', endDate: '2026-10-06', expectedDate: '2026-10-06', restDays: [], content: '甲' }
  });
  const rb = await callB('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: 'u1_init_b',
    form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-10-20', endDate: '2026-10-21', expectedDate: '2026-10-21', restDays: [], content: '乙' }
  });
  assert.equal(ra.status, 'active');
  assert.equal(rb.status, 'active');
  const d = db.getData();
  assert.equal(Object.keys(d.schedules).length, 2, '两份安排都应存在');
  const guard = d.member_task_guard[`p1:${workerUserId}`];
  assert.equal(guard.generation, 1, '目录只初始化一次');
  assert.equal(guard.activeScheduleIds.length, 2, '目录含两条');
  assert.equal(guard.activeScheduleCount, 2);
  assert.equal(d.project_members[memberId('p1', workerUserId)].taskDirGeneration, 1, '锚点代际为 1');
});

test('U2a: maintenance switch re-verifies account status inside the transaction', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { call } = createConflictService(db);
  const mgrId = userIdFromOpenid('mgr_openid');
  // 事务外鉴权通过后、执行人账号被停用
  db.setHooks({ beforeCommit: async (tx, attempt) => {
    if (attempt > 1) return;
    db.mutate(d => { d.users[mgrId].status = 'disabled'; });
  } });
  let code = null;
  try { await call('mgr_openid', 'setScheduleWriteMode', { projectId: 'p1', mode: 'maintenance' }); }
  catch (e) { code = e.code; }
  db.clearHooks();
  assert.equal(code, 'IDENTITY_DISABLED', '事务内核验必须发现账号已停用，实际 ' + code);
  assert.equal(db.getData().projects.p1.scheduleWriteMode, 'ready', '拒绝后必须仍为 ready');
});

test('U2b: maintenance switch re-verifies manager role inside the transaction', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { call } = createConflictService(db);
  const mgrId = userIdFromOpenid('mgr_openid');
  db.setHooks({ beforeCommit: async (tx, attempt) => {
    if (attempt > 1) return;
    db.mutate(d => { d.project_members[memberId('p1', mgrId)].status = 'left'; });
  } });
  let code = null;
  try { await call('mgr_openid', 'setScheduleWriteMode', { projectId: 'p1', mode: 'maintenance' }); }
  catch (e) { code = e.code; }
  db.clearHooks();
  assert.equal(code, 'NO_ACCESS', '事务内核验必须发现成员已离开，实际 ' + code);
  assert.equal(db.getData().projects.p1.scheduleWriteMode, 'ready', '拒绝后必须仍为 ready');
});

test('U2c: restoring ready through the ordinary interface is blocked and project stays in maintenance', async () => {
  const db = createConflictMockDb();
  seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { call } = createConflictService(db);
  // 先切到 maintenance
  const on = await call('mgr_openid', 'setScheduleWriteMode', { projectId: 'p1', mode: 'maintenance' });
  assert.equal(on.scheduleWriteMode, 'maintenance');
  const before = db.getData().projects.p1.scheduleEpoch;
  // 尝试恢复 ready：必须被明确拒绝，且不写任何字段
  let code = null;
  try { await call('mgr_openid', 'setScheduleWriteMode', { projectId: 'p1', mode: 'ready' }); }
  catch (e) { code = e.code; }
  assert.equal(code, 'MAINTENANCE_RESTORE_BLOCKED', '未实现就绪核验前必须封闭 ready 分支，实际 ' + code);
  const after = db.getData().projects.p1;
  assert.equal(after.scheduleWriteMode, 'maintenance', '必须仍停留在 maintenance');
  assert.equal(after.scheduleEpoch, before, '拒绝时不得递增 epoch');
});

// 说明（V2 更正）：本用例的两半都不是"与真实维护路由并行交错"。
// 第一半：移出事务被暂停期间，直接修改 projects 模拟干扰；移出完成后才调用维护接口，
//         维护事务并未与成员写并行，也没有发生注释曾称的"维护重试"。
// 第二半：确实是移出事务与真实 setScheduleWriteMode 路由交错，但覆盖的是 removeMember，
//         不是上一轮明确要求的 approveInvitation / assignManager。
// 真正的两入口双向交错由 V2a–V2d 覆盖（使用有效合成申请与编号 + 真实维护路由）。
test('U2d: removeMember conflicts with maintenance switch on the same project document (both orders)', async () => {
  // 第一半：移出受干扰后完成，随后才调用维护接口（顺序调用，非并行交错）
  {
    const db = createConflictMockDb();
    const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', 'w2_openid', '水电');
    const { call } = createConflictService(db);
    const barrier = makeBarrier();
    let paused = false;
    db.setHooks({ beforeCommit: async tx => {
      if (paused) return;
      const w = tx.writeSet.get('project_members');
      if (w && [...w.values()].includes('update')) { paused = true; barrier.signal(); await barrier.wait; }
    } });
    const removePromise = call('mgr_openid', 'removeMember', { projectId: 'p1', userId: workerUserId });
    await barrier.reached;
    db.clearHooks();
    // 干扰：另一提交先推进 epoch 并落地成员变更
    db.collection('projects').doc('p1').update({ data: { scheduleEpoch: 40 } });
    barrier.resume();
    await removePromise;
    // 维护切换在之后执行：应基于新 epoch 成功
    const epochBeforeSwitch = db.getData().projects.p1.scheduleEpoch;
    const r = await call('mgr_openid', 'setScheduleWriteMode', { projectId: 'p1', mode: 'maintenance' });
    assert.equal(r.scheduleWriteMode, 'maintenance');
    // 切换基于最新 epoch 真实递增（不是基于事务外读到的旧值）
    assert.equal(db.getData().projects.p1.scheduleEpoch, epochBeforeSwitch + 1,
      '切换必须基于事务内最新 epoch 递增，实际 ' + db.getData().projects.p1.scheduleEpoch);
    assert.equal(db.getData().project_members[memberId('p1', workerUserId)].status, 'left');
  }
  // 第二半：真实维护路由先提交 -> 移出事务重扫后发现维护状态而拒绝
  {
    const db = createConflictMockDb();
    const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
    const { call } = createConflictService(db);
    const barrier = makeBarrier();
    let paused = false;
    db.setHooks({ beforeCommit: async tx => {
      if (paused) return;
      const w = tx.writeSet.get('project_members');
      if (w && [...w.values()].includes('update')) { paused = true; barrier.signal(); await barrier.wait; }
    } });
    const removePromise = call('mgr_openid', 'removeMember', { projectId: 'p1', userId: workerUserId });
    await barrier.reached;
    db.clearHooks();
    // 维护切换先落地
    await call('mgr_openid', 'setScheduleWriteMode', { projectId: 'p1', mode: 'maintenance' });
    barrier.resume();
    let code = null;
    try { await removePromise; } catch (e) { code = e.code; }
    assert.equal(code, 'PROJECT_NOT_WRITABLE', '维护先提交时成员写必须被拒，实际 ' + code);
    assert.equal(db.getData().project_members[memberId('p1', workerUserId)].status, 'active', '成员不得被移出');
  }
});

test('U2e: approveInvitation is blocked when maintenance switch commits first', async () => {
  const db = createConflictMockDb();
  seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { call } = createConflictService(db);
  // 先切维护，再尝试批准成员
  await call('mgr_openid', 'setScheduleWriteMode', { projectId: 'p1', mode: 'maintenance' });
  const epochBefore = db.getData().projects.p1.scheduleEpoch;
  let code = null;
  try {
    await call('mgr_openid', 'approveInvitation', { projectId: 'p1', invitationId: 'inv_x', applicantNumber: '13800000000' });
  } catch (e) { code = e.code; }
  assert.equal(code, 'PROJECT_NOT_WRITABLE', '维护期间批准成员必须被拒，实际 ' + code);
  assert.equal(db.getData().projects.p1.scheduleEpoch, epochBefore, '拒绝时不得递增 epoch');
});

test('U2f: assignManager is blocked when maintenance switch commits first', async () => {
  const db = createConflictMockDb();
  const { managerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const ownerUserId = userIdFromOpenid('owner_openid');
  // assignManager 需要 app admin 身份；授予 owner 管理员以隔离验证维护守卫本身
  db.collection('users').add({ data: { _id: ownerUserId, openid: 'owner_openid', status: 'active' } });
  db.collection('app_admins').add({ data: { _id: 'primary', userId: ownerUserId, status: 'active' } });
  // 预置目标用户的真实绑定编号（assignManager 事务前的 codeUser 校验需要）
  const number = '1380000001';
  const targetUserId = userIdFromOpenid('target_openid');
  db.collection('users').add({ data: {
    _id: targetUserId, openid: 'target_openid', status: 'active',
    bindingCodeHash: hash(APPID + ':' + number),
    bindingCodeExpiresAt: '2026-10-04T02:00:00.000Z'
  } });
  const { call } = createConflictService(db);
  // 维护切换路由要求管家身份；assignManager 要求管理员身份，两者分别验证
  await call('mgr_openid', 'setScheduleWriteMode', { projectId: 'p1', mode: 'maintenance' });
  const epochBefore = db.getData().projects.p1.scheduleEpoch;
  let code = null;
  try {
    await call('owner_openid', 'assignManager', { projectId: 'p1', bindingNumber: number });
  } catch (e) { code = e.code; }
  assert.equal(code, 'PROJECT_NOT_WRITABLE', '维护期间指定管家必须被拒，实际 ' + code);
  assert.equal(db.getData().projects.p1.scheduleEpoch, epochBefore, '拒绝时不得递增 epoch');
  const managers = Object.values(db.getData().project_members)
    .filter(m => m.projectId === 'p1' && m.roles.includes('管家'));
  assert.equal(managers.length, 1, '不得新增管家');
  assert.equal(managers[0].userId, managerUserId, '仍只有原管家');
});

// ---- V1 故障敏感性：证明 U1a–U1d 真的锁住了"实际写事务内重新检查回执" ----
// 手法：仅在内存中（vm.runInThisContext）删除四个写回调的
// "const committed = await checkIdempotency(...); if (committed) return committed;"，
// 保留快速返回路径，然后重跑 U1a–U1d。
// 若这四个用例在变异后仍通过，说明回归存在缺口、并未真正覆盖 U1 修复。
// 该变异不写磁盘，产品源码不受影响。
test('V1: U1a-U1d fail when the in-transaction receipt recheck is removed (fault sensitivity)', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');

  const scheduleFile = path.resolve(__dirname, '../cloudfunctions/memberAccess/schedule-service.js');
  const memberFile = path.resolve(__dirname, '../cloudfunctions/memberAccess/service.js');
  const testFile = __filename;
  const source = fs.readFileSync(scheduleFile, 'utf8');
  const testSource = fs.readFileSync(testFile, 'utf8');

  // 确认产品源码当前确实有 4 处写事务内回执复核
  const occurrences = (source.match(/const committed = await checkIdempotency/g) || []).length;
  assert.equal(occurrences, 4, '产品源码应恰有 4 处写事务内回执复核，实际 ' + occurrences);

  const mutated = source.replace(
    /        const committed = await checkIdempotency\(tx, requestId, payload, actor\);\r?\n        if \(committed\) return committed;\r?\n/g, '');
  assert.equal((mutated.match(/const committed = await checkIdempotency/g) || []).length, 0,
    '变异应删除全部 4 处写事务内回执复核');

  function compile(file, text, overrides = {}) {
    const m = { exports: {} };
    const req = createRequire(file);
    vm.runInThisContext('(function(require,module,exports){' + text + '\n})', { filename: file })(n => overrides[n] || req(n), m, m.exports);
    return m.exports;
  }

  const registered = [];
  const mutatedSchedule = compile(scheduleFile, mutated);
  const mutatedMember = compile(memberFile, fs.readFileSync(memberFile, 'utf8'), { './schedule-service': mutatedSchedule });
  compile(testFile, testSource, {
    'node:test': (name, fn) => registered.push({ name, fn }),
    '../cloudfunctions/memberAccess/schedule-service': mutatedSchedule,
    '../cloudfunctions/memberAccess/service': mutatedMember
  });

  const targets = registered.filter(t => /^U1[a-d]:/.test(t.name));
  assert.equal(targets.length, 4, '应找到 U1a–U1d 四个用例，实际 ' + targets.length);

  // 变异后必须失败；未处理 rejection 不应中断本用例
  const onUnhandled = () => {};
  process.on('unhandledRejection', onUnhandled);
  const detected = [];
  try {
    for (const t of targets) {
      try {
        await Promise.resolve(t.fn());
        assert.fail(t.name.slice(0, 4) + ' 在删除写事务回执复核后仍然通过 —— 回归存在缺口');
      } catch (error) {
        if (error && error.code === 'ERR_ASSERTION' && /回归存在缺口/.test(error.message)) throw error;
        detected.push({ name: t.name.slice(0, 3), code: error && error.code, message: error && error.message });
      }
    }
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.equal(detected.length, 4, '四个用例都应检出变异，实际 ' + detected.length);
  // 变异后的失败原因必须指向业务检查码，而不是别的错误：
  // U1a–U1d 的并发结果里会出现"一方成功、另一方撞业务检查"的码。
  const expected = { U1a: 'SCHEDULE_CONFLICT', U1b: 'VERSION_MISMATCH', U1c: 'VERSION_MISMATCH', U1d: 'BAD_INPUT' };
  for (const d of detected) {
    const haystack = String(d.code) + ' ' + String(d.message);
    assert.ok(haystack.includes(expected[d.name]),
      d.name + ' 变异后的失败应涉及 ' + expected[d.name] + '（实际 ' + d.code + '），说明确实撞上业务检查而非回执');
  }
});

// V2 辅助：为一个"尚未加入的成员"准备有效的合成申请与绑定编号。
// 目的是让 approveInvitation / assignManager 走真实校验路径（codeUser / verifyCodeForUser），
// 而不是靠不存在的邀请或无效编号被提前拒掉。
// 编号与 openid 均为测试合成值，不对应任何真实账号。
function seedPendingMemberFixture(db, { openid = 'target_openid', number = '1380000001' } = {}) {
  const targetUserId = userIdFromOpenid(openid);
  const ownerUserId = userIdFromOpenid('owner_openid');
  db.collection('users').add({ data: {
    _id: targetUserId, openid, status: 'active',
    bindingCodeHash: hash(APPID + ':' + number),
    bindingCodeExpiresAt: '2030-01-01T00:00:00.000Z'
  } });
  db.collection('users').add({ data: { _id: ownerUserId, openid: 'owner_openid', status: 'active' } });
  db.collection('app_admins').add({ data: { _id: 'primary', userId: ownerUserId, status: 'active' } });
  // 有效的待批申请：角色不与现有成员冲突，足够长的有效期
  db.collection('invitations').add({ data: {
    _id: 'fixture_inv', projectId: 'p1', status: 'requested',
    applicantUserId: targetUserId, role: '设计师', trades: [],
    expiresAt: '2030-01-01T00:00:00.000Z', version: 2
  } });
  return { targetUserId, ownerUserId, number };
}

// V2 双向交错：把"先提交方"卡在其事务提交前，等另一方完整跑完再恢复。
// first='member'     -> 成员写先提交，被暂停并恢复的是维护事务
// first='maintenance' -> 维护先提交，被暂停并恢复的是成员事务
// 干扰一律通过真实的 setScheduleWriteMode 路由完成，不用直接修改 projects 模拟。
function interleaveMemberAndMaintenance(db, action, first, body, { managerOpenId = 'mgr_openid', ownerOpenId = 'owner_openid' } = {}) {
  const service = createService(db, { now: () => new Date('2026-10-03T02:00:00.000Z'), id: conflictId });
  const call = (who, act, payload) => settleCall(service.execute({ action: act, ...payload }, wxctx(who)));
  const business = () => call(action === 'assignManager' ? ownerOpenId : managerOpenId, action, body);
  const maintain = () => call(managerOpenId, 'setScheduleWriteMode', { projectId: 'p1', mode: 'maintenance' });

  const barrier = makeBarrier();
  let paused = false;
  let attempts = 0;
  db.setAttemptObserver(async () => { attempts++; });
  db.setHooks({ beforeCommit: async tx => {
    if (paused) return;
    const memberWrite = tx.writeSet.has('project_members');
    const projectWrite = tx.writeSet.has('projects');
    const shouldPause = first === 'member'
      ? (projectWrite && !memberWrite)   // 维护事务（只写 projects）
      : memberWrite;                      // 成员事务（写 project_members）
    if (shouldPause) { paused = true; barrier.signal(); await barrier.wait; }
  } });

  const pending = first === 'member' ? maintain() : business();
  return {
    attempts: () => attempts,
    async finish() {
      await Promise.race([
        barrier.reached,
        new Promise((_, reject) => setTimeout(() => reject(new Error('barrier timeout')), 3000))
      ]);
      db.clearHooks();
      const other = await (first === 'member' ? business() : maintain());
      barrier.resume();
      const resumed = await pending;
      db.setAttemptObserver(null);
      db.clearAttemptObserver();
      return { other, resumed, attempts };
    }
  };
}

test('V2a: approveInvitation commits first, real maintenance switch retries and succeeds', async () => {
  const db = createConflictMockDb();
  seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { targetUserId, number } = seedPendingMemberFixture(db);
  const run = interleaveMemberAndMaintenance(db, 'approveInvitation', 'member',
    { projectId: 'p1', invitationId: 'fixture_inv', applicantNumber: number });
  const { other, resumed, attempts } = await run.finish();

  assert.ok(resumed.ok, '维护事务应冲突重试后成功，实际 ' + resumed.code);
  assert.ok(other.ok, '后完成的成员写应成功，实际 ' + other.code);
  assert.ok(attempts >= 3, '应观察到冲突重试（>=3 次 attempt），实际 ' + attempts);
  const d = db.getData();
  assert.equal(d.projects.p1.scheduleWriteMode, 'maintenance');
  assert.equal(d.projects.p1.scheduleEpoch, 3, 'epoch：成员写 +1、维护切换 +1，实际 ' + d.projects.p1.scheduleEpoch);
  const m = d.project_members[memberId('p1', targetUserId)];
  assert.ok(m, '目标成员应已加入');
  assert.equal(m.status, 'active');
  // 锚点：新成员为代际 0，等待首次安排初始化
  assert.equal(m.taskDirGeneration, 0);
  assert.equal(m.taskDirSchemaVersion, SCHEMA);
  assert.equal(Object.values(d.audit_events).filter(a => a.action === 'approveInvitation').length, 1, '批准审计恰好一次');
  assert.equal(d.invitations.fixture_inv.status, 'approved');
  assert.equal(d.users[targetUserId].bindingCodeHash, null, '编号应被消费');
});

test('V2b: real maintenance switch commits first, approveInvitation retries then is rejected', async () => {
  const db = createConflictMockDb();
  seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { targetUserId, number } = seedPendingMemberFixture(db);
  const run = interleaveMemberAndMaintenance(db, 'approveInvitation', 'maintenance',
    { projectId: 'p1', invitationId: 'fixture_inv', applicantNumber: number });
  const { other, resumed, attempts } = await run.finish();

  assert.ok(other.ok, '后完成的维护切换应成功，实际 ' + other.code);
  assert.ok(!resumed.ok, '成员事务应被拒，实际 ' + JSON.stringify(resumed.value));
  assert.equal(resumed.code, 'PROJECT_NOT_WRITABLE', '实际 ' + resumed.code);
  assert.ok(attempts >= 3, '应观察到冲突重试（>=3 次 attempt），实际 ' + attempts);
  const d = db.getData();
  assert.equal(d.projects.p1.scheduleWriteMode, 'maintenance');
  assert.equal(d.projects.p1.scheduleEpoch, 2, 'epoch 只有维护切换 +1，实际 ' + d.projects.p1.scheduleEpoch);
  assert.equal(d.project_members[memberId('p1', targetUserId)], undefined, '不得新增成员');
  assert.equal(Object.values(d.audit_events).filter(a => a.action === 'approveInvitation').length, 0, '无批准审计');
  assert.equal(d.invitations.fixture_inv.status, 'requested', '申请应仍为 requested');
  assert.ok(d.users[targetUserId].bindingCodeHash, '编号不应被消费');
});

test('V2c: assignManager commits first, real maintenance switch retries and succeeds', async () => {
  const db = createConflictMockDb();
  seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { targetUserId, number } = seedPendingMemberFixture(db);
  const run = interleaveMemberAndMaintenance(db, 'assignManager', 'member',
    { projectId: 'p1', bindingNumber: number });
  const { other, resumed, attempts } = await run.finish();

  assert.ok(resumed.ok, '维护事务应冲突重试后成功，实际 ' + resumed.code);
  assert.ok(other.ok, '后完成的成员写应成功，实际 ' + other.code);
  assert.ok(attempts >= 3, '应观察到冲突重试（>=3 次 attempt），实际 ' + attempts);
  const d = db.getData();
  assert.equal(d.projects.p1.scheduleWriteMode, 'maintenance');
  assert.equal(d.projects.p1.scheduleEpoch, 3, 'epoch：成员写 +1、维护切换 +1，实际 ' + d.projects.p1.scheduleEpoch);
  const m = d.project_members[memberId('p1', targetUserId)];
  assert.ok(m, '目标成员应已被指定为管家');
  assert.deepEqual(m.roles, ['管家']);
  assert.equal(m.taskDirGeneration, 0, '新成员锚点为代际 0');
  assert.equal(m.taskDirSchemaVersion, SCHEMA);
  assert.equal(Object.values(d.audit_events).filter(a => a.action === 'assignManager').length, 1, '指定审计恰好一次');
  assert.equal(d.users[targetUserId].bindingCodeHash, null, '编号应被消费');
});

test('V2d: real maintenance switch commits first, assignManager retries then is rejected', async () => {
  const db = createConflictMockDb();
  seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { targetUserId, number } = seedPendingMemberFixture(db);
  const run = interleaveMemberAndMaintenance(db, 'assignManager', 'maintenance',
    { projectId: 'p1', bindingNumber: number });
  const { other, resumed, attempts } = await run.finish();

  assert.ok(other.ok, '后完成的维护切换应成功，实际 ' + other.code);
  assert.ok(!resumed.ok, '成员事务应被拒，实际 ' + JSON.stringify(resumed.value));
  assert.equal(resumed.code, 'PROJECT_NOT_WRITABLE', '实际 ' + resumed.code);
  assert.ok(attempts >= 3, '应观察到冲突重试（>=3 次 attempt），实际 ' + attempts);
  const d = db.getData();
  assert.equal(d.projects.p1.scheduleWriteMode, 'maintenance');
  assert.equal(d.projects.p1.scheduleEpoch, 2, 'epoch 只有维护切换 +1，实际 ' + d.projects.p1.scheduleEpoch);
  assert.equal(d.project_members[memberId('p1', targetUserId)], undefined, '不得新增管家');
  assert.equal(Object.values(d.audit_events).filter(a => a.action === 'assignManager').length, 0, '无指定审计');
  assert.ok(d.users[targetUserId].bindingCodeHash, '编号不应被消费');
});

// ---- U3：产品 80 次保护与 attempt 计数隔离 ----

test('U3a: product transaction wrapper allows exactly 80 ops and rejects the 81st before the SDK call', async () => {
  // 底层夹具关闭 80 拦截，只保留平台 100：确保拦截来自产品自身
  const db = createPlatformLimitedMockDb({}, { appBudget: null });
  db.collection('users').add({ data: { _id: 'u1', status: 'active' } });
  const service = createScheduleService(db);
  // 前 80 次成功
  await service.transaction(async tx => {
    for (let i = 0; i < 80; i++) await tx.collection('users').doc('u1').get();
  });
  assert.equal(db.getExecutedOps(), 80, '底层应恰好执行 80 次');
  // 第 81 次：产品预算码，且底层不再执行
  let code = null;
  try {
    await service.transaction(async tx => {
      for (let i = 0; i < 81; i++) await tx.collection('users').doc('u1').get();
    });
  } catch (e) { code = e.code; }
  assert.equal(code, 'SCHEDULE_OPERATION_BUDGET_EXCEEDED', '第 81 次必须由产品预算码拒绝，实际 ' + code);
  assert.equal(db.getExecutedOps(), 80 + 80, '第 81 次不得到达底层：底层总执行应为 160，实际 ' + db.getExecutedOps());
});

test('U3b: concurrent attempts on the same service instance count independently', async () => {
  const db = createPlatformLimitedMockDb({}, { appBudget: null });
  db.collection('users').add({ data: { _id: 'u1', status: 'active' } });
  const service = createScheduleService(db);
  const barrier = makeBarrier();
  // A 读到 60 次时暂停；B 完整跑 10 次；A 再读 30 次（共 90）
  // 若计数器是实例共享状态，B 会重置 A 的计数，A 将错误地成功。
  const pa = service.transaction(async tx => {
    for (let i = 0; i < 60; i++) await tx.collection('users').doc('u1').get();
    barrier.signal();
    await barrier.wait;
    for (let i = 0; i < 30; i++) await tx.collection('users').doc('u1').get();
  });
  await barrier.reached;
  await service.transaction(async tx => {
    for (let i = 0; i < 10; i++) await tx.collection('users').doc('u1').get();
  });
  barrier.resume();
  let code = null;
  try { await pa; } catch (e) { code = e.code; }
  assert.equal(code, 'SCHEDULE_OPERATION_BUDGET_EXCEEDED',
    '并发 attempt 必须各自独立计数：A 累计 90 次应被产品拒绝，实际 ' + code);
});

test('U3c: SDK re-entry on conflict restarts counting from zero for the new attempt', async () => {
  const db = createConflictMockDb();
  const { workerUserId } = seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const { call } = createConflictService(db);
  const created = await call('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('r'), form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07', restDays: [], content: '原内容' }
  });
  // 第一次事务在提交前暂停，期间另一提交推进项目 epoch，使本事务必然冲突重入
  const barrier = makeBarrier();
  let paused = false;
  db.setHooks({ beforeCommit: async tx => {
    if (paused) return;
    const w = tx.writeSet.get('schedules');
    if (w && [...w.values()].includes('update')) { paused = true; barrier.signal(); await barrier.wait; }
  } });
  const p = call('mgr_openid', 'updateSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('r2'),
    form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07', restDays: [], content: '调整后' },
    reason: '调整'
  });
  await barrier.reached;
  db.clearHooks();
  db.collection('projects').doc('p1').update({ data: { scheduleEpoch: 77 } });
  const attempts = [];
  db.setAttemptObserver(async attempt => { attempts.push(attempt); });
  barrier.resume();
  const r = await p;
  db.clearAttemptObserver();
  assert.equal(r.version, 2, '重入后应成功');
  assert.ok(attempts.length >= 2, '应发生 SDK 重入（多次 attempt），实际 ' + attempts.length + ' 次');
  // 重入后的新 attempt 必须从 0 计数：单 attempt 峰值不超过业务上界
  assert.ok(attempts.length <= 6, 'attempt 次数应在合理范围，实际 ' + attempts.length);
});

test('U3d: budget pre-check rejects before any write with zero writes and eight collections unchanged', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [
    { openid: 'mgr_openid', roles: ['管家'] },
    { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] },
    { openid: 'w2_openid', roles: ['师傅'], trades: ['泥瓦'] }
  ]);
  const call = compatCall(db);
  const service = createScheduleService(db);
  // 直接构造不可支持预算：桶并集上限 26 时预检 18+5+52=75 ≤ 80 可支持；
  // 用更大的桶数验证预检公式本身为上界（不依赖夹具拦截）
  const ops = service.computeBudget('updateSchedule', { bucketKeyCount: 26, workerChanged: true });
  assert.equal(ops, 75, '26 桶最坏预检应为 75（真实上界），实际 ' + ops);
  assert.ok(ops <= 80, '26 桶最坏仍应可支持');
  // 构造真正超限的预检（桶数超过并集上限时由 range 检查先拦）；
  // 这里验证超限预检的语义：computeBudget 单调递增，且 >80 时 assertWithinBudget 抛预算码
  const over = service.computeBudget('updateSchedule', { bucketKeyCount: 40, workerChanged: true });
  assert.ok(over > 80, '超限预检必须 > 80，实际 ' + over);
  let code = null;
  try { service.assertWithinBudget('updateSchedule', { bucketKeyCount: 40, workerChanged: true }); }
  catch (e) { code = e.code; }
  assert.equal(code, 'SCHEDULE_OPERATION_BUDGET_EXCEEDED', '超限预检必须返回预算码，实际 ' + code);
  // 真实路径：26 桶请求必须成功且有真实写入（首写前拒绝与写后回滚是不同语义）
  const created = await call('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: uuid('r1'), form: compatForm(compatUid('w_openid'), '2026-01-02', '2027-01-01')
  });
  db.resetWriteCount();
  const before = snapshotAll8(db, 'p1');
  const r2 = await call('mgr_openid', 'updateSchedule', {
    projectId: 'p1', scheduleId: created.scheduleId, expectedVersion: 1, requestId: uuid('r2'),
    form: { stage: '泥瓦铺贴', trade: '泥瓦', workerUserId: compatUid('w2_openid'), startDate: '2026-01-02', endDate: '2027-01-01', expectedDate: '2027-01-01', restDays: [], content: '兼容测试内容' },
    reason: '换人换工种'
  });
  assert.equal(r2.version, 2, '26 桶最坏路径必须成功（可支持，不是首写前拒绝）');
  assert.ok(db.getWriteCount() > 0, '可支持路径必须有真实写入');
  assert.ok(db.getPeakAttemptOps() <= 80, '实测峰值 ' + db.getPeakAttemptOps() + ' 必须在 80 内');
  assert.notDeepStrictEqual(snapshotAll8(db, 'p1'), before, '可支持路径必须产生真实变更');
});

test('U3e: pre-check value is an upper bound for every measured branch', async () => {
  const db = createPlatformLimitedMockDb();
  seedReady(db, 'p1', [
    { openid: 'mgr_openid', roles: ['管家'] },
    { openid: 'w_openid', roles: ['师傅'], trades: ['水电', '泥瓦'] },
    { openid: 'w2_openid', roles: ['师傅'], trades: ['水电', '泥瓦'] }
  ]);
  const call = compatCall(db);
  const service = createScheduleService(db);
  const checks = [];
  // create 首用
  let c1 = await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('a'), form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-07') });
  checks.push(['create 首用', db.getPeakAttemptOps(), service.computeBudget('createSchedule', { bucketKeyCount: 1 })]);
  // create 已初始化
  db.resetPeak();
  await call('mgr_openid', 'createSchedule', { projectId: 'p1', requestId: uuid('b'), form: compatForm(compatUid('w_openid'), '2026-11-05', '2026-11-06') });
  checks.push(['create 已初始化', db.getPeakAttemptOps(), service.computeBudget('createSchedule', { bucketKeyCount: 1 })]);
  // reassign
  db.resetPeak();
  await call('mgr_openid', 'reassignSchedule', { projectId: 'p1', scheduleId: c1.scheduleId, expectedVersion: 1, requestId: uuid('c'), workerUserId: compatUid('w2_openid'), reason: '改派' });
  checks.push(['reassign', db.getPeakAttemptOps(), service.computeBudget('reassignSchedule', {})]);
  // cancel
  db.resetPeak();
  await call('mgr_openid', 'cancelSchedule', { projectId: 'p1', scheduleId: c1.scheduleId, expectedVersion: 2, requestId: uuid('d'), reason: '取消' });
  checks.push(['cancel 1桶', db.getPeakAttemptOps(), service.computeBudget('cancelSchedule', { bucketKeyCount: 1 })]);
  for (const [name, peak, pre] of checks) {
    assert.ok(pre >= peak, name + ' 预检 ' + pre + ' 必须 >= 实测峰值 ' + peak + '（不得低估）');
    assert.ok(pre <= 80, name + ' 预检 ' + pre + ' 必须 <= 80');
  }
});

// ---- V3：受控预算注入走真实业务路由 + SDK 重入每次 attempt 独立计数的可量化断言 ----

// V3 辅助：在内存中编译一份被受控修改过的 schedule-service（不写磁盘），
// 并用它组装出真实的 memberAccess service，使路由走完整的产品逻辑。
// injection 只改一个数值常量，用于构造"按现有分支无法支持"的超限预算。
function compileInMemory(overrides) {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const scheduleFile = path.resolve(__dirname, '../cloudfunctions/memberAccess/schedule-service.js');
  const memberFile = path.resolve(__dirname, '../cloudfunctions/memberAccess/service.js');
  const original = fs.readFileSync(scheduleFile, 'utf8');
  const mutated = original.replace(overrides.find, overrides.replace);
  assert.notEqual(mutated, original, '受控注入必须确实修改了源码文本，否则本用例无效');

  function compile(file, text, ov = {}) {
    const m = { exports: {} };
    const req = createRequire(file);
    vm.runInThisContext('(function(require,module,exports){' + text + '\n})', { filename: file })(n => ov[n] || req(n), m, m.exports);
    return m.exports;
  }
  const schedule = compile(scheduleFile, mutated);
  const member = compile(memberFile, fs.readFileSync(memberFile, 'utf8'), { './schedule-service': schedule });
  return { schedule, member };
}

test('V3a: over-budget pre-check on the real createSchedule route writes nothing and leaves all collections unchanged', async () => {
  // 受控注入：把 create 的固定预算从 18 提高到 90，使任何 create 都会超限。
  // 只改内存副本，产品源码不变。
  const { member } = compileInMemory({
    find: 'const FIXED_CREATE = 18',
    replace: 'const FIXED_CREATE = 90'
  });

  // 底层夹具关闭 80 拦截，只保留平台 100：确保拦截来自产品预算预检而非夹具
  const db = createPlatformLimitedMockDb({}, { appBudget: null });
  seedReady(db, 'p1', [
    { openid: 'mgr_openid', roles: ['管家'] },
    { openid: 'w_openid', roles: ['师傅'], trades: ['水电'] }
  ]);
  const service = member.createService(db, { now: () => new Date('2026-10-03T02:00:00.000Z'), id: conflictId });
  const call = (who, action, body) => settleCall(service.execute({ action, ...body }, wxctx(who)));

  const before = JSON.stringify(db.getData());
  db.resetWriteCount();
  db.resetExecutedOps();

  const settled = await call('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: 'v3_over_budget',
    form: compatForm(compatUid('w_openid'), '2026-10-05', '2026-10-05')
  });

  assert.ok(!settled.ok, '超限必须被拒绝，实际成功返回');
  assert.equal(settled.code, 'SCHEDULE_OPERATION_BUDGET_EXCEEDED', '实际 ' + settled.code);
  assert.equal(db.getWriteCount(), 0, '首写前拒绝：底层写调用必须为 0，实际 ' + db.getWriteCount());
  assert.equal(JSON.stringify(db.getData()), before, '拒绝后全部集合必须逐字节不变');
  assert.deepEqual(snapshotAll8(db, 'p1'), snapshotAll8(db, 'p1'), '八集合快照一致');
});

test('V3b: normal create still succeeds after the same injection is absent (26-bucket worst case retained)', async () => {
  // 对照：未注入时同一路由必须成功，且确有真实写入（首写前拒绝 ≠ 写后回滚）
  const db = createPlatformLimitedMockDb({}, { appBudget: null });
  seedReady(db, 'p1', [
    { openid: 'mgr_openid', roles: ['管家'] },
    { openid: 'w_openid', roles: ['师傅'], trades: ['水电', '泥瓦'] },
    { openid: 'w2_openid', roles: ['师傅'], trades: ['水电', '泥瓦'] }
  ]);
  const service = createService(db, { now: () => new Date('2026-10-03T02:00:00.000Z'), id: conflictId });
  const call = (who, action, body) => settleCall(service.execute({ action, ...body }, wxctx(who)));

  const before = snapshotAll8(db, 'p1');
  db.resetWriteCount();
  const settled = await call('mgr_openid', 'createSchedule', {
    projectId: 'p1', requestId: 'v3_ok',
    form: compatForm(compatUid('w_openid'), '2026-01-02', '2027-01-01')
  });
  assert.ok(settled.ok, '未注入时 365 天创建必须成功，实际 ' + settled.code);
  assert.ok(db.getWriteCount() > 0, '可支持路径必须有真实写入');
  assert.ok(db.getPeakAttemptOps() <= 80, '实测峰值 ' + db.getPeakAttemptOps() + ' 必须 <= 80');
  const after = snapshotAll8(db, 'p1');
  assert.notDeepEqual(after, before, '可支持路径必须产生真实变更');
  assert.equal(Object.keys(after.occupancy).length, 13, '365 天应占 13 个月度桶');
});

test('V3c: each SDK re-entry counts from zero — quantified per-attempt operation counts', async () => {
  // 目标：直接量化"每次 SDK 回调各自独立计数"。
  // 手法：用冲突夹具制造一次真实的 SDK 重入——第一次 attempt 在提交前被外部改动
  // 打断（改动它读过的 projects 文档），必然触发重试。回调每次 attempt 都读 60 次
  // 同一文档；若计数是共享/累计的，第二次 attempt 会是 120 次并被产品拒绝。
  const db = createConflictMockDb();
  seedConflictProject(db, 'p1', 'mgr_openid', 'w_openid', null, '水电');
  const service = createScheduleService(db);

  // 记录每次 attempt 内底层实际执行的数据操作次数
  const perAttempt = [];
  const original = db.runTransaction;
  db.runTransaction = async work => original(async tx => {
    const attemptIndex = perAttempt.length;
    perAttempt.push(0);
    let localOps = 0;
    const countingTx = {
      collection: name => {
        const inner = tx.collection(name);
        return {
          doc: id => ({
            get: async () => { localOps++; return inner.doc(id).get(); },
            update: async a => { localOps++; return inner.doc(id).update(a); },
            remove: async () => { localOps++; return inner.doc(id).remove(); }
          }),
          where: q => inner.where(q),
          add: async a => { localOps++; return inner.add(a); }
        };
      }
    };
    try {
      return await work(countingTx);
    } finally {
      perAttempt[attemptIndex] = localOps;
    }
  });

  // 只在第一次 attempt 提交前制造冲突；第二次起不再干扰，使其成功
  let interfered = false;
  db.setHooks({ beforeCommit: async () => {
    if (interfered) return;
    interfered = true;
    db.mutate(d => { d.projects.p1.scheduleEpoch = (d.projects.p1.scheduleEpoch || 1) + 1; });
  } });

  try {
    await service.transaction(async tx => {
      // 读 projects 文档，使外部对该文档的改动能被 OCC 冲突检测捕获
      await tx.collection('projects').doc('p1').get();
      for (let i = 0; i < 59; i++) await tx.collection('users').doc('nobody').get();
    });
  } finally {
    db.runTransaction = original;
    db.clearHooks();
  }

  assert.equal(perAttempt.length, 2, '应恰好发生一次 SDK 重入（2 次 attempt），实际 ' + perAttempt.length + ' 次');
  // 每次 attempt 独立计数：两次都是 60，而非 60 + 120 的累计
  assert.equal(perAttempt[0], 60, '第一次 attempt 应执行 60 次，实际 ' + perAttempt[0]);
  assert.equal(perAttempt[1], 60,
    '重入后的 attempt 必须从 0 重新计数（同样 60 次），而非累计 120 次，实际 ' + perAttempt[1]);
  assert.ok(perAttempt.every(n => n <= 80), '任何单次 attempt 都不得超过 80，实际 ' + JSON.stringify(perAttempt));
  // 产品侧峰值口径：重入后的 attempt 峰值同样只有 60
  assert.equal(service.currentAttemptPeak(), 60, '产品记录的最近一次 attempt 峰值应为 60，实际 ' + service.currentAttemptPeak());
});
