// 开发核验专用：目标固定为测试集合及第一单元六个业务集合，不能访问任意名称。
const TARGET_APPID = 'wxfb4db1615ac15531';
const TARGET_ENV = 'cloud1-d8gcq5ag39d847723';
const ALLOWED_VERSIONS = Object.freeze(['develop', 'trial']);
const COLLECTION = 'yf_diag_visibility';
const BUSINESS_COLLECTIONS = Object.freeze([
  'users', 'app_admins', 'projects', 'project_members', 'invitations', 'audit_events'
]);

function classifyError(error) {
  const message = String(error && (error.errMsg || error.message) || error);
  const code = error && error.errCode;
  // SDK 有两种文案：database permission denied / Permission denied。
  // 必须同时匹配数据库错误码，不能把普通登录或网络错误当成通过。
  const denied = (Number(code) === -502003 || /-502003\b/.test(message)) &&
    /\bpermission\s+denied\b/i.test(message);
  return { status: denied ? 'denied' : 'inconclusive', code: code == null ? null : code, message };
}

function createProbe(api, configuredEnv, timeoutMs = 15000, targetCollection = COLLECTION) {
  let readResult;
  let readStarted = false;
  let writeStarted = false;
  function collection() {
    let info;
    try {
      info = api.getAccountInfoSync().miniProgram;
    } catch (error) {
      throw new Error('无法读取当前小程序账号信息，检测停止。');
    }
    if (!info || typeof info !== 'object' || info.appId !== TARGET_APPID || configuredEnv !== TARGET_ENV) {
      throw new Error('目标小程序或环境不匹配，检测停止。');
    }
    if (!ALLOWED_VERSIONS.includes(info.envVersion)) {
      throw new Error('此检测只能用于开发预览，不能在正式版或未识别版本执行。');
    }
    if (targetCollection !== COLLECTION && !BUSINESS_COLLECTIONS.includes(targetCollection)) {
      throw new Error('不允许检测此集合。');
    }
    return api.cloud.database({ env: TARGET_ENV }).collection(targetCollection);
  }
  async function request(work) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(work),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('请求超时，结果未知。请勿重复写入，先核查云端。')), timeoutMs); })
      ]);
      return { status: 'unexpected-success', message: '请求意外成功，停止后续实施。' };
    } catch (error) { return classifyError(error); }
    finally { clearTimeout(timer); }
  }
  return {
    async read() {
      if (readStarted) return { status: 'blocked', message: '本次已尝试读取，不重复请求。' };
      readStarted = true;
      readResult = await request(() => collection().limit(1).get());
      return { ...readResult, operation: 'read', checkedAt: new Date().toISOString() };
    },
    async write() {
      if (!readResult || readResult.status !== 'denied' || writeStarted) {
        return { status: 'blocked', message: '须先明确验证读取被拒绝，且每次检测只允许一次写入尝试。' };
      }
      writeStarted = true;
      const markerId = 'yf-permission-probe-' + targetCollection + '-' + Date.now();
      const result = await request(() => collection().add({ data: {
        _id: markerId, diagnostic: true, purpose: 'client-permission-check'
      } }));
      return { ...result, operation: 'create', markerId, checkedAt: new Date().toISOString() };
    }
  };
}

module.exports = { createProbe, classifyError, TARGET_ENV, COLLECTION, BUSINESS_COLLECTIONS };
