'use strict';
// Run synthetic-boundary fixture preparer v3 (R5 closure).
// Extracts the WHOLE Run method and its real helpers (Receipt/Close/Quote/
// Require/Allowed/Output) byte-for-byte from the pinned helper v2 source, then
// applies a fixed, uniqueness-checked replacement table that swaps EVERY
// OS-facing call (P/Invoke, Thread, Stopwatch, File, Environment, Marshal) for
// a numbered Hook double. v3 closes the generated source: full declarations
// (structs/constants/usings), Hook reference set equals Hook definition set,
// no leftover OS calls, per-scenario state reset, real success/failure
// semantics, chunked output, Unexpected accounting and per-scenario call/
// ordering/finalization assertions. inspect() exposes those static checks so
// evidence can run them on generated AND tampered sources.
// The generated C# fixture is PREPARED, NOT COMPILED OR EXECUTED.
const crypto = require('node:crypto');
const H = b => crypto.createHash('sha256').update(b).digest('hex');
const SOURCE_SHA = '408d9108fff46b045bf19183d1488a53f02ca52f4e255fab987163df60124a7b';

// Scenario table: n -> fail code injected through Hook.PrepareScenario.
// n=0 is the success path. Reason expectation = fail code (NONE for n=0).
const SCEN = ['NONE', 'SOURCE_HASH', 'SOURCE_LINK', 'JOB_CREATE', 'JOB_SET', 'JOB_LIMITS',
  'OBS_FAILURE', 'PIPE', 'STDIN', 'CREATE', 'JOB_ASSIGN', 'HANDLE_CLOSE', 'RESUME',
  'OBS_MEMBER_LIMIT', 'STDERR', 'OUTPUT_LIMIT', 'TIMEOUT', 'ROOT_EXIT', 'TREE_COUNT', 'READ'];
