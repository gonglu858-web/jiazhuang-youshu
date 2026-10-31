'use strict';
// Run synthetic-boundary fixture preparer v2 (R5).
// Extracts the WHOLE Run method (and its real helpers Receipt/Close/Quote/Require/
// Allowed/Output) byte-for-byte from the pinned helper v2 source, then applies a
// fixed, uniqueness-checked replacement table that swaps every OS-facing call
// (P/Invoke, Thread, Stopwatch, File, Environment, Marshal) for a numbered Hook
// double. The generated C# fixture is PREPARED, NOT COMPILED OR EXECUTED.
const crypto = require('node:crypto');
const H = b => crypto.createHash('sha256').update(b).digest('hex');
const SOURCE_SHA = '408d9108fff46b045bf19183d1488a53f02ca52f4e255fab987163df60124a7b';

// Scenarios: each fail code maps to the first Hook that refuses; "null" = success path.
const SCENARIOS = [
  { n: 0, fail: null, expect: 'completed' },
  { n: 1, fail: 'SOURCE_HASH', expect: 'SOURCE_HASH' },
  { n: 2, fail: 'SOURCE_LINK', expect: 'SOURCE_LINK' },
  { n: 3, fail: 'JOB_CREATE', expect: 'JOB_CREATE' },
  { n: 4, fail: 'JOB_SET', expect: 'JOB_SET' },
  { n: 5, fail: 'JOB_LIMITS', expect: 'JOB_LIMITS' },
  { n: 6, fail: 'OBS_FAILURE', expect: 'OBS_FAILURE' },
  { n: 7, fail: 'PIPE', expect: 'PIPE' },
  { n: 8, fail: 'STDIN', expect: 'STDIN' },
  { n: 9, fail: 'CREATE', expect: 'CREATE' },
  { n: 10, fail: 'JOB_ASSIGN', expect: 'JOB_ASSIGN' },
  { n: 11, fail: 'HANDLE_CLOSE', expect: 'HANDLE_CLOSE' },
  { n: 12, fail: 'RESUME', expect: 'RESUME' },
  { n: 13, fail: 'OBS_MEMBER_LIMIT', expect: 'OBS_MEMBER_LIMIT' },
  { n: 14, fail: 'STDERR', expect: 'STDERR' },
  { n: 15, fail: 'OUTPUT_LIMIT', expect: 'OUTPUT_LIMIT' },
  { n: 16, fail: 'TIMEOUT', expect: 'TIMEOUT' },
  { n: 17, fail: 'ROOT_EXIT', expect: 'ROOT_EXIT' },
  { n: 18, fail: 'TREE_COUNT', expect: 'TREE_COUNT' },
  { n: 19, fail: 'READ', expect: 'READ' }
];

