// Uncompiled synthetic boundary fixture v3 (R5 closure). Prepared, NOT compiled or executed.
// Control-flow expressions are extracted byte-for-byte from the pinned helper v2
// (sha256 408d9108fff46b045bf19183d1488a53f02ca52f4e255fab987163df60124a7b); every OS-facing call is replaced by the fixed Hook double
// below. Declarations, types, scopes, scenario wiring, success/failure semantics,
// chunked output, Unexpected accounting and per-scenario call/ordering/finalization
// assertions are closed at source level. Dynamic C# assertions remain UNEXECUTED.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
internal static class RootOnlyRunBoundaryFixture {
  const string Root = @"C:\Users\30591\Documents\ChatGPT\装修进度验收APP";
  const string Node = @"C:\Users\30591\.agent-reach\tools\node-v22.16.0-win-x64\node.exe";
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
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  // ── Real helper code, extracted byte-for-byte (OS calls replaced via the fixed table) ──
static void Require(bool ok, string code) { if (!ok) throw new InvalidOperationException(code); }
  static void Require(bool ok) { Require(ok, "HELPER_ERROR"); }
  static string Quote(string value) {
    StringBuilder b = new StringBuilder("\""); int slash = 0;
    foreach (char c in value) {
      if (c == '\\') { slash++; continue; }
      b.Append('\\', c == '"' ? slash * 2 + 1 : slash); b.Append(c); slash = 0;
    }
    b.Append('\\', slash * 2); b.Append('"'); return b.ToString();
  }

  static bool Allowed(string s) {return Array.IndexOf(new string[]{"MODE","SOURCE_MISSING","SOURCE_LINK","SOURCE_HASH","JOB_CREATE","JOB_SET","JOB_LIMITS","PIPE","STDIN","CREATE","JOB_ASSIGN","HANDLE_CLOSE","RESUME","JOB_QUERY","WAIT","EXIT_CODE","OUTPUT_LIMIT","STDERR","READ","TIMEOUT","ROOT_EXIT","TREE_COUNT","TIMEOUT_NOT_REACHED","OBS_LAYOUT","OBS_PORT","OBS_FAILURE","OBS_MEMBER_LIMIT"},s)>=0;}

  sealed class Receipt {
    public string Mode, Reason="NONE", Outcome="failed", Stdout="";
    public L2MemberObserver Observer;
    public bool AccountingLayoutVerified;
    public bool Created, Assigned, Resumed, RootExited, JobEmpty, KillRequested, KillAccepted, ReadersDone, HandlesClosed=true;
    public uint Pid, Total, Active, RootExit=259; public long OutBytes, ErrBytes, Elapsed;
    public bool Cleanup { get { return (!Created || RootExited) && JobEmpty && ReadersDone && HandlesClosed && (Observer==null || Observer.HandlesClosed); } }
    public string Json() {
      return "{\"schema\":\"codex-l2-root-only-job/1\",\"mode\":\""+Mode+"\",\"outcome\":\""+Outcome+"\",\"reason\":\""+Reason+"\","+
        "\"created\":"+B(Created)+",\"assigned\":"+B(Assigned)+",\"resumed\":"+B(Resumed)+",\"pid\":"+Pid+
        ",\"rootExited\":"+B(RootExited)+",\"rootExit\":"+RootExit+",\"jobEmpty\":"+B(JobEmpty)+",\"totalProcesses\":"+Total+",\"activeProcesses\":"+Active+
        ",\"killRequested\":"+B(KillRequested)+",\"killAccepted\":"+B(KillAccepted)+",\"readersDone\":"+B(ReadersDone)+",\"handlesClosed\":"+B(HandlesClosed)+
        ",\"cleanupConfirmed\":"+B(Cleanup)+",\"stdoutBytes\":"+OutBytes+",\"stderrBytes\":"+ErrBytes+",\"stdoutBase64\":\""+Stdout+"\",\"elapsedMs\":"+Elapsed+",\"accountingLayoutVerified\":"+B(AccountingLayoutVerified)+",\"observation\":"+(Observer==null?"null":Observer.Json())+"}";
    }
    static string B(bool v) { return v ? "true" : "false"; }
  }

