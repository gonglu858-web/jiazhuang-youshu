#!/usr/bin/env node
/**
 * WorkBuddy C1 复现（环境归属 Uin 数字类型兼容）— 2026-10-07
 *
 * 目的：闭合 docs/Codex验收-CLI接入T1与真实只读-20261007.md 第 3 节 C1。
 * 背景：真实只读执行中 EnvInfo.UserInfo.Uin 实测为 number（Number.isSafeInteger
 *       为 true），而原实现只接受非空字符串，导致整组在 describeEnvInfo 以
 *       ENV_INFO_FIELD_INVALID 停止（C1-0）。
 *
 * 约束：
 *   - 仅离线：直接调用库函数，不执行 CLI、不联网、不读认证、不初始化、不部署。
 *   - 全部使用**合成账号**，不复制任何真实值做夹具。
 *   - 结果另存为 WorkBuddyC1Uin类型兼容复现-20261007.json，不覆盖历史证据。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OBSERVER = path.resolve(__dirname, '..', '..', 'miniapp', 'scripts', 'lib', 'cloudbase-readonly-observer.cjs');
const o = require(OBSERVER);

const { FIXED, ERR, digestOf, assertSts, assertDescribeEnvInfo, normalizeEnvUin } = o;

// 合成账号（仅夹具，非任何真实主体）
const SYN = '100012345678';
const SYN_OTHER = '100099999999';
const SYN_STS = '100088888888';

const results = [];
function probe(id, fn) {
  try {
    const detail = fn();
    results.push({ id, pass: true, ...detail });
  } catch (error) {
    results.push({ id, pass: false, errorName: error && error.name,
      errorCode: error && error.code, message: error && error.message });
  }
}
/** 断言 fn 以指定错误码抛出 */
function expectCode(code, fn) {
  try {
    fn();
  } catch (error) {
    if (error && error.code === code) return true;
    throw new Error('期望错误码 ' + code + '，实际 ' + (error && error.code) + '：' + (error && error.message));
  }
  throw new Error('期望以 ' + code + ' 拒绝，但未抛错');
}

const stsDigest = digestOf(crypto, SYN);
const stsDigestOther = digestOf(crypto, SYN_OTHER);

function envInfo(userOverrides) {
  return {
    EnvInfo: {
      EnvBaseInfo: { EnvId: FIXED.envId, Status: 'NORMAL', Region: FIXED.region },
      UserInfo: Object.assign({ WxAppId: FIXED.wxAppId }, userOverrides || {})
    },
    RequestId: 'req-synthetic'
  };
}
const info = (uin) => assertDescribeEnvInfo(envInfo({ Uin: uin }), stsDigest, crypto, 'describeEnvInfo');

// C1-0复现原缺陷：数字型 Uin 在修复前被拒（现应通过）
probe('uin-number-accepted', () => {
  const r = info(Number(SYN));
  return {
    note: '数字型 Uin（已实测形态）必须被接受并按 String(Uin) 摘要',
    uinSha256MatchesSts: r.uinSha256 === stsDigest, uinTail: r.uinTail
  };
});

// 字符串旧正向
probe('uin-string-accepted', () => {
  const r = info(SYN);
  return { note: '十进制正整数字符串形态继续可用', uinSha256MatchesSts: r.uinSha256 === stsDigest };
});

// number 与 STS 摘要不匹配 → ACCOUNT_MISMATCH
probe('uin-number-mismatch-rejected', () => ({
  rejected: expectCode(ERR.ACCOUNT_MISMATCH, () => info(Number(SYN_OTHER))),
  note: '类型合法但账号不同 → 账号不匹配'
}));

// 非法数值
probe('uin-bad-numbers-rejected', () => {
  const bads = [Number.MAX_SAFE_INTEGER + 2, 1.5, -1, 0, -0, NaN, Infinity, -Infinity,
    Number.MAX_VALUE, Number.MIN_VALUE, 9007199254740993];
  const rejected = bads.every(b => expectCode(ERR.ENV_INFO_FIELD_INVALID, () => normalizeEnvUin(b, 'x')));
  return { rejected, tried: bads.length,
    note: '不安全整数/小数/负数/零/NaN/Infinity 全部拒绝' };
});

// 非法字符串（非十进制正整数）
probe('uin-bad-strings-rejected', () => {
  const bads = ['', ' ', 'abc', SYN + ' ', ' ' + SYN, '+' + SYN, '-' + SYN, '1.0', '1e5',
    '0x10', SYN.slice(0, 5) + ' ' + SYN.slice(5), '100012345678\n', '０１', '0', '00', '000'];
  const rejected = bads.every(b => expectCode(ERR.ENV_INFO_FIELD_INVALID, () => normalizeEnvUin(b, 'x')));
  return { rejected, tried: bads.length,
    note: '空白/符号/小数/科学计数/十六进制/全角/全零/非十进制一律拒绝（不做 trim）' };
});

