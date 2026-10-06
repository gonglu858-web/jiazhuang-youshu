const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, APPID } = require('../cloudfunctions/memberAccess/service');
const { createScheduleService } = require('../cloudfunctions/memberAccess/schedule-service');

const clone = value => JSON.parse(JSON.stringify(value));
class MemoryDb {
  constructor(data = {}, inTransaction = false) { this.data = data; this.inTransaction = inTransaction; }
  collection(name) {
    if (!this.data[name]) this.data[name] = {};
    const values = this.data[name];
    const buildQuery = query => {
      let list = Object.values(values).filter(row =>
        Object.entries(query).every(([key, value]) => row[key] === value)).map(clone);
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
    };
    return {
      doc: key => ({
        get: async () => ({ data: values[key] ? [clone(values[key])] : [] }),
        update: async ({ data }) => {
          if (!values[key]) throw new Error('missing document');
          if (Object.prototype.hasOwnProperty.call(data, '_id')) {
            const error = new Error('不能更新_id的值');
            error.code = 'INVALID_PARAM';
            throw error;
          }
          values[key] = { ...values[key], ...clone(data) };
          return { updated: 1 };
        },
        remove: async () => { delete values[key]; }
      }),
      where: query => buildQuery(query),
      add: async ({ data }) => {
        if (values[data._id]) throw new Error('duplicate document');
        values[data._id] = clone(data);
        return { _id: data._id };
      }
    };
  }
  async runTransaction(work) {
    const working = new MemoryDb(clone(this.data), true);
    const result = await work(working);
    this.data = working.data;
    return result;
  }
}

const ctx = openid => ({ APPID, OPENID: openid });
let counter = 0;
const setup = () => {
  const db = new MemoryDb();
  const service = createService(db, {
    now: () => new Date('2026-09-24T02:00:00.000Z'),
    id: prefix => `${prefix}_${++counter}`,
    bindingNumber: (() => { let n = 1000000000; return () => String(++n); })(),
    inviteCode: (() => { let n = 0; return () => (++n).toString(16).toUpperCase().padStart(18, '0'); })()
  });
  const call = (who, action, body = {}) => service.execute({ action, ...body }, ctx(who));
  return { db, call };
};
const rejects = (promise, code) => assert.rejects(promise, error => error && error.code === code);

function hash(value) { const crypto = require('node:crypto'); return crypto.createHash('sha256').update(value).digest('hex'); }
function memberId(projectId, userId) { return `m_${hash(`${projectId}:${userId}`).slice(0, 40)}`; }

async function seedProjectWithWorker({ db, call }) {
  const owner = await call('owner', 'identify');
  await db.collection('app_admins').add({ data: { _id: 'primary', userId: owner.userId, status: 'active' } });
  const { projectId } = await call('owner', 'createProject', { name: '虚构测试 · 施工安排' });
  const managerNumber = (await call('manager', 'requestBindingNumber')).bindingNumber;
  await call('owner', 'assignManager', { projectId, bindingNumber: managerNumber });
  const invitation = await call('manager', 'createInvitation', { projectId, role: '师傅', trades: ['水电'] });
  await call('worker', 'applyInvitation', { invitationCode: invitation.invitationCode });
  const worker = await call('worker', 'identify');
  const workerNumber = (await call('worker', 'requestBindingNumber')).bindingNumber;
  await call('manager', 'approveInvitation', { projectId, invitationId: invitation.invitationId, applicantNumber: workerNumber });
  return { projectId, managerUserId: (await call('manager', 'identify')).userId, workerUserId: worker.userId };
}