  static bool Close(ref IntPtr h, Receipt r) {
    if(h==IntPtr.Zero || h==Invalid) {h=IntPtr.Zero; return true;}
    bool ok=false;
    try {ok=Hook.CloseHandle(h);} catch {ok=false;} finally {h=IntPtr.Zero;}
    if(!ok)r.HandlesClosed=false;
    return ok;
  }

  sealed class Output {
    public long Stdout, Stderr; public bool OutDone, ErrDone; public string Failure;
    public readonly MemoryStream Bytes = new MemoryStream(); public readonly object Sync = new object();
    public void Read(IntPtr handle, bool error) {
      try {
        byte[] buffer = new byte[4096];
        while (true) {
          uint count; bool ok = Hook.ReadChunk(handle, buffer, out count);
          if (!ok) { if (Hook.LastError()==109) break; throw new InvalidOperationException(); }
          if (count==0) break;
          lock (Sync) {
            if (error) Stderr += count; else Stdout += count;
            if (Stdout+Stderr>Limit) Failure="OUTPUT_LIMIT";
            else if (error) Failure="STDERR";
            if (!error && Failure==null) Bytes.Write(buffer,0,(int)count);
          }
          Array.Clear(buffer,0,buffer.Length);
        }
      } catch { lock(Sync) { if(Failure==null) Failure="READ"; } }
      finally { lock(Sync) { if(error) ErrDone=true; else OutDone=true; } }
    }
  }

