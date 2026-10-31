'use strict';
// Strict compile-config checker + single-target selector (R3 closure).
// The expected configuration is REBUILT here from independent reviewed
// constants (pinned digests/paths from the reviewed historical fixed config
// and this round's prepared fixture v3 files) — never derived from the
// object under check. strictCheck() performs an exact deep comparison:
// precise field sets, full paths (no basename shortcuts), host/compiler/
// reference digests, argument order and content, input closure, environment,
// limits, outputs and the single-compile semantics. selectSingleTarget() is
// the reusable entry the later driver consumes: one selected case per
// authorization, one compile, no default batch runs. No compile or run
// approval exists or is implied by this module.
const crypto = require('node:crypto');
const H = b => crypto.createHash('sha256').update(b).digest('hex');

// ── Independent reviewed constants ──
const ROOT = 'C:\\Users\\30591\\Documents\\ChatGPT\\装修进度验收APP';
const EVID = ROOT + '\\docs\\证据';
const HOST = { path: 'C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe',
  sha256: 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19' };
const CSC = { path: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  bytes: 2569832, sha256: '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00' };
const CSC_CONFIG = { path: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe.config',
  bytes: 182, sha256: '2d4610ade011e530d817dd3ba4fc787e5dc0c2297cc520c30a643b8fb13f9093' };
const REFERENCES = [
  { path: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\mscorlib.dll', bytes: 5445432, sha256: '11ac114c43ecf6996bef58ba3c99fba3693a4560a84eeadde54d193060dc626c' },
  { path: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.dll', bytes: 3545264, sha256: '2b3c17c6208a0b4b6beb94e1a066f99ba06cdb2ea919479e99d47e8c6d96dc71' },
  { path: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.Core.dll', bytes: 1551104, sha256: '8b898bed54ae8cc61f9c58cc3eb062724f8357d2bdda338b5d363654ecff333d' }
];
const SRC_HELPER = EVID + '\\CodexL2单根对照辅助层v2-20261031.cs';
const SRC_OBSERVER = EVID + '\\CodexL2成员观察器v3-20261028.cs';
const SRC_CLEANUP_FIXTURE = EVID + '\\CodexL2单根收尾合成夹具v1-20261031.cs';
const SRC_RUN_FIXTURE = EVID + '\\CodexL2单根Run合成边界夹具v3-20261031.cs';
const SRC_CLEANUP_PREP = EVID + '\\CodexL2单根收尾夹具准备v1-20261031.cjs';
const SRC_RUN_PREP = EVID + '\\CodexL2单根Run合成边界准备v3-20261031.cjs';
const SHA_HELPER = '408d9108fff46b045bf19183d1488a53f02ca52f4e255fab987163df60124a7b';
const SHA_OBSERVER = '722d28e9e2f145d9bcf4e00fb82ee4837ec4b365d53bdd86b4472a6228fd9019';
const SHA_CLEANUP_FIXTURE = '9b76b6af754992cbb69b6a77c24191f16ed0132d6028a214118f31aed2840fd2';
const SHA_RUN_FIXTURE = '88ed80b47798d348717bb8b02dee9bbf3cb6412f0f0007258823cad8381f8b9e';
const SHA_CLEANUP_PREP = 'c22a543113d979994d5d84e3a3ae76c38c3e7db007a9d4d61cbd07b58d718858';
const SHA_RUN_PREP = 'eea43bed024acab302ca2b5d4f3bfb63425332d34d6661c9d083ddf73beac7d3';
// Fixed compiler argument template (order fixed; /main and source files appended per case).
const ARGS_TEMPLATE = ['/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/platform:x64', '/langversion:5',
  '/codepage:65001', '/utf8output', '/optimize+', '/debug-', '/warn:4', '/warnaserror+',
  '/errorreport:none', '/nowin32manifest'];
const REF_ARGS = REFERENCES.map(r => '/reference:' + r.path);

function buildCase(id, main, exeName, sourceFiles, inputDirName) {
  const outputRoot = ROOT + '\\artifacts\\psr-l2\\' + inputDirName;
  const outputFile = outputRoot + '\\' + exeName;
  return {
    id, main, expectedExitCode: 0,
    outputRoot, tempRoot: outputRoot + '\\tmp', outputFile,
    record: EVID + '\\CodexL2单根单次编译v3-' + id + '-待执行.json',
    sourceFiles,
    args: [...ARGS_TEMPLATE, '/main:' + main, ...REF_ARGS, '/out:' + outputFile, ...sourceFiles],
    childEnv: {
      SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
      PATH: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319',
      TEMP: outputRoot + '\\tmp', TMP: outputRoot + '\\tmp'
    }
  };
}

// The complete expected configuration, rebuilt from the constants above.
const EXPECTED = {
  schema: 'codex-l2-rootonly-compile-config/3',
  basisCommit: 'dac82a2',
  executionAuthorized: false,
  artifactExecutionApproved: false,
  singleCompile: {
    maxDirectCompilerStarts: 1, automaticRetry: false, failureStopsAll: true,
    note: '每次获准仅选定一个用例并编译一次；异常即停、不重试；编译产物不运行；多用例清单不默认批跑'
  },
  selection: {
    policy: 'single-target-per-authorization',
    note: '每次获准仅选定一个目标（selectSingleTarget 返回单用例计划）；换目标须再次获准，各自单次编译',
    selector: 'selectSingleTarget(config, caseId)'
  },
  host: { path: HOST.path, sha256: HOST.sha256 },
  cwd: ROOT,
  toolFacts: {
    source: 'historical',
    note: '编译器与引用摘要沿用已审固定配置（CodexL2观察器固定编译配置v2-20261029.json）；本轮未再次核对环境文件，未读取候选系统文件',
    compiler: { path: CSC.path, bytes: CSC.bytes, sha256: CSC.sha256 },
    compilerConfig: { path: CSC_CONFIG.path, bytes: CSC_CONFIG.bytes, sha256: CSC_CONFIG.sha256 },
    references: REFERENCES.map(r => ({ path: r.path, bytes: r.bytes, sha256: r.sha256 }))
  },
  spawn: { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: 30000, reapMs: 2000, maxCombinedOutputBytes: 131072 },
  postcheck: {
    exitCode: 0, signal: null, stderrBytes: 0, stdoutBytes: 0,
    outputMachine: 'AMD64', outputMagic: 'PE32+', requiresClrHeader: true,
    maxOutputFileBytes: 1048576, tempDirectoryMustBeEmpty: true,
    executeOutput: false, executionAllowed: false,
    artifactBinding: 'bound digest must equal postcheck product sha256 before any later single-run'
  },
  inputs: [
    { path: SRC_HELPER, sha256: SHA_HELPER },
    { path: SRC_OBSERVER, sha256: SHA_OBSERVER },
    { path: SRC_CLEANUP_FIXTURE, sha256: SHA_CLEANUP_FIXTURE },
    { path: SRC_RUN_FIXTURE, sha256: SHA_RUN_FIXTURE },
    { path: SRC_CLEANUP_PREP, sha256: SHA_CLEANUP_PREP },
    { path: SRC_RUN_PREP, sha256: SHA_RUN_PREP }
  ],
  cases: [
    buildCase('rootOnlyHelper', 'L2MemberRunner', 'rootonly-helper.exe',
      [SRC_HELPER, SRC_OBSERVER], 'rootonly-v3-helper'),
    buildCase('cleanupFixture', 'RootOnlyCleanupFixture', 'cleanup-fixture.exe',
      [SRC_CLEANUP_FIXTURE], 'rootonly-v3-cleanupFixture'),
    buildCase('runBoundaryFixture', 'RootOnlyRunBoundaryFixture', 'run-boundary.exe',
      [SRC_RUN_FIXTURE], 'rootonly-v3-runBoundary')
  ]
};

function deepEq(a, b, path, errs) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) { errs.push(path + ' (array shape)'); return; }
    for (let i = 0; i < a.length; i++) deepEq(a[i], b[i], path + '[' + i + ']', errs);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b) errs.push(path + ' (' + JSON.stringify(b) + ' != ' + JSON.stringify(a) + ')');
    return;
  }
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join('\u0000') !== kb.join('\u0000')) { errs.push(path + ' {field set}'); return; }
  for (const k of ka) deepEq(a[k], b[k], path + '.' + k, errs);
}