test('service route maps schedule business errors', async () => {
  const { db, call } = setup();
  const { projectId, workerUserId } = await seedProjectWithWorker({ db, call });
  await rejects(call('manager', 'createSchedule', { projectId, requestId: 'req-1', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-23', expectedDate: '2026-09-23', restDays: [], content: 'x' } }), 'BAD_INPUT');
});

test('service route returns VERSION_MISMATCH not SERVER_ERROR', async () => {
  const { db, call } = setup();
  const { projectId, workerUserId } = await seedProjectWithWorker({ db, call });
  const created = await call('manager', 'createSchedule', { projectId, requestId: 'req-1', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' } });
  await rejects(call('manager', 'updateSchedule', { projectId, scheduleId: created.scheduleId, expectedVersion: 99, requestId: 'req-2', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'y' }, reason: '原因' }), 'VERSION_MISMATCH');
});

test('removeMember blocks when worker has active schedule', async () => {
  const { db, call } = setup();
  const { projectId, workerUserId } = await seedProjectWithWorker({ db, call });
  await call('manager', 'createSchedule', { projectId, requestId: 'req-1', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' } });
  await rejects(call('manager', 'removeMember', { projectId, userId: workerUserId }), 'WORKER_HAS_ACTIVE_SCHEDULES');
  assert.equal(db.data.project_members[memberId(projectId, workerUserId)].status, 'active');
});

test('removeMember allows after reassign', async () => {
  const { db, call } = setup();
  const { projectId, workerUserId } = await seedProjectWithWorker({ db, call });
  // 第二位师傅
  const invitation2 = await call('manager', 'createInvitation', { projectId, role: '师傅', trades: ['水电'] });
  await call('worker2', 'applyInvitation', { invitationCode: invitation2.invitationCode });
  const worker2 = await call('worker2', 'identify');
  const worker2Number = (await call('worker2', 'requestBindingNumber')).bindingNumber;
  await call('manager', 'approveInvitation', { projectId, invitationId: invitation2.invitationId, applicantNumber: worker2Number });

  const created = await call('manager', 'createSchedule', { projectId, requestId: 'req-1', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' } });
  await call('manager', 'reassignSchedule', { projectId, scheduleId: created.scheduleId, expectedVersion: 1, requestId: 'req-2', workerUserId: worker2.userId, reason: '换人' });
  await call('manager', 'removeMember', { projectId, userId: workerUserId });
  assert.equal(db.data.project_members[memberId(projectId, workerUserId)].status, 'left');
});

test('removeMember allows after cancel', async () => {
  const { db, call } = setup();
  const { projectId, workerUserId } = await seedProjectWithWorker({ db, call });
  const created = await call('manager', 'createSchedule', { projectId, requestId: 'req-1', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' } });
  await call('manager', 'cancelSchedule', { projectId, scheduleId: created.scheduleId, expectedVersion: 1, requestId: 'req-2', reason: '取消' });
  await call('manager', 'removeMember', { projectId, userId: workerUserId });
  assert.equal(db.data.project_members[memberId(projectId, workerUserId)].status, 'left');
});

test('removeMember blocks when guard missing but schedule active', async () => {
  const { db, call } = setup();
  const { projectId, workerUserId } = await seedProjectWithWorker({ db, call });
  await call('manager', 'createSchedule', { projectId, requestId: 'req-1', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' } });
  // 目录被删除后（锚点代际仍为 1）必须拒绝，不得回退扫描重建，也不得放行移出
  delete db.data.member_task_guard[`${projectId}:${workerUserId}`];
  await rejects(call('manager', 'removeMember', { projectId, userId: workerUserId }), 'TASK_DIR_INCONSISTENT');
  assert.equal(db.data.project_members[memberId(projectId, workerUserId)].status, 'active', '拒绝后成员不得被移出');
});

test('removeMember then create for removed worker fails', async () => {
  const { db, call } = setup();
  const { projectId, workerUserId } = await seedProjectWithWorker({ db, call });
  await call('manager', 'removeMember', { projectId, userId: workerUserId });
  assert.equal(db.data.project_members[memberId(projectId, workerUserId)].status, 'left');
  await rejects(call('manager', 'createSchedule', { projectId, requestId: 'req-1', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' } }), 'WORKER_INVALID');
  assert.equal(Object.keys(db.data.schedules).length, 0);
});

test('reassign then removeMember old worker: old worker can be removed', async () => {
  const { db, call } = setup();
  const { projectId, workerUserId } = await seedProjectWithWorker({ db, call });
  const invitation2 = await call('manager', 'createInvitation', { projectId, role: '师傅', trades: ['水电'] });
  await call('worker2', 'applyInvitation', { invitationCode: invitation2.invitationCode });
  const worker2 = await call('worker2', 'identify');
  const worker2Number = (await call('worker2', 'requestBindingNumber')).bindingNumber;
  await call('manager', 'approveInvitation', { projectId, invitationId: invitation2.invitationId, applicantNumber: worker2Number });

  const created = await call('manager', 'createSchedule', { projectId, requestId: 'req-1', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' } });
  await call('manager', 'reassignSchedule', { projectId, scheduleId: created.scheduleId, expectedVersion: 1, requestId: 'req-2', workerUserId: worker2.userId, reason: '换人' });
  await call('manager', 'removeMember', { projectId, userId: workerUserId });
  assert.equal(db.data.project_members[memberId(projectId, workerUserId)].status, 'left');
  const schedules = await call('manager', 'listSchedules', { projectId });
  assert.equal(schedules.schedules.length, 1);
  assert.equal(schedules.schedules[0].workerUserId, worker2.userId);
});

test('removeMember then reassign to removed worker fails', async () => {
  const { db, call } = setup();
  const { projectId, workerUserId } = await seedProjectWithWorker({ db, call });
  const invitation2 = await call('manager', 'createInvitation', { projectId, role: '师傅', trades: ['水电'] });
  await call('worker2', 'applyInvitation', { invitationCode: invitation2.invitationCode });
  const worker2 = await call('worker2', 'identify');
  const worker2Number = (await call('worker2', 'requestBindingNumber')).bindingNumber;
  await call('manager', 'approveInvitation', { projectId, invitationId: invitation2.invitationId, applicantNumber: worker2Number });

  const created = await call('manager', 'createSchedule', { projectId, requestId: 'req-1', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId: worker2.userId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' } });
  // 先把原责任人 workerUserId 移出
  await call('manager', 'removeMember', { projectId, userId: workerUserId });
  // 改派到已移出的 workerUserId 应失败
  await rejects(call('manager', 'reassignSchedule', { projectId, scheduleId: created.scheduleId, expectedVersion: 1, requestId: 'req-2', workerUserId, reason: '换回' }), 'WORKER_INVALID');
  assert.equal(db.data.project_members[memberId(projectId, workerUserId)].status, 'left');
});

test('schedule service returns AppError from schedule-service', async () => {
  const { db } = setup();
  db.collection('users').add({ data: { _id: 'u_manager', status: 'active' } });
  const scheduleService = createScheduleService(db);
  await assert.rejects(scheduleService.createSchedule('p_missing', 'req', { stage: '水电隐蔽工程', trade: '水电' }, { user: { _id: 'u_manager' }, role: '管家' }), error => typeof error.code === 'string' && error.code.length > 0);
});

test('listSchedules route returns flat schedules and pagination', async () => {
  const { db, call } = setup();
  const { projectId, workerUserId } = await seedProjectWithWorker({ db, call });
  await call('manager', 'createSchedule', { projectId, requestId: 'req-1', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' } });
  const body = await call('manager', 'listSchedules', { projectId });
  assert.equal(Array.isArray(body.schedules), true);
  assert.equal(typeof body.pagination, 'object');
  assert.equal(typeof body.pagination.hasMore, 'boolean');
  assert.equal(body.schedules.length, 1);
  assert.equal(body.schedules[0].projectId, projectId);
});

test('listScheduleRevisions route returns flat revisions and pagination', async () => {
  const { db, call } = setup();
  const { projectId, workerUserId } = await seedProjectWithWorker({ db, call });
  const created = await call('manager', 'createSchedule', { projectId, requestId: 'req-1', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' } });
  await call('manager', 'updateSchedule', { projectId, scheduleId: created.scheduleId, expectedVersion: 1, requestId: 'req-2', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'y' }, reason: '原因' });
  const body = await call('manager', 'listScheduleRevisions', { projectId, scheduleId: created.scheduleId });
  assert.equal(Array.isArray(body.revisions), true);
  assert.equal(typeof body.pagination, 'object');
  assert.equal(body.revisions.length, 2);
  assert.equal(body.revisions[1].changeType, 'update');
  assert.equal(body.revisions[1].beforeVersion, 1);
  assert.equal(body.revisions[1].afterVersion, 2);
});

test('receipt replay rejects when actor permission revoked before retry', async () => {
  const { db, call } = setup();
  const { projectId, managerUserId, workerUserId } = await seedProjectWithWorker({ db, call });
  await call('manager', 'createSchedule', { projectId, requestId: 'req-1', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' } });
  const beforeCount = Object.keys(db.data.schedules).length;
  // 外层已通过，现在撤销管家权限，重放同一 requestId 应被拒绝
  db.data.project_members[memberId(projectId, managerUserId)].status = 'left';
  await rejects(call('manager', 'createSchedule', { projectId, requestId: 'req-1', form: { stage: '水电隐蔽工程', trade: '水电', workerUserId, startDate: '2026-09-25', endDate: '2026-09-27', expectedDate: '2026-09-27', restDays: [], content: 'x' } }), 'NO_ACCESS');
  // 没有重复创建
  assert.equal(Object.keys(db.data.schedules).length, beforeCount);
});