  static Receipt RunSynthetic(int scenario) {
    Receipt r=new Receipt();r.Mode="rootOnly";Output output=new Output();var clock=Hook.Clock();
    IntPtr job=IntPtr.Zero, rd=IntPtr.Zero, wr=IntPtr.Zero, er=IntPtr.Zero, ew=IntPtr.Zero, input=IntPtr.Zero, env=IntPtr.Zero;
    ProcessInfo pi=new ProcessInfo(); object outThread=null,errThread=null;
    object nodeHold=null;
    try {
      string[] args=Hook.Arguments();nodeHold=Hook.Hold(scenario);
      r.AccountingLayoutVerified=Hook.RuntimeFact("OBS_LAYOUT");
      job=Hook.JobCreate();Require(job!=IntPtr.Zero,"JOB_CREATE");
      ExtendedLimit limits=new ExtendedLimit();limits.Basic.Flags=KillOnClose;
      Require(Hook.JobSet(limits),"JOB_SET");
      ExtendedLimit actual;Require(Hook.JobLimits(out actual)&&actual.Basic.Flags==KillOnClose,"JOB_LIMITS");
      r.Observer=new L2MemberObserver();Require(r.Observer.Failure=="NONE","OBS_FAILURE");
      Hook.PipeFactoryInit();
      Require(Hook.Pipe(out rd,out wr),"PIPE");
      Require(Hook.Pipe(out er,out ew),"PIPE");
      input=Hook.StdIn();Require(input!=Invalid,"STDIN");
      string app=Node;StringBuilder command=new StringBuilder(Quote(app));foreach(string s in args)command.Append(' ').Append(Quote(s));
      Startup si=new Startup();si.Size=Hook.StructSize();si.Flags=0x100;si.Input=input;si.Output=wr;si.Error=ew;
      env=Hook.EnvironmentBlock();Require(Hook.CreateProcess(app,command,env,Root,ref si,out pi),"CREATE");
      r.Created=true;r.Pid=pi.Pid;
      Require(Hook.JobAssign(job,pi.Process),"JOB_ASSIGN");r.Assigned=true;
      r.Observer.Root(pi.Pid,pi.Process);
      Require(Close(ref wr,r)&Close(ref ew,r)&Close(ref input,r),"HANDLE_CLOSE");
      outThread=Hook.StartReader(output,rd,false);
      errThread=Hook.StartReader(output,er,true);
      Require(Hook.Resume()==1,"RESUME");r.Resumed=true;
      int budget=Hook.Budget();
      while(true) {
        r.Observer.Poll();Require(r.Observer.Failure=="NONE","OBS_FAILURE");
        Hook.Account(r);Require(r.Total<=16,"OBS_MEMBER_LIMIT");uint wait=Hook.Wait();Require(wait==WaitObject||wait==WaitTimeout,"WAIT");
        if(wait==WaitObject) {r.RootExited=true;Require(Hook.ExitCode(pi.Process,out r.RootExit),"EXIT_CODE");}
        lock(output.Sync) {if(output.Failure!=null)throw new InvalidOperationException(output.Failure);r.ReadersDone=output.OutDone&&output.ErrDone;}
        if(r.RootExited && r.JobEmpty && r.ReadersDone)break;
        if(Hook.ElapsedMs(clock)>=budget)throw new InvalidOperationException("TIMEOUT");
        Hook.SleepTick();
      }
      Require(r.RootExit==0,"ROOT_EXIT");Require(r.Total==1,"TREE_COUNT");
      r.Outcome="completed";
    } catch(InvalidOperationException e) {r.Reason=Allowed(e.Message)?e.Message:"HELPER_ERROR";}
      catch {r.Reason="HELPER_ERROR";}
    finally {
      if(r.Created && (!r.RootExited || !r.JobEmpty || r.Reason!="NONE")) {
        r.KillRequested=true;r.KillAccepted=r.Assigned?Hook.TerminateJob(job,9009):Hook.TerminateProc(pi.Process,9009);
      }
      var reap=Hook.Clock();
      while(Hook.ElapsedMs(reap)<2000) {
        try {if(job!=IntPtr.Zero)Hook.Account(r);else r.JobEmpty=!r.Created;
          if(r.Created && Hook.Wait()==WaitObject){r.RootExited=Hook.ExitCode(pi.Process,out r.RootExit);}
        } catch {r.JobEmpty=false;}
        lock(output.Sync){r.ReadersDone=(outThread==null||output.OutDone)&&(errThread==null||output.ErrDone);}
        if((!r.Created||r.RootExited)&&r.JobEmpty&&r.ReadersDone)break;Hook.SleepTick();
      }
      if(outThread!=null)r.ReadersDone=Hook.Join(outThread,100)&&r.ReadersDone;
      if(errThread!=null)r.ReadersDone=Hook.Join(errThread,100)&&r.ReadersDone;
      lock(output.Sync) {r.OutBytes=output.Stdout;r.ErrBytes=output.Stderr;if(r.Reason=="NONE"&&output.Failure!=null)r.Reason=output.Failure;
        if(r.Reason=="NONE")r.Stdout=Convert.ToBase64String(output.Bytes.ToArray());output.Bytes.Dispose();}
      if(r.Observer!=null)r.Observer.Stop(r.Total);
      r.HandlesClosed=(Close(ref pi.Thread,r)&Close(ref pi.Process,r)&Close(ref rd,r)&Close(ref wr,r)&Close(ref er,r)&Close(ref ew,r)&Close(ref input,r)&Close(ref job,r))&&r.HandlesClosed;
      if(env!=IntPtr.Zero)Hook.EnvFree(env);
      try {if(nodeHold!=null)Hook.HoldDispose(nodeHold);}catch{r.HandlesClosed=false;}
      r.Elapsed=Hook.ElapsedMs(clock);
      if(r.Observer!=null && r.Observer.Failure!="NONE" && r.Reason=="NONE")r.Reason="OBS_FAILURE";
      if(r.Reason!="NONE"||!r.Cleanup){r.Outcome="failed";r.Stdout="";}
    }
    return r;
  }

