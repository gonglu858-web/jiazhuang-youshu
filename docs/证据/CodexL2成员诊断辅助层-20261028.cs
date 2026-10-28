// Preparation source only. Not compiled or executed in this delivery.
// Framework 4.x console executable; fixed modes, no caller program/arguments.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal static class L2MemberRunner {
  const string Root = @"C:\Users\30591\Documents\ChatGPT\装修进度验收APP";
  const string Node = @"C:\Users\30591\.agent-reach\tools\node-v22.16.0-win-x64\node.exe";
  const string NodeHash = "c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19";
  const int Limit = 131072;
  const uint KillOnClose = 0x2000, Suspended = 4, UnicodeEnvironment = 0x400, NoWindow = 0x08000000;
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
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags; public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit value, uint size);
  [DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject", SetLastError=true)] static extern bool QueryLimits(IntPtr job, int kind, out ExtendedLimit value, uint size, IntPtr returned);
  [DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject", SetLastError=true)] static extern bool QueryAccounting(IntPtr job, int kind, out Accounting value, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security attrs, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref Security attrs, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr handle, byte[] buffer, uint size, out uint read, IntPtr overlapped);

  static void Require(bool ok, string code) { if (!ok) throw new InvalidOperationException(code); }
  // Complete Windows CRT quoting; empty values and trailing slashes are preserved.
  static string Quote(string value) {
    StringBuilder b = new StringBuilder("\""); int slash = 0;
    foreach (char c in value) {
      if (c == '\\') { slash++; continue; }
      b.Append('\\', c == '"' ? slash * 2 + 1 : slash); b.Append(c); slash = 0;
    }
    b.Append('\\', slash * 2); b.Append('"'); return b.ToString();
  }
  static void Chain(string file) {
    Require(File.Exists(file), "SOURCE_MISSING");
    for (string p = file; p != null; p = Path.GetDirectoryName(p))
      Require((File.GetAttributes(p) & FileAttributes.ReparsePoint) == 0, "SOURCE_LINK");
  }
  static FileStream Hold(string file, string expected) {
    Chain(file); FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
    try {
      using (SHA256 sha = SHA256.Create()) {
        string actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        Require(actual == expected, "SOURCE_HASH");
      }
      return stream;
    } catch { stream.Dispose(); throw; }
  }
  static string[] Arguments(string mode) {
    if (mode == "normal") return new string[] { "-e", "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},100)'],{stdio:'ignore',windowsHide:true,shell:false});c.on('error',()=>process.exit(3));c.on('exit',n=>{if(n!==0)process.exit(3);process.stdout.write('L2_NORMAL');});" };
    throw new InvalidOperationException("MODE");
  }

  static IntPtr EnvironmentBlock() {
    SortedDictionary<string,string> values = new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    foreach (DictionaryEntry e in Environment.GetEnvironmentVariables())
      if (!String.Equals((string)e.Key,"NODE_OPTIONS",StringComparison.OrdinalIgnoreCase)) values[(string)e.Key]=(string)e.Value;
    StringBuilder b = new StringBuilder(); foreach (KeyValuePair<string,string> e in values) b.Append(e.Key).Append('=').Append(e.Value).Append('\0');
    b.Append('\0'); return Marshal.StringToHGlobalUni(b.ToString());
  }
  sealed class Output {
    public long Stdout, Stderr; public bool OutDone, ErrDone; public string Failure;
    public readonly MemoryStream Bytes = new MemoryStream(); public readonly object Sync = new object();
    public void Read(IntPtr handle, bool error) {
      try {
        byte[] buffer = new byte[4096];
        while (true) {
          uint count; bool ok = ReadFile(handle, buffer, (uint)buffer.Length, out count, IntPtr.Zero);
          if (!ok) { if (Marshal.GetLastWin32Error()==109) break; throw new InvalidOperationException(); }
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
  sealed class Receipt {
    public string Mode, Reason="NONE", Outcome="failed", Stdout="";
    public L2MemberObserver Observer;
    public bool AccountingLayoutVerified;
    public bool Created, Assigned, Resumed, RootExited, JobEmpty, KillRequested, KillAccepted, ReadersDone, HandlesClosed=true;
    public uint Pid, Total, Active, RootExit=259; public long OutBytes, ErrBytes, Elapsed;
    public bool Cleanup { get { return (!Created || RootExited) && JobEmpty && ReadersDone && HandlesClosed && (Observer==null || Observer.HandlesClosed); } }
    public string Json() {
      return "{\"schema\":\"codex-l2-member-job/1\",\"mode\":\""+Mode+"\",\"outcome\":\""+Outcome+"\",\"reason\":\""+Reason+"\","+
        "\"created\":"+B(Created)+",\"assigned\":"+B(Assigned)+",\"resumed\":"+B(Resumed)+",\"pid\":"+Pid+
        ",\"rootExited\":"+B(RootExited)+",\"rootExit\":"+RootExit+",\"jobEmpty\":"+B(JobEmpty)+",\"totalProcesses\":"+Total+",\"activeProcesses\":"+Active+
        ",\"killRequested\":"+B(KillRequested)+",\"killAccepted\":"+B(KillAccepted)+",\"readersDone\":"+B(ReadersDone)+",\"handlesClosed\":"+B(HandlesClosed)+
        ",\"cleanupConfirmed\":"+B(Cleanup)+",\"stdoutBytes\":"+OutBytes+",\"stderrBytes\":"+ErrBytes+",\"stdoutBase64\":\""+Stdout+"\",\"elapsedMs\":"+Elapsed+",\"accountingLayoutVerified\":"+B(AccountingLayoutVerified)+",\"observation\":"+(Observer==null?"null":Observer.Json())+"}";
    }
    static string B(bool v) { return v ? "true" : "false"; }
  }
  static bool Close(ref IntPtr h) { if(h==IntPtr.Zero || h==Invalid) {h=IntPtr.Zero; return true;} bool ok=CloseHandle(h);h=IntPtr.Zero;return ok; }
  static void Account(IntPtr job, Receipt r) {
    Accounting a; Require(QueryAccounting(job,1,out a,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"JOB_QUERY");
    r.Active=a.Active;r.Total=a.Total;r.JobEmpty=a.Active==0;
  }
  // SDK winnt.h: 4 LARGE_INTEGER then 4 DWORD; x64 size 48.
  // Runtime Marshal probe, not executed during source preparation.
  static void VerifyAccountingLayout() {
    Require(IntPtr.Size==8 && Marshal.SizeOf(typeof(Accounting))==48,"OBS_LAYOUT");
    string[] names={"User","Kernel","PeriodUser","PeriodKernel","Faults","Total","Active","Terminated"};
    int[] offsets={0,8,16,24,32,36,40,44};
    for(int i=0;i<names.Length;i++)Require(Marshal.OffsetOf(typeof(Accounting),names[i]).ToInt32()==offsets[i],"OBS_LAYOUT");
    IntPtr b=Marshal.AllocHGlobal(48);
    try {for(int i=0;i<48;i++)Marshal.WriteByte(b,i,0);
      Marshal.WriteInt64(b,0,11);Marshal.WriteInt64(b,8,22);Marshal.WriteInt64(b,16,33);Marshal.WriteInt64(b,24,44);
      Marshal.WriteInt32(b,32,55);Marshal.WriteInt32(b,36,4);Marshal.WriteInt32(b,40,0);Marshal.WriteInt32(b,44,2);
      Accounting a=(Accounting)Marshal.PtrToStructure(b,typeof(Accounting));
      Require(a.User==11&&a.Kernel==22&&a.PeriodUser==33&&a.PeriodKernel==44&&a.Faults==55&&a.Total==4&&a.Active==0&&a.Terminated==2,"OBS_LAYOUT");
    }finally{Marshal.FreeHGlobal(b);}
  }
  static Receipt Run(string mode) {
    Receipt r=new Receipt();r.Mode=mode;Output output=new Output();Stopwatch clock=Stopwatch.StartNew();
    IntPtr job=IntPtr.Zero, rd=IntPtr.Zero, wr=IntPtr.Zero, er=IntPtr.Zero, ew=IntPtr.Zero, input=IntPtr.Zero, env=IntPtr.Zero;
    ProcessInfo pi=new ProcessInfo(); Thread outThread=null,errThread=null;
    FileStream nodeHold=null;
    try {
      string[] args=Arguments(mode);nodeHold=Hold(Node,NodeHash);
      VerifyAccountingLayout();r.AccountingLayoutVerified=true;
      job=CreateJobObjectW(IntPtr.Zero,null);Require(job!=IntPtr.Zero,"JOB_CREATE");
      ExtendedLimit limits=new ExtendedLimit();limits.Basic.Flags=KillOnClose;
      Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit))),"JOB_SET");
      ExtendedLimit actual;Require(QueryLimits(job,9,out actual,(uint)Marshal.SizeOf(typeof(ExtendedLimit)),IntPtr.Zero)&&actual.Basic.Flags==KillOnClose,"JOB_LIMITS");
      r.Observer=new L2MemberObserver(job);Require(r.Observer.Failure=="NONE","OBS_FAILURE");
      Security sa=new Security();sa.Length=Marshal.SizeOf(typeof(Security));sa.Inherit=1;
      Require(CreatePipe(out rd,out wr,ref sa,0),"PIPE");Require(SetHandleInformation(rd,1,0),"PIPE");
      Require(CreatePipe(out er,out ew,ref sa,0),"PIPE");Require(SetHandleInformation(er,1,0),"PIPE");
      input=CreateFileW("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero);Require(input!=Invalid,"STDIN");
      string app=Node;StringBuilder command=new StringBuilder(Quote(app));foreach(string s in args)command.Append(' ').Append(Quote(s));
      Startup si=new Startup();si.Size=Marshal.SizeOf(typeof(Startup));si.Flags=0x100;si.Input=input;si.Output=wr;si.Error=ew;
      env=EnvironmentBlock();Require(CreateProcessW(app,command,IntPtr.Zero,IntPtr.Zero,true,Suspended|NoWindow|UnicodeEnvironment,env,Root,ref si,out pi),"CREATE");
      r.Created=true;r.Pid=pi.Pid;
      Require(AssignProcessToJobObject(job,pi.Process),"JOB_ASSIGN");r.Assigned=true;
      r.Observer.Root(pi.Pid,pi.Process);
      Require(Close(ref wr)&Close(ref ew)&Close(ref input),"HANDLE_CLOSE");
      outThread=new Thread(delegate(){output.Read(rd,false);});outThread.IsBackground=true;outThread.Start();
      errThread=new Thread(delegate(){output.Read(er,true);});errThread.IsBackground=true;errThread.Start();
      Require(ResumeThread(pi.Thread)==1,"RESUME");r.Resumed=true;
      int budget=5000;
      while(true) {
        r.Observer.Poll();Require(r.Observer.Failure=="NONE","OBS_FAILURE");
        Account(job,r);Require(r.Total<=16,"OBS_MEMBER_LIMIT");uint wait=WaitForSingleObject(pi.Process,0);Require(wait==WaitObject||wait==WaitTimeout,"WAIT");
        if(wait==WaitObject) {r.RootExited=true;Require(GetExitCodeProcess(pi.Process,out r.RootExit),"EXIT_CODE");}
        lock(output.Sync) {if(output.Failure!=null)throw new InvalidOperationException(output.Failure);r.ReadersDone=output.OutDone&&output.ErrDone;}
        if(r.RootExited && r.JobEmpty && r.ReadersDone)break;
        if(clock.ElapsedMilliseconds>=budget)throw new InvalidOperationException("TIMEOUT");
        Thread.Sleep(10);
      }
      Require(r.RootExit==0,"ROOT_EXIT");Require(r.Total==2,"TREE_COUNT");
      r.Outcome="completed";
    } catch(InvalidOperationException e) {r.Reason=Allowed(e.Message)?e.Message:"HELPER_ERROR";}
      catch {r.Reason="HELPER_ERROR";}
    finally {
      if(r.Created && (!r.RootExited || !r.JobEmpty || r.Reason!="NONE")) {
        r.KillRequested=true;r.KillAccepted=r.Assigned?TerminateJobObject(job,9009):TerminateProcess(pi.Process,9009);
      }
      Stopwatch reap=Stopwatch.StartNew();
      while(reap.ElapsedMilliseconds<2000) {
        try {if(job!=IntPtr.Zero)Account(job,r);else r.JobEmpty=!r.Created;
          if(r.Created && WaitForSingleObject(pi.Process,0)==WaitObject){r.RootExited=GetExitCodeProcess(pi.Process,out r.RootExit);}
        } catch {r.JobEmpty=false;}
        lock(output.Sync){r.ReadersDone=(outThread==null||output.OutDone)&&(errThread==null||output.ErrDone);}
        if((!r.Created||r.RootExited)&&r.JobEmpty&&r.ReadersDone)break;Thread.Sleep(10);
      }
      if(outThread!=null)r.ReadersDone=outThread.Join(100)&&r.ReadersDone;
      if(errThread!=null)r.ReadersDone=errThread.Join(100)&&r.ReadersDone;
      lock(output.Sync) {r.OutBytes=output.Stdout;r.ErrBytes=output.Stderr;if(r.Reason=="NONE"&&output.Failure!=null)r.Reason=output.Failure;
        if(r.Reason=="NONE")r.Stdout=Convert.ToBase64String(output.Bytes.ToArray());output.Bytes.Dispose();}
      if(r.Observer!=null)r.Observer.Stop(r.Total);
      r.HandlesClosed=Close(ref pi.Thread)&Close(ref pi.Process)&Close(ref rd)&Close(ref wr)&Close(ref er)&Close(ref ew)&Close(ref input)&Close(ref job);
      if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);
      try {if(nodeHold!=null)nodeHold.Dispose();}catch{r.HandlesClosed=false;}
      r.Elapsed=clock.ElapsedMilliseconds;
      if(r.Observer!=null && r.Observer.Failure!="NONE" && r.Reason=="NONE")r.Reason="OBS_FAILURE";
      if(r.Reason!="NONE"||!r.Cleanup)r.Outcome="failed";
    }
    return r;
  }
  static bool Allowed(string s) {return Array.IndexOf(new string[]{"MODE","SOURCE_MISSING","SOURCE_LINK","SOURCE_HASH","JOB_CREATE","JOB_SET","JOB_LIMITS","PIPE","STDIN","CREATE","JOB_ASSIGN","HANDLE_CLOSE","RESUME","JOB_QUERY","WAIT","EXIT_CODE","OUTPUT_LIMIT","STDERR","READ","TIMEOUT","ROOT_EXIT","TREE_COUNT","TIMEOUT_NOT_REACHED","OBS_LAYOUT","OBS_PORT","OBS_FAILURE","OBS_MEMBER_LIMIT"},s)>=0;}
  public static int Main(string[] args) {
    if(args.Length!=1 || args[0]!="normal"){Console.WriteLine("{\"error\":\"MODE\"}");return 1;}
    Receipt r=Run(args[0]);Console.WriteLine(r.Json());return r.Outcome=="completed"?0:1;
  }
}