// Per-scenario finalization expectations (real call-accounting assertions):
//   kill: 0 none / 1 TerminateJob / 2 TerminateProc — derived from the real
//   finally condition (r.Created && (!r.RootExited || !r.JobEmpty || r.Reason!="NONE")).
const KILL_EXPECT = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1];
// Join expectations: reader threads only exist from line 179 on (n>=12 except 13..19 all reach).
const JOIN_EXPECT = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2];
// HoldDispose expectations: nodeHold non-null iff Hold succeeded (n>=3).
const HOLD_DISPOSE_EXPECT = [1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
// EnvFree expectations: env non-Zero iff the CREATE line was reached (n>=9) —
// AND the SUCCESS path (n=0) also reaches it, so EnvFree runs exactly once there.
const ENV_FREE_EXPECT = [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

// Fixed replacement table: every "from" must occur exactly once across the
// extracted bodies (Run body + Output class + Close). Sites numbered for
// call accounting; see Hook.Note site constants in the generated fixture.
const REPLACE = [
  ['static Receipt Run(string mode) {', 'static Receipt RunSynthetic(int scenario) {'],
  ['Receipt r=new Receipt();r.Mode=mode;Output output=new Output();Stopwatch clock=Stopwatch.StartNew();',
   'Receipt r=new Receipt();r.Mode="rootOnly";Output output=new Output();var clock=Hook.Clock();'],
  ['ProcessInfo pi=new ProcessInfo(); Thread outThread=null,errThread=null;',
   'ProcessInfo pi=new ProcessInfo(); object outThread=null,errThread=null;'],
  ['FileStream nodeHold=null;', 'object nodeHold=null;'],
  ['string[] args=Arguments(mode);nodeHold=Hold(Node,NodeHash);',
   'string[] args=Hook.Arguments();nodeHold=Hook.Hold(scenario);'],
  ['VerifyAccountingLayout();r.AccountingLayoutVerified=true;',
   'r.AccountingLayoutVerified=Hook.RuntimeFact("OBS_LAYOUT");'],
  ['job=CreateJobObjectW(IntPtr.Zero,null);Require(job!=IntPtr.Zero,"JOB_CREATE");',
   'job=Hook.JobCreate();Require(job!=IntPtr.Zero,"JOB_CREATE");'],
  ['Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit))),"JOB_SET");',
   'Require(Hook.JobSet(limits),"JOB_SET");'],
  ['ExtendedLimit actual;Require(QueryLimits(job,9,out actual,(uint)Marshal.SizeOf(typeof(ExtendedLimit)),IntPtr.Zero)&&actual.Basic.Flags==KillOnClose,"JOB_LIMITS");',
   'ExtendedLimit actual;Require(Hook.JobLimits(out actual)&&actual.Basic.Flags==KillOnClose,"JOB_LIMITS");'],
  ['r.Observer=new L2MemberObserver(job);', 'r.Observer=new L2MemberObserver();'],
  ['Security sa=new Security();sa.Length=Marshal.SizeOf(typeof(Security));sa.Inherit=1;',
   'Hook.PipeFactoryInit();'],
  ['Require(CreatePipe(out rd,out wr,ref sa,0),"PIPE");Require(SetHandleInformation(rd,1,0),"PIPE");',
   'Require(Hook.Pipe(out rd,out wr),"PIPE");'],
  ['Require(CreatePipe(out er,out ew,ref sa,0),"PIPE");Require(SetHandleInformation(er,1,0),"PIPE");',
   'Require(Hook.Pipe(out er,out ew),"PIPE");'],
  ['input=CreateFileW("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero);Require(input!=Invalid,"STDIN");',
   'input=Hook.StdIn();Require(input!=Invalid,"STDIN");'],
  ['si.Size=Marshal.SizeOf(typeof(Startup));', 'si.Size=Hook.StructSize();'],
  ['env=EnvironmentBlock();Require(CreateProcessW(app,command,IntPtr.Zero,IntPtr.Zero,true,Suspended|NoWindow|UnicodeEnvironment,env,Root,ref si,out pi),"CREATE");',
   'env=Hook.EnvironmentBlock();Require(Hook.CreateProcess(app,command,env,Root,ref si,out pi),"CREATE");'],
  ['Require(AssignProcessToJobObject(job,pi.Process),"JOB_ASSIGN");r.Assigned=true;',
   'Require(Hook.JobAssign(job,pi.Process),"JOB_ASSIGN");r.Assigned=true;'],
  ['outThread=new Thread(delegate(){output.Read(rd,false);});outThread.IsBackground=true;outThread.Start();',
   'outThread=Hook.StartReader(output,rd,false);'],
  ['errThread=new Thread(delegate(){output.Read(er,true);});errThread.IsBackground=true;errThread.Start();',
   'errThread=Hook.StartReader(output,er,true);'],
  ['Require(ResumeThread(pi.Thread)==1,"RESUME");r.Resumed=true;',
   'Require(Hook.Resume()==1,"RESUME");r.Resumed=true;'],
  ['Account(job,r);Require(r.Total<=16,"OBS_MEMBER_LIMIT");uint wait=WaitForSingleObject(pi.Process,0);Require(wait==WaitObject||wait==WaitTimeout,"WAIT");',
   'Hook.Account(r);Require(r.Total<=16,"OBS_MEMBER_LIMIT");uint wait=Hook.Wait();Require(wait==WaitObject||wait==WaitTimeout,"WAIT");'],
  ['if(wait==WaitObject) {r.RootExited=true;Require(GetExitCodeProcess(pi.Process,out r.RootExit),"EXIT_CODE");}',
   'if(wait==WaitObject) {r.RootExited=true;Require(Hook.ExitCode(pi.Process,out r.RootExit),"EXIT_CODE");}'],
  ['if(clock.ElapsedMilliseconds>=budget)throw new InvalidOperationException("TIMEOUT");',
   'if(Hook.ElapsedMs(clock)>=budget)throw new InvalidOperationException("TIMEOUT");'],
  ['        Thread.Sleep(10);', '        Hook.SleepTick();'],
  ['if((!r.Created||r.RootExited)&&r.JobEmpty&&r.ReadersDone)break;Thread.Sleep(10);',
   'if((!r.Created||r.RootExited)&&r.JobEmpty&&r.ReadersDone)break;Hook.SleepTick();'],
  ['Stopwatch reap=Stopwatch.StartNew();', 'var reap=Hook.Clock();'],
  ['while(reap.ElapsedMilliseconds<2000) {', 'while(Hook.ElapsedMs(reap)<2000) {'],
  ['try {if(job!=IntPtr.Zero)Account(job,r);else r.JobEmpty=!r.Created;',
   'try {if(job!=IntPtr.Zero)Hook.Account(r);else r.JobEmpty=!r.Created;'],
  ['if(r.Created && WaitForSingleObject(pi.Process,0)==WaitObject){r.RootExited=GetExitCodeProcess(pi.Process,out r.RootExit);}',
   'if(r.Created && Hook.Wait()==WaitObject){r.RootExited=Hook.ExitCode(pi.Process,out r.RootExit);}'],
  ['if(outThread!=null)r.ReadersDone=outThread.Join(100)&&r.ReadersDone;',
   'if(outThread!=null)r.ReadersDone=Hook.Join(outThread,100)&&r.ReadersDone;'],
  ['if(errThread!=null)r.ReadersDone=errThread.Join(100)&&r.ReadersDone;',
   'if(errThread!=null)r.ReadersDone=Hook.Join(errThread,100)&&r.ReadersDone;'],
  ['r.KillAccepted=r.Assigned?TerminateJobObject(job,9009):TerminateProcess(pi.Process,9009);',
   'r.KillAccepted=r.Assigned?Hook.TerminateJob(job,9009):Hook.TerminateProc(pi.Process,9009);'],
  ['if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);', 'if(env!=IntPtr.Zero)Hook.EnvFree(env);'],
  ['try {if(nodeHold!=null)nodeHold.Dispose();}catch{r.HandlesClosed=false;}',
   'try {if(nodeHold!=null)Hook.HoldDispose(nodeHold);}catch{r.HandlesClosed=false;}'],
  ['r.Elapsed=clock.ElapsedMilliseconds;', 'r.Elapsed=Hook.ElapsedMs(clock);'],
  ['try {ok=CloseHandle(h);} catch {ok=false;} finally {h=IntPtr.Zero;}',
   'try {ok=Hook.CloseHandle(h);} catch {ok=false;} finally {h=IntPtr.Zero;}'],
  ['uint count; bool ok = ReadFile(handle, buffer, (uint)buffer.Length, out count, IntPtr.Zero);',
   'uint count; bool ok = Hook.ReadChunk(handle, buffer, out count);'],
  ['if (!ok) { if (Marshal.GetLastWin32Error()==109) break; throw new InvalidOperationException(); }',
   'if (!ok) { if (Hook.LastError()==109) break; throw new InvalidOperationException(); }'],
  ['      int budget=5000;', '      int budget=Hook.Budget();']
];

// Struct/constant declarations copied byte-for-byte from the helper (plain
// data, no P/Invoke): needed by the real control flow that stays.
const DECLARATIONS = `  const string Root = @"C:\\Users\\30591\\Documents\\ChatGPT\\装修进度验收APP";
  const string Node = @"C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe";
  const string NodeHash = "c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19";
  const int Limit = 131072;
  const uint KillOnClose = 0x2000;
  const uint WaitObject = 0, WaitTimeout = 258;
  static readonly IntPtr Invalid = new IntPtr(-1);
  [StructLayout(LayoutKind.Sequential)] struct Security { public int Length; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags; public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }`;

// Static closure checks over a GENERATED fixture source. Used by the preparer
// itself and by the evidence against generated and tampered copies.
function inspect(src) {
  const problems = [];
  const check = (cond, code) => { if (!cond) problems.push(code); };
  // (1) every Hook.* reference has a matching Hook definition
  const refs = new Set();
  for (const m of src.matchAll(/Hook\.(\w+)\(/g)) refs.add(m[1]);
  const hookBody = src.slice(src.indexOf('internal static class Hook'), src.indexOf('static string Q('));
  const defs = new Set();
  for (const m of hookBody.matchAll(/(?:public|internal) static [\w<>\[\]]+ (\w+)\(/g)) defs.add(m[1]);
  for (const r of refs) if (!defs.has(r)) problems.push('HOOK_UNDEF:' + r);
  // (2) no OS-facing surface remains in the real-code bodies
  const runStart = src.indexOf('static Receipt RunSynthetic');
  const runEnd = src.indexOf('  // ── Fixed Hook double');
  const real = src.slice(runStart, runEnd);
  check(!/DllImport|static extern|Process\.Start|Thread\(|Stopwatch\.|Marshal\.|GetEnvironmentVariables|ElapsedMilliseconds/.test(real), 'CAPABILITY_REMAINS_RUN');
  // Output sits AFTER Receipt in the fixture; slice forward to the Run body.
  const outStart = src.indexOf('sealed class Output');
  const outEnd = src.indexOf('static Receipt RunSynthetic');
  check(outStart >= 0 && outEnd > outStart, 'OUTPUT_SLICE');
  const outBody = src.slice(outStart, outEnd);
  check(!/ReadFile\(|Marshal\./.test(outBody), 'CAPABILITY_REMAINS_OUTPUT');
  const closeStart = src.indexOf('static bool Close('), closeEnd = src.indexOf('sealed class Output');
  check(/(?<![.\w])CloseHandle\(/.test(src.slice(closeStart, closeEnd)) === false, 'CAPABILITY_REMAINS_CLOSE');
  // Per-item close closure: the real finally closes every acquired handle —
  // deleting the eight finally Close calls must be detectable statically.
  const closeCalls = (real.match(/Close\(ref /g) || []).length;
  check(closeCalls === 11, 'CLOSE_CALLS_COUNT:' + closeCalls);
  for (const fn of ['CreateJobObjectW', 'SetInformationJobObject', 'QueryLimits', 'QueryAccounting', 'AssignProcessToJobObject',
    'TerminateJobObject', 'TerminateProcess', 'ResumeThread', 'CreatePipe', 'SetHandleInformation', 'CreateFileW',
    'CreateProcessW', 'WaitForSingleObject', 'GetExitCodeProcess']) {
    if (real.includes(fn)) problems.push('OS_CALL_REMAINS:' + fn);
  }
  // (3) no reference to the removed mode parameter
  check(!/\bmode\b/.test(real), 'MODE_REMAINS');
  // (4) declarations present
  for (const t of ['struct Security', 'struct BasicLimit', 'struct IoCounters', 'struct ExtendedLimit',
    'struct Startup', 'struct ProcessInfo', 'using System.Text;', 'const string Node', 'const int Limit']) {
    check(src.includes(t), 'DECL_MISSING:' + t);
  }
  // (5) per-scenario reset covers all mutable hook state
  const prep = hookBody.slice(hookBody.indexOf('PrepareScenario'), hookBody.indexOf('PrepareScenario') + 900);
  for (const st of ['Calls.Clear()', 'Unexpected=0', 'ReadPlan=', 'WaitPlan=', 'LastWin=0', 'Tick=0', 'JobCreated=false', 'lastWait=', 'pipeSeq=0', 'Opened.Clear()', 'Closed.Clear()']) {
    check(prep.includes(st), 'RESET_MISSING:' + st);
  }
  // (5b) scope: the scenario fail switch lives on the OUTER class so the nested
  // observer can resolve it; Hook must not redeclare it.
  check(/static string FailAt="NONE";/.test(src.slice(0, src.indexOf('internal static class Hook'))), 'SCOPE_FAILAT');
  check(!/static string FailAt/.test(hookBody), 'FAILAT_REDECLARED');
  // (5c) JSON string escaping helper exists and is used by the receipt writer
  check(/static string JsonQ\(string s\)/.test(src), 'JSON_ESCAPE_DEF');
  check(/JsonQ\(k\)\+":"\+JsonQ\(v\)/.test(src), 'JSON_ESCAPE_USE');
  // (6) scenario wiring: 20 cases planned and asserted through the real control flow
  check(src.includes('for(int n=0;n<20;n++)'), 'SCENARIO_LOOP');
  check((src.match(/PrepareScenario\(n\)/g) || []).length >= 1, 'SCENARIO_WIRING');
  // (7) chunked output path exists (no whole-buffer CopyTo overflow)
  check(!src.includes('.CopyTo(buf,0)'), 'CHUNK_OVERFLOW');
  check(src.includes('for(int i=0;i<33;i++)ReadPlan.Enqueue(4096)'), 'CHUNK_PLAN');
  // (8) success/failure semantics: success expects Reason NONE + Outcome completed
  check(src.includes('string expReason=(n==0)?"NONE":SCEN[n];'), 'SEMANTICS_REASON');
  check(src.includes('string expOutcome=(n==0)?"completed":"failed";'), 'SEMANTICS_OUTCOME');
  // (9) brace balance
  let bal = 0; for (const ch of src) { if (ch === '{') bal++; if (ch === '}') bal--; }
  check(bal === 0, 'BRACE_BALANCE');
  // (10) type-reference closure: every constructed type is declared or framework
  const declared = new Set();
  for (const m of src.matchAll(/(?:class|struct)\s+(\w+)/g)) declared.add(m[1]);
  const framework = new Set(['object', 'IntPtr', 'Exception', 'InvalidOperationException', 'StringBuilder',
    'Queue<int>', 'List<long>', 'MemoryStream', 'byte', 'long', 'int', 'uint', 'ulong', 'bool', 'string']);
  for (const m of src.matchAll(/new\s+([\w<>\[\]]+)\s*\(/g)) {
    const t = m[1];
    if (!framework.has(t) && !declared.has(t) && !/^Queue|^List/.test(t)) problems.push('TYPE_UNDEF:' + t);
  }
  return problems;
}

function build(helperBytes) {
  if (!Buffer.isBuffer(helperBytes) || H(helperBytes) !== SOURCE_SHA) throw Error('SOURCE_DRIFT');
  const s = helperBytes.toString('utf8');
  function once(x, where) { if (where.split(x).length - 1 !== 1) throw Error('ANCHOR_NOT_UNIQUE:' + x.slice(0, 48)); }
  function section(a, b) {
    const i = s.indexOf(a), j = s.indexOf(b, i + a.length);
    if (i < 0 || j < 0) throw Error('ANCHOR_MISSING');
    return s.slice(i, j);
  }
  const runRaw = section('  static Receipt Run(string mode) {', '  static bool Allowed(string s) {');
  const receipt = section('  sealed class Receipt {', '  static bool Close(');
  const close = section('  static bool Close(', '  static void Account(');
  const quote = section('  static string Quote(string value) {', '  static void Chain(');
  const requireFn = 'static void Require(bool ok, string code) { if (!ok) throw new InvalidOperationException(code); }\n  static void Require(bool ok) { Require(ok, "HELPER_ERROR"); }';
  const allowed = section('  static bool Allowed(string s) {', '  public static int Main(string[] args) {');
  const outputRaw = section('  sealed class Output {', '  sealed class Receipt {');
  once('static void Require(bool ok, string code) { if (!ok) throw new InvalidOperationException(code); }', s);
  // Apply the fixed replacement table across the extracted bodies (run, output, close).
  let run = runRaw, out = outputRaw, cls = close;
  for (const [from, to] of REPLACE) {
    const inRun = run.split(from).length - 1, inOut = out.split(from).length - 1, inCls = cls.split(from).length - 1;
    if (inRun + inOut + inCls !== 1) throw Error('REPLACE_NOT_UNIQUE:' + from.slice(0, 48));
    if (inRun === 1) run = run.replace(from, () => to);
    else if (inOut === 1) out = out.replace(from, () => to);
    else cls = cls.replace(from, () => to);
  }
  const scenArr = SCEN.map(x => JSON.stringify(x)).join(',');
  const killArr = KILL_EXPECT.join(',');
  const joinArr = JOIN_EXPECT.join(',');
  const hdArr = HOLD_DISPOSE_EXPECT.join(',');
  const efArr = ENV_FREE_EXPECT.join(',');
  const source = `// Uncompiled synthetic boundary fixture v3 (R5 closure). Prepared, NOT compiled or executed.
// Control-flow expressions are extracted byte-for-byte from the pinned helper v2
// (sha256 ${SOURCE_SHA}); every OS-facing call is replaced by the fixed Hook double
// below. Declarations, types, scopes, scenario wiring, success/failure semantics,
// chunked output, Unexpected accounting and per-scenario call/ordering/finalization
// assertions are closed at source level. Dynamic C# assertions remain UNEXECUTED.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
internal static class RootOnlyRunBoundaryFixture {
${DECLARATIONS}
  // ── Real helper code, extracted byte-for-byte (OS calls replaced via the fixed table) ──
${requireFn}
${quote}
${allowed}
${receipt}
${cls}
${out}
${run}
  // ── Fixed Hook double: numbered sites, per-scenario failure table, real accounting ──
  // FailAt lives on the OUTER class: the nested observer and the Hook both
  // resolve this one declaration (single scope, no redeclaration).
  static string FailAt="NONE";
  internal static readonly string[] SCEN=new string[]{${scenArr}};
  static readonly int[] KillExpect=new int[]{${killArr}};
  static readonly int[] JoinExpect=new int[]{${joinArr}};
  static readonly int[] HoldDisposeExpect=new int[]{${hdArr}};
  static readonly int[] EnvFreeExpect=new int[]{${efArr}};
  internal static class Hook {
    // Note sites: 0=Hold 1=JobCreate 2=JobSet 3=JobLimits 4=Pipe 5=StdIn 6=CreateProcess
    // 7=Resume 8=Account 9=Wait 10=ExitCode 11=HoldDispose 12=JobAssign 13=TerminateJob
    // 14=TerminateProc 15=CloseHandle 16=Join 17=EnvFree 18=StartReader 100=ReadChunk
    public static List<long> Calls=new List<long>();
    public static int Unexpected;
    // Handle ledger: every non-zero handle the real control flow acquires and
    // every CloseHandle actually performed — per-item close/leak/duplicate checks.
    public static List<IntPtr> Opened=new List<IntPtr>();
    public static List<IntPtr> Closed=new List<IntPtr>();
    static Queue<int> ReadPlan=new Queue<int>();
    static Queue<uint> WaitPlan=new Queue<uint>();
    static int LastWin;
    static long Tick;
    static bool JobCreated;
    static uint lastWait=WaitTimeout;
    static int pipeSeq;
    static void Note(long site){Calls.Add(site);}
    static bool Want(string c){return FailAt==c;}
    // One place resets ALL mutable scenario state (clock/queues/counters included).
    internal static void PrepareScenario(int n){
      FailAt=SCEN[n];Calls.Clear();Unexpected=0;ReadPlan=new Queue<int>();WaitPlan=new Queue<uint>();
      LastWin=0;Tick=0;JobCreated=false;lastWait=WaitTimeout;pipeSeq=0;Opened.Clear();Closed.Clear();
      if(n==15){for(int i=0;i<33;i++)ReadPlan.Enqueue(4096);ReadPlan.Enqueue(0);}
      else if(n==14){ReadPlan.Enqueue(12);ReadPlan.Enqueue(0);ReadPlan.Enqueue(5);ReadPlan.Enqueue(0);}
      else if(n==19){ReadPlan.Enqueue(-1);}
      else {ReadPlan.Enqueue(12);ReadPlan.Enqueue(0);ReadPlan.Enqueue(0);}
      if(n==0||n==17||n==18)WaitPlan.Enqueue(WaitObject);else WaitPlan.Enqueue(WaitTimeout);
    }
    public static string[] Arguments(){return new string[]{"-e","process.stdout.write('L2_ROOT_ONLY');"};}
    public static object Hold(int scenario){Note(0);
      if(scenario==1)throw new InvalidOperationException("SOURCE_HASH");
      if(scenario==2)throw new InvalidOperationException("SOURCE_LINK");
      return new object();}
    public static void HoldDispose(object h){Note(11);}
    public static bool RuntimeFact(string c){return true;}
    public static IntPtr JobCreate(){Note(1);if(Want("JOB_CREATE"))return IntPtr.Zero;JobCreated=true;Opened.Add(new IntPtr(20));return new IntPtr(20);}
    public static bool JobSet(ExtendedLimit l){Note(2);if(!JobCreated)Unexpected++;return !Want("JOB_SET");}
    public static bool JobLimits(out ExtendedLimit actual){Note(3);actual=new ExtendedLimit();actual.Basic.Flags=KillOnClose;return !Want("JOB_LIMITS");}
    public static void PipeFactoryInit(){}
    // Distinct handle pairs per call: two pipes can no longer be confused with
    // one another, so per-item close/leak/duplicate checks are meaningful.
    public static bool Pipe(out IntPtr r,out IntPtr w){Note(4);r=new IntPtr(30+pipeSeq*2);w=new IntPtr(31+pipeSeq*2);pipeSeq++;
      if(!Want("PIPE")){Opened.Add(r);Opened.Add(w);return true;}
      return false;}
    public static IntPtr StdIn(){Note(5);if(Want("STDIN"))return Invalid;Opened.Add(new IntPtr(50));return new IntPtr(50);}
    public static int StructSize(){return 104;}
    public static IntPtr EnvironmentBlock(){return new IntPtr(70);}
    public static bool CreateProcess(string app,StringBuilder command,IntPtr env,string cwd,ref Startup si,out ProcessInfo pi){
      Note(6);pi=new ProcessInfo();
      if(Want("CREATE"))return false;
      pi.Pid=100;pi.Process=new IntPtr(60);pi.Thread=new IntPtr(61);
      Opened.Add(pi.Process);Opened.Add(pi.Thread);return true;}
    public static bool JobAssign(IntPtr job,IntPtr process){Note(12);return !Want("JOB_ASSIGN");}
    public static uint Resume(){Note(7);return Want("RESUME")?0u:1u;}
    public static void Account(Receipt r){Note(8);
      if(Want("OBS_MEMBER_LIMIT")){r.Total=17;r.Active=1;}
      else if(Want("TREE_COUNT")){r.Total=2;r.Active=0;}
      else {r.Total=1;r.Active=0;}
      r.JobEmpty=r.Active==0;}
    public static uint Wait(){Note(9);lastWait=WaitPlan.Count>0?WaitPlan.Dequeue():WaitTimeout;return lastWait;}
    public static bool ExitCode(IntPtr process,out uint code){Note(10);if(lastWait!=WaitObject)Unexpected++;code=Want("ROOT_EXIT")?9009u:0u;return true;}
    public static object Clock(){return new object();}
    public static long ElapsedMs(object c){Tick+=Want("TIMEOUT")?6000:10;return Tick;}
    public static void SleepTick(){}
    public static object StartReader(Output o,IntPtr h,bool err){Note(18);o.Read(h,err);return new object();}
    public static bool Join(object t,int ms){Note(16);return true;}
    public static void EnvFree(IntPtr e){Note(17);}
    public static int Budget(){return 5000;}
    public static bool TerminateJob(IntPtr job,uint code){Note(13);return true;}
    public static bool TerminateProc(IntPtr process,uint code){Note(14);return true;}
    public static bool CloseHandle(IntPtr h){Note(15);Closed.Add(h);return !Want("HANDLE_CLOSE");}
    // Chunked reads honor the real 4096-byte buffer: the OUTPUT_LIMIT plan
    // accumulates 33 full chunks (135168 > 131072) across separate reads.
    public static bool ReadChunk(IntPtr h,byte[] buf,out uint n){Note(100);
      if(ReadPlan.Count==0){LastWin=109;n=0;return false;}
      int v=ReadPlan.Dequeue();
      if(v==-1){LastWin=5;n=0;return false;}
      if(v==0){LastWin=109;n=0;return false;}
      int take=Math.Min(v,buf.Length);
      byte[] d=System.Text.Encoding.ASCII.GetBytes("L2_ROOT_ONLY");
      for(int i=0;i<take;i++)buf[i]=d[i%d.Length];
      n=(uint)take;return true;}
    public static int LastError(){return LastWin;}
    // Real finalization assertions over the recorded call list AND the handle
    // ledger: kill routing, reader joins, hold disposal, env release, per-item
    // close (every opened non-zero handle closed exactly once, no duplicates,
    // no unknown closes), and no unexpected hook contract violation.
    internal static bool FinalizationOk(int n){
      if(Unexpected!=0)return false;
      foreach(IntPtr h in Opened){int c=0;foreach(IntPtr x in Closed)if(x.Equals(h))c++;if(c!=1)return false;}
      foreach(IntPtr x in Closed){bool known=false;foreach(IntPtr h in Opened)if(h.Equals(x))known=true;if(!known)return false;}
      int kills13=0,kills14=0;foreach(long c in Calls){if(c==13)kills13++;if(c==14)kills14++;}
      if(KillExpect[n]==0&&(kills13!=0||kills14!=0))return false;
      if(KillExpect[n]==1&&kills13!=1)return false;
      if(KillExpect[n]==2&&kills14!=1)return false;
      int joins=0;foreach(long c in Calls)if(c==16)joins++;
      if(joins!=JoinExpect[n])return false;
      int hd=0;foreach(long c in Calls)if(c==11)hd++;
      if(hd!=HoldDisposeExpect[n])return false;
      int ef=0;foreach(long c in Calls)if(c==17)ef++;
      if(ef!=EnvFreeExpect[n])return false;
      if(n==0){
        // success ordering uses the REAL creation site (CreateProcess); hold
        // disposal happens in the finally — after the first wait, not before.
        int createProc=Calls.IndexOf(6);int jobCreate=Calls.IndexOf(1);
        int resume=Calls.IndexOf(7);int wait=Calls.IndexOf(9);int holdD=Calls.IndexOf(11);
        if(createProc<0||jobCreate<0||resume<0||wait<0||holdD<0)return false;
        if(!(jobCreate<createProc&&createProc<resume&&resume<wait&&wait<holdD))return false;
      }
      return true;
    }
  }
  static string JsonQ(string s){StringBuilder b=new StringBuilder().Append((char)34);foreach(char c in s){if(c==(char)34){b.Append((char)92).Append((char)34);}else if(c==(char)92){b.Append((char)92).Append((char)92);}else if(c<(char)32){b.Append((char)63);}else{b.Append(c);}}b.Append((char)34);return b.ToString();}
  static string Q(string s){return JsonQ(s);}
  static string J(string k,string v){return JsonQ(k)+":"+JsonQ(v);}
  public static int Main(string[] args){
    if(args.Length!=0)return 2;
    int passed=0;
    // admission check over the real extracted Allowed table (mode gate data)
    try{Require(Allowed("MODE")&&Allowed("TREE_COUNT")&&Allowed("OBS_MEMBER_LIMIT"),"ALLOWED_TABLE");}catch{
      Console.WriteLine("{"+J("ok","false")+","+J("failedCase","admission")+"}");return 1;}
    passed++;
    for(int n=0;n<20;n++){
      Hook.PrepareScenario(n);
      Receipt r=null;string err=null;
      try{r=RunSynthetic(n);}catch(Exception e){err=e.Message;}
      string expReason=(n==0)?"NONE":SCEN[n];
      string expOutcome=(n==0)?"completed":"failed";
      bool ok=err==null&&r!=null&&r.Reason==expReason&&r.Outcome==expOutcome&&Hook.FinalizationOk(n);
      if(!ok){Console.WriteLine("{"+J("ok","false")+","+J("failedScenario",n.ToString())+","+
        J("err",err==null?"null":err)+","+J("reason",r==null?"null":r.Reason)+","+
        J("passed",passed.ToString())+"}");return 1;}
      passed++;
    }
    Console.WriteLine("{"+J("ok","true")+","+J("passed",passed.ToString())+","+
      J("executedProductionHelper","false")+","+
      J("note","synthetic boundary fixture; production helper not executed")+"}");
    return 0;
  }
  // Observer internals are out of scope; synthetic fields only. Nested inside the
  // fixture class so the real Receipt/Run references resolve and the observer can
  // read the scenario state. FailAt routes the construction-time failure only;
  // member-limit detection goes through the real Account totals + Require.
  internal sealed class L2MemberObserver {
    public string Failure=(FailAt=="OBS_FAILURE")?"OBS_CLOSE":"NONE";
    public bool HandlesClosed=true;public bool Stopped=true;
    public void Poll(){}
    public void Root(long pid,IntPtr handle){}
    public void Stop(long total){Stopped=true;}
    public string Json(){return "null";}
  }
}`;
  const problems = inspect(source);
  if (problems.length) throw Error('FIXTURE_NOT_CLOSED:' + problems.join(','));
  const copied = {
    runExpressions: H(Buffer.from(run)), receipt: H(Buffer.from(receipt)), close: H(Buffer.from(cls)),
    quote: H(Buffer.from(quote)), allowed: H(Buffer.from(allowed)), outputClass: H(Buffer.from(out))
  };
  return {
    source, sourceSha256: SOURCE_SHA, generatedSha256: H(Buffer.from(source)), copied,
    plannedCases: SCEN.length, compiled: false, executed: false,
    pendingDynamicAssertions: [
      'Scenario pass/fail outcomes require compiling and running this fixture (not authorized this round)',
      'Hook doubles are a prepared behavior table; they do not prove real Job/pipe/thread semantics',
      'Observer internals remain synthetic; full Run dynamic coverage stays open'
    ]
  };
}
module.exports = Object.freeze({ build, inspect, SOURCE_SHA, SCEN, KILL_EXPECT, JOIN_EXPECT, HOLD_DISPOSE_EXPECT, ENV_FREE_EXPECT });
