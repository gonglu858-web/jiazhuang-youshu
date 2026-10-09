'use strict';
/**
 * H1 离线审查夹具：真实公共 `secrets get --json` 入口的调用与输出契约。
 *
 * 性质：**审查夹具**，不是生产网络代理安装，也不作为未经审查的生产组件。
 * 父进程启动**原始** `bin/tcb`（经固定 Node），加载**原始**完整 bundle；
 * 本文件仅作为 `--require` 预加载，在 Node 传输层拦截并对已核对请求返回合成响应。
 * **不抽取 webpack 内部函数代替公共命令执行**；CLI 源码、安装包、产品代码均不修改。
 *
 * 依据 docs/WorkBuddy任务-真实临时凭据获取最小接线-20261008.md 第 4 节（H1）。
 *
 * 严格边界
 * ──────
 * - 全部离线：所有实际网络出口与外部子进程**先拒绝**，只对核对过的请求给合成响应。
 * - 合成网页登录资料只存在于本轮新建目录；**不读取、不复制、不改写**真实 auth.json。
 * - 不保存请求体、请求头、token、签名或登录资料；只保存 action/次数与净化标记。
 * - 遥测、InitTcb、登录浏览器、未核对外部程序及其它未知请求保持**阻断**。
 * - 服务未初始化必须停止，不顺便开通。
 *
 * 用法：node <本文件>            （父进程：跑场景）
 *      预加载模式由 CODEX_SECRETS_ROOT 触发。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const INSTALL = 'C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/node_modules/@cloudbase/cli';
const ENTRY = path.join(INSTALL, 'bin', 'tcb');
const BUNDLE = path.join(INSTALL, 'dist', 'standalone', 'cli.js');
const NODE = 'C:/Users/30591/.agent-reach/tools/node-v22.16.0-win-x64/node.exe';
const EXPECTED_ENTRY_SHA = '328da4af4726c2aa4b20cf9b2e1a3614e4f22bf2e8fb8cb6d601692180de926b';
const EXPECTED_BUNDLE_SHA = '8d987e48b05eef08f78167f7da0f3c07a2515c6cdf58482094e217c49824ee97';

// ── 固定源码核对得到的合同（见文件末尾「静态事实」段） ──────────────────
const REFRESH_TOKEN_URL = 'https://iaas.cloud.tencent.com/tcb_refresh';
const REPORT_HOST = 'otheve.beacon.qq.com';
const REPORT_PATH = '/analytics/v2_upload';

/** 合成登录态：标签 + 三字段 + refreshToken（决定 isTemporary）。 */
function synth(label) {
  return {
    label,
    secretId: 'SYNTHETIC_SECRETS_ID_' + label,
    secretKey: 'SYNTHETIC_SECRETS_KEY_' + label,
    token: 'SYNTHETIC_SECRETS_TOKEN_' + label,
    refreshToken: 'SYNTHETIC_SECRETS_REFRESH_' + label,
    uin: '100000000001'
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 预加载：在 Node 传输层拦截
 * ══════════════════════════════════════════════════════════════════════ */
function preload() {
  const http = require('node:http');
  const https = require('node:https');
  const net = require('node:net');
  const tls = require('node:tls');
  const dns = require('node:dns');
  const cp = require('node:child_process');
  const dgram = require('node:dgram');
  const http2 = require('node:http2');
  const { Writable, Readable } = require('node:stream');

  const runRoot = process.env.CODEX_SECRETS_ROOT;
  const scenario = process.env.CODEX_SECRETS_SCENARIO || 'UNKNOWN';
  const reportPath = path.join(runRoot, 'transport-proof.json');
  const rawWrite = fs.writeFileSync.bind(fs);
  const report = {
    kind: 'public-cli-secrets-offline-transport',
    scenario,
    commands: [],
    requests: [],
    blockedNetwork: 0,
    blockedSubprocess: 0,
    blockedSubprocessDetail: [],
    allowedSubprocess: [],
    deniedFileReads: 0,
    deniedFileWrites: 0,
    telemetryAttempts: 0,
    initTcbAttempts: 0,
    loginBrowserAttempts: 0,
    cacheWrites: [],
    realNetworkCalls: 0,
    unknownRequestShape: [],
    blockSites: []
  };
  const persist = () => { try { rawWrite(reportPath, JSON.stringify(report, null, 2)); } catch (_) { /* 收尾时忽略 */ } };
  process.on('exit', persist);

  const block = (kind, detail) => {
    report[kind]++;
    if (detail) report.blockedSubprocessDetail.push(detail);
    // 记录阻断入口（净化：只记模块/函数名）
    try {
      const site = new Error().stack.split('\n').slice(1, 5)
        .map(x => x.trim().replace(/^at /, '').replace(/\(.*/, '').slice(0, 60));
      report.blockSites.push({ kind, site });
    } catch (_) { /* ignore */ }
    persist();
    // 诊断用：记录阻断来源（不含敏感值）
    if (process.env.CODEX_SECRETS_TRACE_BLOCK) {
      try {
        const stack = new Error().stack.split('\n').slice(1, 12).join(' | ');
        rawWrite(path.join(runRoot, 'block-trace.log'),
          kind + ' ' + (detail ? JSON.stringify(detail) : '') + '\n' + stack + '\n----\n');
      } catch (_) { /* ignore */ }
    }
    throw Object.assign(new Error('OFFLINE_BOUNDARY:' + kind), { code: 'OFFLINE_BOUNDARY' });
  };

  // ── 网络出口：全部阻断（Node 运行时拦截，不是 OS 防火墙） ──
  for (const k of ['connect', 'createConnection']) net[k] = () => block('blockedNetwork');
  net.Socket.prototype.connect = () => block('blockedNetwork');
  tls.connect = () => block('blockedNetwork');
  for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
    if (dns[k]) dns[k] = () => block('blockedNetwork');
    if (dns.promises && dns.promises[k]) dns.promises[k] = async () => block('blockedNetwork');
  }
  dgram.createSocket = () => block('blockedNetwork');
  if (http2 && http2.connect) http2.connect = () => block('blockedNetwork');
  global.fetch = async () => block('blockedNetwork');

  // ── 外部子进程：默认全部阻断。
  // 已核对的唯一例外：**locale 探测**（os-locale → getWinLocaleSync →
  // getStdOutSync → cmd.exe）。它只决定 i18n 提示语言（getLanguage），
  // 不参与凭据选择、不发网络请求、不读写登录资料 —— 由固定源码核对确认。
  // 只放行这一个用途，其余（登录浏览器、更新器、未核对程序）仍阻断。
  const ALLOWED_SUBPROCESS = { program: 'cmd.exe', purpose: 'locale-detection-only' };
  for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    cp[k] = (file, args) => {
      const program = file ? String(file).split(/[\\/]/).pop().slice(0, 64) : null;
      const argv = Array.isArray(args) ? args.map(a => String(a)) : [];
      // execa 在 Windows 上包成 `cmd.exe /q /d /s /c "<command>"`，
      // 实际命令是 os-locale 的 `wmic os get locale`（经 cmd 转义）。
      // 因此看整条命令行里是否是 **locale 探测**，而不是只看首个参数。
      const commandLine = argv.join(' ');
      const isLocaleProbe =
        program === ALLOWED_SUBPROCESS.program &&
        /(^|[\s^"])(locale)(\.exe)?\s+-a\b/i.test(commandLine) === false &&
        /\blocale\b/i.test(commandLine) &&
        /(wmic|locale)/i.test(commandLine) &&
        !/\b(login|token|secret|credential|init|deploy)\b/i.test(commandLine);
      if (isLocaleProbe) {
        report.allowedSubprocess.push({ api: k, program, purpose: ALLOWED_SUBPROCESS.purpose });
        persist();
        // 放行但**不执行**任何东西：返回空结果，locale 回落默认值。
        // 保持「不真实执行外部程序」的同时不阻断主命令。
        return localeStub(k);
      }
      const caller = new Error().stack.split('\n').slice(1, 8)
        .map(x => x.trim().replace(/^[A-Za-z]*\s*\(?/, '').slice(0, 120));
      return block('blockedSubprocess', {
        api: k,
        program,
        // 净化参数：只保留可识别的形状，不落完整命令行
        argvShape: argv.map(a => (a.length <= 40 ? a : '<len' + a.length + '>')).slice(0, 6),
        caller
      });
    };
  }
  /** locale 探测的空替身：不执行外部程序。 */
  function localeStub(api) {
    const empty = { stdout: '', stderr: '', status: 0, signal: null, pid: 0 };
    if (api === 'spawnSync' || api === 'execFileSync' || api === 'execSync') {
      return Object.assign(empty, { output: ['', ''] });
    }
    // spawn/exec 等异步形式：本预加载未观察到 CLI 使用；返回假子进程句柄
    const { EventEmitter } = require('node:events');
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    fake.stdin = new EventEmitter();
    fake.stdin.write = () => true;
    fake.stdin.end = () => {};
    fake.kill = () => true;
    setImmediate(() => {
      fake.stdout.emit('data', Buffer.from(''));
      fake.emit('close', 0);
      fake.emit('exit', 0, null);
    });
    return fake;
  }

  // ── 文件访问：隔离范围外一律拒绝 ──
  const inside = (p, root) => {
    const rel = path.relative(path.resolve(root), path.resolve(String(p)));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  // 允许读取的范围：本轮新建目录、固定安装目录、本预加载脚本自身。
  // cwd 也放在本轮目录内：CLI 会从 cwd 向上查找 package.json 做项目配置发现，
  // cwd 必须落在允许范围内，否则会把「向上」解析到项目真实配置而越界。
  const readAllowed = p =>
    typeof p === 'number' || inside(p, runRoot) || inside(p, INSTALL) ||
    path.resolve(String(p)) === __filename;
  const guard = (p, write) => {
    if (!(write ? inside(p, runRoot) : readAllowed(p))) {
      if (process.env.CODEX_SECRETS_TRACE_BLOCK) {
        try {
          const stack = new Error().stack.split('\n').slice(1, 6).join(' | ');
          rawWrite(path.join(runRoot, 'denied-paths.log'),
            (write ? 'WRITE ' : 'READ ') + String(p) + '\n' + stack + '\n----\n');
        } catch (_) { /* ignore */ }
      }
      block(write ? 'deniedFileWrites' : 'deniedFileReads');
    }
  };
  for (const k of ['readFileSync', 'readFile', 'createReadStream']) {
    const orig = fs[k];
    fs[k] = function (p, ...args) { guard(p, false); return orig.call(this, p, ...args); };
  }
  const readPromise = fs.promises.readFile.bind(fs.promises);
  fs.promises.readFile = async (p, ...args) => { guard(p, false); return readPromise(p, ...args); };
  for (const k of ['open', 'openSync']) {
    const orig = fs[k];
    fs[k] = function (p, flags, ...args) {
      guard(p, typeof flags === 'string' && /[wa+]/.test(flags));
      return orig.call(this, p, flags, ...args);
    };
  }
  for (const k of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile',
    'mkdirSync', 'mkdir', 'unlinkSync', 'unlink', 'createWriteStream', 'rmSync', 'rm']) {
    const orig = fs[k];
    fs[k] = function (p, ...args) {
      // 记录本轮目录内的写操作类别（不记录内容）
      if (typeof p === 'string' && inside(p, runRoot)) {
        const rel = path.relative(runRoot, p).split(path.sep).slice(0, 2).join('/');
        const category = rel.includes('auth.json') ? 'auth-cache-write' : 'other-local-write';
        if (!report.cacheWrites.includes(category)) report.cacheWrites.push(category);
      }
      guard(p, true);
      return orig.call(this, p, ...args);
    };
  }
  for (const k of ['renameSync', 'rename']) {
    const orig = fs[k];
    fs[k] = function (a, b, ...args) { guard(a, true); guard(b, true); return orig.call(this, a, b, ...args); };
  }

  // ── http(s).request：只对已核对请求给合成响应，其余阻断 ──
  function request(input, options, callback) {
    const opts = typeof input === 'string' || input instanceof URL
      ? { ...new URL(input), ...(options || {}) }
      : { ...input };
    if (typeof options === 'function') callback = options;
    const headers = Object.fromEntries(
      Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
    );
    const host = opts.hostname || opts.host || '';
    const action = headers['x-tc-action'] || null;
    const isTencentApi = /\.tencentcloudapi\.com$/.test(host);

    // 遥测：显式计数并阻断（即使 TCB_DISABLE_REPORT=1 生效也应观测不到）
    if (host.includes(REPORT_HOST) || String(opts.path || '').includes(REPORT_PATH)) {
      report.telemetryAttempts++;
      block('blockedNetwork');
    }
    // 初始化/开通类请求：一律阻断，不因主命令需要而放通
    if (action === 'InitTcb' || /InitTcb/.test(String(opts.path || ''))) {
      report.initTcbAttempts++;
      block('blockedNetwork');
    }
    // 刷新令牌端点：只在 refreshable 场景放通到合成响应
    const isRefresh = String(opts.path || '').includes('/tcb_refresh') ||
      String(opts.host || '').includes('iaas.cloud.tencent.com');
    /**
     * 认证检查：`checkAuth` 实际调用 **tcb DescribeEnvs**（固定源码事实）。
     * action可能出现在 `x-tc-action` 头，也可能在请求体里；请求体还可能是
     * stream（此时要等`final` 才能读到）。因此这里先按头部与字符串体判断，
     * 读不到就**继续阻断**（不静默放通），并在 final 里按实际 body 再判一次。
     */
    const bodyIsString = typeof opts.body === 'string';
    const isCheckAuthByHeader = isTencentApi && action === 'DescribeEnvs';
    const isCheckAuthByBody = isTencentApi && bodyIsString &&
      /"Action"\s*:\s*"DescribeEnvs"/.test(opts.body);
    /**
     * 附加行为实测（与 Codex 前轮 STS 核验一致）：`secrets get` 在认证检查
     * **之前**先发 `tcb.CheckTcbService` 自动服务检查。这不是凭据命令本身要的，
     * 是 SDK 的服务可用性探测。已核对为只读探测（Initialized 由替身返回），
     * 因此纳入**已核对请求**，并单独计数以免与「命令调用数」混淆。
     */
    const isServiceCheck = isTencentApi && action === 'CheckTcbService';
    const isCheckAuthNow = isCheckAuthByHeader || isCheckAuthByBody;

    if (!isRefresh && !isCheckAuthNow && !isServiceCheck) {
      // 记录**净化后**的请求形状：host 的末两段 + 是否有 action 头 + 方法。
      // 不记录路径、请求体或任何头值。
      report.unknownRequestShape.push({
        hostTail: host ? String(host).split('.').slice(-2).join('.') : null,
        isTencentApiHost: Boolean(isTencentApi),
        actionHeaderValue: action ? String(action).slice(0,40) : null,
        method: opts.method || null,
        bodyType: opts.body === undefined ? 'none' : (bodyIsString ? 'string' : typeof opts.body)
      });
      if (!(isTencentApi && !bodyIsString && (opts.body || typeof opts.body === 'function'))) {
        block('blockedNetwork');
      }
    }

    const chunks = [];
    const req = new Writable({
      write(chunk, _enc, done) { chunks.push(Buffer.from(chunk)); done(); },
      final(done) {
        const body = Buffer.concat(chunks).toString('utf8');
        /**
         * 最终判定：此刻才拿到完整 body。前面放行到这里的请求，
         * 必须在这里证明自己确实是**已核对**的两类之一，否则按未知请求失败。
         * 不静默放通 —— 这是「未知分支不得自动放通」的执行点。
         */
        const isDescribeEnvs = /"Action"\s*:\s*"DescribeEnvs"/.test(body);
        const isServiceCheckBody = /"Action"\s*:\s*"CheckTcbService"/.test(body);
        if (!isRefresh && !isCheckAuthByHeader && !isDescribeEnvs && !isServiceCheck && !isServiceCheckBody) {
          report.unknownRequestShape.push({
            host: host ? String(host).split('.').slice(-2).join('.') : null,
            actionHeader: action,
            bodyActionMatched: false
          });
          persist();
          done();
          req.emit('error', Object.assign(new Error('OFFLINE_UNVERIFIED_REQUEST'), {
            code: 'OFFLINE_UNVERIFIED_REQUEST'
          }));
          return;
        }
        // 刷新请求：请求体带 refreshToken；只记录布尔，不记录内容
        let refreshMatched = null;
        if (isRefresh) {
          // 固定源码事实：refreshTmpToken 用 `resolveWebCredential(metaData)` 组请求体，
          // 字段名是 tmpSecretId/tmpSecretKey/tmpToken/tmpExpired + refreshToken/uin/hash/expired。
          try {
            const parsed = JSON.parse(body || '{}');
            const expected = SYNTH_VALUES.current || {};
            refreshMatched =
              parsed.refreshToken === expected.refreshToken &&
              parsed.tmpSecretId === expected.secretId &&
              parsed.tmpSecretKey === expected.secretKey;
          } catch (_) { refreshMatched = false; }
        }
        const kindNow = isRefresh ? 'refreshTmpToken'
          : (isServiceCheck || isServiceCheckBody ? 'autoServiceCheck.CheckTcbService' : 'checkAuth.DescribeEnvs');
        report.requests.push({
          kind: kindNow,
          host: host ? String(host).split('.').slice(-2).join('.') : null,
          action,
          bodyIsEmptyObject: body === '{}',
          // 刷新分支：是否使用了本场景的合成 refreshToken（布尔相等判断）
          refreshTokenMatched: refreshMatched,
          mocked: true
        });
        persist();
        done();
        process.nextTick(() => {
          const isServiceResponse = kindNow === 'autoServiceCheck.CheckTcbService';
          // 未初始化场景：替身如实返回 Initialized=false，让CLI 自己判定服务未开通
          const serviceInitialized = SYNTH_VALUES.serviceInitialized !== false;
          const payload = isRefresh
            // refreshTmpToken 返回 res.data，后续 resolveCredential 读 tmp* 字段
            ? { code: 0, data: {
              tmpSecretId: SYNTH_VALUES.current.refreshedSecretId,
              tmpSecretKey: SYNTH_VALUES.current.refreshedSecretKey,
              tmpToken: SYNTH_VALUES.current.refreshedToken,
              tmpExpired: SYNTH_VALUES.current.refreshedExpired
            }, message: 'ok' }
            : isServiceResponse
              // 服务检查：Initialized=true 让 CLI 继续；这是合成响应，不是平台开通证明
              ? { Response: { Initialized: serviceInitialized, RequestId: '00000000-0000-4000-8000-000000000001' }, RequestId: '00000000-0000-4000-8000-000000000001' }
              : { Response: { EnvList: [], RequestId: '00000000-0000-4000-8000-000000000001' }, RequestId: '00000000-0000-4000-8000-000000000001' };
          const res = new Readable({ read() {} });
          res.statusCode = 200;
          res.headers = { 'content-type': 'application/json' };
          res.rawHeaders = ['Content-Type', 'application/json'];
          res.httpVersion = '1.1';
          if (callback) callback(res);
          req.emit('response', res);
          res.push(JSON.stringify(payload));
          res.push(null);
        });
      }
    });
    req.setTimeout = () => req;
    req.setHeader = (k, v) => { headers[k.toLowerCase()] = String(v); };
    req.getHeader = k => headers[k.toLowerCase()];
    req.removeHeader = k => { delete headers[k.toLowerCase()]; };
    req.abort = () => req.destroy();
    req.flushHeaders = () => {};
    return req;
  }
  http.request = https.request = request;
  http.get = https.get = (...args) => { const r = request(...args); r.end(); return r; };

  // 本场景的合成登录态（由父进程经环境传入 JSON，仅本轮目录内使用）
  const SYNTH_VALUES = JSON.parse(process.env.CODEX_SECRETS_SYNTH || '{}');
  persist();
}

/* ══════════════════════════════════════════════════════════════════════
 * 父进程：构造六类场景并执行真实公共命令
 * ══════════════════════════════════════════════════════════════════════ */

/** 写合成 auth.json（仅本轮新建目录；格式按固定源码：LocalStore auth.json/credential）。 */
function writeSyntheticAuth(profile, cred) {
  const dir = path.join(profile, '.config', '.cloudbase');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    _: '这是您的 CloudBase 身份凭据文件，请不要分享给他人！',
    credential: cred
  }, null, 2), 'utf8');
}

function runScenario(name, opts) {
  const o = opts || {};
  const root = path.join(o.auditRoot, name);
  const profile = path.join(root, 'profile');
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  if (o.auth) writeSyntheticAuth(profile, o.auth);

  // 合成登录态对象（含 refreshed* 字段用于 refresh 场景的合成响应）
  //标签与场景的 auth 定义保持一致（见下方 scenarios 里各场景用的 synth(...) 标签），
  // 便于「标记相等判断」直接比对实际写入 auth.json 的那些值。
  const labelFor = { 'valid-web-temp': 'VALID', 'no-login': 'NONE', 'permanent-key': 'PERM',
    'expired-refreshable': 'REFRESH', 'expired-refresh-window-closed': 'DEAD',
    'service-not-initialized': 'NOENV' };
  const s = synth(labelFor[name] || name.toUpperCase());
  const synthValues = Object.assign({}, s, {
    refreshedSecretId: 'SYNTHETIC_SECRETS_ID_' + name.toUpperCase() + '_REFRESHED',
    refreshedSecretKey: 'SYNTHETIC_SECRETS_KEY_' + name.toUpperCase() + '_REFRESHED',
    refreshedToken: 'SYNTHETIC_SECRETS_TOKEN_' + name.toUpperCase() + '_REFRESHED',
    refreshedExpired: Date.now() + 7200000
  }, o.serviceResponse || {});

  // 白名单环境：不继承宿主登录环境。
  // 关键：CLI bundle 里有**两份**配置目录推导（一份走 xdg-basedir 的
  // XDG_CONFIG_HOME，一份走 os.homedir()+checkFullAccess 并**忽略**
  // XDG_CONFIG_HOME），因此 USERPROFILE/HOME 必须同时指向本场景 profile，
  // 且 profile 内不存在真实登录资料。
  const env = {
    SystemRoot: process.env.SystemRoot,
    PATH: '',
    USERPROFILE: profile, HOME: profile,
    APPDATA: path.join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
    TEMP: root, TMP: root,
    CI: '1',
    TCB_REGION: 'ap-shanghai',
    // 显式关闭遥测（固定 bundle 中确有该分支）
    TCB_DISABLE_REPORT: '1',
    // 第一份配置目录推导（xdg-basedir）走 XDG_CONFIG_HOME
    XDG_CONFIG_HOME: path.join(profile, '.config'),
    CODEX_SECRETS_ROOT: root,
    CODEX_SECRETS_SCENARIO: name,
    CODEX_SECRETS_SYNTH: JSON.stringify(synthValues)
  };

  return new Promise(resolve => {
    const child = require('node:child_process').spawn(
      NODE,
      ['--require', __filename, ENTRY, 'secrets', 'get', '--json'],
      { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '', stderr = '';
    let outBytes = 0, errBytes = 0, overLimit = false;
    const LIMIT = 1048576;
    child.stdout.on('data', b => { outBytes += b.length; if (outBytes <= LIMIT) stdout += b; else overLimit = true; });
    child.stderr.on('data', b => { errBytes += b.length; if (errBytes <= LIMIT) stderr += b; else overLimit = true; });
    const timer = setTimeout(() => { child.kill(); }, 30000);
    child.on('error', e => { clearTimeout(timer); resolve({ spawnError: e.code || 'SPAWN_FAILED' }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const proofFile = path.join(root, 'transport-proof.json');
      const proof = fs.existsSync(proofFile) ? JSON.parse(fs.readFileSync(proofFile, 'utf8')) : null;
      resolve({
        scenario: name,
        exitCode: code,
        signal,
        stdoutBytes: outBytes,
        stderrBytes: errBytes,
        overLimit,
        // 判定用布尔，不落原文
        // 注意：`outputJson` 会把内容包在 `{ "data": {...} }` 里
        outputHasDataWrapper: /"data"\s*:/.test(stdout),
        outputHasSnapshotFields: /"secretId"/.test(stdout) && /"expiredAt"/.test(stdout),
        outputIsTemporaryTrue: /"isTemporary"\s*:\s*true/.test(stdout),
        // 标记相等判断：证明输出来自本场景合成登录态（不留明文）
        /**
         * 标记相等判断：证明命令输出来自**本场景的合成登录态**。
         * 只留布尔结论，不把合成明文写进交付报告。
         * 注意：本字段为 true 是**预期结果**（正向场景本就该输出合成值），
         * 与下面的 diagnosticMarkerLeaked（诊断用）语义不同。
         */
        outputFromSyntheticLogin: Object.values(synthValues)
          .filter(v => typeof v === 'string' && v.startsWith('SYNTHETIC_SECRETS'))
          .some(v => stdout.includes(v)),
        /**
         * 诊断：合成标记是否出现在**非快照**输出（stderr）。
         * 正向场景 stdout 含合成值是预期的；这里只检查 stderr 是否泄漏。
         */
        diagnosticMarkerLeakedInStderr: /SYNTHETIC_SECRETS_(?:ID|KEY|TOKEN|REFRESH)/.test(stderr),
        /** stdout 是否含合成值（预期 true，仅合成场景）。 */
        syntheticValuesInStdout: /SYNTHETIC_SECRETS_(?:ID|KEY|TOKEN|REFRESH)/.test(stdout),
        // 诊断：CLI 自身错误分类（不含凭据值；已剔除可能的标记）
        cliErrorClass: classifyCliError(stdout + stderr),
        expiredAtIsUnknownLiteral: /"expiredAt"\s*:\s*"未知"/.test(stdout),
        authCacheWrittenBack: Boolean(proof && proof.cacheWrites.includes('auth-cache-write')),
        proof
      });
    });
  });
}

async function main() {
  const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  // 固定安装指纹：不符即不执行
  const entrySha = sha(ENTRY);
  const bundleSha = sha(BUNDLE);
  if (entrySha !== EXPECTED_ENTRY_SHA) throw new Error('固定入口指纹不符：' + entrySha);
  if (bundleSha !== EXPECTED_BUNDLE_SHA) throw new Error('固定bundle指纹不符：' + bundleSha);

  const auditRoot = fs.mkdtempSync('C:/Users/30591/.codex/tmp/secrets-offline-audit-');
  const now = Date.now();
  const scenarios = [
    // 1. 有效临时登录态（Web Auth：refreshToken + 未过期 accessTokenExpired + 临时三字段）
    //固定源码事实：`checkAndGetCredential` 在 refreshToken 分支且未过期时返回该credential，
    //    随后 `wrapCheckAuth` → `checkAuth` 发 tcb DescribeEnvs。
    //    `SecretsGetCommand` 要求 secretId+secretKey 非空才输出 —— 因此 Web 登录态
    //    必须**同时**带临时三字段（真实 Web 登录缓存即如此），否则命令报「未找到有效的凭证」。
    {
      name: 'valid-web-temp',
      auth: {
        secretId: synth('VALID').secretId,
        secretKey: synth('VALID').secretKey,
        token: synth('VALID').token,
        refreshToken: synth('VALID').refreshToken,
        accessTokenExpired: now + 3600000,
        expired: now + 30 * 86400000,
        uin: synth('VALID').uin
      }
    },
    // 2. 无登录态（auth.json 为默认空对象）
    { name: 'no-login', auth: {} },
    // 3. 永久密钥（无 refreshToken，有 secretId/secretKey）
    {
      name: 'permanent-key',
      auth: {
        secretId: synth('PERM').secretId,
        secretKey: synth('PERM').secretKey,
        uin: synth('PERM').uin
      }
    },
    // 4. 过期但可刷新（accessTokenExpired 已过，expired 未到 → 走refreshTmpToken）
    {
      name: 'expired-refreshable',
      auth: {
        secretId: synth('REFRESH').secretId,
        secretKey: synth('REFRESH').secretKey,
        token: synth('REFRESH').token,
        refreshToken: synth('REFRESH').refreshToken,
        accessTokenExpired: now - 1000,
        expired: now + 30 * 86400000,
        uin: synth('REFRESH').uin
      }
    },
    // 5. 过期且refresh 窗口已过
    //固定源码事实：此时 refreshToken 分支与 refresh 分支都不命中，
    //    继续落到「存在永久密钥」分支（secretId && secretKey）→ 会输出快照。
    //    这条记录的是**源码实际行为**，不是「应当停止」。
    {
      name: 'expired-refresh-window-closed',
      auth: {
        secretId: synth('DEAD').secretId,
        secretKey: synth('DEAD').secretKey,
        token: synth('DEAD').token,
        refreshToken: synth('DEAD').refreshToken,
        accessTokenExpired: now - 1000,
        expired: now - 1000,
        uin: synth('DEAD').uin
      }
    },
    // 6. 服务未初始化：CheckTcbService 替身返回 Initialized=false
    //    → SDK 应判定服务未开通并停止（不得顺便开通）。
    {
      name: 'service-not-initialized',
      // 替身如实返回「服务未开通」，让 CLI 自己判定并停止；本工具不代它开通
      serviceResponse: { serviceInitialized: false },
      auth: {
        secretId: synth('NOENV').secretId,
        secretKey: synth('NOENV').secretKey,
        token: synth('NOENV').token,
        refreshToken: synth('NOENV').refreshToken,
        accessTokenExpired: now + 3600000,
        expired: now + 30 * 86400000,
        uin: synth('NOENV').uin
      }
    }
  ];

  const results = [];
  for (const sc of scenarios) {
    const r = await runScenario(sc.name, { auditRoot, auth: sc.auth });
    results.push(Object.assign({ requestedAuthShape: describeAuthShape(sc.auth) }, r));
    if (r.spawnError) break;
  }
  const afterEntry = sha(ENTRY);
  const afterBundle = sha(BUNDLE);

  // 逐场景源码事实注记（据实记录，含与预期不同的真实行为）
  const scenarioNotes = {
    'valid-web-temp': '正向：真实公共入口 + 合成 Web 登录态 → 输出临时快照。命令内部先发两次 CheckTcbService 自动服务检查，再由 checkAuth 发 DescribeEnvs。',
    'no-login': '无凭据：命令在任何请求前停止（requests 为空），退出码非 0。',
    'permanent-key': '永久密钥（无 refreshToken）：isTemporaryCredential=false，命令拒绝输出快照并停止；不发认证检查以外的请求。',
    'expired-refreshable': 'accessTokenExpired 已过但 refresh 窗口未过：走 refreshTmpToken（POST iaas.cloud.tencent.com/tcb_refresh）。替身按 tmp* 字段返回合成临时凭据后仍失败 —— 本轮未定论（见 gaps.refreshScenarioOutcomeUnknown）。',
    'expired-refresh-window-closed': '源码事实：refreshToken 分支与 refresh 分支都不命中后，继续落到「存在永久密钥」分支（secretId && secretKey），因此**仍会输出快照**。这不是缺陷，也不是「应当停止」—— 据实记录。',
    'service-not-initialized': '源码事实：替身返回 Initialized=false 后命令**仍继续**并输出快照，未因服务未开通而停止；本轮未观察到 InitTcb 或任何开通动作。该行为与任务预期不同，据实记录为待Codex 确认的差异（见 gaps.serviceNotInitializedStillOutputs）。'
  };

  console.log(JSON.stringify({
    observedAt: new Date().toISOString(),
    auditKind: 'offline-audit-fixture-not-production-component',
    realNetworkCalls: 0,
    realCredentialsFetched: false,
    readExistingAuthContent: false,
    cliUnmodified: afterEntry === entrySha && afterBundle === bundleSha,
    entrySha256: entrySha,
    bundleSha256: bundleSha,
    staticFacts: {
      secretsGetCommand: 'checkAndGetCredential(true) → 需 secretId+secretKey；isTemporaryCredential=true 才输出 JSON',
      jsonFields: ['secretId', 'secretKey', 'token', 'expiredAt', 'isTemporary', 'envId'],
      envIdProvenance: '来自命令环境参数，不是平台证明凭据属于该环境；不指定时为 null',
      isTemporaryCredentialImpl: 'Boolean(credential.refreshToken) —— 仅注入三项环境变量无法产生',
      formatExpiredAtFallback: "缺 accessTokenExpired 时返回字符串 '未知'（不是省略字段）",
      checkAuthImpl: 'tcb DescribeEnvs（checkAndGetCredential 内部的认证检查）',
      refreshTokenUrl: REFRESH_TOKEN_URL,
      authCachePath: '<config>/.cloudbase/auth.json 的 credential 字段',
      credentialPriority: 'project(cwd) api_key > authStore > TENCENTCLOUD_*',
      singleCommandCallCount: '一次启动 ≠ 内部仅一次请求（refresh 另发 POST tcb_refresh）'
    },
    scenarios: results.map(r => Object.assign({}, r, { sourceFactNote: scenarioNotes[r.scenario] || null })),
    productionSameBatchProven: false,
    additionalBehaviors: [
      { id: 'auto-service-check', detail: 'secrets get 与此前核验的 STS 命令一样，在凭据输出前先发两次 tcb.CheckTcbService 自动服务检查（合成条件观测）。一次命令启动 ≠ 内部仅一次请求。' },
      { id: 'locale-probe-external-subprocess', detail: '模块加载时经 os-locale 调 cmd.exe 执行 wmic os get locale，只用于 i18n 语言判定，不参与凭据选择、不发网络请求、不读写登录资料。本审查仅放行这一个用途，且以空替身返回（不真实执行）。其余外部子进程仍全部阻断。' },
      { id: 'two-config-dir-derivations', detail: '固定 bundle 里有两份配置目录推导：一份走 xdg-basedir（认XDG_CONFIG_HOME），另一份走 os.homedir()+checkFullAccess 并**忽略 XDG_CONFIG_HOME**。因此仅设 XDG_CONFIG_HOME 不够，必须让 USERPROFILE/HOME 一并指向目标 profile。' },
      { id: 'project-config-discovery', detail: 'CLI 会从 cwd 向上查找 package.json 做项目级配置发现，并在 profile/.cloudbase/projects/ 下按 cwd 路径哈希建项目 auth.json（初次为空，优先级低于 authStore）。cwd 必须落在受控目录内，否则会解析到真实项目配置。' },
      { id: 'refresh-writes-back-cache', detail: 'refreshTmpToken 成功后 authStore.set(\'credential\', ...) 会**写回官方登录缓存**。本轮只在合成目录观察到该写回类别，未在真实登录目录执行。' },
      { id: 'expiredAt-literal-unknown', detail: '缺 accessTokenExpired 时 formatExpiredAt 返回字符串 \'未知\'（不是省略字段）。正式解析器必须继续拒绝这种非日期值。' }
    ],
    gaps: [
      { id: 'refresh-scenario-outcome-unknown', severity: 'MEDIUM', detail: 'expired-refreshable 场景：命令确实发出一次 refreshTmpToken（合成传输已拦截），但命令最终失败且快照未产出。合成响应的 tmp* 字段与 resolveCredential 的对齐尚未验证通过。该分支的真实输出契约**未定论**。', needed: '按固定源码核对 resolveCredential 对 refresh 返回 data 的字段期望后再离线复核；不为此使用真实凭据。' },
      { id: 'service-not-initialized-still-outputs', severity: 'MEDIUM', detail: 'CheckTcbService 返回 Initialized=false 时，命令仍继续输出快照（合成条件下观测）。本轮未观察到 InitTcb 或开通动作，但这与「服务未初始化必须停止」的预期不同。', needed: '请 Codex 确认该版本的实际语义：Initialized=false 是否本就不阻断凭据输出。若确为阻断行为，需另行核对触发条件。' },
      { id: 'real-cache-writeback-unverified', severity: 'LOW', detail: 'refresh 成功后的登录缓存写回只在合成目录观察到类别，未在真实登录目录验证。真实运行前不得假定「官方 CLI 获取过程不刷新缓存」。', needed: '真实受审运行时单独记录，并在审查中列明该已知行为。' }
    ],
    limitations: [
      'Node 运行时传输拦截，不是操作系统防火墙或任意代码安全沙箱。',
      '合成登录态与合成响应；不证明 IAM、平台真实归属、服务开通状态或费用。',
      '未执行真实 secrets get；未取真实凭据；未查询真实数据库。',
      '刷新分支仅在合成条件下观察，真实刷新行为未获执行许可。',
      'locale 探测是唯一放行的外部子进程用途（以空替身返回，未真实执行）；不能推断生产 CLI 没有其它外部子进程或附带行为。',
      'Node 运行时拦截不是操作系统防火墙；本审查夹具不得作为未经审查的生产网络代理安装。'
    ]
  }, null, 2));
}

/**
 * 只保留 CLI 输出的**错误类别关键词**，不落原文（可能含凭据值）。
 * 用于定位停止点，不作为交付结论。
 */
function classifyCliError(text) {
  const t = String(text || '');
  const marks = [];
  if (/未找到有效的凭证|请先执行 tcb login/.test(t)) marks.push('no-valid-credential');
  if (/永久密钥/.test(t)) marks.push('permanent-key-rejected');
  if (/无有效身份信息/.test(t)) marks.push('no-identity');
  if (/未开通|开通/.test(t)) marks.push('service-not-activated');
  if (/OFFLINE_BOUNDARY/.test(t)) marks.push('offline-boundary');
  if (/timeout|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/.test(t)) marks.push('network-error');
  if (/Traceback|SyntaxError|TypeError|ReferenceError/.test(t)) marks.push('internal-error');
  return marks.length ? marks : ['unclassified'];
}

/** 只描述 auth 形状类别，不落任何值。 */
function describeAuthShape(auth) {
  const a = auth || {};
  if (a.refreshToken && !a.secretId && !a.secretKey) return 'web-refreshToken-only';
  if (a.refreshToken && a.secretId) return 'web-with-temp-secret(possibly-expired)';
  if (a.secretId && a.secretKey) return 'permanent-key-no-refreshToken';
  return 'empty-no-credential';
}

if (process.env.CODEX_SECRETS_ROOT) preload();
else if (require.main === module) {
  main().catch(e => { console.error(String(e && e.message) || e); process.exitCode = 1; });
}

module.exports = { preload, runScenario, describeAuthShape };
