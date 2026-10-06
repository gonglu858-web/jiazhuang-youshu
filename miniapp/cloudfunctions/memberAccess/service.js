const crypto = require('node:crypto');
const { createScheduleService, TASK_DIR_SCHEMA_VERSION: SCHEDULE_SCHEMA_VERSION } = require('./schedule-service');

const APPID = 'wxfb4db1615ac15531';
const ROLES = ['师傅', '主业主', '设计师', '家庭成员'];
const TRADES = ['拆改', '泥瓦', '水电', '防水', '木工', '油漆', '美缝', '安装', '保洁'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const id = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function check(condition, code, message) { if (!condition) throw new AppError(code, message); }
function one(response) {
  if (!response || !response.data) return null;
  return Array.isArray(response.data) ? response.data[0] || null : response.data;
}
function many(response) { return response && Array.isArray(response.data) ? response.data : []; }
function safeText(value, max) {
  return typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : '';
}
function publicProject(project, roles) {
  return { id: project._id, name: project.name, roles, status: project.status, scope: project.scope };
}

function createService(db, options = {}) {
  const now = options.now || (() => new Date());
  const nextId = options.id || id;
  const bindingNumber = options.bindingNumber || (() => String(crypto.randomInt(1000000000, 10000000000)));
  const inviteCode = options.inviteCode || (() => crypto.randomBytes(9).toString('hex').toUpperCase());
  const at = () => now().toISOString();
  const get = async (name, key, source = db) => one(await source.collection(name).doc(key).get());
  const find = async (name, where, source = db) => many(await source.collection(name).where(where).get());
  const add = async (name, value, source = db) => source.collection(name).add({ data: value });
  const update = async (name, key, value, source = db) => source.collection(name).doc(key).update({ data: value });
  async function transaction(work) {
    check(typeof db.runTransaction === 'function', 'TRANSACTION_UNAVAILABLE', '当前数据库不支持所需的原子操作，已停止写入。');
    return db.runTransaction(work);
  }
  const scheduleService = createScheduleService(db, { now, id: nextId, audit, AppError });
  // T4 统一维护守卫：成员写入口（批准加入/指定管家/移出）遵循同一维护策略，
  // 并在同一事务内真实递增 scheduleEpoch，与维护切换形成写冲突。
  // projects 字段缺失视为未就绪；修复未完成不得 ready 由部署准备流程保证。
  function assertScheduleWritableInTx(project) {
    if (!project) throw new AppError('NO_ACCESS', '项目不可用。');
    if (project.scheduleWriteMode !== 'ready') {
      throw new AppError('PROJECT_NOT_WRITABLE', '项目当前处于维护或未就绪状态，暂不能变更成员，请联系管理员。');
    }
    if (!Number.isInteger(project.scheduleSchemaVersion) || project.scheduleSchemaVersion < 1) {
      throw new AppError('PROJECT_NOT_WRITABLE', '项目尚未完成施工安排结构准备，请联系管理员。');
    }
    if (!Number.isInteger(project.scheduleEpoch) || project.scheduleEpoch < 0) {
      throw new AppError('PROJECT_NOT_WRITABLE', '项目并发版本缺失或不合法，请联系管理员。');
    }
  }
  // 维护策略校验 + 项目冲突写（真实递增 epoch）
  async function guardAndBumpEpoch(tx, projectId) {
    const project = await get('projects', projectId, tx);
    assertScheduleWritableInTx(project);
    await update('projects', projectId, {
      scheduleEpoch: project.scheduleEpoch + 1,
      version: (project.version || 0) + 1
    }, tx);
    return project;
  }

  async function audit(tx, actor, actorRole, action, projectId, subjectUserId, before, after) {
    await add('audit_events', { _id: nextId('a'), projectId, actorUserId: actor._id,
      actorRole, action, subjectUserId: subjectUserId || null, before: before || null,
      after: after || null, createdAt: at() }, tx);
  }
  async function identity(wxContext) {
    check(wxContext && wxContext.APPID === APPID && typeof wxContext.OPENID === 'string' && wxContext.OPENID.length > 0,
      'IDENTITY_UNAVAILABLE', '无法确认当前小程序微信身份，请重新进入。');
    const userId = `u_${hash(`${APPID}:${wxContext.OPENID}`).slice(0, 40)}`;
    let user = await get('users', userId);
    if (!user) {
      try {
        await transaction(async tx => {
          check(!(await get('users', userId, tx)), 'ALREADY_EXISTS', '账号已登记。');
          await add('users', { _id: userId, openid: wxContext.OPENID, status: 'active',
            createdAt: at(), updatedAt: at() }, tx);
          await audit(tx, { _id: userId }, '本人普通账号', 'registerIdentity', null, userId,
            null, { status: 'active' });
        });
      } catch (error) {
        user = await get('users', userId);
        if (!user) throw error;
      }
      user = user || await get('users', userId);
    }
    check(user && user.openid === wxContext.OPENID && user.status === 'active',
      'IDENTITY_DISABLED', '当前微信账号无法使用此功能。');
    const admin = await get('app_admins', 'primary');
    return { user, isAdmin: !!(admin && admin.status === 'active' && admin.userId === userId) };
  }
  async function projectAccess(projectId, actor, source = db) {
    check(typeof projectId === 'string' && projectId.length < 100, 'BAD_INPUT', '项目编号无效。');
    const project = await get('projects', projectId, source);
    check(project && project.scope === 'identity-test' && project.status === 'active', 'NO_ACCESS', '无法访问此测试项目。');
    const memberId = `m_${hash(`${projectId}:${actor.user._id}`).slice(0, 40)}`;
    const member = await get('project_members', memberId, source);
    check(actor.isAdmin || (member && member.status === 'active'), 'NO_ACCESS', '当前微信账号不是该项目成员。');
    return { project, member };
  }
  async function managerAccess(projectId, actor, source = db) {
    const access = await projectAccess(projectId, actor, source);
    check(access.member && access.member.status === 'active' && access.member.roles.includes('管家'),
      'NO_ACCESS', '仅项目管家可管理成员。');
    return access;
  }
  async function requireAdmin(userId, source = db) {
    const admin = await get('app_admins', 'primary', source);
    check(admin && admin.status === 'active' && admin.userId === userId,
      'NO_ACCESS', '仅负责人可执行此操作。');
  }
  async function codeUser(number) {
    check(typeof number === 'string' && /^\d{10}$/.test(number), 'BAD_INPUT', '请输入十位身份绑定编号。');
    const matches = await find('users', { bindingCodeHash: hash(`${APPID}:${number}`) });
    check(matches.length === 1 && matches[0].status === 'active' &&
      Date.parse(matches[0].bindingCodeExpiresAt || '') > now().getTime(), 'CODE_INVALID', '绑定编号无效或已过期，请本人重新获取。');
    return matches[0];
  }
  async function verifyCodeForUser(number, userId, tx) {
    check(typeof number === 'string' && /^\d{10}$/.test(number),
      'BAD_INPUT', '请输入十位身份绑定编号。');
    const user = await get('users', userId, tx);
    check(user && user.status === 'active' &&
      user.bindingCodeHash === hash(`${APPID}:${number}`) &&
      Date.parse(user.bindingCodeExpiresAt || '') > now().getTime(),
    'CODE_INVALID', '绑定编号与当前微信账号不一致或已过期。');
    return user;
  }
  async function execute(event, wxContext) {
    check(event && typeof event.action === 'string', 'BAD_INPUT', '操作名称缺失。');
    if (event.action === 'checkTransaction') {
      check(wxContext && wxContext.APPID === APPID &&
        typeof wxContext.OPENID === 'string' && wxContext.OPENID.length > 0,
      'IDENTITY_UNAVAILABLE', '无法确认当前小程序微信身份，请重新进入。');
      await transaction(async tx => { await get('app_admins', 'primary', tx); });
      return { transactionReady: true };
    }
    const actor = await identity(wxContext);
    const userId = actor.user._id;
    switch (event.action) {
      case 'identify': return { userId, isAdmin: actor.isAdmin };
      case 'requestBindingNumber': {
        const number = bindingNumber();
        check(/^\d{10}$/.test(number), 'SERVER_ERROR', '绑定编号生成失败。');
        const expiresAt = new Date(now().getTime() + 24 * 60 * 60 * 1000).toISOString();
        await transaction(async tx => {
          await update('users', userId, { bindingCodeHash: hash(`${APPID}:${number}`),
            bindingCodeExpiresAt: expiresAt, updatedAt: at() }, tx);
          await audit(tx, actor.user, actor.isAdmin ? '负责人' : '本人普通账号',
            'requestBindingNumber', null, userId, null, { expiresAt });
        });
        return { bindingNumber: number, expiresAt };
      }
      case 'listMyProjects': {
        const memberships = actor.isAdmin ? [] : await find('project_members', { userId, status: 'active' });
        const projects = actor.isAdmin ? await find('projects', { scope: 'identity-test', status: 'active' }) :
          (await Promise.all(memberships.map(item => get('projects', item.projectId)))).filter(Boolean);
        return { projects: projects.filter(item => item.scope === 'identity-test' && item.status === 'active')
          .map(item => publicProject(item, actor.isAdmin ? ['负责人'] : (memberships.find(m => m.projectId === item._id) || { roles: [] }).roles)) };
      }
      case 'createProject': {
        check(actor.isAdmin, 'NO_ACCESS', '仅负责人可创建测试项目。');
        const name = safeText(event.name, 60);
        check(name && name.startsWith('虚构测试'), 'BAD_INPUT', '测试项目名称须以“虚构测试”开头，不能录入真实客户资料。');
        const projectId = nextId('p');
        await transaction(async tx => {
          await requireAdmin(userId, tx);
          await add('projects', { _id: projectId, name, ownerUserId: userId, primaryOwnerUserId: null,
            scope: 'identity-test', status: 'active', version: 1, createdAt: at(),
            // 施工安排写策略：新项目直接就绪；scheduleEpoch 建立项目级串行化冲突点
            scheduleWriteMode: 'ready', scheduleSchemaVersion: SCHEDULE_SCHEMA_VERSION, scheduleEpoch: 1 }, tx);
          await add('project_members', { _id: `m_${hash(`${projectId}:${userId}`).slice(0, 40)}`,
            projectId, userId, roles: ['负责人'], trades: [], status: 'active', joinedAt: at(), version: 1,
            // 任务目录锚点：首次初始化由首次安排触发，此处只建代际 0
            taskDirSchemaVersion: SCHEDULE_SCHEMA_VERSION, taskDirGeneration: 0 }, tx);
          await audit(tx, actor.user, '负责人', 'createProject', projectId, userId, null, { name });
        });
        return { projectId };
      }
      case 'assignManager': {
        check(actor.isAdmin, 'NO_ACCESS', '仅负责人可指定管家。');
        const { project } = await projectAccess(event.projectId, actor);
        const target = await codeUser(event.bindingNumber);
        check(target._id !== userId, 'BAD_INPUT', '负责人不能用此入口给自己指定管家。');
        const memberId = `m_${hash(`${project._id}:${target._id}`).slice(0, 40)}`;
        await transaction(async tx => {
          await requireAdmin(userId, tx);
          // T4：维护策略与项目写冲突（真实递增 epoch），维护期间不得指定管家
          await guardAndBumpEpoch(tx, project._id);
          await verifyCodeForUser(event.bindingNumber, target._id, tx);
          const current = await get('project_members', memberId, tx);
          const roles = [...new Set([...(current && current.status === 'active' ? current.roles : []), '管家'])];
          // 重新加入/变更角色时保留既有 taskDirGeneration 与目录，不重置
          if (current) await update('project_members', memberId, { roles, status: 'active',
            joinedAt: current.joinedAt || at(), leftAt: null, version: (current.version || 0) + 1 }, tx);
          else await add('project_members', { _id: memberId, projectId: project._id, userId: target._id,
            roles, trades: [], status: 'active', joinedAt: at(), version: 1,
            // 新成员：锚点代际 0，等待首次安排初始化
            taskDirSchemaVersion: SCHEDULE_SCHEMA_VERSION, taskDirGeneration: 0 }, tx);
          await update('users', target._id, { bindingCodeHash: null, bindingCodeExpiresAt: null, updatedAt: at() }, tx);
          await audit(tx, actor.user, '负责人', 'assignManager', project._id, target._id,
            current ? { roles: current.roles, status: current.status } : null, { roles, status: 'active' });
        });
        return { projectId: project._id, memberId };
      }
      case 'getMembers': {
        const { project, member } = await projectAccess(event.projectId, actor);
        const members = await find('project_members', { projectId: project._id, status: 'active' });
        const mayRemove = !!(member && member.roles.includes('管家'));
        return { project: publicProject(project, actor.isAdmin ? ['负责人'] : member.roles),
          members: members.map(item => ({ id: item._id, ...(mayRemove ? { userId: item.userId } : {}),
            label: `成员 ${item.userId.slice(-6)}`,
            roles: item.roles, trades: item.trades, joinedAt: item.joinedAt })) };
      }
      case 'createInvitation': {
        const { project } = await managerAccess(event.projectId, actor);
        check(ROLES.includes(event.role), 'BAD_INPUT', '请选择可邀请的项目角色。');
        const trades = event.role === '师傅' ? [...new Set(Array.isArray(event.trades) ? event.trades : [])] : [];
        check(event.role !== '师傅' || (trades.length > 0 && trades.every(item => TRADES.includes(item))),
          'BAD_INPUT', '邀请师傅时须指定有效工种。');
        check(event.role !== '主业主' || !project.primaryOwnerUserId, 'OWNER_EXISTS', '项目已有主业主。');
        const code = inviteCode();
        check(/^[A-F0-9]{18}$/.test(code), 'SERVER_ERROR', '邀请码生成失败。');
        const invitationId = nextId('i');
        const expiresAt = new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
        await transaction(async tx => {
          await managerAccess(project._id, actor, tx);
          const currentProject = await get('projects', project._id, tx);
          check(event.role !== '主业主' || !currentProject.primaryOwnerUserId,
            'OWNER_EXISTS', '项目已有主业主。');
          await add('invitations', { _id: invitationId, projectId: project._id, role: event.role,
            trades, tokenHash: hash(`${APPID}:${code}`), status: 'issued', issuedByUserId: userId,
            issuedAt: at(), expiresAt, version: 1 }, tx);
          await audit(tx, actor.user, '管家', 'createInvitation', project._id, null, null,
            { invitationId, role: event.role, trades, status: 'issued' });
        });
        return { invitationId, invitationCode: code, expiresAt };
      }
      case 'applyInvitation': {
        const code = typeof event.invitationCode === 'string' ? event.invitationCode.trim().toUpperCase() : '';
        check(/^[A-F0-9]{18}$/.test(code), 'BAD_INPUT', '邀请码格式无效。');
        const matches = await find('invitations', { tokenHash: hash(`${APPID}:${code}`) });
        check(matches.length === 1, 'CODE_INVALID', '邀请不存在。');
        const invitation = matches[0];
        const project = await get('projects', invitation.projectId);
        check(project && project.scope === 'identity-test' && project.status === 'active',
          'NO_ACCESS', '无法申请加入此测试项目。');
        check(Date.parse(invitation.expiresAt) > now().getTime(), 'CODE_INVALID', '邀请已过期。');
        check(invitation.status === 'issued' ||
          (invitation.status === 'requested' && invitation.applicantUserId === userId),
        'CODE_INVALID', '邀请已由其他账号申请或已失效。');
        if (invitation.status === 'requested') return { invitationId: invitation._id, status: 'requested' };
        await transaction(async tx => {
          const currentProject = await get('projects', invitation.projectId, tx);
          check(currentProject && currentProject.scope === 'identity-test' &&
            currentProject.status === 'active', 'NO_ACCESS', '测试项目不可用。');
          const current = await get('invitations', invitation._id, tx);
          check(current && current.status === 'issued' && Date.parse(current.expiresAt) > now().getTime(),
            'CODE_INVALID', '邀请已被使用或过期。');
          await update('invitations', invitation._id, { status: 'requested', applicantUserId: userId,
            requestedAt: at(), version: current.version + 1 }, tx);
          await audit(tx, actor.user, '申请人', 'applyInvitation', invitation.projectId, userId,
            { status: current.status }, { status: 'requested' });
        });
        return { invitationId: invitation._id, status: 'requested' };
      }
      case 'listInvitations': {
        const { project } = await managerAccess(event.projectId, actor);
        const invitations = await find('invitations', { projectId: project._id, status: 'requested' });
        return { invitations: invitations.map(item => ({ id: item._id, role: item.role, trades: item.trades,
          applicantLabel: `成员 ${item.applicantUserId.slice(-6)}`, requestedAt: item.requestedAt })) };
      }
      case 'approveInvitation': {
        const { project } = await managerAccess(event.projectId, actor);
        check(typeof event.invitationId === 'string', 'BAD_INPUT', '邀请编号无效。');
        await transaction(async tx => {
          await managerAccess(project._id, actor, tx);
          // T4：维护策略与项目写冲突（真实递增 epoch），维护期间不得批准成员
          await guardAndBumpEpoch(tx, project._id);
          const invitation = await get('invitations', event.invitationId, tx);
          check(invitation && invitation.projectId === project._id && invitation.status === 'requested' &&
            Date.parse(invitation.expiresAt) > now().getTime(), 'CODE_INVALID', '邀请未待核对或已过期。');
          const currentProject = await get('projects', project._id, tx);
          check(currentProject && currentProject.status === 'active', 'NO_ACCESS', '项目不可用。');
          check(invitation.role !== '主业主' || !currentProject.primaryOwnerUserId,
            'OWNER_EXISTS', '项目已有主业主，不能重复授予。');
          const target = await get('users', invitation.applicantUserId, tx);
          check(target && target.status === 'active', 'CODE_INVALID', '申请人账号不可用。');
          check(target._id !== userId, 'NO_ACCESS', '不能批准自己的加入申请。');
          await verifyCodeForUser(event.applicantNumber, target._id, tx);
          const memberId = `m_${hash(`${project._id}:${target._id}`).slice(0, 40)}`;
          const previous = await get('project_members', memberId, tx);
          const roles = [...new Set([...(previous && previous.status === 'active' ? previous.roles : []), invitation.role])];
          const trades = [...new Set([...(previous && previous.status === 'active' ? previous.trades : []), ...invitation.trades])];
          if (previous) await update('project_members', memberId, { roles, trades, status: 'active',
            joinedAt: previous.joinedAt || at(), leftAt: null, version: (previous.version || 0) + 1 }, tx);
          else await add('project_members', { _id: memberId, projectId: project._id, userId: target._id,
            roles, trades, status: 'active', joinedAt: at(), version: 1,
            // 新成员：锚点代际 0
            taskDirSchemaVersion: SCHEDULE_SCHEMA_VERSION, taskDirGeneration: 0 }, tx);
          // 重新加入（previous 存在）时保留既有 taskDirGeneration 与目录，不重置、不清空任务状态
          if (invitation.role === '主业主') await update('projects', project._id,
            { primaryOwnerUserId: target._id, version: currentProject.version + 1 }, tx);
          await update('invitations', invitation._id, { status: 'approved', approvedByUserId: userId,
            approvedAt: at(), version: invitation.version + 1 }, tx);
          await update('users', target._id, { bindingCodeHash: null, bindingCodeExpiresAt: null,
            updatedAt: at() }, tx);
          await audit(tx, actor.user, '管家', 'approveInvitation', project._id, target._id,
            previous ? { roles: previous.roles, status: previous.status } : null,
            { roles, trades, status: 'active' });
        });
        return { invitationId: event.invitationId, status: 'approved' };
      }
      case 'removeMember': {
        const { project } = await managerAccess(event.projectId, actor);
        check(typeof event.userId === 'string' && event.userId !== userId, 'BAD_INPUT', '不能移出自己。');
        check(project.scope === 'identity-test', 'NO_ACCESS', '此入口只处理虚构测试项目。');
        // 事务外有界扫描 + 事务内围栏/epoch 复核；STALE_SCAN 时整体重扫（最多两轮）
        // 与 create/reassign 共享 member_task_guard 围栏和 projects.scheduleEpoch，形成真实写冲突
        return await scheduleService.runWithScanRounds({
          collect: () => scheduleService.collectPreconditions(project._id, [event.userId]),
          run: async (tx, snapshot) => {
            await managerAccess(project._id, actor, tx);
            const currentProject = await get('projects', project._id, tx);
            check(currentProject && currentProject.primaryOwnerUserId !== event.userId,
              'NO_ACCESS', '不能通过此入口移出主业主。');
            const memberId = `m_${hash(`${project._id}:${event.userId}`).slice(0, 40)}`;
            const current = await get('project_members', memberId, tx);
            check(current && current.status === 'active' &&
              !current.roles.some(role => ['负责人', '管家'].includes(role)),
            'NO_ACCESS', '该成员不能通过此入口移出。');
            // 维护策略 + 目录围栏 + 项目 epoch 复核；不通过则抛 STALE_SCAN 触发重扫
            await scheduleService.lockDirForRemoval(tx, project._id, event.userId, snapshot);
            // 仍有 active 安排则拒绝移出
            const snap = snapshot.dirs.get(event.userId);
            if (snap.scanned.length > 0) {
              throw new AppError('WORKER_HAS_ACTIVE_SCHEDULES', '该成员仍有未取消的施工安排，须先改派或取消后才能移出。');
            }
            // 项目 epoch 真实递增，与维护切换形成写冲突
            await update('projects', project._id, {
              scheduleEpoch: (currentProject.scheduleEpoch || 0) + 1,
              version: (currentProject.version || 0) + 1
            }, tx);
            await update('project_members', memberId, { status: 'left', leftAt: at(), version: current.version + 1 }, tx);
            await audit(tx, actor.user, '管家', 'removeMember', project._id, current.userId,
              { roles: current.roles, status: current.status }, { roles: current.roles, status: 'left' });
            return { userId: event.userId, status: 'left' };
          }
        });
      }
      case 'setScheduleWriteMode': {
        // U2 维护切换：事务外鉴权只作为快速失败；setMaintenanceMode 内部会在
        // 事务内重新核验账号状态、管家角色与项目范围，不依赖这里的旧身份。
        // 恢复 ready 由 setMaintenanceMode 一律拒绝并返回 MAINTENANCE_RESTORE_BLOCKED。
        const { project } = await managerAccess(event.projectId, actor);
        check(event.mode === 'ready' || event.mode === 'maintenance', 'BAD_INPUT', '模式须为 ready 或 maintenance。');
        return await scheduleService.setMaintenanceMode(project._id, event.mode, actor);
      }
      case 'getScheduleContext': {
        await projectAccess(event.projectId, actor);
        const ctx = await scheduleService.getScheduleContext(event.projectId, { user: actor.user, isAdmin: actor.isAdmin, role: actor.isAdmin ? '负责人' : '成员' });
        return ctx;
      }
      case 'listSchedules': {
        await projectAccess(event.projectId, actor);
        return await scheduleService.listSchedules(event.projectId, { status: event.status, trade: event.trade, date: event.date, cursor: event.cursor, limit: event.limit });
      }
      case 'getSchedule': {
        await projectAccess(event.projectId, actor);
        return { schedule: await scheduleService.getSchedule(event.projectId, event.scheduleId) };
      }
      case 'listScheduleRevisions': {
        await projectAccess(event.projectId, actor);
        return await scheduleService.listScheduleRevisions(event.projectId, event.scheduleId, { cursor: event.cursor, limit: event.limit });
      }
      case 'createSchedule': {
        await managerAccess(event.projectId, actor);
        return await scheduleService.createSchedule(event.projectId, event.requestId, event.form, { user: actor.user, role: '管家' }, { expectedConfirmed: event.expectedConfirmed });
      }
      case 'updateSchedule': {
        await managerAccess(event.projectId, actor);
        return await scheduleService.updateSchedule(event.projectId, event.scheduleId, event.expectedVersion, event.requestId, event.form, event.reason, { user: actor.user, role: '管家' }, { expectedConfirmed: event.expectedConfirmed });
      }
      case 'reassignSchedule': {
        await managerAccess(event.projectId, actor);
        return await scheduleService.reassignSchedule(event.projectId, event.scheduleId, event.expectedVersion, event.requestId, event.workerUserId, event.reason, { user: actor.user, role: '管家' });
      }
      case 'cancelSchedule': {
        await managerAccess(event.projectId, actor);
        return await scheduleService.cancelSchedule(event.projectId, event.scheduleId, event.expectedVersion, event.requestId, event.reason, { user: actor.user, role: '管家' });
      }
      default: throw new AppError('BAD_INPUT', '不支持的操作。');
    }
  }
  return { execute };
}

module.exports = { createService, AppError, APPID };
