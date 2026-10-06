// 本地交互校验，不能作为真实身份或云端权限边界。
const { validDay } = require('./date');
const { STAGES } = require('./seed');
const clone = value => JSON.parse(JSON.stringify(value));
const assert = (condition, message) => {
  if (!condition) {
    const error = new Error(message);
    error.code = 'BAD_INPUT';
    error.kind = 'validation';
    throw error;
  }
};
const account = state => state.accounts.find(item => item.id === state.currentUserId);
const membership = (state, projectId) => state.members.find(item => item.projectId === projectId && item.userId === state.currentUserId && item.status === 'active');
const canRead = (state, projectId) => !!(account(state) && (account(state).leader || membership(state, projectId)));
const canManage = (state, projectId) => (membership(state, projectId) || { roles: [] }).roles.includes('管家');

function project(state, projectId) {
  const result = state.projects.find(item => item.id === projectId);
  assert(result && canRead(state, projectId), '当前示例账号无法访问此项目，请返回项目列表。');
  return result;
}

function activeOn(schedule, date) {
  return date >= schedule.start && date <= schedule.end && !schedule.restDays.includes(date);
}

function workerCanPost(state, schedule, date) {
  const member = membership(state, schedule.projectId);
  return !!(member && member.roles.includes('师傅') && member.trades.includes(schedule.trade) && activeOn(schedule, date));
}

function scheduleStatus(state, schedule, date) {
  if (date < schedule.start) return { text: '未到安排日期', tone: 'muted', active: false };
  if (date > schedule.end) return { text: '安排已结束', tone: 'muted', active: false };
  if (schedule.restDays.includes(date)) return { text: '休息／停工 · 无需更新', tone: 'muted', active: false };
  const updated = state.records.some(item => item.projectId === schedule.projectId && item.trade === schedule.trade && item.date === date && item.kind === 'worker');
  return { text: updated ? '当日已更新' : '当日待更新', tone: updated ? 'success' : 'warning', active: true, updated };
}

function saveSchedule(state, projectId, input, now, id) {
  project(state, projectId);
  assert(canManage(state, projectId), '仅项目管家可维护施工安排。');
  const previous = input.id ? state.schedules.find(item => item.id === input.id && item.projectId === projectId) : null;
  assert(!input.id || previous, '原施工安排已不存在。');
  assert(!previous || previous.version === input.version, '安排已变化，请重新进入后编辑。');
  assert(validDay(input.start) && validDay(input.end) && input.start <= input.end, '施工结束日期不能早于开始日期。');
  assert(validDay(input.expected) && input.expected >= input.start, '预计完成日期不能早于开始日期。');
  assert(STAGES.includes(input.stage), '请选择施工阶段。');
  assert(typeof input.content === 'string' && input.content.trim().length > 0 && input.content.length <= 500, '请填写本次施工内容（最多 500 字）。');
  const worker = state.members.find(item => item.projectId === projectId && item.userId === input.workerId && item.status === 'active' && item.roles.includes('师傅') && item.trades.includes(input.trade));
  assert(worker, '主要上传责任人须为本项目该工种的在册师傅。');
  const restDays = [...new Set(input.restDays || [])].sort();
  assert(restDays.every(date => validDay(date) && date >= input.start && date <= input.end), '休息／停工日期必须在施工日期范围内，请移除超出范围的日期。');
  const next = clone(state);
  const oldSnapshot = previous ? clone(previous) : null;
  if (oldSnapshot) delete oldSnapshot.history;
  const history = previous ? previous.history.concat([oldSnapshot]) : [];
  const saved = { id: previous ? previous.id : id, projectId, trade: input.trade, stage: input.stage, workerId: input.workerId, start: input.start, end: input.end, expected: input.expected, restDays, content: input.content.trim(), version: previous ? previous.version + 1 : 1, history, updatedAt: now, updatedBy: account(state).name, actorRole: '管家' };
  if (previous) next.schedules[next.schedules.findIndex(item => item.id === previous.id)] = saved;
  else next.schedules.push(saved);
  return next;
}

function mediaError(media) {
  if (!Array.isArray(media)) return '请先拍摄现场影像。';
  const images = media.filter(item => item.type === 'image');
  const videos = media.filter(item => item.type === 'video');
  if (images.length + videos.length !== media.length) return '存在不支持的影像类型。';
  if (images.length > 9) return '每次最多 9 张照片。';
  if (videos.some(item => !Number.isFinite(item.duration) || item.duration <= 0 || item.duration > 60)) return '每段视频须大于 0 秒且不超过 60 秒。';
  if (media.some(item => !['camera', 'simulated'].includes(item.source))) return '现场记录只接受相机拍摄；电脑试用请使用明确标记的模拟影像。';
  if (media.some(item => !item.id || !item.capturedAt || (item.source === 'camera' && !item.path))) return '影像信息不完整，请重新拍摄。';
  if (new Set(media.map(item => item.id)).size !== media.length) return '影像重复，请重新拍摄。';
  if (images.length < 3 && videos.length < 1) return '至少拍摄 3 张照片或录制 1 段视频后再发布。';
  return '';
}

function validateRecord(state, input, today) {
  project(state, input.projectId);
  const schedule = state.schedules.find(item => item.id === input.scheduleId && item.projectId === input.projectId);
  assert(schedule && workerCanPost(state, schedule, today), '今天没有本人获授权工种的施工安排，或今天为休息／停工日。');
  assert(schedule.version === input.scheduleVersion, '施工安排已调整，请返回重新进入；未发布内容仍保留在当前页面。');
  assert(input.requestId && typeof input.requestId === 'string', '提交编号缺失，请重新进入。');
  assert(typeof input.location === 'string' && input.location.trim() && input.location.length <= 120, '请选择或填写施工位置（最多 120 字）。');
  assert(typeof input.note === 'string' && input.note.trim() && input.note.length <= 1000, '请填写现场施工说明（最多 1000 字）。');
  const error = mediaError(input.media);
  assert(!error, error);
  return schedule;
}

function publishRecord(state, input, today, now, id) {
  project(state, input.projectId);
  const existing = state.records.find(item => item.requestId === input.requestId && item.authorId === state.currentUserId && item.projectId === input.projectId);
  if (existing) return state;
  const schedule = validateRecord(state, input, today);
  assert(input.media.every(item => item.source === 'simulated' || item.saved), '影像尚未全部保存，请重试本地保存。');
  const next = clone(state);
  const snapshot = clone(schedule);
  delete snapshot.history;
  next.records.push({ id, requestId: input.requestId, projectId: schedule.projectId, scheduleId: schedule.id, trade: schedule.trade, stage: schedule.stage, authorId: account(state).id, authorName: account(state).name, actorRole: '师傅', kind: 'worker', date: today, createdAt: now, location: input.location.trim(), note: input.note.trim(), scheduleSnapshot: snapshot, media: clone(input.media) });
  return next;
}

module.exports = { account, membership, canRead, canManage, project, activeOn, workerCanPost, scheduleStatus, saveSchedule, mediaError, validateRecord, publishRecord };