// 非法类型
probe('uin-bad-types-rejected', () => {
  const bads = [null, undefined, true, false, {}, { valueOf: () => SYN, toString: () => SYN },
    [], [SYN], Symbol('x'), 100012345678n, () => SYN, new String(SYN)];
  const rejected = bads.every(b => expectCode(ERR.ENV_INFO_FIELD_INVALID, () => normalizeEnvUin(b, 'x')));
  return { rejected, tried: bads.length,
    note: 'null/undefined/布尔/对象/数组/Symbol/BigInt/函数/String 包装对象全部拒绝；'
      + '不使用任意 String(value) 让对象通过' };
});

// 带前导零不得被归一后匹配
probe('uin-leading-zero-not-normalized', () => {
  const padded = '00' + SYN;
  const digestDiffers = digestOf(crypto, padded) !== stsDigest;
  const mismatch = expectCode(ERR.ACCOUNT_MISMATCH, () => info(padded));
  const tailFromRaw = assertDescribeEnvInfo(envInfo({ Uin: padded }), digestOf(crypto, padded), crypto, 'x').uinTail;
  return { digestDiffers, mismatch, tailFromRaw, paddedTail: padded.slice(-4),
    note: '前导零字符串保留原始字节，摘要不同→ 不匹配；尾号亦取自原始字节' };
});

// C1 不外溢：STS 数字身份仍拒绝
probe('sts-still-strict', () => ({
  accountIdNumber: expectCode(ERR.STS_FIELD_INVALID, () => assertSts(
    { Type: 'CAMRole', AccountId: Number(SYN), UserId: 'u', PrincipalId: 'p', Arn: 'a', RequestId: 'r' }, crypto, 'x')),
  userIdNumber: expectCode(ERR.STS_FIELD_INVALID, () => assertSts(
    { Type: 'CAMRole', AccountId: SYN, UserId: 12345, PrincipalId: 'p', Arn: 'a', RequestId: 'r' }, crypto, 'x')),
  note: 'STS AccountId / UserId 仍必须是字符串；C1 只作用于环境归属 Uin'
}));

// WxAppId / 地域未放宽
probe('wxappid-and-region-still-strict', () => ({
  wxAppIdNumber: expectCode(ERR.WX_APP_ID_MISMATCH, () => assertDescribeEnvInfo(
    envInfo({ Uin: SYN, WxAppId: Number(FIXED.wxAppId) }), stsDigest, crypto, 'x')),
  regionMismatch: expectCode(ERR.ENVS_FIELD_MISMATCH, () => assertDescribeEnvInfo({
    EnvInfo: {
      EnvBaseInfo: { EnvId: FIXED.envId, Status: 'NORMAL', Region: 'ap-beijing' },
      UserInfo: { Uin: SYN, WxAppId: FIXED.wxAppId }
    }
  }, stsDigest, crypto, 'x')),
  note: '数字型 AppId 不可替代 WxAppId；地域仍精确匹配'
}));

// 输出不含完整账号值
probe('no-raw-account-in-output', () => {
  const r = info(Number(SYN));
  const dumped = JSON.stringify(r);
  return {
    leaks: dumped.includes(SYN) || dumped.includes(String(Number(SYN))),
    hasDigest: typeof r.uinSha256 === 'string' && r.uinSha256.length === 64,
    hasTail: typeof r.uinTail === 'string' && r.uinTail.length <= 4,
    note: '只保留摘要与尾号'
  };
});

const out = {
  observedAt: new Date().toISOString(),
  scope: 'C1 环境归属 Uin 数字类型窄适配',
  constraints: { network: false, executedCli: false, readAuth: false, installed: false, initialized: false, deployed: false, ranReadOnly: false },
  realNetworkCalls: 0,
  syntheticFixture: true,
  note: '全部使用合成账号，不代表任何真实主体',
  observerSha256: crypto.createHash('sha256').update(fs.readFileSync(OBSERVER)).digest('hex'),
  results,
  summary: {
    total: results.length,
    passed: results.filter(r => r.pass).length,
    failed: results.filter(r => !r.pass).length
  }
};

const dest = path.join(__dirname, 'WorkBuddyC1Uin类型兼容复现-20261007.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
process.stdout.write('\n[written] ' + dest + '\n');
if (out.summary.failed > 0) process.exitCode = 1;