const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { bindingDigest } = require('../miniprogram/utils/binding-digest');
const { createValidBindingProbe, MEMBER_TARGET: target } = require('../miniprogram/utils/member-write-probe');
const number = '1234567890'; // 合成测试编号，不是用户凭据。
const now = Date.parse('2026-09-29T13:00:00Z');
const proof = { evidenceId: 'synthetic', userId: target.userId, digest: bindingDigest(number),
  verifiedAt: '2026-09-29T12:59:00Z', checkBefore: '2026-09-29T13:45:00Z', expiresAt: '2026-09-30T12:59:00Z' };
const access = () => ({ project: { id: target.projectId, scope: 'identity-test', status: 'active', roles: ['主业主'] },
  members: [{ id: target.memberId, label: '成员 989a74', roles: ['师傅', '设计师'], trades: ['拆改', '木工'] }] });
function fixture(overrides = {}) {
  const calls = [];
  const call = async (action, input) => {
    calls.push({ action, input });
    if (overrides[action]) return overrides[action](input, calls);
    if (action === 'identify') return { userId: target.actorId, isAdmin: false };
    if (action === 'getMembers') return access();
    throw Object.assign(new Error('仅负责人可指定管家。'), { businessCode: 'NO_ACCESS' });
  };
  return { call, calls };
}
test('固定格式摘要与 Node crypto 独立结果一致，拒绝非十位ASCII数字', () => {
  const vectors = ['0000000000', '9999999999', number,
    ...Array.from({ length: 100 }, () => String(crypto.randomInt(0, 10000000000)).padStart(10, '0'))];
  for (const input of vectors) assert.equal(bindingDigest(input),
    crypto.createHash('sha256').update('wxfb4db1615ac15531:' + input).digest('hex'));
  for (const bad of ['', '１２３４５６７８９０', 1234567890, '123', '123456789x']) assert.throws(() => bindingDigest(bad));
});
test('只用核验一致的有效编号发送一次请求，报告不包含原始编号', async () => {
  const { call, calls } = fixture();
  const result = await createValidBindingProbe(proof).run(call, number, () => now);
  assert.equal(result.complete, true);
  assert.equal(result.results[0].status, 'denied');
  assert.deepEqual(calls.filter(row => row.action === 'assignManager'), [{ action: 'assignManager',
    input: { projectId: target.projectId, bindingNumber: number } }]);
  assert.equal(JSON.stringify(result).includes(number), false);
});
test('不同编号、过期、未来或无效核验时间及错误归属不调用云函数', async () => {
  for (const [p, n, time] of [
    [proof, '9999999999', now], [proof, '', now], [proof, number, Date.parse(proof.checkBefore)],
    [{ ...proof, expiresAt: new Date(now).toISOString() }, number, now],
    [{ ...proof, userId: 'other' }, number, now], [{ ...proof, checkBefore: 'invalid' }, number, now],
    [proof, number, Date.parse(proof.verifiedAt) - 1]
  ]) {
    const { call, calls } = fixture();
    assert.equal((await createValidBindingProbe(p).run(call, n, () => time)).complete, false);
    assert.equal(calls.length, 0);
  }
});
test('错误微信、变化的成员或预检期间过期不发指定请求', async () => {
  for (const overrides of [
    { identify: () => ({ userId: 'other', isAdmin: false }) },
    { identify: () => ({ userId: target.actorId, isAdmin: true }) },
    { getMembers: () => { const a = access(); a.project.roles.push('管家'); return a; } },
    { getMembers: () => { const a = access(); a.members = []; return a; } }
  ]) {
    const { call, calls } = fixture(overrides);
    assert.equal((await createValidBindingProbe(proof).run(call, number, () => now)).complete, false);
    assert.ok(calls.every(row => row.action !== 'assignManager'));
  }
  let ticks = 0;
  const { call, calls } = fixture();
  const result = await createValidBindingProbe(proof).run(call, number,
    () => ++ticks === 1 ? now : Date.parse(proof.checkBefore));
  assert.equal(result.complete, false);
  assert.ok(calls.every(row => row.action !== 'assignManager'));
});
test('成功、错误码和带编号的底层错误均停止且不泄露编号', async () => {
  for (const assignManager of [() => ({}),
    () => { throw Object.assign(new Error(number), { businessCode: 'CODE_INVALID' }); },
    () => { throw new Error('network request: ' + number); },
    () => { throw Object.assign(new Error('另一种拒绝'), { businessCode: 'NO_ACCESS' }); }
  ]) {
    const { call, calls } = fixture({ assignManager });
    const result = await createValidBindingProbe(proof).run(call, number, () => now);
    assert.equal(result.complete, false);
    assert.equal(calls.at(-1).action, 'assignManager');
    assert.equal(JSON.stringify(result).includes(number), false);
  }
});
