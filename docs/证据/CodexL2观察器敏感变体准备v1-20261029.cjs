'use strict';
// Fixed in-memory mutants only, never compiles/executes/writes a source file.
const crypto=require('node:crypto');
const BASE='6ebb2da69580ebebc56fe889d803571f60753b1e7140fe2aabacb283ff728b6a';
const definitions=Object.freeze([
 {id:'caseSensitive',before:'String.Equals(value,Node,StringComparison.OrdinalIgnoreCase)',after:'String.Equals(value,Node,StringComparison.Ordinal)',expectedFirstFailure:'classification'},
 {id:'finalIdentity',before:'c.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)!=m.Created',after:'(c.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)!=m.Created&&m.State!="CAPTURED")',expectedFirstFailure:'final1'},
 {id:'borrowedClose',before:'m.Handle!=IntPtr.Zero&&m.Owned',after:'m.Handle!=IntPtr.Zero&&m.Pid!=0',expectedFirstFailure:'captureBorrowed0'},
 {id:'recapture',before:'if(m.State!="UNKNOWN")return;',after:'if(m.Pid==0)return;',expectedFirstFailure:'captureBorrowed0'}
].map(Object.freeze));
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function prepare(source){
 if(typeof source!=='string'||hash(source)!==BASE)throw Error('BASE_DRIFT');
 return definitions.map(d=>{const i=source.indexOf(d.before);if(i<0||source.indexOf(d.before,i+1)!==-1)throw Error('ANCHOR');
 const output=source.slice(0,i)+d.after+source.slice(i+d.before.length);
 return {id:d.id,source:output,sha256:hash(output),expectedFirstFailure:d.expectedFirstFailure,expectedExitCode:1,compiled:false,executed:false};});
}
module.exports={prepare,BASE};
