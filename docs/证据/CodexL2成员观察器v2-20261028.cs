// Preparation only; not compiled or executed. SDK 10.0.26100.0 definitions in review.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

// No worker thread: sampled by the owning runner before/after its bounded waits.
// Notification loss/short-lived members are not repaired by global enumeration.
internal sealed class L2MemberObserver {
  const string Node = @"C:\Users\30591\.agent-reach\tools\node-v22.16.0-win-x64\node.exe";
  const int MemberLimit=16, EventLimit=128;
  readonly IntPtr job;
  IntPtr port;
  readonly Dictionary<uint,Member> members=new Dictionary<uint,Member>();
  readonly List<string> events=new List<string>();
  uint root;
  bool stopped, duplicateNew;
  public bool HandlesClosed=true;
  public string Failure="NONE";
  public bool IdentityCoverage;
  public uint FinalTotal;
  [StructLayout(LayoutKind.Sequential)] struct Association { public IntPtr Key, Port; }
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; public ulong Value { get { return ((ulong)High<<32)|Low; } } }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file,IntPtr existing,UIntPtr key,uint threads);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port,out uint message,out UIntPtr key,out IntPtr pid,uint wait);
  [DllImport("kernel32.dll",EntryPoint="SetInformationJobObject",SetLastError=true)] static extern bool Associate(IntPtr job,int kind,ref Association value,uint size);
  [DllImport("kernel32.dll",EntryPoint="QueryInformationJobObject",SetLastError=true)] static extern bool QueryIds(IntPtr job,int kind,IntPtr data,uint size,out uint returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FileTime created,out FileTime exited,out FileTime kernel,out FileTime user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder path,ref uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  sealed class Member {
    public uint Pid;
    public IntPtr Handle;
    public bool Owned, NewSeen, Listed, ExitSeen;
    public string Created=null, Image="UNKNOWN", State="UNKNOWN";
  }
  void Bad(string code) { if(Failure=="NONE")Failure=code; }
  public L2MemberObserver(IntPtr target) {
    job=target;
    if(IntPtr.Size!=8)throw new InvalidOperationException("OBS_LAYOUT");
    port=CreateIoCompletionPort(new IntPtr(-1),IntPtr.Zero,UIntPtr.Zero,1);
    if(port==IntPtr.Zero)throw new InvalidOperationException("OBS_PORT");
    Association a=new Association();a.Key=new IntPtr(1);a.Port=port;
    // Return the object after association failure so the caller can always close the port.
    try {if(!Associate(job,7,ref a,(uint)Marshal.SizeOf(typeof(Association))))Bad("OBS_ASSOCIATE");}
    catch {Bad("OBS_ASSOCIATE");}
  }
  Member Slot(uint pid) {
    Member m;if(members.TryGetValue(pid,out m))return m;
    if(pid==0||members.Count>=MemberLimit){Bad("OBS_MEMBER_LIMIT");return null;}
    m=new Member();m.Pid=pid;members.Add(pid,m);return m;
  }
  void Capture(Member m,IntPtr supplied) {
    // Capture at most once. An unknown or exited PID is never reopened later.
    if(m.State!="UNKNOWN")return;
    m.State="UNAVAILABLE";
    IntPtr h=supplied;
    if(h==IntPtr.Zero) {h=OpenProcess(0x1000|0x00100000,false,m.Pid);m.Owned=true;}
    m.Handle=h;
    if(h==IntPtr.Zero)return;
    bool inJob;FileTime c,e,k,u,c2;
    if(!IsProcessInJob(h,job,out inJob)||!inJob){m.State="MEMBERSHIP_UNKNOWN";return;}
    if(WaitForSingleObject(h,0)!=258){m.State="EXITED_BEFORE_CAPTURE";return;}
    if(!GetProcessTimes(h,out c,out e,out k,out u)||c.Value==0){m.State="TIME_UNKNOWN";return;}
    StringBuilder path=new StringBuilder(32768);uint size=32768;
    if(!QueryFullProcessImageNameW(h,0,path,ref size)||size==0||size>=32768){m.State="IMAGE_UNKNOWN";return;}
    if(!GetProcessTimes(h,out c2,out e,out k,out u)||c2.Value!=c.Value||!IsProcessInJob(h,job,out inJob)||!inJob){m.State="IDENTITY_CHANGED";return;}
    m.Created=c.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
    m.Image=String.Equals(path.ToString(),Node,StringComparison.OrdinalIgnoreCase)?"FIXED_NODE":"OTHER_IMAGE";
    path.Length=0;m.State="CAPTURED";
  }
  public void Root(uint pid,IntPtr handle) {root=pid;Member m=Slot(pid);if(m!=null)Capture(m,handle);}
  void Drain() {
    while(Failure=="NONE") {
      uint msg;UIntPtr key;IntPtr raw;
      if(!GetQueuedCompletionStatus(port,out msg,out key,out raw,0)) {
        if(Marshal.GetLastWin32Error()!=258||raw!=IntPtr.Zero)Bad("OBS_QUEUE");return;
      }
      if(events.Count>=EventLimit){Bad("OBS_EVENT_LIMIT");return;}
      if(key.ToUInt64()!=1){Bad("OBS_KEY");return;}
      if(msg==4){events.Add("{\"kind\":\"ACTIVE_ZERO\",\"pid\":0}");continue;}
      if(msg!=6&&msg!=7&&msg!=8){Bad("OBS_EVENT_TYPE");return;}
      long id=raw.ToInt64();if(id<=0||id>uint.MaxValue){Bad("OBS_PID");return;}
      uint pid=(uint)id;Member m=Slot(pid);if(m==null)return;
      string kind=msg==6?"NEW":msg==7?"EXIT":"ABNORMAL_EXIT";
      events.Add("{\"kind\":\""+kind+"\",\"pid\":"+pid+"}");
      if(msg==6){if(m.NewSeen)duplicateNew=true;m.NewSeen=true;Capture(m,IntPtr.Zero);}
      else {m.ExitSeen=true;if(m.State=="UNKNOWN")m.State="EXIT_WITHOUT_IDENTITY";}
    }
  }
  void Census() {
    int bytes=8+MemberLimit*8;IntPtr b=Marshal.AllocHGlobal(bytes);
    try {
      for(int i=0;i<bytes;i++)Marshal.WriteByte(b,i,0);
      uint returned;
      if(!QueryIds(job,3,b,(uint)bytes,out returned)){Bad("OBS_CENSUS");return;}
      uint assigned=unchecked((uint)Marshal.ReadInt32(b,0)),count=unchecked((uint)Marshal.ReadInt32(b,4));
      if(assigned>MemberLimit||count>MemberLimit||count>assigned||returned<8+count*8||returned>bytes){Bad("OBS_CENSUS_SIZE");return;}
      List<uint> unique=new List<uint>();
      for(int i=0;i<(int)count;i++) {
        long id=Marshal.ReadInt64(b,8+i*8);if(id<=0||id>uint.MaxValue||unique.Contains((uint)id)){Bad("OBS_CENSUS_PID");return;}
        unique.Add((uint)id);
        Member m=Slot((uint)id);if(m==null)return;m.Listed=true;Capture(m,IntPtr.Zero);
      }
    } finally {Marshal.FreeHGlobal(b);}
  }
  public void Poll() {
    if(stopped||Failure!="NONE")return;
    try {Drain();if(Failure=="NONE")Census();}catch{Bad("OBS_QUERY_EXCEPTION");}
  }
  public void Stop(uint total) {
    if(stopped)return;
    Poll();FinalTotal=total;
    IdentityCoverage=Failure=="NONE"&&!duplicateNew&&members.Count==total&&total>0;
    foreach(Member m in members.Values) {
      try {
        if(m.State!="CAPTURED"||m.Handle==IntPtr.Zero)IdentityCoverage=false;
        if(m.Handle!=IntPtr.Zero) {
          FileTime c,e,k,u;bool inJob;
          if(!GetProcessTimes(m.Handle,out c,out e,out k,out u)||c.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)!=m.Created||!IsProcessInJob(m.Handle,job,out inJob)||!inJob||WaitForSingleObject(m.Handle,0)!=0)IdentityCoverage=false;
        }
      } catch {IdentityCoverage=false;Bad("OBS_FINAL_QUERY");}
      finally {
        if(m.Handle!=IntPtr.Zero&&m.Owned)try{HandlesClosed=CloseHandle(m.Handle)&&HandlesClosed;}catch{HandlesClosed=false;}
        m.Handle=IntPtr.Zero;
      }
    }
    if(port!=IntPtr.Zero){try{HandlesClosed=CloseHandle(port)&&HandlesClosed;}catch{HandlesClosed=false;}port=IntPtr.Zero;}
    stopped=true;if(!HandlesClosed)Bad("OBS_CLOSE");
    IdentityCoverage=IdentityCoverage&&HandlesClosed;
  }
  public string Json() {
    StringBuilder b=new StringBuilder("{\"failure\":\"").Append(Failure).Append("\",\"identityCoverage\":").Append(IdentityCoverage?"true":"false")
      .Append(",\"parentEvidenceComplete\":false,\"notificationCompletenessGuaranteed\":false,\"stopped\":").Append(stopped?"true":"false")
      .Append(",\"handlesClosed\":").Append(HandlesClosed?"true":"false").Append(",\"duplicateNew\":").Append(duplicateNew?"true":"false")
      .Append(",\"finalTotal\":").Append(FinalTotal).Append(",\"events\":[").Append(String.Join(",",events.ToArray())).Append("],\"members\":[");
    bool first=true;foreach(Member m in members.Values){if(!first)b.Append(',');first=false;
      b.Append("{\"pid\":").Append(m.Pid).Append(",\"creationTime\":").Append(m.Created==null?"null":"\""+m.Created+"\"")
      .Append(",\"image\":\"").Append(m.Image).Append("\",\"state\":\"").Append(m.State).Append("\",\"root\":").Append(m.Pid==root?"true":"false")
      .Append(",\"parent\":\"UNKNOWN\",\"newSeen\":").Append(m.NewSeen?"true":"false").Append(",\"listed\":").Append(m.Listed?"true":"false")
      .Append(",\"exitSeen\":").Append(m.ExitSeen?"true":"false").Append('}');}
    return b.Append("]}").ToString();
  }
}
