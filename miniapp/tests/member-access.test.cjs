const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, APPID } = require('../cloudfunctions/memberAccess/service');
const { runWriteProbe } = require('../miniprogram/utils/member-write-probe');

const clone = value => JSON.parse(JSON.stringify(value));
class MemoryDb {
  constructor(data = {}, inTransaction = false) { this.data = data; this.inTransaction = inTransaction; }
  collection(name) {
    if (!this.data[name]) this.data[name] = {};
    const values = this.data[name];
    return {
      doc: key => ({
        get: async () => ({ data: values[key] ? [clone(values[key])] : [] }),
        update: async ({ data }) => {
          if (!values[key]) throw new Error('missing document');
          values[key] = { ...values[key], ...clone(data) };
          return { updated: 1 };
        }
      }),
      where: query => {
        let list = Object.values(values).filter(row =>
          Object.entries(query).every(([key, value]) => row[key] === value)).map(clone);
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
      },
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

test('微信服务端身份才可信；首登仅创建普通用户，编号不能自行提权', async () => {
  const { db, call } = setup();
  await rejects(call('owner', 'createProject', { name: '虚构测试甲' }), 'NO_ACCESS');
  const identity = await call('owner', 'identify', { role: '负责人', userId: 'someone-else' });
  assert.equal(identity.isAdmin, false);
  assert.equal(Object.keys(db.data.users).length, 1);
  assert.equal(Object.keys(db.data.app_admins).length, 0);
  const number = await call('owner', 'requestBindingNumber');
  assert.match(number.bindingNumber, /^\d{10}$/);
  assert.equal(db.data.users[identity.userId].bindingCodeHash.length, 64);
  assert.equal(JSON.stringify(db.data.users).includes(number.bindingNumber), false);
  await rejects(call('owner', 'createProject', { name: '虚构测试甲', bindingNumber: number.bindingNumber }), 'NO_ACCESS');
  await rejects(serviceWithBadContext(db).execute({ action: 'identify' }, { APPID: 'wrong', OPENID: 'owner' }), 'IDENTITY_UNAVAILABLE');
});

function serviceWithBadContext(db) { return createService(db); }

test('只读事务检查先核实微信身份，且不登记账号或写入审计', async () => {
  const { db, call } = setup();
  assert.deepEqual(await call('owner', 'checkTransaction'), { transactionReady: true });
  assert.equal(Object.keys(db.data.users || {}).length, 0);
  assert.equal(Object.keys(db.data.audit_events || {}).length, 0);
  await rejects(serviceWithBadContext(db).execute({ action: 'checkTransaction' },
    { APPID: 'wrong', OPENID: 'owner' }), 'IDENTITY_UNAVAILABLE');
  const noTransaction = new MemoryDb();
  noTransaction.runTransaction = undefined;
  await rejects(createService(noTransaction).execute({ action: 'checkTransaction' }, ctx('owner')),
    'TRANSACTION_UNAVAILABLE');
});

test('负责人受控绑定后建虚构项目，管家按本人编号加入；普通账号不能指定管家', async () => {
  const { db, call } = setup();
  const owner = await call('owner', 'identify');
  // 模拟在用户确认编号之后，由可信管理工具执行的一次性授权；业务函数没有此操作。
  await db.collection('app_admins').add({ data: { _id: 'primary', userId: owner.userId, status: 'active' } });
  const created = await call('owner', 'createProject', { name: '虚构测试 · 晴川居' });
  const project = db.data.projects[created.projectId];
  assert.equal(project.scope, 'identity-test');
  assert.equal((await call('owner', 'listMyProjects')).projects.length, 1);
  assert.equal((await call('manager', 'listMyProjects')).projects.length, 0);
  const managerNumber = (await call('manager', 'requestBindingNumber')).bindingNumber;
  await rejects(call('manager', 'assignManager', { projectId: created.projectId,
    bindingNumber: managerNumber }), 'NO_ACCESS');
  await rejects(call('owner', 'assignManager', { projectId: created.projectId,
    bindingNumber: '0000000000' }), 'CODE_INVALID');
  await call('owner', 'assignManager', { projectId: created.projectId, bindingNumber: managerNumber });
  const managerProjects = (await call('manager', 'listMyProjects')).projects;
  assert.deepEqual(managerProjects[0].roles, ['管家']);
  assert.equal((await call('owner', 'getMembers', { projectId: created.projectId })).members.length, 2);
  assert.equal(db.data.users[(await call('manager', 'identify')).userId].bindingCodeHash, null);
  assert.ok(Object.values(db.data.audit_events).some(item => item.action === 'assignManager' && item.actorRole === '负责人'));
});

test('邀请申请未批准时不可读；管家批准后可读，移出立即失权且历史保留', async () => {
  const { db, call } = setup();
  const owner = await call('owner', 'identify');
  await db.collection('app_admins').add({ data: { _id: 'primary', userId: owner.userId, status: 'active' } });
  const { projectId } = await call('owner', 'createProject', { name: '虚构测试 · 甲' });
  const managerNumber = (await call('manager', 'requestBindingNumber')).bindingNumber;
  await call('owner', 'assignManager', { projectId, bindingNumber: managerNumber });
  const issued = await call('manager', 'createInvitation', { projectId, role: '师傅', trades: ['水电'] });
  assert.equal(JSON.stringify(db.data.invitations).includes(issued.invitationCode), false);
  assert.ok(Object.values(db.data.audit_events).some(item => item.action === 'createInvitation'));
  await call('worker', 'applyInvitation', { invitationCode: issued.invitationCode });
  const workerNumber = (await call('worker', 'requestBindingNumber')).bindingNumber;
  await rejects(call('worker', 'getMembers', { projectId }), 'NO_ACCESS');
  assert.equal((await call('worker', 'listMyProjects')).projects.length, 0);
  await rejects(call('worker', 'approveInvitation', { projectId, invitationId: issued.invitationId,
    role: '管家' }), 'NO_ACCESS');
  await rejects(call('manager', 'approveInvitation', { projectId, invitationId: issued.invitationId,
    applicantNumber: '0000000000' }), 'CODE_INVALID');
  await call('manager', 'approveInvitation', { projectId, invitationId: issued.invitationId,
    applicantNumber: workerNumber });
  assert.equal((await call('worker', 'listMyProjects')).projects.length, 1);
  const members = (await call('worker', 'getMembers', { projectId })).members;
  const worker = members.find(item => item.roles.includes('师傅'));
  assert.deepEqual(worker.trades, ['水电']);
  assert.equal(worker.userId, undefined);
  await rejects(call('worker', 'getMembers', { projectId: 'p_other' }), 'NO_ACCESS');
  const managedWorker = (await call('manager', 'getMembers', { projectId })).members
    .find(item => item.roles.includes('师傅'));
  await call('manager', 'removeMember', { projectId, userId: managedWorker.userId });
  await rejects(call('worker', 'getMembers', { projectId }), 'NO_ACCESS');
  assert.equal((await call('worker', 'listMyProjects')).projects.length, 0);
  assert.ok(Object.values(db.data.audit_events).some(item => item.action === 'removeMember' &&
    item.subjectUserId === managedWorker.userId && item.before.status === 'active'));
});

test('写入探针与真实服务逻辑集成：退出师傅及跨项目管家的前置鉴权拒绝且数据库无变化', async () => {
  const { db, call } = setup();
  const owner = await call('owner', 'identify');
  await db.collection('app_admins').add({ data: { _id: 'primary', userId: owner.userId, status: 'active' } });
  const first = await call('owner', 'createProject', { name: '虚构测试 · 甲' });
  const second = await call('owner', 'createProject', { name: '虚构测试 · 乙' });
  const number = (await call('manager', 'requestBindingNumber')).bindingNumber;
  await call('owner', 'assignManager', { projectId: first.projectId, bindingNumber: number });
  const invitation = await call('manager', 'createInvitation', { projectId: first.projectId,
    role: '师傅', trades: ['拆改'] });
  await call('worker', 'applyInvitation', { invitationCode: invitation.invitationCode });
  const worker = await call('worker', 'identify');
  const workerNumber = (await call('worker', 'requestBindingNumber')).bindingNumber;
  await call('manager', 'approveInvitation', { projectId: first.projectId,
    invitationId: invitation.invitationId, applicantNumber: workerNumber });
  const activeBefore = clone(db.data);
  const activeReport = await runWriteProbe(async (action, input) => {
    try { return await call('worker', action, input); }
    catch (error) { error.businessCode = error.code; throw error; }
  }, [{ id: first.projectId, label: '甲' }, { id: second.projectId, label: '乙' }], () => {}, 'active-worker');
  assert.equal(activeReport.complete, true);
  assert.equal(activeReport.results.length, 4);
  assert.deepEqual(activeReport.preflight.map(r => r.status), ['allowed', 'denied']);
  assert.ok(activeReport.results.slice(1).every(r => r.message === '仅项目管家可管理成员。'));
  assert.deepEqual(db.data, activeBefore);
  await call('manager', 'removeMember', { projectId: first.projectId, userId: worker.userId });
  const before = clone(db.data);
  const projects = [first, second].map((p, i) => ({ id: p.projectId, label: String(i) }));
  for (const who of ['worker', 'manager']) {
    const report = await runWriteProbe(async (action, input) => {
      try { return await call(who, action, input); }
      catch (error) { error.businessCode = error.code; throw error; }
    }, projects);
    assert.equal(report.complete, true);
    assert.equal(report.results.length, who === 'worker' ? 8 : 4);
    assert.ok(report.results.every(row => row.status === 'denied'));
    assert.deepEqual(db.data, before);
  }
});

test('同项目只有一位主业主，重复审批与越权、真实名称都被拒绝', async () => {
  const { db, call } = setup();
  const owner = await call('owner', 'identify');
  await db.collection('app_admins').add({ data: { _id: 'primary', userId: owner.userId, status: 'active' } });
  await rejects(call('owner', 'createProject', { name: '真实客户王先生家' }), 'BAD_INPUT');
  const { projectId } = await call('owner', 'createProject', { name: '虚构测试 · 甲' });
  const managerNumber = (await call('manager', 'requestBindingNumber')).bindingNumber;
  await call('owner', 'assignManager', { projectId, bindingNumber: managerNumber });
  const first = await call('manager', 'createInvitation', { projectId, role: '主业主' });
  const second = await call('manager', 'createInvitation', { projectId, role: '主业主' });
  await call('ownerA', 'applyInvitation', { invitationCode: first.invitationCode });
  await call('ownerB', 'applyInvitation', { invitationCode: second.invitationCode });
  const firstNumber = (await call('ownerA', 'requestBindingNumber')).bindingNumber;
  const secondNumber = (await call('ownerB', 'requestBindingNumber')).bindingNumber;
  await rejects(call('manager', 'approveInvitation', { projectId, invitationId: first.invitationId,
    applicantNumber: secondNumber }), 'CODE_INVALID');
  await call('manager', 'approveInvitation', { projectId, invitationId: first.invitationId,
    applicantNumber: firstNumber });
  const approvedState = clone(db.data);
  await rejects(call('manager', 'approveInvitation', { projectId, invitationId: second.invitationId,
    applicantNumber: secondNumber }), 'OWNER_EXISTS');
  await rejects(call('manager', 'approveInvitation', { projectId, invitationId: first.invitationId,
    applicantNumber: firstNumber }), 'CODE_INVALID');
  await rejects(call('manager', 'removeMember', { projectId, userId: db.data.projects[projectId].primaryOwnerUserId }), 'NO_ACCESS');
  // MemoryDb 会在读取时创建空集合，比较时排除空集合（不代表业务写入）
  const meaningful = state => Object.fromEntries(Object.entries(state).filter(([, v]) => Object.keys(v || {}).length > 0));
  assert.deepEqual(meaningful(db.data), meaningful(approvedState), '重复批准、第二主业主及移出拒绝均不改变任何记录');
  assert.equal(Object.values(db.data.project_members).filter(row => row.projectId === projectId &&
    row.status === 'active' && row.roles.includes('主业主')).length, 1);
  assert.equal(db.data.invitations[second.invitationId].status, 'requested');
  assert.equal((await call('ownerB', 'listMyProjects')).projects.length, 0);
});

async function preparedInvitation(role = '师傅') {
  const state = setup();
  const { db, call } = state;
  const owner = await call('owner', 'identify');
  await db.collection('app_admins').add({ data: { _id: 'primary', userId: owner.userId, status: 'active' } });
  const { projectId } = await call('owner', 'createProject', { name: '虚构测试 · 本地权限回归' });
  const bindingNumber = (await call('manager', 'requestBindingNumber')).bindingNumber;
  await call('owner', 'assignManager', { projectId, bindingNumber });
  const manager = await call('manager', 'identify');
  const worker = await call('worker', 'identify');
  const issued = await call('manager', 'createInvitation', { projectId, role, trades: ['拆改'] });
  return { ...state, owner, manager, worker, projectId, issued };
}

for (const [role, mode] of [['主业主', 'active-primary-owner'], ['师傅', 'active-worker-designer']]) {
test(`${mode}探针通过真实服务逻辑校验四项管理拒绝，所有数据库记录不变`, async () => {
  const { db, call, projectId, issued } = await preparedInvitation(role);
  await call('worker', 'applyInvitation', { invitationCode: issued.invitationCode });
  const applicantNumber = (await call('worker', 'requestBindingNumber')).bindingNumber;
  await call('manager', 'approveInvitation', { projectId, invitationId: issued.invitationId, applicantNumber });
  if (mode === 'active-worker-designer') {
    const designer = await call('manager', 'createInvitation', { projectId, role: '设计师' });
    await call('worker', 'applyInvitation', { invitationCode: designer.invitationCode });
    const number = (await call('worker', 'requestBindingNumber')).bindingNumber;
    await call('manager', 'approveInvitation', { projectId, invitationId: designer.invitationId, applicantNumber: number });
  }
  const second = await call('owner', 'createProject', { name: '虚构测试 · 隔离项目' });
  const before = clone(db.data);
  const report = await runWriteProbe(async (action, input) => {
    try { return await call('worker', action, input); }
    catch (error) { error.businessCode = error.code; throw error; }
  }, [{ id: projectId, label: '所属项目' }, { id: second.projectId, label: '隔离项目' }],
  () => {}, mode);
  assert.equal(report.complete, true);
  assert.equal(report.expectedCount, 4);
  assert.deepEqual(report.skippedProjects, [second.projectId]);
  assert.deepEqual(report.preflight[0].roles, mode === 'active-worker-designer' ? ['师傅', '设计师'] : ['主业主']);
  assert.deepEqual(report.preflight.map(row => row.status), ['allowed', 'denied']);
  assert.equal(report.results.length, 4);
  assert.ok(report.results.every(row => row.status === 'denied'));
  assert.deepEqual(db.data, before);
});

}

test('主业主对真实有效师傅目标的移出被拒绝且数据不变，管家同请求可成功', async () => {
  const { db, call, projectId, issued } = await preparedInvitation('主业主');
  await call('worker', 'applyInvitation', { invitationCode: issued.invitationCode });
  await call('manager', 'approveInvitation', { projectId, invitationId: issued.invitationId,
    applicantNumber: (await call('worker', 'requestBindingNumber')).bindingNumber });
  const target = await call('target', 'identify');
  for (const [role, trades] of [['师傅', ['拆改']], ['设计师', []], ['师傅', ['木工']]]) {
    const invitation = await call('manager', 'createInvitation', { projectId, role, trades });
    await call('target', 'applyInvitation', { invitationCode: invitation.invitationCode });
    await call('manager', 'approveInvitation', { projectId, invitationId: invitation.invitationId,
      applicantNumber: (await call('target', 'requestBindingNumber')).bindingNumber });
  }
  const request = { projectId, userId: target.userId };
  const before = clone(db.data);
  await rejects(call('worker', 'removeMember', request), 'NO_ACCESS');
  assert.deepEqual(db.data, before);
  await call('manager', 'removeMember', request);
  assert.equal(Object.values(db.data.project_members).find(row => row.userId === target.userId).status, 'left');
});

test('主业主持有效目标编号不能指定管家且编号未消费，负责人同请求可成功', async () => {
  const { db, call, projectId, issued } = await preparedInvitation('主业主');
  await call('worker', 'applyInvitation', { invitationCode: issued.invitationCode });
  await call('manager', 'approveInvitation', { projectId, invitationId: issued.invitationId,
    applicantNumber: (await call('worker', 'requestBindingNumber')).bindingNumber });
  const target = await call('target', 'identify');
  const bindingNumber = (await call('target', 'requestBindingNumber')).bindingNumber;
  const request = { projectId, bindingNumber };
  const before = clone(db.data);
  await rejects(call('worker', 'assignManager', request), 'NO_ACCESS');
  assert.deepEqual(db.data, before);
  await call('owner', 'assignManager', request);
  assert.deepEqual(Object.values(db.data.project_members).find(row => row.userId === target.userId).roles, ['管家']);
  assert.equal(db.data.users[target.userId].bindingCodeHash, null);
});

test('家庭成员本地生命周期：批准前隔离、批准后只读、有效管理目标仍拒绝、退出后失权', async () => {
  const { db, call, worker, projectId, issued } = await preparedInvitation('家庭成员');
  await call('worker', 'applyInvitation', { invitationCode: issued.invitationCode });
  assert.deepEqual((await call('worker', 'listMyProjects')).projects, []);
  await rejects(call('worker', 'getMembers', { projectId }), 'NO_ACCESS');
  const number = (await call('worker', 'requestBindingNumber')).bindingNumber;
  await call('manager', 'approveInvitation', {
    projectId, invitationId: issued.invitationId, applicantNumber: number
  });
  const target = await call('target', 'identify');
  const invitation = await call('manager', 'createInvitation', { projectId, role: '师傅', trades: ['拆改'] });
  await call('target', 'applyInvitation', { invitationCode: invitation.invitationCode });
  const targetNumber = (await call('target', 'requestBindingNumber')).bindingNumber;
  const approval = { projectId, invitationId: invitation.invitationId, applicantNumber: targetNumber };
  const isolated = await call('owner', 'createProject', { name: '虚构测试 · 家庭成员隔离' });
  const before = clone(db.data);
  assert.deepEqual((await call('worker', 'listMyProjects')).projects.map(row => row.roles), [['家庭成员']]);
  const visible = await call('worker', 'getMembers', { projectId });
  assert.ok(visible.members.length >= 3);
  assert.ok(visible.members.every(row => row.userId === undefined));
  await rejects(call('worker', 'getMembers', { projectId: isolated.projectId }), 'NO_ACCESS');
  await rejects(call('worker', 'listInvitations', { projectId }), 'NO_ACCESS');
  await rejects(call('worker', 'approveInvitation', approval), 'NO_ACCESS');
  await rejects(call('worker', 'assignManager', { projectId, bindingNumber: targetNumber }), 'NO_ACCESS');
  await rejects(call('worker', 'createInvitation', { projectId, role: '师傅', trades: ['木工'] }), 'NO_ACCESS');
  assert.deepEqual(db.data, before, '读取与越权拒绝不得改变邀请、凭据或成员');
  // 同一有效请求由合法管家成功执行，排除因无效目标而得到拒绝的假阳性。
  await call('manager', 'approveInvitation', approval);
  const activeTarget = clone(db.data);
  await rejects(call('worker', 'removeMember', { projectId, userId: target.userId }), 'NO_ACCESS');
  assert.deepEqual(db.data, activeTarget);
  await call('manager', 'removeMember', { projectId, userId: target.userId });
  await call('manager', 'removeMember', { projectId, userId: worker.userId });
  assert.deepEqual((await call('worker', 'listMyProjects')).projects, []);
  await rejects(call('worker', 'getMembers', { projectId }), 'NO_ACCESS');
  const history = Object.values(db.data.project_members).filter(row => row.userId === worker.userId);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'left');
  assert.deepEqual(history[0].roles, ['家庭成员']);
});

test('伪造账号与角色不改变申请人、授权来源或审计身份；有效凭据也不能越权批准', async () => {
  const { db, call, owner, manager, worker, projectId, issued } = await preparedInvitation();
  const forged = { OPENID: 'owner', APPID, userId: owner.userId, applicantUserId: manager.userId,
    isAdmin: true, role: '管家', roles: ['负责人', '管家'], trades: ['木工'] };
  await call('worker', 'applyInvitation', { ...forged, invitationCode: issued.invitationCode });
  assert.equal(db.data.invitations[issued.invitationId].applicantUserId, worker.userId);
  const applicantNumber = (await call('worker', 'requestBindingNumber')).bindingNumber;
  const request = { ...forged, projectId, invitationId: issued.invitationId, applicantNumber };
  const before = clone(db.data);
  await rejects(call('worker', 'approveInvitation', request), 'NO_ACCESS');
  await rejects(call('worker', 'assignManager', { ...forged, projectId, bindingNumber: applicantNumber }), 'NO_ACCESS');
  assert.deepEqual(db.data, before);
  await call('manager', 'approveInvitation', request);
  const member = Object.values(db.data.project_members).find(row => row.userId === worker.userId);
  assert.deepEqual(member.roles, ['师傅']);
  assert.deepEqual(member.trades, ['拆改']);
  const audit = Object.values(db.data.audit_events).find(row => row.action === 'approveInvitation');
  assert.equal(audit.actorUserId, manager.userId);
  assert.equal(audit.subjectUserId, worker.userId);
  assert.equal(audit.actorRole, '管家');
  const after = clone(db.data);
  await rejects(call('manager', 'approveInvitation', request), 'CODE_INVALID');
  assert.deepEqual(db.data, after, '重复批准不得增加成员版本、审计或重复消费编号');
});

test('批准主业主时审计写入失败，成员、项目、邀请和绑定编号整体回滚', async () => {
  const { db, call, projectId, issued } = await preparedInvitation('主业主');
  await call('worker', 'applyInvitation', { invitationCode: issued.invitationCode });
  const applicantNumber = (await call('worker', 'requestBindingNumber')).bindingNumber;
  const before = clone(db.data);
  const transaction = db.runTransaction.bind(db);
  db.runTransaction = work => transaction(async tx => {
    const collection = tx.collection.bind(tx);
    tx.collection = name => {
      const result = collection(name);
      if (name === 'audit_events') result.add = async () => { throw new Error('LOCAL_AUDIT_FAILURE'); };
      return result;
    };
    return work(tx);
  });
  await assert.rejects(call('manager', 'approveInvitation', { projectId,
    invitationId: issued.invitationId, applicantNumber }), /LOCAL_AUDIT_FAILURE/);
  assert.deepEqual(db.data, before);
});

test('批准前主业主已被占用，事务内重读阻止第二次授权且不消费申请人编号', async () => {
  const { db, call, projectId, issued } = await preparedInvitation('主业主');
  await call('worker', 'applyInvitation', { invitationCode: issued.invitationCode });
  const applicantNumber = (await call('worker', 'requestBindingNumber')).bindingNumber;
  const transaction = db.runTransaction.bind(db);
  let occupiedState;
  db.runTransaction = work => {
    db.data.projects[projectId].primaryOwnerUserId = 'local-existing-primary-owner';
    occupiedState = clone(db.data);
    return transaction(work);
  };
  await rejects(call('manager', 'approveInvitation', { projectId,
    invitationId: issued.invitationId, applicantNumber }), 'OWNER_EXISTS');
  assert.deepEqual(db.data, occupiedState);
});

test('同账号可合并已授权角色，但管家不能批准自己的申请', async () => {
  const { db, call } = setup();
  const owner = await call('owner', 'identify');
  await db.collection('app_admins').add({ data: { _id: 'primary', userId: owner.userId, status: 'active' } });
  const { projectId } = await call('owner', 'createProject', { name: '虚构测试 · 乙' });
  for (const who of ['managerA', 'managerB']) {
    const number = (await call(who, 'requestBindingNumber')).bindingNumber;
    await call('owner', 'assignManager', { projectId, bindingNumber: number });
  }
  const invite = await call('managerA', 'createInvitation', { projectId, role: '师傅', trades: ['木工'] });
  await call('managerA', 'applyInvitation', { invitationCode: invite.invitationCode });
  const number = (await call('managerA', 'requestBindingNumber')).bindingNumber;
  await rejects(call('managerA', 'approveInvitation', { projectId, invitationId: invite.invitationId,
    applicantNumber: number }), 'NO_ACCESS');
  await call('managerB', 'approveInvitation', { projectId, invitationId: invite.invitationId,
    applicantNumber: number });
  const roles = (await call('managerA', 'listMyProjects')).projects[0].roles;
  assert.deepEqual(roles.sort(), ['师傅', '管家'].sort());
  await rejects(call('managerA', 'removeMember', { projectId,
    userId: (await call('managerB', 'identify')).userId }), 'NO_ACCESS');
});

test('有效待批准申请：主业主不能批准，管家可用同一申请与编号合法批准（仅内存）', async () => {
  const { db, call } = setup();
  const admin = await call('admin', 'identify');
  await db.collection('app_admins').add({ data: { _id: 'primary', userId: admin.userId, status: 'active' } });
  const { projectId } = await call('admin', 'createProject', { name: '虚构测试 · 批准权限' });
  const managerNumber = (await call('manager', 'requestBindingNumber')).bindingNumber;
  await call('admin', 'assignManager', { projectId, bindingNumber: managerNumber });
  async function grant(who, role, trades = []) {
    const invite = await call('manager', 'createInvitation', { projectId, role, trades });
    await call(who, 'applyInvitation', { invitationCode: invite.invitationCode });
    const applicantNumber = (await call(who, 'requestBindingNumber')).bindingNumber;
    await call('manager', 'approveInvitation', { projectId,
      invitationId: invite.invitationId, applicantNumber });
  }
  await grant('primaryOwner', '主业主');
  await grant('applicant', '师傅', ['拆改']);
  await grant('applicant', '设计师');
  const invite = await call('manager', 'createInvitation', { projectId, role: '师傅', trades: ['拆改'] });
  await call('applicant', 'applyInvitation', { invitationCode: invite.invitationCode });
  const applicantNumber = (await call('applicant', 'requestBindingNumber')).bindingNumber;
  const request = { projectId, invitationId: invite.invitationId, applicantNumber };
  const before = clone(db.data);
  await assert.rejects(call('primaryOwner', 'approveInvitation', request), error =>
    error.code === 'NO_ACCESS' && error.message === '仅项目管家可管理成员。');
  assert.deepEqual(db.data, before, '主业主拒绝不得消费申请、编号或修改成员与审计');
  await call('manager', 'approveInvitation', request);
  const applicant = await call('applicant', 'identify');
  const member = Object.values(db.data.project_members).find(row =>
    row.projectId === projectId && row.userId === applicant.userId);
  assert.deepEqual(member.roles, ['师傅', '设计师']);
  assert.deepEqual(member.trades, ['拆改']);
  assert.equal(db.data.invitations[invite.invitationId].status, 'approved');
  assert.equal(db.data.users[applicant.userId].bindingCodeHash, null);
  assert.equal(Object.values(db.data.audit_events).filter(row =>
    row.action === 'approveInvitation').length,
  Object.values(before.audit_events).filter(row => row.action === 'approveInvitation').length + 1);
});

test('负责人资格在事务开始前被撤销时，不能继续创建项目或指定管家', async () => {
  const { db, call } = setup();
  const owner = await call('owner', 'identify');
  await db.collection('app_admins').add({ data: { _id: 'primary', userId: owner.userId, status: 'active' } });
  const originalTransaction = db.runTransaction.bind(db);
  db.runTransaction = async work => {
    db.data.app_admins.primary.status = 'revoked';
    return originalTransaction(work);
  };
  await rejects(call('owner', 'createProject', { name: '虚构测试 · 不应创建' }), 'NO_ACCESS');
  assert.equal(Object.keys(db.data.projects || {}).length, 0);

  db.runTransaction = originalTransaction;
  db.data.app_admins.primary.status = 'active';
  const { projectId } = await call('owner', 'createProject', { name: '虚构测试 · 甲' });
  const number = (await call('manager', 'requestBindingNumber')).bindingNumber;
  db.runTransaction = async work => {
    db.data.app_admins.primary.status = 'revoked';
    return originalTransaction(work);
  };
  await rejects(call('owner', 'assignManager', { projectId, bindingNumber: number }), 'NO_ACCESS');
  assert.equal(Object.values(db.data.project_members).filter(item => item.roles.includes('管家')).length, 0);
});
