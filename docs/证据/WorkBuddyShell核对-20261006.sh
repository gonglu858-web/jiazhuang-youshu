#!/usr/bin/env bash
# ============================================================================
# 【已停用 / DEPRECATED —— 保留文件，仅作历史留档，不再运行、不再完善】
#
# 停用依据：docs/Codex验收-独立副本S3b与E1核心-20261006.md 第 3 节。
#
# 停用原因（两条，均为实测/静态确认）：
#  1) 本脚本**复用单一入口的 runId** 再次执行相同隔离副本；副本按自身文件名
#     写 JSON，因此**覆盖了单一入口刚保存的结果文件**。它虽不修改入口的
#     sealed 字段，却修改了入口所引用的证据文件，因此**不构成独立保存**。
#     实测后果 —— 入口报告记录的 producedSha256 与当前文件不一致：
#       前轮34条：报告 98f43d0f06748e17e92f4bbe026cb469b1b818a57f8a9ad4b7dab9efe2b95706
#                 当前 f04dc41cd5597fbaf153dc7e575ef06a391f31063cd82d53949c7627aef636d4
#       上轮18条：报告 70aadbe9b6cb0ac35733f9651dcd29ca362cfb3f05dce0a987ad8b2f545af763
#                 当前 55cf5deb71e73f984f861c09c5d1376190bf57988953ff283a5e54f2cffa7441
#     两份均不匹配。**保留旧报告哈希原样，不修改以掩盖该差异。**
#     入口报告只能作为**当时的运行记录**，当前路径下的文件不得再当作它的原始字节证据。
#  2) 本脚本只打印两次进程退出码，**未把退出码传入 readOne 的 completed 判断**；
#     执行失败但旧 JSON 仍留在原路径时，可能读到旧结果并标 completed。
#     （该点为静态代码结论，**未运行故障场景、未宣称此错误已发生**。）
#
# 处置（已确定，不在本文件内继续实现）：
#  - 不删除本文件、不重跑、不修成新的 shell 重跑器。
#  - 后续如宿主 spawn 失败，由单一入口如实记「未完成」，是否需要单独、
#    独立编号的新验证由 Codex 决定；**不把一次失败扩成多条自动补跑链**。
#  - S3-b 与 E1 核心已由 Codex 验收通过，本脚本与核心结论无关。
#
# 依据：Codex验收-独立副本S3b与E1核心-20261006.md 第 3、5 节
# ============================================================================

# ---------------------------------------------------------------------------
# 以下为停用前的原始内容，原样保留供历史查阅，不再执行。
# ---------------------------------------------------------------------------

# E1 附随：shell 独立核对入口
#
# 用途与边界（按 Codex 复核第 3.2 / 3.3 节）：
#  - 单一入口 `WorkBuddy单一重跑入口-20261006.cjs` 只用子进程执行，**不做进程内回退**。
#  - 当宿主出现 spawn EBUSY 时，它如实记「本次未完成」并保持 sealed=false。
#  - 本脚本由 **shell** 直接运行隔离副本，用于**另行核对**断言本身，
#    其结果写入**独立文件**，**不回填**单一入口的 sealed 结论。
#
# 用法： bash docs/证据/WorkBuddyShell核对-20261006.sh <runId>
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_ID="${1:-}"
if [ -z "$RUN_ID" ]; then
  echo "用法：bash docs/证据/WorkBuddyShell核对-20261006.sh <runId>"
  echo "（runId 取自单一入口 JSON 的 runId 字段）"
  exit 2
fi

DIR="$ROOT/docs/证据重跑"
OUT="$ROOT/docs/证据/WorkBuddyShell核对-${RUN_ID}.json"

R34="$DIR/${RUN_ID}__WorkBuddy返修R1R5复现-20261005.cjs"
R18="$DIR/${RUN_ID}__WorkBuddy返修S1S5复现-20261006.cjs"

echo "运行标识：$RUN_ID"
for f in "$R34" "$R18"; do
  if [ ! -f "$f" ]; then
    echo "缺少隔离副本：$f（先运行单一入口生成副本）"
    exit 2
  fi
done

echo "--- shell 直接执行 34 条隔离副本 ---"
node "$R34" >/dev/null 2>&1
echo "  退出码=$?"
echo "--- shell 直接执行 18 条隔离副本 ---"
node "$R18" >/dev/null 2>&1
echo "  退出码=$?"