// strictCheck(configRaw): the public contract is NARROWED to raw JSON bytes or
// a JSON string. Parsed objects are refused outright — a caller-supplied object
// could carry getters/toJSON that answer differently on each read, so the one
// and only value snapshot is the plain object produced by a single JSON.parse
// of the caller's bytes. Validation, selection and the returned copy all
// consume that SAME snapshot. Throws CONFIG_MISMATCH:<path> on the first
// divergence from the rebuilt (and itself immutable) expectation.
function strictCheck(configRaw) {
  if (!Buffer.isBuffer(configRaw) && typeof configRaw !== 'string') {
    throw Object.assign(Error('CONFIG_WIRE'), { code: 'CONFIG_WIRE' });   // no parsed objects
  }
  let cfg;
  try { cfg = JSON.parse(configRaw.toString('utf8')); }                   // the single controlled snapshot
  catch (e) { throw Object.assign(Error('CONFIG_PARSE'), { code: 'CONFIG_PARSE' }); }
  needPlain(cfg);
  const errs = [];
  deepEq(EXPECTED, cfg, '$', errs);
  if (errs.length) {
    const e = Object.assign(Error('CONFIG_MISMATCH:' + errs[0]), { code: 'CONFIG_MISMATCH', mismatches: errs });
    throw e;
  }
  return deepFreeze(cfg);                                                 // same snapshot, frozen in place
}
function needPlain(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Object.assign(Error('CONFIG_PARSE'), { code: 'CONFIG_PARSE' });
}
function deepFreeze(v) {
  if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
}

