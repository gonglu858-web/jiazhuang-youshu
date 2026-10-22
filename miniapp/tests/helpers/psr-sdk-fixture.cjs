'use strict';
// 真SDK包装/事务/EJSON，替换仅限上下文、node-sdk工厂与传输；无平台证明。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../../..');
const SDK=path.join(process.env.USERPROFILE,'.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules');
async function runSdkEntry(entryFile,event,openid,options={}) {
  assert.ok(fs.existsSync(path.join(SDK,'wx-server-sdk/index.js')),'现有本地SDK缺失，不能静态回退报通过');
  const nodeSdk=require(path.join(SDK,'@cloudbase/node-sdk'));
  const database=require(path.join(SDK,'@cloudbase/database'));
  const ejson=require(path.join(SDK,'@cloudbase/database/dist/commonjs/utils/utils.js'));
  const originalInit=nodeSdk.init,originalReq=database.Db.reqClass;
  const docs=new Map(),pending=new Map(),actions=[];
  let factory=0,starts=0,inserts=0,commits=0,now=options.now, conflict=false;
  class Transport {
    async send(action,p={}) {
      actions.push(action);
      if(action==='database.startTransaction'){const id='synthetic-tx-'+(++starts);pending.set(id,new Map());return {transactionId:id};}
      if(action==='database.commitTransaction'){
        commits++;
        if(options.commitConflict&&!conflict){conflict=true;pending.delete(p.transactionId);
          if(options.expireAfterConflict)now=options.expires;
          return {code:'DATABASE_TRANSACTION_CONFLICT'};}
        for(const [id,d] of pending.get(p.transactionId)||[])docs.set(id,d);
        pending.delete(p.transactionId);return {};
      }
      if(action==='database.abortTransaction'){pending.delete(p.transactionId);return {};}
      if(action==='database.getDocument'){
        if(options.failRead)throw Object.assign(Error('synthetic read failure'),{code:'SYNTHETIC_PRIVATE_ERROR'});
        const id=ejson.parseByEJSON(p.query)._id;
        const d=(pending.get(p.transactionId)||new Map()).get(id)||docs.get(id);
        if(!p.transactionId&&options.expireOnRead)now=options.expires;
        return {data:{list:d?[ejson.stringifyByEJSON(d)]:[],offset:0,limit:1}};
      }
      if(action==='database.insertDocument'){
        inserts++;if(options.failSecond&&inserts===2)throw Error('synthetic second write failure');
        assert.ok(pending.has(p.transactionId),'写必须属于事务');
        const d=ejson.parseByEJSON(p.data[0]);pending.get(p.transactionId).set(d._id,d);
        return {data:{insertedIds:[d._id]}};
      }
      throw Error('未声明SDK操作');
    }
  }
  nodeSdk.init=()=>({logger:()=>{},database:()=>new database.Db({env:'cloud1-d8gcq5ag39d847723'})});
  database.Db.reqClass=Transport;
  const cloud=require(path.join(SDK,'wx-server-sdk'));
  const oldContext=cloud.getWXContext,oldDatabase=cloud.database;
  cloud.getWXContext=()=>({APPID:'wxfb4db1615ac15531',OPENID:openid});
  cloud.database=function(...a){factory++;return oldDatabase.apply(cloud,a);};
  let source=fs.readFileSync(entryFile,'utf8').replace('const CONFIG_SYNTHETIC = true;','const CONFIG_SYNTHETIC = false;');
  if(options.unfixed){assert.ok(source.includes('cloud.database({ throwOnNotFound: false })'));
    source=source.replace('cloud.database({ throwOnNotFound: false })','cloud.database()');}
  const module={exports:{}};
  try {
    vm.runInNewContext(source,{module,exports:module.exports,console,process:{env:{}},Date:{now:()=>now},
      require(name){
        if(name==='wx-server-sdk')return cloud;
        if(name==='./request-adapter')return require(path.join(path.dirname(entryFile),'request-adapter.js'));
        if(name==='./participant-self-registration')return require(path.join(path.dirname(entryFile),'participant-self-registration.js'));
        throw Error('非声明依赖');
      }},{filename:entryFile});
    const result=await module.exports.main(event);
    return {result,actions,factory,starts,inserts,commits,stored:docs.size};
  } finally {cloud.getWXContext=oldContext;cloud.database=oldDatabase;nodeSdk.init=originalInit;database.Db.reqClass=originalReq;}
}
module.exports=Object.freeze({runSdkEntry,SDK});
