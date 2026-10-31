'use strict';
// Generates source only; selected helper methods are copied byte-for-byte.
const crypto=require('node:crypto');
const SOURCE_SHA='408d9108fff46b045bf19183d1488a53f02ca52f4e255fab987163df60124a7b';
const H=b=>crypto.createHash('sha256').update(b).digest('hex');
function build(bytes){
  if(!Buffer.isBuffer(bytes)||H(bytes)!==SOURCE_SHA)throw Error('SOURCE_DRIFT');
  const s=bytes.toString('utf8');
  function section(a,b){const i=s.indexOf(a),j=s.indexOf(b,i+a.length);if(i<0||j<0||s.indexOf(a,i+1)!==-1||s.indexOf(b,j+1)!==-1)throw Error('ANCHOR');return s.slice(i,j);}
  const receipt=section('  sealed class Receipt {','  static bool Close(');
  const close=section('  static bool Close(','  static void Account(');
  const closeFinal='r.HandlesClosed=(Close(ref pi.Thread,r)&Close(ref pi.Process,r)&Close(ref rd,r)&Close(ref wr,r)&Close(ref er,r)&Close(ref ew,r)&Close(ref input,r)&Close(ref job,r))&&r.HandlesClosed;';
  const verdict='if(r.Reason!="NONE"||!r.Cleanup){r.Outcome="failed";r.Stdout="";}';
  for(const x of [closeFinal,verdict])if(s.split(x).length!==2)throw Error('ANCHOR');
  const source=`// Uncompiled synthetic fixture. No production entry, file, process, native or network APIs.
using System;
using System.Collections.Generic;
internal static class RootOnlyCleanupFixture {
  static readonly IntPtr Invalid=new IntPtr(-1);
  struct ProcessInfo { public IntPtr Thread,Process; }
  static Queue<int> Returns=new Queue<int>();
  static List<long> Calls=new List<long>();
  static int Unexpected;
  static bool CloseHandle(IntPtr h){Calls.Add(h.ToInt64());if(Returns.Count==0||h.ToInt64()<=0){Unexpected++;throw new Exception("UNEXPECTED_CALL");}int v=Returns.Dequeue();if(v<0)throw new Exception("SYNTHETIC_CLOSE_THROW");return v==1;}
${receipt}${close}
  static void Finish(Receipt r){${verdict}}
  static void FinalHandles(Receipt r){ProcessInfo pi=new ProcessInfo();pi.Thread=new IntPtr(1);pi.Process=new IntPtr(2);IntPtr rd=new IntPtr(3),wr=new IntPtr(4),er=new IntPtr(5),ew=new IntPtr(6),input=new IntPtr(7),job=new IntPtr(8);${closeFinal}}
  static void Require(bool b){if(!b)throw new Exception("ASSERTION_FAILED");}
  static void Reset(params int[] values){Returns=new Queue<int>(values);Calls=new List<long>();Unexpected=0;}
  static void EightHandles(){Require(Calls.Count==8);for(int i=0;i<8;i++)Require(Calls[i]==i+1);}
  static Receipt Ready(){Receipt r=new Receipt();r.Created=true;r.RootExited=true;r.JobEmpty=true;r.ReadersDone=true;r.Outcome="completed";r.Stdout="TDJfUk9PVF9PTkxZ";r.OutBytes=12;r.Observer=new L2MemberObserver();return r;}
  static bool Test(int n){
    Reset();Receipt r=Ready();IntPtr h=new IntPtr(10);bool ok;
    switch(n){
      case 0: Reset(1);ok=Close(ref h,r);Require(ok&&h==IntPtr.Zero&&r.HandlesClosed&&Calls.Count==1&&Returns.Count==0);break;
      case 1: Reset();h=IntPtr.Zero;Require(Close(ref h,r)&&r.HandlesClosed&&Calls.Count==0);break;
      case 2: Reset();h=Invalid;Require(Close(ref h,r)&&h==IntPtr.Zero&&Calls.Count==0);break;
      case 3: Reset(0);Require(!Close(ref h,r)&&!r.HandlesClosed&&h==IntPtr.Zero&&Calls.Count==1&&Returns.Count==0);break;
      case 4: Reset(-1);Require(!Close(ref h,r)&&!r.HandlesClosed&&h==IntPtr.Zero&&Calls.Count==1&&Returns.Count==0);break;
      case 5: Reset(0,1);Require(!Close(ref h,r));h=new IntPtr(11);Require(Close(ref h,r)&&!r.HandlesClosed&&Calls.Count==2&&Returns.Count==0);break;
      case 6: Reset(0,1,1,1,1,1,1,1);FinalHandles(r);EightHandles();Require(!r.HandlesClosed&&Returns.Count==0);break;
      case 7: Reset(1,1,1,1,1,1,1,1);r.HandlesClosed=false;FinalHandles(r);EightHandles();Require(!r.HandlesClosed&&Returns.Count==0);break;
      case 8: Reset(1,1,1,1,1,1,1,1);FinalHandles(r);EightHandles();Require(r.HandlesClosed&&Returns.Count==0);break;
      case 9: r.HandlesClosed=false;Finish(r);Require(r.Outcome=="failed"&&r.Stdout==""&&r.OutBytes==12&&!r.Cleanup);break;
      case 10: r.Observer.HandlesClosed=false;r.Reason="OBS_FAILURE";Finish(r);Require(r.Outcome=="failed"&&r.Stdout==""&&r.OutBytes==12&&!r.Cleanup);break;
      case 11: r.Reason="TIMEOUT";Finish(r);Require(r.Outcome=="failed"&&r.Stdout==""&&r.OutBytes==12);break;
      case 12: Finish(r);Require(r.Outcome=="completed"&&r.Stdout=="TDJfUk9PVF9PTkxZ"&&r.OutBytes==12&&r.Cleanup);break;
      default: throw new Exception("CASE");
    }Require(Unexpected==0);return true;
  }
  public static int Main(string[] args){if(args.Length!=0)return 2;int passed=0;for(int i=0;i<13;i++){try{Test(i);passed++;}catch{Console.WriteLine("{\\"ok\\":false,\\"failedCase\\":"+i+",\\"passed\\":"+passed+"}");return 1;}}Console.WriteLine("{\\"ok\\":true,\\"passed\\":"+passed+",\\"executedProductionHelper\\":false}");return 0;}
}
// Observer internals are deliberately out of scope; final fields are synthetic.
internal sealed class L2MemberObserver {public bool HandlesClosed=true;public string Json(){return "null";}}
`;
  // Fixed fixture capabilities: real managed values/collections only, never an OS handle.
  if(/DllImport|static extern|Process\.Start|File\.|Environment\.|Thread\.|Stopwatch\.|Marshal\./.test(source))throw Error('CAPABILITY_REMAINS');
  return {source,sourceSha256:SOURCE_SHA,generatedSha256:H(Buffer.from(source)),copied:{receipt:H(Buffer.from(receipt)),close:H(Buffer.from(close)),closeFinal:H(Buffer.from(closeFinal)),verdict:H(Buffer.from(verdict))},plannedCases:13,compiled:false,executed:false};
}
module.exports={build,SOURCE_SHA};
