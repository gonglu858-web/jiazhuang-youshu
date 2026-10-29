// Preparation only. This file and the transformed observer are the ONLY proposed inputs.
// No real process handle, file, network or native entry is used by these fixtures.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

internal sealed partial class L2MemberObserver {
  sealed class Step {
    public string Name; public long Handle; public bool Ok=true, Flag=true, Throws;
    public uint Number, Count, Returned=8; public long Pid; public long[] Ids=new long[0];
    public ulong Time=123; public string Text=Node;
    public Step(string name,long handle) {Name=name;Handle=handle;}
  }
  static class SyntheticBoundary {
    internal static readonly Queue<Step> Steps=new Queue<Step>();
    internal static readonly List<string> Calls=new List<string>();
    internal static int Unexpected;
    internal static Step Take(string name,long handle) {
      Calls.Add(name+":"+handle);
      if(Steps.Count==0){Unexpected++;throw new InvalidOperationException("UNEXPECTED_CALL");}
      Step s=Steps.Dequeue();
      if(s.Name!=name||s.Handle!=handle){Unexpected++;throw new InvalidOperationException("CALL_MISMATCH");}
      if(s.Throws)throw new InvalidOperationException("SYNTHETIC_FAILURE");
      return s;
    }
    internal static void Need(bool value){if(!value){Unexpected++;throw new InvalidOperationException("ARGUMENT_MISMATCH");}}
    internal static IntPtr CreateIoCompletionPort(IntPtr file,IntPtr existing,UIntPtr key,uint threads){
      Need(file.ToInt64()==-1&&existing==IntPtr.Zero&&key==UIntPtr.Zero&&threads==1);
      return Take("port",0).Ok?new IntPtr(900):IntPtr.Zero;
    }
    internal static bool Associate(IntPtr job,int kind,ref Association value,uint size){
      Need(job.ToInt64()==800&&kind==7&&value.Key.ToInt64()==1&&value.Port.ToInt64()==900&&size==16);
      return Take("associate",800).Ok;
    }
    internal static bool GetQueuedCompletionStatus(IntPtr port,out uint message,out UIntPtr key,out IntPtr pid,uint wait){
      Need(port.ToInt64()==900&&wait==0);Step s=Take("queue",900);
      message=s.Number;key=new UIntPtr(s.Flag?1u:2u);pid=new IntPtr(s.Pid);return s.Ok;
    }
    internal static int LastError(){return (int)Take("error",0).Number;}
    internal static bool QueryIds(IntPtr job,int kind,IntPtr data,uint size,out uint returned){
      Need(job.ToInt64()==800&&kind==3&&data!=IntPtr.Zero&&size==136);
      Step s=Take("census",800);returned=s.Returned;
      // Only writes the buffer allocated by the real observer for this call.
      Need(s.Ids.Length<=16);Marshal.WriteInt32(data,0,(int)s.Number);Marshal.WriteInt32(data,4,(int)s.Count);
      for(int i=0;i<s.Ids.Length;i++)Marshal.WriteInt64(data,8+i*8,s.Ids[i]);return s.Ok;
    }
    internal static IntPtr OpenProcess(uint access,bool inherit,uint pid){
      Need(access==0x101000&&!inherit&&pid==101);return Take("open",101).Ok?new IntPtr(501):IntPtr.Zero;
    }
    internal static bool IsProcessInJob(IntPtr process,IntPtr job,out bool result){
      Need(job.ToInt64()==800);Step s=Take("job",process.ToInt64());result=s.Flag;return s.Ok;
    }
    internal static bool GetProcessTimes(IntPtr process,out FileTime created,out FileTime exited,out FileTime kernel,out FileTime user){
      Step s=Take("time",process.ToInt64());created=new FileTime();created.Low=(uint)s.Time;created.High=(uint)(s.Time>>32);
      exited=new FileTime();kernel=new FileTime();user=new FileTime();return s.Ok;
    }
    internal static bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder path,ref uint size){
      Need(flags==0&&size==32768&&path.Capacity==32768);Step s=Take("image",process.ToInt64());
      path.Append(s.Text);size=s.Number;return s.Ok;
    }
    internal static uint WaitForSingleObject(IntPtr process,uint milliseconds){Need(milliseconds==0);return Take("wait",process.ToInt64()).Number;}
    internal static bool CloseHandle(IntPtr handle){return Take("close",handle.ToInt64()).Ok;}
  }
  static Step Add(string name,long handle){Step s=new Step(name,handle);SyntheticBoundary.Steps.Enqueue(s);return s;}
  static void Assert(bool v){if(!v)throw new InvalidOperationException("ASSERTION");}
  static void Reset(){Assert(SyntheticBoundary.Steps.Count==0);SyntheticBoundary.Calls.Clear();SyntheticBoundary.Unexpected=0;}
  static void EmptyPoll(){Add("queue",900).Ok=false;Add("error",0).Number=258;Add("census",800);}
  static L2MemberObserver NewObserver(){Add("port",0);Add("associate",800);return new L2MemberObserver(new IntPtr(800));}
  // Fixed capture faults stop the expected call script at the exact failed boundary.
  static string CaptureScript(int fault,long h){
    Step s=Add("job",h);if(fault==1){s.Ok=false;return "MEMBERSHIP_UNKNOWN";}if(fault==2){s.Flag=false;return "MEMBERSHIP_UNKNOWN";}
    s=Add("wait",h);s.Number=258;if(fault==3){s.Number=0;return "EXITED_BEFORE_CAPTURE";}
    s=Add("time",h);if(fault==4){s.Ok=false;return "TIME_UNKNOWN";}if(fault==5){s.Time=0;return "TIME_UNKNOWN";}
    s=Add("image",h);s.Number=(uint)Node.Length;
    if(fault==6){s.Ok=false;return "IMAGE_UNKNOWN";}if(fault==7){s.Number=0;return "IMAGE_UNKNOWN";}if(fault==8){s.Number=32768;return "IMAGE_UNKNOWN";}
    s=Add("time",h);if(fault==9){s.Time=124;return "IDENTITY_CHANGED";}if(fault==10){s.Ok=false;return "IDENTITY_CHANGED";}
    s=Add("job",h);if(fault==11){s.Flag=false;return "IDENTITY_CHANGED";}if(fault==12){s.Ok=false;return "IDENTITY_CHANGED";}
    return "CAPTURED";
  }
  static void FinalMember(long h,bool captured){Add("time",h);if(captured){Add("job",h);Add("wait",h).Number=0;}}
  static void CaptureCase(int fault,bool owned){
    Reset();L2MemberObserver o=NewObserver();long h=owned?501:500;
    if(owned){Step evt=Add("queue",900);evt.Number=6;evt.Pid=101;Add("open",101);}
    string expected=CaptureScript(fault,h);
    if(owned){EmptyPoll();o.Poll();}else{o.Root(101,new IntPtr(h));}
    Assert(o.members[101].State==expected);int before=SyntheticBoundary.Calls.Count;
    o.Root(101,new IntPtr(h));Assert(SyntheticBoundary.Calls.Count==before); // no re-capture
    EmptyPoll();FinalMember(h,fault==0);if(owned)Add("close",h);Add("close",900);
    o.Stop(1);Assert(o.IdentityCoverage==(fault==0));Assert(o.HandlesClosed&&o.stopped&&o.Failure=="NONE");
    string json=o.Json();Assert(json.IndexOf(Node,StringComparison.Ordinal)<0&&json.Contains("\"parent\":\"UNKNOWN\"")&&json.Contains("\"parentEvidenceComplete\":false"));
    before=SyntheticBoundary.Calls.Count;o.Stop(1);o.Poll();Assert(before==SyntheticBoundary.Calls.Count);
    Assert(SyntheticBoundary.Steps.Count==0&&SyntheticBoundary.Unexpected==0);
  }
  static void Classification(){
    string con=@"C:\Windows\System32\conhost.exe";
    Assert(ClassifyPath(Node)=="FIXED_NODE_PATH"&&ClassifyPath(Node.ToUpperInvariant())=="FIXED_NODE_PATH");
    Assert(ClassifyPath(con)=="WINDOWS_CONHOST_PATH_CANDIDATE"&&ClassifyPath(con.ToUpperInvariant())=="WINDOWS_CONHOST_PATH_CANDIDATE");
    foreach(string p in new string[]{null,"",con+" ",con+"x","x"+con,"conhost.exe",@"D:\Windows\System32\conhost.exe",con.Replace('\\','/')})Assert(ClassifyPath(p)=="OTHER_PATH");
  }
  static void Done(){Assert(SyntheticBoundary.Steps.Count==0&&SyntheticBoundary.Unexpected==0);}
  static void QueueEnd(){Add("queue",900).Ok=false;Add("error",0).Number=258;}
  static void CensusFailure(int mode){
    Reset();L2MemberObserver o=NewObserver();QueueEnd();Step s=Add("census",800);string expected="OBS_CENSUS_SIZE";
    switch(mode){
      case 0:s.Ok=false;expected="OBS_CENSUS";break;
      case 1:s.Number=17;break;
      case 2:s.Count=17;break;
      case 3:s.Count=1;break;
      case 4:s.Number=1;s.Count=1;s.Returned=15;break;
      case 5:s.Returned=137;break;
      case 6:s.Number=1;s.Count=1;s.Returned=16;s.Ids=new long[]{0};expected="OBS_CENSUS_PID";break;
      case 7:s.Number=1;s.Count=1;s.Returned=16;s.Ids=new long[]{4294967296L};expected="OBS_CENSUS_PID";break;
      default:s.Throws=true;expected="OBS_QUERY_EXCEPTION";break;
    }
    o.Poll();Assert(o.Failure==expected);Add("close",900);o.Stop(0);Assert(!o.IdentityCoverage&&o.HandlesClosed);Done();
  }
  static void QueueFailure(int mode){
    Reset();L2MemberObserver o=NewObserver();Step s=Add("queue",900);string expected="OBS_PID";s.Number=6;
    switch(mode){
      case 0:s.Flag=false;expected="OBS_KEY";break;
      case 1:s.Number=99;expected="OBS_EVENT_TYPE";break;
      case 2:s.Pid=0;break;
      case 3:s.Pid=4294967296L;break;
      case 4:s.Ok=false;Add("error",0).Number=5;expected="OBS_QUEUE";break;
      default:s.Throws=true;expected="OBS_QUERY_EXCEPTION";break;
    }
    o.Poll();Assert(o.Failure==expected);Add("close",900);o.Stop(0);Assert(!o.IdentityCoverage&&o.HandlesClosed);Done();
  }
  static void FinalFailure(int mode){
    Reset();L2MemberObserver o=NewObserver();CaptureScript(0,500);o.Root(101,new IntPtr(500));EmptyPoll();
    Step t=Add("time",500);
    if(mode==0)t.Ok=false;
    else if(mode==1)t.Time=124;
    else if(mode==2)t.Throws=true;
    else {Step j=Add("job",500);if(mode==3)j.Flag=false;else if(mode==4)j.Ok=false;else Add("wait",500).Number=258;}
    Add("close",900);o.Stop(1);Assert(!o.IdentityCoverage&&o.HandlesClosed);Assert(o.Failure==(mode==2?"OBS_FINAL_QUERY":"NONE"));Done();
  }
  static void PortCases(int mode){
    Reset();Add("port",0);Step a=Add("associate",800);if(mode==0)a.Ok=false;else a.Throws=true;
    L2MemberObserver o=new L2MemberObserver(new IntPtr(800));Assert(o.Failure=="OBS_ASSOCIATE");
    Step c=Add("close",900);if(mode==2)c.Ok=false;if(mode==3)c.Throws=true;
    o.Stop(0);Assert(o.HandlesClosed==(mode<2)&&!o.IdentityCoverage);Done();
  }
  static void ExitBeforeNew(){
    Reset();L2MemberObserver o=NewObserver();Step e=Add("queue",900);e.Number=7;e.Pid=101;
    e=Add("queue",900);e.Number=6;e.Pid=101;EmptyPoll();o.Poll();
    Assert(o.members[101].State=="EXIT_WITHOUT_IDENTITY");EmptyPoll();Add("close",900);o.Stop(1);
    Assert(!o.IdentityCoverage&&o.HandlesClosed);Done(); // no OpenProcess expected
  }
  static void Limits(int mode){
    Reset();L2MemberObserver o=NewObserver();
    if(mode==0){for(int i=0;i<129;i++)Add("queue",900).Number=4;o.Poll();Assert(o.Failure=="OBS_EVENT_LIMIT");}
    else {for(int i=0;i<17;i++){Step s=Add("queue",900);s.Number=7;s.Pid=101+i;}o.Poll();Assert(o.Failure=="OBS_MEMBER_LIMIT");}
    Add("close",900);o.Stop(17);Assert(!o.IdentityCoverage&&o.HandlesClosed);Done();
  }
  static void OwnedCases(int mode){
    Reset();L2MemberObserver o=NewObserver();Step s;
    if(mode==0){s=Add("queue",900);s.Number=6;s.Pid=101;Add("open",101).Ok=false;EmptyPoll();o.Poll();Assert(o.members[101].State=="UNAVAILABLE");EmptyPoll();Add("close",900);o.Stop(1);Assert(!o.IdentityCoverage);Done();return;}
    if(mode==1||mode==2){QueueEnd();s=Add("census",800);s.Number=mode==2?2u:1u;s.Count=s.Number;s.Returned=mode==2?24u:16u;s.Ids=mode==2?new long[]{101,101}:new long[]{101};}
    else {s=Add("queue",900);s.Number=6;s.Pid=101;}
    Add("open",101);CaptureScript(0,501);
    if(mode!=1&&mode!=2){
      if(mode==3){s=Add("queue",900);s.Number=6;s.Pid=101;}
      EmptyPoll();
    }
    o.Poll();if(mode==2)Assert(o.Failure=="OBS_CENSUS_PID");else EmptyPoll();
    FinalMember(501,true);s=Add("close",501);if(mode==4)s.Ok=false;if(mode==5)s.Throws=true;
    Add("close",900);o.Stop(mode==6?2u:1u);
    Assert(o.IdentityCoverage==(mode==1));Assert(o.HandlesClosed==(mode!=4&&mode!=5));
    if(mode==3)Assert(o.duplicateNew);Done();
  }
  static void RootException(){
    Reset();L2MemberObserver o=NewObserver();Add("job",500).Throws=true;bool threw=false;
    try{o.Root(101,new IntPtr(500));}catch(InvalidOperationException){threw=true;}
    Assert(threw);EmptyPoll();FinalMember(500,false);Add("close",900);o.Stop(1);Assert(!o.IdentityCoverage&&o.HandlesClosed);Done();
  }
  public static int SyntheticMain(string[] args){
    int completed=0;bool ok=false;
    try {Assert(args.Length==0);Classification();completed++;
      for(int i=0;i<=12;i++){CaptureCase(i,false);completed++;CaptureCase(i,true);completed++;}
      for(int i=0;i<9;i++){CensusFailure(i);completed++;}
      for(int i=0;i<6;i++){QueueFailure(i);completed++;FinalFailure(i);completed++;}
      for(int i=0;i<4;i++){PortCases(i);completed++;}ExitBeforeNew();completed++;
      for(int i=0;i<2;i++){Limits(i);completed++;}for(int i=0;i<7;i++){OwnedCases(i);completed++;}RootException();completed++;
      ok=SyntheticBoundary.Unexpected==0&&SyntheticBoundary.Steps.Count==0;
    }catch{ok=false;}
    Console.WriteLine("{\"schema\":\"codex-observer-synthetic-draft/1\",\"completed\":"+completed+",\"ok\":"+(ok?"true":"false")+",\"nativeExecuted\":false,\"l2Approved\":false}");
    return ok?0:1;
  }
}
internal static class L2ObserverSyntheticEntry {public static int Main(string[] args){return L2MemberObserver.SyntheticMain(args);}}