// Fixed replacement table: every "from" must occur exactly once in the extracted body.
const REPLACE = [
  ['static Receipt Run(string mode) {', 'static Receipt RunSynthetic(int scenario) {'],
  ['string[] args=Arguments(mode);nodeHold=Hold(Node,NodeHash);',
   'string[] args=Hook.Arguments();object nodeHold=Hook.Hold(scenario);'],
  ['VerifyAccountingLayout();r.AccountingLayoutVerified=true;',
   'r.AccountingLayoutVerified=Hook.RuntimeFact("OBS_LAYOUT");'],
  ['job=CreateJobObjectW(IntPtr.Zero,null);Require(job!=IntPtr.Zero,"JOB_CREATE");',
   'job=Hook.JobCreate();Require(job!=IntPtr.Zero,"JOB_CREATE");'],
  ['Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit))),"JOB_SET");',
   'Require(Hook.JobSet(),"JOB_SET");'],
  ['ExtendedLimit actual;Require(QueryLimits(job,9,out actual,(uint)Marshal.SizeOf(typeof(ExtendedLimit)),IntPtr.Zero)&&actual.Basic.Flags==KillOnClose,"JOB_LIMITS");',
   'Require(Hook.JobLimits(),"JOB_LIMITS");'],
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
   'env=Hook.Environment();Require(Hook.CreateProcess(ref pi),"CREATE");'],
  ['outThread=new Thread(delegate(){output.Read(rd,false);});outThread.IsBackground=true;outThread.Start();',
   'outThread=Hook.StartReader(output,rd,false);'],
  ['errThread=new Thread(delegate(){output.Read(er,true);});errThread.IsBackground=true;errThread.Start();',
   'errThread=Hook.StartReader(output,er,true);'],
  ['Require(ResumeThread(pi.Thread)==1,"RESUME");r.Resumed=true;',
   'Require(Hook.Resume()==1,"RESUME");r.Resumed=true;'],
  ['Account(job,r);Require(r.Total<=16,"OBS_MEMBER_LIMIT");',
   'Hook.Account(r);Require(r.Total<=16,"OBS_MEMBER_LIMIT");'],
  ['uint wait=WaitForSingleObject(pi.Process,0);Require(wait==WaitObject||wait==WaitTimeout,"WAIT");',
   'uint wait=Hook.Wait();Require(wait==WaitObject||wait==WaitTimeout,"WAIT");'],
  ['if(wait==WaitObject) {r.RootExited=true;Require(GetExitCodeProcess(pi.Process,out r.RootExit),"EXIT_CODE");}',
   'if(wait==WaitObject) {r.RootExited=true;Require(Hook.ExitCode(out r.RootExit),"EXIT_CODE");}'],
  ['if(clock.ElapsedMilliseconds>=budget)throw new InvalidOperationException("TIMEOUT");',
   'if(Hook.ElapsedMs(clock)>=budget)throw new InvalidOperationException("TIMEOUT");'],
  ['if((!r.Created||r.RootExited)&&r.JobEmpty&&r.ReadersDone)break;Thread.Sleep(10);',
   'if((!r.Created||r.RootExited)&&r.JobEmpty&&r.ReadersDone)break;Hook.SleepTick();'],
  ['\n        Thread.Sleep(10);', '\n        Hook.SleepTick();'],
  ['Stopwatch clock=Stopwatch.StartNew();', 'var clock=Hook.Clock();'],
  ['Stopwatch reap=Stopwatch.StartNew();', 'var reap=Hook.Clock();'],
  ['while(reap.ElapsedMilliseconds<2000) {', 'while(Hook.ElapsedMs(reap)<2000) {'],
  ['if(job!=IntPtr.Zero)Account(job,r);else r.JobEmpty=!r.Created;',
   'if(job!=IntPtr.Zero)Hook.Account(r);else r.JobEmpty=!r.Created;'],
  ['if(r.Created && WaitForSingleObject(pi.Process,0)==WaitObject){r.RootExited=GetExitCodeProcess(pi.Process,out r.RootExit);}',
   'if(r.Created && Hook.Wait()==WaitObject){r.RootExited=Hook.ExitCode(out r.RootExit);}'],
  ['if(outThread!=null)r.ReadersDone=outThread.Join(100)&&r.ReadersDone;',
   'if(outThread!=null)r.ReadersDone=Hook.Join(outThread,100)&&r.ReadersDone;'],
  ['if(errThread!=null)r.ReadersDone=errThread.Join(100)&&r.ReadersDone;',
   'if(errThread!=null)r.ReadersDone=Hook.Join(errThread,100)&&r.ReadersDone;'],
  ['if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);', 'Hook.EnvFree(env);'],
  ['try {if(nodeHold!=null)nodeHold.Dispose();}catch{r.HandlesClosed=false;}',
   'try {if(nodeHold!=null)Hook.HoldDispose(nodeHold);}catch{r.HandlesClosed=false;}'],
  ['r.Elapsed=clock.ElapsedMilliseconds;', 'r.Elapsed=Hook.ElapsedMs(clock);'],
  ['ProcessInfo pi=new ProcessInfo(); Thread outThread=null,errThread=null;',
   'ProcessInfo pi=new ProcessInfo(); object outThread=null,errThread=null;'],
  ['FileStream nodeHold=null;', 'object nodeHold=null;'],
  ['uint count; bool ok = ReadFile(handle, buffer, (uint)buffer.Length, out count, IntPtr.Zero);',
   'uint count; bool ok = Hook.ReadChunk(handle, buffer, out count);'],
  ['if (!ok) { if (Marshal.GetLastWin32Error()==109) break; throw new InvalidOperationException(); }',
   'if (!ok) { if (Hook.LastError()==109) break; throw new InvalidOperationException(); }'],
  ['      int budget=5000;', '      int budget=Hook.Budget();']
];