echo "--- shell 直接核对 CLI 拒绝（宿主 spawn 受限时唯一可行的验证途径）---"
PLAN="$DIR/cli-shell-plan-${RUN_ID}.json"
node -e '
const fs=require("fs");
fs.writeFileSync(process.argv[1],JSON.stringify({enabled:true,appId:"wxfb4db1615ac15531",envId:"cloud1-d8gcq5ag39d847723",roundId:"r-cli-shell",targetUserId:"u_"+"0".repeat(40),evidenceId:"ev",expiresAt:"2030-01-01T00:00:00Z",schemaVersion:1,operatorRef:"op",approvedOwnerHint:"2d3aa4",approval:{approvedUserIds:["u_"+"0".repeat(40)],approvedBy:"x",approvedAt:"2026-10-05T00:00:00Z"}},null,2));
' "$PLAN"
EXEC_OUT="$(node "$ROOT/miniapp/scripts/prepare-sandbox-primary.cjs" --plan "$PLAN" --execute 2>&1)"; EXEC_CODE=$?
APPR_OUT="$(node "$ROOT/miniapp/scripts/prepare-sandbox-primary.cjs" --plan "$PLAN" --approval x.json 2>&1)"; APPR_CODE=$?
rm -f "$PLAN"
printf '%s\n' "$EXEC_CODE" > "$DIR/.cli-exec.code"
printf '%s\n' "$APPR_CODE" > "$DIR/.cli-appr.code"
printf '%s' "$EXEC_OUT" > "$DIR/.cli-exec.out"
printf '%s' "$APPR_OUT" > "$DIR/.cli-appr.out"

node -e '
const fs=require("fs"),path=require("path"),crypto=require("crypto");
const root=process.argv[1], runId=process.argv[2], out=process.argv[3];
const sha=f=>crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const dir=path.join(root,"docs/证据重跑");
function readOne(base,label,expect){
  const cjs=path.join(dir,base), json=cjs.replace(/\.cjs$/,".json");
  if(!fs.existsSync(json)) return {label,producedJson:false,completed:false,reason:"shell 执行后未产出结果文件"};
  const doc=JSON.parse(fs.readFileSync(json,"utf8"));
  const s=doc.summary||{};
  const unmet=doc.results.filter(x=>x.sealed!==true).map(x=>({id:x.id,hostSpawnBlocked:x.hostSpawnBlocked===true||undefined}));
  return {label,producedJson:true,completed:true,summary:s,
    matchesExpectation:s.total===expect.total&&s.sealed===expect.sealed&&(s.unsealed===undefined||s.unsealed===expect.unsealed),
    expectedSummary:expect,unmetItems:unmet.length?unmet:undefined,
    producedSha256:sha(json),executedAt:doc.executedAt||null,
    isolatedScript:path.relative(root,cjs).split(path.sep).join("/"),
    isolatedResult:path.relative(root,json).split(path.sep).join("/")};
}
const r34=readOne(`${runId}__WorkBuddy返修R1R5复现-20261005.cjs`,"前轮34条",{total:34,sealed:34,unsealed:0});
const r18=readOne(`${runId}__WorkBuddy返修S1S5复现-20261006.cjs`,"上轮18条",{total:18,sealed:18,unsealed:0});
// CLI 拒绝核对：shell 直接执行，绕开宿主对 node 内 spawn 的限制
const rd=(n)=>{try{return fs.readFileSync(path.join(dir,n),"utf8");}catch(e){return "";}};
const execOut=rd(".cli-exec.out"), apprOut=rd(".cli-appr.out");
const execCode=Number(rd(".cli-exec.code").trim()||"-1"), apprCode=Number(rd(".cli-appr.code").trim()||"-1");
for(const n of [".cli-exec.code",".cli-appr.code",".cli-exec.out",".cli-appr.out"]) { try{fs.rmSync(path.join(dir,n));}catch(e){} }
const cliShell={
  note:"宿主 spawn 受限时，CLI 拒绝只能由 shell 另行核对；此结果不回填单一入口的 sealed 结论",
  executeRefused: execCode!==0 && /--execute 已拒绝/.test(execOut),
  executeMentionsNoFakeAtomicity: /不得用独立的读 → 写 → 回读冒充原子性/.test(execOut),
  executeExitCode: execCode,
  approvalFlagRefused: apprCode!==0 && /不接受 --approval/.test(apprOut),
  approvalExitCode: apprCode
};
cliShell.allCorrect = cliShell.executeRefused && cliShell.executeMentionsNoFakeAtomicity && cliShell.approvalFlagRefused;
const doc={executedAt:new Date().toISOString(),runId,
  scope:"shell 独立核对：宿主 spawn 受限时另行验证断言；不回填单一入口的 sealed 结论",
  relationToSingleEntry:"WorkBuddy单一重跑入口-20261006.json 的 sealed 仍按其自身执行结果（宿主 spawn 受阻时为 false）；本文件不修改它",
  records:[r34,r18],cliShellVerification:cliShell,
  allMatched:r34.matchesExpectation===true&&r18.matchesExpectation===true};
fs.writeFileSync(out,JSON.stringify(doc,null,2)+"\n");
console.log(`  34 条：${JSON.stringify(r34.summary)} 期望匹配=${r34.matchesExpectation}${r34.unmetItems?" 未达期望项="+JSON.stringify(r34.unmetItems):""}`);
console.log(`  18 条：${JSON.stringify(r18.summary)} 期望匹配=${r18.matchesExpectation}`);
console.log(`  CLI（shell 核对）：execute 拒绝=${cliShell.executeRefused} 禁止伪原子=${cliShell.executeMentionsNoFakeAtomicity} approval 拒绝=${cliShell.approvalFlagRefused}`);
console.log(`已写：${path.relative(root,out).split(path.sep).join("/")}`);
' "$ROOT" "$RUN_ID" "$OUT"