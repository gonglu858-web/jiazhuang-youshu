'use strict';
// In-memory source transformation only. No compiler or executable launch capability.
const crypto=require('node:crypto');
const SOURCE_SHA='722d28e9e2f145d9bcf4e00fb82ee4837ec4b365d53bdd86b4472a6228fd9019';
const calls={CreateIoCompletionPort:'file,existing,key,threads',GetQueuedCompletionStatus:'port,out message,out key,out pid,wait',Associate:'job,kind,ref value,size',QueryIds:'job,kind,data,size,out returned',OpenProcess:'access,inherit,pid',IsProcessInJob:'process,job,out result',GetProcessTimes:'process,out created,out exited,out kernel,out user',QueryFullProcessImageNameW:'process,flags,path,ref size',WaitForSingleObject:'process,milliseconds',CloseHandle:'handle'};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function transform(bytes){
  if(!Buffer.isBuffer(bytes)||sha(bytes)!==SOURCE_SHA)throw Error('SOURCE_DRIFT');
  const source=bytes.toString('utf8'),edits=[];
  function edit(before,after){const start=source.indexOf(before);if(start<0||source.indexOf(before,start+before.length)!==-1)throw Error('ANCHOR');edits.push({start,before,after});}
  edit('internal sealed class L2MemberObserver {','internal sealed partial class L2MemberObserver {');
  for(const [name,args] of Object.entries(calls)){
    const re=new RegExp('\\[DllImport\\([^\\r\\n]+\\)\\] static extern ([^\\r\\n]+? '+name+'\\([^\\r\\n]*?\\));','g');
    const matches=[...source.matchAll(re)];if(matches.length!==1)throw Error('DECLARATION');
    edit(matches[0][0],'static '+matches[0][1]+' { return SyntheticBoundary.'+name+'('+args+'); }');
  }
  edit('Marshal.GetLastWin32Error()','SyntheticBoundary.LastError()');
  edits.sort((a,b)=>b.start-a.start);let text=source;
  for(const e of edits)text=text.slice(0,e.start)+e.after+text.slice(e.start+e.before.length);
  if(/DllImport|static extern|Marshal\.GetLastWin32Error/.test(text))throw Error('NATIVE_REMAINS');
  let restored=text;
  for(const e of [...edits].reverse()) {if(restored.slice(e.start,e.start+e.after.length)!==e.after)throw Error('RESTORE');restored=restored.slice(0,e.start)+e.before+restored.slice(e.start+e.after.length);}
  if(!Buffer.from(restored).equals(bytes))throw Error('ROUNDTRIP');
  return {source:text,sourceSha256:SOURCE_SHA,generatedSha256:sha(Buffer.from(text)),edits:edits.map(e=>({start:e.start,before:e.before,after:e.after})),compiled:false,executed:false};
}
module.exports={transform,SOURCE_SHA};
if(require.main===module){process.stdout.write(JSON.stringify({executionEnabled:false,reason:'PREPARATION_LIBRARY_ONLY',compiled:false,executed:false})+'\n');process.exitCode=2;}