// selectSingleTarget(config, caseId): the reusable single-target entry.
// Verifies the WHOLE config first, then returns the one selected case plan.
// Unknown or ambiguous targets are rejected. No compile/run happens here.
function selectSingleTarget(configRaw, caseId) {
  const cfg = strictCheck(configRaw);
  if (typeof caseId !== 'string' || !cfg.cases.some(c => c.id === caseId)) {
    throw Object.assign(Error('TARGET_UNKNOWN'), { code: 'TARGET_UNKNOWN' });
  }
  const matched = cfg.cases.filter(c => c.id === caseId);
  if (matched.length !== 1) throw Object.assign(Error('TARGET_AMBIGUOUS'), { code: 'TARGET_AMBIGUOUS' });
  const c = matched[0];
  return deepFreeze({
    caseId: c.id, main: c.main, expectedExitCode: c.expectedExitCode,
    outputFile: c.outputFile, tempRoot: c.tempRoot, record: c.record,
    args: [...c.args], childEnv: { ...c.childEnv },
    sourceFiles: [...c.sourceFiles],
    maxDirectCompilerStarts: cfg.singleCompile.maxDirectCompilerStarts,
    automaticRetry: cfg.singleCompile.automaticRetry,
    failureStopsAll: cfg.singleCompile.failureStopsAll,
    executeOutput: cfg.postcheck.executeOutput,
    executionAllowed: cfg.postcheck.executionAllowed,
    note: 'single target selected; one compile per authorization; output never executed'
  });
}

module.exports = Object.freeze({
  strictCheck, selectSingleTarget,
  // The independent expectation is exported ONLY as an immutable JSON string —
  // never as a mutable object reference that callers could edit in place.
  expectedConfigJson: Object.freeze(JSON.stringify(EXPECTED)),
  constants: Object.freeze({
    ROOT, HOST, CSC, CSC_CONFIG, REFERENCES,
    SHA_HELPER, SHA_OBSERVER, SHA_CLEANUP_FIXTURE, SHA_RUN_FIXTURE, SHA_CLEANUP_PREP, SHA_RUN_PREP
  })
});
