'use strict';
// 本包专用原生命令输出严格解码辅助（Codex 本地编码方案 §3 C1）。
// 接口固定：decodeNative(buffer) / decodeAscii(buffer) / decodeUtf8Strict(buffer)。
// 不提供任意编码、命令、路径或 options 透传；不支持运行时严格能力的编码明确拒绝。
// 编码契约依据：docs/证据/CodeBuddy本地编码模块兼容返修-20261024.json S1–S3
// （icacls/whoami 管道输出 = OEM 代码页 936（GB18030 兼容），本机取证确认）；
// v2 复核：docs/证据/CodeBuddy本地编码模块兼容返修v2-20261024.json——适用性由
// local-tools 在产品调用前以固定只读探针受控建立，不靠代码页推导（R1）。
// R3：fatal 严格解码之外**显式拒绝替换字符 U+FFFD**——合法编码的 U+FFFD 字节
// （UTF-8 EF BF BD；GB18030 四字节 84 31 A4 37）在 fatal 下可解出 U+FFFD，
// 一律拒绝（不删除字符、不静默替换）。
const ERROR_CODE = 'PSR_NATIVE_DECODE_FAILED';

function fail(reason) {
  const e = new Error('原生命令输出严格解码失败：' + reason);
  e.code = ERROR_CODE;
  throw e;
}

/** 解码结果不得含替换字符（R3）：fatal 可解出合法编码的 U+FFFD，显式拒绝。 */
function rejectReplacement(text) {
  if (text.includes('\uFFFD')) fail('解码结果含替换字符 U+FFFD（严格拒绝，不删除不替换）');
  return text;
}

/** 原生命令输出（icacls/whoami 等 C 运行时管道输出）：按本机 OEM 代码页严格解码。 */
let nativeDecoder = null;
function decodeNative(buffer) {
  if (!Buffer.isBuffer(buffer)) fail('输入不是 Buffer');
  if (!nativeDecoder) {
    try { nativeDecoder = new TextDecoder('gb18030', { fatal: true }); }
    catch (e) { fail('运行时不支持 gb18030 严格解码（' + e.message + '）'); }
  }
  try { return rejectReplacement(nativeDecoder.decode(buffer)); }
  catch (e) {
    if (e && e.code === ERROR_CODE) throw e; // 已是本模块错误（含 U+FFFD 拒绝）
    fail('GB18030 严格解码拒绝（非法/不完整序列）：' + e.message);
  }
}

/** Git 输出：core.quotepath 下路径为 ASCII 转义；出现 >=0x80 字节即形状异常。 */
function decodeAscii(buffer) {
  if (!Buffer.isBuffer(buffer)) fail('输入不是 Buffer');
  for (const b of buffer) {
    if (b >= 0x80) fail('ASCII 通道出现高位字节（0x' + b.toString(16) + '）');
  }
  return buffer.toString('latin1');
}

/** DPAPI 受控 PS 会话 stdout：hex 密文通道按 UTF-8 严格解码。 */
let utf8Decoder = null;
function decodeUtf8Strict(buffer) {
  if (!Buffer.isBuffer(buffer)) fail('输入不是 Buffer');
  if (!utf8Decoder) {
    try { utf8Decoder = new TextDecoder('utf-8', { fatal: true }); }
    catch (e) { fail('运行时不支持 utf-8 严格解码（' + e.message + '）'); }
  }
  try { return rejectReplacement(utf8Decoder.decode(buffer)); }
  catch (e) {
    if (e && e.code === ERROR_CODE) throw e; // 已是本模块错误（含 U+FFFD 拒绝）
    fail('UTF-8 严格解码拒绝（非法/不完整序列）：' + e.message);
  }
}

module.exports = Object.freeze({
  ERROR_CODE,
  decodeNative,   // icacls/whoami 等原生命令管道输出（OEM CP，本机 936）
  decodeAscii,    // git 输出（core.quotepath ASCII 协议）
  decodeUtf8Strict // 受控 PS 会话 stdout（hex 密文等 UTF-8 协议）
});