function build(helperBytes) {
  if (!Buffer.isBuffer(helperBytes) || H(helperBytes) !== SOURCE_SHA) throw Error('SOURCE_DRIFT');
  const s = helperBytes.toString('utf8');
  function once(x) { if (s.split(x).length !== 2) throw Error('ANCHOR_NOT_UNIQUE'); }
  function section(a, b) {
    const i = s.indexOf(a), j = s.indexOf(b, i + a.length);
    if (i < 0 || j < 0) throw Error('ANCHOR_MISSING');
    return s.slice(i, j);
  }
  const runRaw = section('  static Receipt Run(string mode) {', '  static bool Allowed(string s) {');
  const receipt = section('  sealed class Receipt {', '  static bool Close(');
  const close = section('  static bool Close(', '  static void Account(');
  const quote = section('  static string Quote(string value) {', '  static void Chain(');
  const requireFn = 'static void Require(bool ok, string code) { if (!ok) throw new InvalidOperationException(code); }';
  const allowed = section('  static bool Allowed(string s) {', '  public static int Main(string[] args) {');
  const outputCls = section('  sealed class Output {', '  sealed class Receipt {');
  once(requireFn);
  // Apply the fixed replacement table to the extracted bodies.
  let run = runRaw, out = outputCls;
  for (const [from, to] of REPLACE) {
    const inRun = run.split(from).length - 1, inOut = out.split(from).length - 1;
    if (inRun + inOut !== 1) throw Error('REPLACE_NOT_UNIQUE:' + from.slice(0, 48));
    if (inRun === 1) run = run.replace(from, () => to); else out = out.replace(from, () => to);
  }
  // Capability ban on the generated fixture: no OS-facing surface may remain.
  const banned = /DllImport|static extern|Process\.Start|File\.|Environment\.|Thread\.|Stopwatch\.|Marshal\.|GetEnvironmentVariables/;
  if (banned.test(run) || banned.test(out)) throw Error('CAPABILITY_REMAINS');
  const scenarios = SCENARIOS.map(x => x.n);
  const expects = SCENARIOS.map(x => `      case ${x.n}: expected="${x.expect}";break;`).join('\n');
  const reads = SCENARIOS.map(x => `      case ${x.n}: Hook.PlanReads("${x.fail}");break;`).join('\n');
  const fails = SCENARIOS.filter(x => x.fail).map(x => `      case "${x.fail}": return true;`).join('\n');
  const source = `// Uncompiled synthetic boundary fixture (R5). Prepared, NOT compiled or executed.
// Control-flow expressions are extracted byte-for-byte from the pinned helper v2
// (sha256 ${SOURCE_SHA}); every OS-facing call is replaced by the fixed Hook double
// below. This is a prepared synthetic boundary, NOT a proof of C# execution.
using System;
using System.Collections.Generic;
using System.IO;
internal static class RootOnlyRunBoundaryFixture {
  const uint WaitObject = 0, WaitTimeout = 258;
  static IntPtr Invalid=new IntPtr(-1);
${requireFn}
${quote}
${allowed}
${receipt}
${close}
${out}
${run}
  // ── Fixed Hook double: numbered sites, per-scenario failure table, unexpected-call accounting ──
  static string FailAt="NONE"; static List<long> Calls=new List<long>(); static int Unexpected;
  static bool Want(string c){return FailAt==c;}
  static void Note(long site){Calls.Add(site);}
  static Queue<int> ReadPlan=new Queue<int>();
  static int LastWin;
  internal static void PlanReads(string fail){
    ReadPlan=new Queue<int>();
    if(fail=="OUTPUT_LIMIT"){ReadPlan.Enqueue(-2);ReadPlan.Enqueue(0);ReadPlan.Enqueue(0);}
    else if(fail=="STDERR"){ReadPlan.Enqueue(0);ReadPlan.Enqueue(5);}
    else if(fail=="READ"){ReadPlan.Enqueue(-1);}
    else {ReadPlan.Enqueue(12);ReadPlan.Enqueue(0);ReadPlan.Enqueue(0);}
  }
  static bool WantRead(){return FailAt=="STDERR"||FailAt=="OUTPUT_LIMIT"||FailAt=="READ"||FailAt=="TIMEOUT"||FailAt=="ROOT_EXIT"||FailAt=="TREE_COUNT";}
  internal static class Hook {
    public static string[] Arguments(){return new string[]{"rootOnly"};}
    public static object Hold(int scenario){if(scenario==1)throw new InvalidOperationException("SOURCE_HASH");if(scenario==2)throw new InvalidOperationException("SOURCE_LINK");return new object();}
    public static void HoldDispose(object h){}
    public static bool RuntimeFact(string c){return true;}
    public static IntPtr JobCreate(){Note(1);return Want("JOB_CREATE")?IntPtr.Zero:new IntPtr(20);}
    public static bool JobSet(){Note(2);return !Want("JOB_SET");}
    public static bool JobLimits(){Note(3);return !Want("JOB_LIMITS");}
    public static void PipeFactoryInit(){}
    public static bool Pipe(out IntPtr r,out IntPtr w){Note(4);r=new IntPtr(30+Calls.Count);w=new IntPtr(40+Calls.Count);return !Want("PIPE");}
    public static IntPtr StdIn(){Note(5);return Want("STDIN")?Invalid:new IntPtr(50);}
    public static int StructSize(){return 104;}
    public static object Environment(){return new object();}
    public static bool CreateProcess(ref ProcessInfo pi){Note(6);if(Want("CREATE"))return false;pi.Pid=100;pi.Process=new IntPtr(60);pi.Thread=new IntPtr(61);return true;}
    public static uint Resume(){Note(7);return Want("RESUME")?0u:1u;}
    public static void Account(Receipt r){Note(8);if(Want("OBS_MEMBER_LIMIT")){r.Total=17;r.Active=1;}else{r.Total=1;r.Active=0;}r.JobEmpty=r.Active==0;}
    public static uint Wait(){Note(9);return (Want("ROOT_EXIT")||Want("TREE_COUNT")||Want("OBS_MEMBER_LIMIT"))?WaitObject:WaitTimeout;}
    public static bool ExitCode(out uint c){Note(10);c=Want("ROOT_EXIT")?9009u:0u;return true;}
    public static object Clock(){return new object();}
    public static long Tick=0;
    public static long ElapsedMs(object c){Tick+=Want("TIMEOUT")?6000:10;return Tick;}
    public static void SleepTick(){}
    public static object StartReader(Output o,IntPtr h,bool e){if(WantRead()||FailAt=="NONE")o.Read(h,e);return new object();}
    public static bool Join(object t,int ms){return true;}
    public static void EnvFree(object e){}
    public static int Budget(){return 5000;}
    public static bool ReadChunk(IntPtr h,byte[] buf,out uint n){Note(100);if(ReadPlan.Count==0){n=0;return false;}int v=ReadPlan.Dequeue();
      if(v==-2){byte[] big=new byte[131073];big.CopyTo(buf,0);n=(uint)Math.Min(131073,buf.Length);return true;}
      if(v==-1){LastWin=5;n=0;return false;}
      if(v==0){LastWin=109;n=0;return false;}
      byte[] d=System.Text.Encoding.ASCII.GetBytes("L2_ROOT_ONLY");for(int i=0;i<v;i++)buf[i]=d[i%d.Length];n=(uint)v;return true;}
    public static int LastError(){return LastWin;}
  }
  // Main gate is the real extracted admission line.
  static int MainGate(string[] args){if(args.Length!=1 || args[0]!="rootOnly"){Console.WriteLine("{\\"error\\":\\"MODE\\"}");return 1;}return -1;}
  public static int Main(string[] args){
    if(args.Length!=0)return 2;
    int passed=0;
    string expected="completed";
    if(MainGate(new string[]{"normal"})!=1){Console.WriteLine("{\\"ok\\":false,\\"failedCase\\":\\"admission\\",\\"passed\\":"+passed+"}");return 1;}
    passed++;
    for(int i=0;i<${SCENARIOS.length};i++){
      switch(i){${expects}
        default: Console.WriteLine("{\\"ok\\":false,\\"failedCase\\":" + i + ",\\"passed\\":" + passed + "}");return 1;}
      FailAt="NONE";
      switch(i){${reads}
        default: ReadPlan=new Queue<int>();ReadPlan.Enqueue(12);ReadPlan.Enqueue(0);ReadPlan.Enqueue(0);break;}
      Receipt r=null;
      try{r=RunSynthetic(i);}catch(Exception e){Console.WriteLine("{\\"ok\\":false,\\"failedCase\\":" + i + ",\\"error\\":\\"" + e.Message + "\\",\\"passed\\":" + passed + "}");return 1;}
      try{Require(r!=null&&r.Reason==expected);Require(expected!="completed"||r.Outcome=="completed");Require(expected=="completed"||r.Outcome=="failed");Require(Unexpected==0);passed++;}
      catch{Console.WriteLine("{\\"ok\\":false,\\"failedCase\\":" + i + ",\\"expected\\":\\"" + expected + "\\",\\"reason\\":\\"" + (r==null?"null":r.Reason) + "\\",\\"passed\\":" + passed + "}");return 1;}
    }
    Console.WriteLine("{\\"ok\\":true,\\"passed\\":" + passed + ",\\"executedProductionHelper\\":false}");
    return 0;
  }
}
// Observer internals are out of scope; synthetic fields only. FailAt routes the failure table.
internal sealed class L2MemberObserver {
  public string Failure=(FailAt=="OBS_FAILURE")?"OBS_CLOSE":"NONE";
  public bool HandlesClosed=true;public bool Stopped=true;
  public void Poll(){if(FailAt=="OBS_MEMBER_LIMIT")Failure="OBS_MEMBER_LIMIT";}
  public void Root(long pid,IntPtr handle){}
  public void Stop(long total){}
  public string Json(){return "null";}
}
`;
  if (!/case 0:/.test(source) || scenarios.length !== SCENARIOS.length) throw Error('SCENARIO_TABLE');
  const copied = {
    runExpressions: H(Buffer.from(run)), receipt: H(Buffer.from(receipt)), close: H(Buffer.from(close)),
    quote: H(Buffer.from(quote)), allowed: H(Buffer.from(allowed)), outputClass: H(Buffer.from(out))
  };
  return {
    source, sourceSha256: SOURCE_SHA, generatedSha256: H(Buffer.from(source)), copied,
    plannedCases: SCENARIOS.length, compiled: false, executed: false,
    pendingDynamicAssertions: [
      'Scenario pass/fail outcomes require compiling and running this fixture (not authorized this round)',
      'Hook doubles are a prepared behavior table; they do not prove real Job/pipe/thread semantics',
      'Observer internals remain synthetic; full Run dynamic coverage stays open'
    ]
  };
}
module.exports = Object.freeze({ build, SOURCE_SHA, SCENARIOS });
