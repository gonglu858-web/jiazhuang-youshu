// Uncompiled synthetic boundary fixture (R5). Prepared, NOT compiled or executed.
// Control-flow expressions are extracted byte-for-byte from the pinned helper v2
// (sha256 408d9108fff46b045bf19183d1488a53f02ca52f4e255fab987163df60124a7b); every OS-facing call is replaced by the fixed Hook double
// below. This is a prepared synthetic boundary, NOT a proof of C# execution.
using System;
using System.Collections.Generic;
using System.IO;
internal static class RootOnlyRunBoundaryFixture {
  const uint WaitObject = 0, WaitTimeout = 258;
  static IntPtr Invalid=new IntPtr(-1);
static void Require(bool ok, string code) { if (!ok) throw new InvalidOperationException(code); }
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
    try {ok=CloseHandle(h);} catch {ok=false;} finally {h=IntPtr.Zero;}
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
    Receipt r=new Receipt();r.Mode=mode;Output output=new Output();var clock=Hook.Clock();
    IntPtr job=IntPtr.Zero, rd=IntPtr.Zero, wr=IntPtr.Zero, er=IntPtr.Zero, ew=IntPtr.Zero, input=IntPtr.Zero, env=IntPtr.Zero;
    ProcessInfo pi=new ProcessInfo(); object outThread=null,errThread=null;
    object nodeHold=null;
    try {
      string[] args=Hook.Arguments();object nodeHold=Hook.Hold(scenario);
      r.AccountingLayoutVerified=Hook.RuntimeFact("OBS_LAYOUT");
      job=Hook.JobCreate();Require(job!=IntPtr.Zero,"JOB_CREATE");
      ExtendedLimit limits=new ExtendedLimit();limits.Basic.Flags=KillOnClose;
      Require(Hook.JobSet(),"JOB_SET");
      Require(Hook.JobLimits(),"JOB_LIMITS");
      r.Observer=new L2MemberObserver();Require(r.Observer.Failure=="NONE","OBS_FAILURE");
      Hook.PipeFactoryInit();
      Require(Hook.Pipe(out rd,out wr),"PIPE");
      Require(Hook.Pipe(out er,out ew),"PIPE");
      input=Hook.StdIn();Require(input!=Invalid,"STDIN");
      string app=Node;StringBuilder command=new StringBuilder(Quote(app));foreach(string s in args)command.Append(' ').Append(Quote(s));
      Startup si=new Startup();si.Size=Hook.StructSize();si.Flags=0x100;si.Input=input;si.Output=wr;si.Error=ew;
      env=Hook.Environment();Require(Hook.CreateProcess(ref pi),"CREATE");
      r.Created=true;r.Pid=pi.Pid;
      Require(AssignProcessToJobObject(job,pi.Process),"JOB_ASSIGN");r.Assigned=true;
      r.Observer.Root(pi.Pid,pi.Process);
      Require(Close(ref wr,r)&Close(ref ew,r)&Close(ref input,r),"HANDLE_CLOSE");
      outThread=Hook.StartReader(output,rd,false);
      errThread=Hook.StartReader(output,er,true);
      Require(Hook.Resume()==1,"RESUME");r.Resumed=true;
      int budget=Hook.Budget();
      while(true) {
        r.Observer.Poll();Require(r.Observer.Failure=="NONE","OBS_FAILURE");
        Hook.Account(r);Require(r.Total<=16,"OBS_MEMBER_LIMIT");uint wait=Hook.Wait();Require(wait==WaitObject||wait==WaitTimeout,"WAIT");
        if(wait==WaitObject) {r.RootExited=true;Require(Hook.ExitCode(out r.RootExit),"EXIT_CODE");}
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
        r.KillRequested=true;r.KillAccepted=r.Assigned?TerminateJobObject(job,9009):TerminateProcess(pi.Process,9009);
      }
      var reap=Hook.Clock();
      while(Hook.ElapsedMs(reap)<2000) {
        try {if(job!=IntPtr.Zero)Hook.Account(r);else r.JobEmpty=!r.Created;
          if(r.Created && Hook.Wait()==WaitObject){r.RootExited=Hook.ExitCode(out r.RootExit);}
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
      Hook.EnvFree(env);
      try {if(nodeHold!=null)Hook.HoldDispose(nodeHold);}catch{r.HandlesClosed=false;}
      r.Elapsed=Hook.ElapsedMs(clock);
      if(r.Observer!=null && r.Observer.Failure!="NONE" && r.Reason=="NONE")r.Reason="OBS_FAILURE";
      if(r.Reason!="NONE"||!r.Cleanup){r.Outcome="failed";r.Stdout="";}
    }
    return r;
  }

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
  static int MainGate(string[] args){if(args.Length!=1 || args[0]!="rootOnly"){Console.WriteLine("{\"error\":\"MODE\"}");return 1;}return -1;}
  public static int Main(string[] args){
    if(args.Length!=0)return 2;
    int passed=0;
    string expected="completed";
    if(MainGate(new string[]{"normal"})!=1){Console.WriteLine("{\"ok\":false,\"failedCase\":\"admission\",\"passed\":"+passed+"}");return 1;}
    passed++;
    for(int i=0;i<20;i++){
      switch(i){      case 0: expected="completed";break;
      case 1: expected="SOURCE_HASH";break;
      case 2: expected="SOURCE_LINK";break;
      case 3: expected="JOB_CREATE";break;
      case 4: expected="JOB_SET";break;
      case 5: expected="JOB_LIMITS";break;
      case 6: expected="OBS_FAILURE";break;
      case 7: expected="PIPE";break;
      case 8: expected="STDIN";break;
      case 9: expected="CREATE";break;
      case 10: expected="JOB_ASSIGN";break;
      case 11: expected="HANDLE_CLOSE";break;
      case 12: expected="RESUME";break;
      case 13: expected="OBS_MEMBER_LIMIT";break;
      case 14: expected="STDERR";break;
      case 15: expected="OUTPUT_LIMIT";break;
      case 16: expected="TIMEOUT";break;
      case 17: expected="ROOT_EXIT";break;
      case 18: expected="TREE_COUNT";break;
      case 19: expected="READ";break;
        default: Console.WriteLine("{\"ok\":false,\"failedCase\":" + i + ",\"passed\":" + passed + "}");return 1;}
      FailAt="NONE";
      switch(i){      case 0: Hook.PlanReads("null");break;
      case 1: Hook.PlanReads("SOURCE_HASH");break;
      case 2: Hook.PlanReads("SOURCE_LINK");break;
      case 3: Hook.PlanReads("JOB_CREATE");break;
      case 4: Hook.PlanReads("JOB_SET");break;
      case 5: Hook.PlanReads("JOB_LIMITS");break;
      case 6: Hook.PlanReads("OBS_FAILURE");break;
      case 7: Hook.PlanReads("PIPE");break;
      case 8: Hook.PlanReads("STDIN");break;
      case 9: Hook.PlanReads("CREATE");break;
      case 10: Hook.PlanReads("JOB_ASSIGN");break;
      case 11: Hook.PlanReads("HANDLE_CLOSE");break;
      case 12: Hook.PlanReads("RESUME");break;
      case 13: Hook.PlanReads("OBS_MEMBER_LIMIT");break;
      case 14: Hook.PlanReads("STDERR");break;
      case 15: Hook.PlanReads("OUTPUT_LIMIT");break;
      case 16: Hook.PlanReads("TIMEOUT");break;
      case 17: Hook.PlanReads("ROOT_EXIT");break;
      case 18: Hook.PlanReads("TREE_COUNT");break;
      case 19: Hook.PlanReads("READ");break;
        default: ReadPlan=new Queue<int>();ReadPlan.Enqueue(12);ReadPlan.Enqueue(0);ReadPlan.Enqueue(0);break;}
      Receipt r=null;
      try{r=RunSynthetic(i);}catch(Exception e){Console.WriteLine("{\"ok\":false,\"failedCase\":" + i + ",\"error\":\"" + e.Message + "\",\"passed\":" + passed + "}");return 1;}
      try{Require(r!=null&&r.Reason==expected);Require(expected!="completed"||r.Outcome=="completed");Require(expected=="completed"||r.Outcome=="failed");Require(Unexpected==0);passed++;}
      catch{Console.WriteLine("{\"ok\":false,\"failedCase\":" + i + ",\"expected\":\"" + expected + "\",\"reason\":\"" + (r==null?"null":r.Reason) + "\",\"passed\":" + passed + "}");return 1;}
    }
    Console.WriteLine("{\"ok\":true,\"passed\":" + passed + ",\"executedProductionHelper\":false}");
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