  // ── Fixed Hook double: numbered sites, per-scenario failure table, real accounting ──
  internal static readonly string[] SCEN=new string[]{"NONE","SOURCE_HASH","SOURCE_LINK","JOB_CREATE","JOB_SET","JOB_LIMITS","OBS_FAILURE","PIPE","STDIN","CREATE","JOB_ASSIGN","HANDLE_CLOSE","RESUME","OBS_MEMBER_LIMIT","STDERR","OUTPUT_LIMIT","TIMEOUT","ROOT_EXIT","TREE_COUNT","READ"};
  static readonly int[] KillExpect=new int[]{0,0,0,0,0,0,0,0,0,0,2,1,1,1,1,1,1,1,1,1};
  static readonly int[] JoinExpect=new int[]{2,0,0,0,0,0,0,0,0,0,0,0,2,2,2,2,2,2,2,2};
  static readonly int[] HoldDisposeExpect=new int[]{1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1};
  static readonly int[] EnvFreeExpect=new int[]{0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1};
  internal static class Hook {
    // Note sites: 0=Hold 1=JobCreate 2=JobSet 3=JobLimits 4=Pipe 5=StdIn 6=CreateProcess
    // 7=Resume 8=Account 9=Wait 10=ExitCode 11=HoldDispose 12=JobAssign 13=TerminateJob
    // 14=TerminateProc 15=CloseHandle 16=Join 17=EnvFree 18=StartReader 100=ReadChunk
    public static List<long> Calls=new List<long>();
    public static int Unexpected;
    static string FailAt="NONE";
    static Queue<int> ReadPlan=new Queue<int>();
    static Queue<uint> WaitPlan=new Queue<uint>();
    static int LastWin;
    static long Tick;
    static bool JobCreated;
    static uint lastWait=WaitTimeout;
    static void Note(long site){Calls.Add(site);}
    static bool Want(string c){return FailAt==c;}
    // One place resets ALL mutable scenario state (clock/queues/counters included).
    internal static void PrepareScenario(int n){
      FailAt=SCEN[n];Calls.Clear();Unexpected=0;ReadPlan=new Queue<int>();WaitPlan=new Queue<uint>();
      LastWin=0;Tick=0;JobCreated=false;lastWait=WaitTimeout;
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
    public static IntPtr JobCreate(){Note(1);if(Want("JOB_CREATE"))return IntPtr.Zero;JobCreated=true;return new IntPtr(20);}
    public static bool JobSet(ExtendedLimit l){Note(2);if(!JobCreated)Unexpected++;return !Want("JOB_SET");}
    public static bool JobLimits(out ExtendedLimit actual){Note(3);actual=new ExtendedLimit();actual.Basic.Flags=KillOnClose;return !Want("JOB_LIMITS");}
    public static void PipeFactoryInit(){}
    public static bool Pipe(out IntPtr r,out IntPtr w){Note(4);r=new IntPtr(30);w=new IntPtr(40);return !Want("PIPE");}
    public static IntPtr StdIn(){Note(5);return Want("STDIN")?Invalid:new IntPtr(50);}
    public static int StructSize(){return 104;}
    public static IntPtr EnvironmentBlock(){return new IntPtr(70);}
    public static bool CreateProcess(string app,StringBuilder command,IntPtr env,string cwd,ref Startup si,out ProcessInfo pi){
      Note(6);pi=new ProcessInfo();
      if(Want("CREATE"))return false;
      pi.Pid=100;pi.Process=new IntPtr(60);pi.Thread=new IntPtr(61);return true;}
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
    public static bool CloseHandle(IntPtr h){Note(15);return !Want("HANDLE_CLOSE");}
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
    // Real finalization assertions over the recorded call list: kill routing,
    // reader joins, hold disposal, env release, and no unexpected hook contract
    // violation. Derived from the real finally condition, not hard-coded outcomes.
    internal static bool FinalizationOk(int n){
      if(Unexpected!=0)return false;
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
        // success ordering: resume before first wait; no kill; hold disposed after create
        int resume=Calls.IndexOf(7);int wait=Calls.IndexOf(9);int create=Calls.IndexOf(1);
        int holdD=Calls.IndexOf(11);
        if(resume<0||wait<0||create<0||holdD<0)return false;
        if(!(create<resume&&resume<wait))return false;
      }
      return true;
    }
  }
  static string Q(string s){return "\""+s+"\"";}
  static string J(string k,string v){return Q(k)+":"+v;}
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
}