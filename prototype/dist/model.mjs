export const TODAY='2026-09-15';
export const PANORAMA='https://pano.kujiale.com/pub/render/pano/custom/tour/3FO4K067RQ7V?fromqrcode=true&friendid=3FO4JPJEENWQ';
export const ROLES=[
 ['owner','主业主','查看进度 · 确认验收'],
 ['keeper','管家','统筹现场 · 跟进问题'],
 ['worker','师傅','每日更新 · 整改交接'],
 ['designer','设计师','维护设计 · 查看进展'],
 ['director','负责人','管理项目 · 上传图纸'],
 ['family','家庭成员','关注进展 · 留言反馈']
];
export const STATUS={
 checking:['待管家检查','orange'],working:['整改中','orange'],review:['待主业主验收',''],
 explanation:['待业主认可说明',''],closed:['已解决','green'],acknowledged:['说明已认可','green'],
 active:['施工中',''],pending:['待主业主确认',''],passed:['验收通过','green'],
 rejected:['待管家跟进','red'],confirmed:['本批已确认','green'],problem:['管家处理中','orange'],
 applied:['待管家验收','orange'],returned:['待师傅继续施工','red'],planned:['待进场','gray'],
 extra_pending:['待业主确认','orange'],extra_confirmed:['已确认待施工',''],extra_working:['施工中',''],
 extra_applied:['待管家验收','orange'],extra_review:['待主业主验收',''],extra_completed:['已完成','green'],
 extra_rejected:['业主已拒绝','red'],extra_returned:['待师傅继续施工','red'],extra_followup:['待管家跟进','red'],
 extra_cancel_pending:['待业主确认取消','orange'],extra_cancelled:['已取消','gray'],
 extra_settlement:['待业主确认结算','orange'],extra_terminated:['已终止','gray']
};

export const WATERPROOF_NODE_TEMPLATES=[
 {id:'first-start',name:'第一遍防水完成＋第一次闭水开始',timeLabel:'第一次闭水开始时间',noteLabel:'第一遍防水完成情况、起始水位和现场说明',defaultTime:'2026-09-10T09:00',defaultNote:'第一遍防水完成，关键节点完整；已注水并记录起始水位。'},
 {id:'first-end',name:'第一次闭水结束',timeLabel:'第一次闭水结束时间',noteLabel:'结束水位和渗漏检查结果',defaultTime:'2026-09-13T09:00',defaultNote:'水位稳定；楼下顶面及相邻墙面未发现渗漏或湿痕。'},
 {id:'backfill',name:'卫生间回填完成',timeLabel:'回填完成时间',noteLabel:'回填材料、范围和现场情况',defaultTime:'2026-09-13T12:00',defaultNote:'第一次闭水通过后完成卫生间回填，回填前后现场情况已检查。'},
 {id:'second-start',name:'第二遍防水完成＋第二次闭水开始',timeLabel:'第二次闭水开始时间',noteLabel:'第二遍防水完成情况、起始水位和现场说明',defaultTime:'2026-09-14T09:00',defaultNote:'回填后第二遍防水完成，关键节点完整；已注水并记录起始水位。'},
 {id:'second-end',name:'第二次闭水结束',timeLabel:'第二次闭水结束时间',noteLabel:'结束水位和渗漏检查结果',defaultTime:'2026-09-16T09:00',defaultNote:'水位稳定；楼下顶面及相邻墙面未发现渗漏或湿痕。'}
];

export const STAGE_TEMPLATES=[
 {id:'st-demolition',name:'拆改阶段',trade:'拆改工',checks:[
  {id:'st-demolition-c1',text:'实际拆除范围与施工图或现场交底一致，没有漏拆、错拆。'},
  {id:'st-demolition-c2',text:'承重墙、梁、柱、外墙及公共区域设施没有被违规破坏。'},
  {id:'st-demolition-c4',text:'给排水、电线、燃气及排烟管道没有损坏。'},
  {id:'st-demolition-c5',text:'门洞、墙体开口及拆除后的尺寸符合后续砌墙和安装要求。'},
  {id:'st-demolition-c6',text:'建筑垃圾已清理。'}
 ]},
 {id:'st-masonry',name:'砌墙阶段',trade:'泥瓦工',checks:[
  '新墙的位置、长度、厚度、高度及门洞尺寸与施工图或现场交底一致。',
  '砖块、砌块、砂浆等材料与项目约定一致，没有使用错误材料。',
  '墙体砌筑平整、垂直，砖缝错开，灰缝饱满，没有明显松动或贯通缝。',
  '新墙与原墙、柱体交接位置已做拉结和防开裂处理。',
  '门洞、窗洞上方已按要求设置过梁，预留洞口和安装位置正确。',
  '卫生间、厨房等潮湿区域的墙体底部已按设计做好防潮或挡水处理。',
  '墙体顶部封堵牢固，管线孔洞和后续施工位置已经预留，现场清理完成。'
 ]},
 {id:'st1',name:'水电隐蔽工程',trade:'水电工',checks:[
  '开关、插座、灯位、给水点和排水点的位置及数量与施工图或现场交底一致。',
  '电线、线管、水管和排水管的品牌及规格与项目约定一致。',
  '电线已经完整穿管，线管和底盒固定牢固，没有裸线或违规暗接接头。',
  '强电和弱电分开布置，交叉位置做好保护，各回路标识清楚。',
  '配电回路、接地和漏电保护符合设计要求，并在通电前完成检查。',
  '给水管固定牢固，冷热水区分清楚，没有渗漏，并已完成打压试验和记录。',
  '排水通畅、坡向正确；暗装或埋地排水管在封闭前已经完成灌水或通水检查。',
  '开槽没有破坏承重结构，管线交叉、转弯和出墙位置已经做好保护。',
  '封闭前已记录完整管线走向、关键节点、打压结果和各房间完成情况，便于后续施工与维修。'
 ]},
 {id:'st-waterproof',name:'防水与闭水试验',trade:'防水工',kind:'waterproof',checks:[
  '防水施工范围、高度和部位与施工图或现场交底一致。',
  '防水材料的品牌、型号和有效期与项目约定一致。',
  '防水施工前的基层坚固、平整、干净，没有明显空鼓、裂缝和积水。',
  '地漏、管根、墙角、门槛和墙地交接位置已按要求做加强处理。',
  '第一遍防水层涂刷均匀，没有漏刷、开裂、起泡和明显破损，厚度符合设计及材料要求。',
  '第一遍防水完成后进行第一次闭水试验，时间不少于 72 小时；记录开始时间、结束时间和水位，并检查楼下顶面及相邻墙面，没有渗漏或湿痕才算通过。',
  '第一次闭水试验通过后进行卫生间回填，并记录回填前后的现场情况。',
  '卫生间回填完成后再做一遍防水，检查防水范围、关键节点和防水层完整性。',
  '第二遍防水完成后进行第二次闭水试验，时间不少于 48 小时；再次记录时间、水位和渗漏检查结果。第二次闭水通过后，才允许本阶段进入最终验收。',
  '验收通过后做好防水层保护，避免后续施工造成破坏。'
 ]},
 {id:'st2',name:'泥瓦铺贴',trade:'泥瓦工',checks:[
  '瓷砖、石材和粘结材料与项目约定一致。',
  '铺贴前已经确认排版、起铺位置、拼花方向和非整砖位置。',
  '墙砖、地砖粘贴牢固；发现空鼓时记录具体位置和范围，整改后重新检查。',
  '墙地砖表面平整，墙面垂直，阴阳角方正，砖缝顺直、宽度均匀。',
  '砖面没有明显裂纹、缺角、破损、污染和影响整体效果的色差。',
  '门洞、墙角、窗台、地漏、管道和开关插座周围的切割及收口整齐。',
  '卫生间、阳台等用水区域坡向地漏，没有倒坡和明显积水，排水通畅。',
  '砖缝内没有影响后续施工的水泥或粘结材料，留缝深度满足后续美缝施工。',
  '门、橱柜、洁具等后续安装所需的高度和尺寸已经预留，完成面做好保护。'
 ]},
 {id:'st3',name:'木工施工',trade:'木工',checks:[
  '吊顶、背景墙、窗帘盒和门套基层等位置及尺寸与施工图或现场交底一致。',
  '龙骨、石膏板、木板及辅料的品牌、规格和数量与项目约定一致。',
  '封板前完成吊顶内部管线、设备、检修口和预留位置检查，并拍摄隐蔽记录。',
  '吊杆、龙骨及连接件安装牢固，间距和固定方式符合设计及材料要求。',
  '重型灯具和设备设置独立可靠的固定位置，不能直接由普通吊顶龙骨承重。',
  '石膏板或其他面板安装平整牢固，没有明显破损、松动和变形；接缝及转角位置按工艺处理。',
  '空调风口、灯位、窗帘、电器、开关插座及后续安装位置预留正确，没有被木作遮挡。'
 ]},
 {id:'st-paint',name:'油漆施工',trade:'油漆工',checks:[
  '腻子、底漆和面漆的品牌、型号、颜色及批次与项目约定一致。',
  '施工前基层牢固、干燥，没有明显空鼓和开裂；石膏板接缝、钉眼及阴阳角已经处理。',
  '腻子层平整、牢固，没有粉化、起皮和明显裂缝。',
  '墙面、顶面打磨平整，阴阳角顺直，没有明显砂纸痕和凹凸。',
  '底漆和面漆按照约定的施工遍数完成，每道工序干燥后再进行下一道。',
  '完成面的颜色和光泽基本一致，没有透底、漏刷、流坠、刷纹、起泡和脱皮。',
  '墙面和顶面干燥后没有明显裂缝、污渍、色差及修补痕迹。',
  '门窗、瓷砖、开关插座、灯位及其他成品没有被涂料污染，边缘收口整齐。',
  '按房间拍摄基层、腻子、底漆和面漆完成情况，并记录发现的问题及整改结果。'
 ]},
 {id:'st-grout',name:'美缝阶段',trade:'美缝工',checks:[
  '美缝剂的品牌、类型、颜色和批次与项目约定一致，正式施工前完成颜色样板确认。',
  '施工前瓷砖及砖缝已经达到材料要求的干燥条件。',
  '砖缝内的水泥、灰尘、油污和积水已经清理，清缝深度满足所用材料要求。',
  '美缝填充连续、饱满，没有明显漏打、断点、气泡、凹陷和开裂。',
  '美缝表面平滑，宽度基本一致，十字交接、阴阳角和收尾位置处理完整。',
  '同一区域颜色和光泽基本一致，砖面没有明显残胶、污染、划伤和崩边。',
  '墙地转角、门槛、管根及需要伸缩的位置，按照设计和材料要求使用适合的填缝或密封材料。',
  '达到规定固化时间后，美缝没有明显脱落、松动和软化；固化前避免踩踏、沾水和污染。',
  '按房间拍摄颜色样板、清缝情况、完成效果和问题整改结果。'
 ]},
 {id:'st-install',name:'安装与收口',trade:'安装工',checks:[
  '门、柜体、洁具、灯具、开关插座、五金及其他安装产品的品牌、型号、颜色和数量与项目约定一致。',
  '室内门、门套和五金安装牢固，门扇开启、关闭和锁具使用顺畅，没有明显碰擦及异常缝隙。',
  '橱柜、衣柜和其他定制柜体安装牢固，位置及尺寸正确，柜门和抽屉开关顺畅。',
  '马桶、台盆、花洒、龙头、地漏及卫浴五金安装牢固，通水和排水正常，没有渗漏。',
  '开关、插座、灯具及面板安装端正、牢固，控制关系正确，通电检查没有异常。',
  '木地板、踢脚线、门槛石和压条安装平整、牢固，接缝及转角收口完整。',
  '空调风口、电器、窗帘和其他设备的安装位置与预留接口匹配，没有遮挡检修口。',
  '柜体、墙面、台面、洁具及门窗周边的打胶连续、整齐，没有明显漏打、开裂和污染。',
  '墙面、地面、顶面及不同材料交接位置收口完整，没有明显孔洞、裸露基层和松动部件。',
  '按房间和安装类别拍摄完成效果、功能测试以及问题整改结果。'
 ]},
 {id:'st-clean',name:'保洁阶段',trade:'保洁工',checks:[
  '施工工具、包装、剩余材料及装修垃圾已经清理，公共通道和电梯等区域没有遗留垃圾。',
  '墙面、顶面、地面、瓷砖、木地板和踢脚线表面没有明显积灰和污渍。',
  '涂料、胶渍、水泥和保护膜等施工残留已经清除，没有因清洁造成划伤、腐蚀或掉色。',
  '门窗、玻璃、窗槽、柜体、抽屉及台面内外清洁，没有明显灰尘和杂物。',
  '马桶、台盆、龙头、镜面、花洒和地漏清洁，排水口没有被清洁垃圾堵塞。',
  '灯具、开关插座面板、电器表面和空调风口清洁，没有积灰、水渍及清洁剂残留。',
  '清洁完成后，各房间能够正常进入和检查，检修口、开关、插座、地漏及设备没有被遮挡。',
  '保洁时发现的划伤、裂缝、松动、渗漏和其他施工问题，需要拍照并转为现场问题，不能用清洁处理代替整改。',
  '按房间拍摄保洁后的全景和重点位置，记录遗留物品、未完成区域及问题整改结果。'
 ]},
 {id:'st-final',name:'竣工验收与交付',trade:'管家',submitterRole:'keeper',kind:'final',checks:[
  '前面 10 个施工阶段都已经由主业主确认通过。',
  '项目内全部问题均已处理结束，不允许保留未解决问题完成交付。',
  '按施工图、效果图、合同和变更记录进行全屋检查，没有明显漏做、错做或未完成项目。',
  '给水、排水、开关、插座、灯具、门窗、洁具、柜体及相关设备完成最终功能检查。',
  '项目内应确认的材料批次均已由主业主确认，不存在“待补拍”或“待确认”材料。',
  '水电管线图、设计变更、隐蔽工程影像、打压记录、闭水记录和各阶段验收记录齐全。',
  '材料及设备的说明书、合格证明、保修凭证、型号信息和售后联系方式已经整理。',
  '钥匙、门禁卡、遥控器、备用五金及其他交付物品按清单移交，并记录数量。',
  {id:'st-final-c10',text:'按房间拍摄竣工全景和重点设施，记录交付日期、参与人员及最终验收意见。'}
 ]}
].map((stage,index)=>({...stage,order:index+1,submitterRole:stage.submitterRole||'worker',checks:stage.checks.map((check,i)=>typeof check==='string'?{id:`${stage.id}-c${i+1}`,text:check}:{id:check.id||`${stage.id}-c${i+1}`,text:check.text})}));

const event=(by,text,time='09-15 09:30')=>({by,text,time});
const stageRecord=(template,overrides={})=>({id:template.id,name:template.name,trade:template.trade,order:template.order,kind:template.kind||'',submitterRole:template.submitterRole,checklist:structuredClone(template.checks),status:'planned',description:template.kind==='final'?'管家完成竣工检查后直接提交主业主确认。':'施工完成后由师傅申请、管家检查并提交、主业主最终确认。',applications:[],media:[],waterproofNodes:[],submission:null,snapshots:[],history:[],...overrides});
const canonicalStages=(overrides={})=>STAGE_TEMPLATES.map(t=>stageRecord(t,overrides[t.id]||{}));

export function seed(){return {
 version:1,stageAcceptancePolicy:2,mediaPolicy:2,stageCatalogPolicy:2,finalChecklistPolicy:1,teamRolePolicy:1,extraPolicy:1,waterproofNodePolicy:1,projects:[{
  id:'p1',name:'云栖花园 · 3栋1202',area:'128㎡',layout:'三室两厅',start:'2026-08-29',keeper:'陈管家',status:'施工中',
  members:[{id:'director',name:'周负责人',role:'director'},{id:'keeper',name:'陈管家',role:'keeper'},{id:'designer',name:'沈设计师',role:'designer'},{id:'owner',name:'林女士',role:'owner'},{id:'family',name:'林先生',role:'family'},{id:'w1',name:'张师傅',role:'worker',trade:'水电工'},{id:'w2',name:'李师傅',role:'worker',trade:'泥瓦工'},{id:'w3',name:'王师傅',role:'worker',trade:'木工'},{id:'w4',name:'赵师傅',role:'worker',trade:'油漆工'},{id:'w5',name:'孙师傅',role:'worker',trade:'拆改工'},{id:'w6',name:'吴师傅',role:'worker',trade:'防水工'},{id:'w7',name:'郑师傅',role:'worker',trade:'美缝工'},{id:'w8',name:'冯师傅',role:'worker',trade:'安装工'},{id:'w9',name:'钱师傅',role:'worker',trade:'保洁工'}],
  applications:[{id:'a1',name:'刘师傅',role:'worker',trade:'泥瓦工',status:'pending'}],
  schedules:[{id:'s1',trade:'水电工',worker:'w1',start:'2026-09-05',end:'2026-09-17',excluded:[],remaining:'主卫给水管路、打压检查',progress:75,history:[]},{id:'s2',trade:'泥瓦工',worker:'w2',start:'2026-09-18',end:'2026-09-29',excluded:[],remaining:'砌墙、泥瓦铺贴',progress:0,history:[]},{id:'s3',trade:'木工',worker:'w3',start:'2026-09-25',end:'2026-10-05',excluded:[],remaining:'吊顶基层、柜体衔接',progress:0,history:[]},{id:'s4',trade:'油漆工',worker:'w4',start:'2026-10-06',end:'2026-10-16',excluded:[],remaining:'墙面基层、乳胶漆施工',progress:0,history:[]}],
  availability:[],feed:[{id:'f1',worker:'w1',name:'张师傅',trade:'水电工',date:TODAY,time:'11:20',location:'厨房 / 主卫',text:'厨房插座定位已完成，主卫给水管路铺设中。明天进行打压检查。',remaining:'主卫给水管路、打压检查',expected:'2026-09-17',media:[],sample:true}],
  issues:[{id:'i1',title:'厨房插座位置偏低',location:'厨房',stage:'st1',description:'厨房台面插座位置与当前图纸不一致，请检查调整。',status:'review',worker:'w1',deadline:'2026-09-16',media:[],history:[event('林女士','提出问题：厨房插座位置偏低','09-13 10:12'),event('陈管家','检查后安排张师傅按当前图纸调整，9月16日前完成。','09-13 15:30'),event('张师傅','已按当前图纸调整插座位置，申请业主验收。（示例记录）','09-15 10:20')]},{id:'i2',title:'主卫管道固定点待补充',location:'主卫',stage:'st1',description:'转角位置的固定情况需要管家检查。',status:'checking',worker:'',deadline:'',media:[],history:[event('林先生','提出问题：请检查主卫转角管道固定情况。','09-15 11:45')]},{id:'i3',title:'客厅预留线头是否需要整理',location:'客厅',stage:'st1',description:'现场有预留线头，想确认后续处理方式。',status:'explanation',worker:'',deadline:'',media:[],history:[event('林女士','提出问题：客厅预留线头是否需要整理。','09-14 13:10'),event('陈管家','目前为后续安装预留，已做临时保护。暂无需改动，请业主确认说明。（示例，非施工标准）','09-15 09:30')]}],
  stages:canonicalStages({st1:{status:'review',description:'已提交阶段完成资料示例；新版清单用于后续重新提交。',history:[event('张师傅','提交水电阶段验收资料（示例）','09-15 12:00')]},st2:{description:'泥瓦铺贴阶段，正式美缝另行验收。'},st3:{description:'吊顶、基层与安装衔接。'}}),
  materials:[{id:'m1',name:'给水管及配件',brand:'示例品牌 A',spec:'PPR 管材及配套管件',quantity:'80',unit:'米',date:'2026-09-14',location:'厨房 / 主卫',status:'pending',media:[],history:[event('陈管家','登记第 1 批材料到场','09-14 09:10')]},{id:'m2',name:'给水管补送',brand:'示例品牌 A',spec:'同规格补送管材',quantity:'12',unit:'米',date:TODAY,location:'主卫',status:'pending',media:[],history:[event('陈管家','登记第 2 批补送，单独提交确认','09-15 09:20')]}],
  designs:[{id:'d1',name:'全屋施工图',version:'V2',current:true,room:'全屋',kind:'drawing',files:[{name:'全屋施工图_V2.pdf',kind:'pdf',sample:true},{name:'全屋施工图_V2.dwg',kind:'dwg',sample:true}],date:'2026-09-12'},{id:'d0',name:'全屋施工图',version:'V1',current:false,room:'全屋',kind:'drawing',files:[{name:'全屋施工图_V1.pdf',kind:'pdf',sample:true},{name:'全屋施工图_V1.dwg',kind:'dwg',sample:true}],date:'2026-08-26'},{id:'d2',name:'客厅设计效果 · 用户提供样例',version:'样例',current:true,room:'客厅',kind:'effect',files:[{name:'盛世港府分享海报.png',kind:'image',url:'./assets/design-poster.png'}],date:TODAY},{id:'d3',name:'盛世港府 · 720°全景样例',version:'样例',current:true,room:'全屋',kind:'panorama',url:PANORAMA,files:[],date:TODAY}],extras:[],afterSales:[]
 },{id:'p2',name:'湖畔新居 · 1栋802',area:'96㎡',layout:'两室两厅',start:'2026-09-21',keeper:'何管家',status:'筹备中',members:[{id:'director',name:'周负责人',role:'director'},{id:'keeper2',name:'何管家',role:'keeper'}],applications:[],schedules:[],availability:[],feed:[],issues:[],stages:canonicalStages(),materials:[],designs:[],extras:[],afterSales:[]}]
};}

export function actorId(actor){return actor.role==='worker'?actor.worker:actor.role;}
export function visibleProjects(state,actor){return state.projects.filter(p=>actor.role==='director'||p.members.some(m=>m.id===actorId(actor)&&m.role===actor.role));}
export function getProject(state,id,actor){const p=visibleProjects(state,actor).find(p=>p.id===id);if(!p)throw Error('当前身份没有这个项目的访问权限');return p;}
export function member(p,actor){return p.members.find(m=>m.id===actorId(actor))||{name:'周负责人',role:'director'};}
export function unresolved(p,stage){return p.issues.filter(i=>i.stage===stage&&!['closed','acknowledged'].includes(i.status));}

export function migrateStageCatalog(state){
 if(state.stageCatalogPolicy===2)return {state,changed:false,addedStages:0};
 const next=structuredClone(state);let addedStages=0;
 for(const p of next.projects){
  const oldStages=Array.isArray(p.stages)?p.stages:[],byId=new Map(oldStages.map(s=>[s.id,s]));
  const stages=STAGE_TEMPLATES.map(template=>{const old=byId.get(template.id);if(!old){addedStages++;return stageRecord(template);}return {...old,id:template.id,name:template.name,trade:template.trade,order:template.order,kind:template.kind||'',submitterRole:template.submitterRole,checklist:structuredClone(template.checks),applications:old.applications||[],media:old.media||[],submission:old.submission||null,snapshots:old.snapshots||[],history:old.history||[]};});
  const canonicalIds=new Set(STAGE_TEMPLATES.map(s=>s.id));p.stages=[...stages,...oldStages.filter(s=>!canonicalIds.has(s.id))];p.afterSales=Array.isArray(p.afterSales)?p.afterSales:[];
  if(p.id==='p1')for(const [id,name,trade] of [['w5','孙师傅','拆改工'],['w6','吴师傅','防水工'],['w7','郑师傅','美缝工'],['w8','冯师傅','安装工'],['w9','钱师傅','保洁工']])if(!p.members.some(m=>m.id===id))p.members.push({id,name,role:'worker',trade});
 }
 next.stageCatalogPolicy=2;return {state:next,changed:true,addedStages};
}
export function migrateFinalChecklistPolicy(state){
 if(state.finalChecklistPolicy===1)return {state,changed:false};
 const next=structuredClone(state),checks=STAGE_TEMPLATES.find(stage=>stage.id==='st-final').checks;
 for(const p of next.projects||[])for(const stage of p.stages||[])if(stage.id==='st-final')stage.checklist=structuredClone(checks);
 next.finalChecklistPolicy=1;
 return {state:next,changed:true};
}
export function migrateStageAcceptancePolicy(state,time=new Date().toLocaleString('zh-CN',{hour12:false})){
 if(state.stageAcceptancePolicy===2)return {state,changed:false,restoredStages:0};const next=structuredClone(state);let restoredStages=0;
 for(const p of next.projects)for(const s of p.stages||[]){const previouslyAcceptedWithIssues=(s.snapshots||[]).some(snapshot=>snapshot.issues?.length>0);if(s.status==='passed'&&(unresolved(p,s.id).length>0||previouslyAcceptedWithIssues)){s.status='review';(s.history??=[]).push(event('规则更新','阶段现须先处理完全部关联问题，再由主业主确认通过。旧规则下的阶段通过已恢复为待验收，原验收记录保留。',time));restoredStages++;}}
 next.stageAcceptancePolicy=2;return {state:next,changed:true,restoredStages};
}
export function migrateMediaPolicy(state){if(state.mediaPolicy===2)return {state,changed:false};const next=structuredClone(state);next.mediaPolicy=2;return {state:next,changed:true};}
export function migrateTeamRolePolicy(state){
 if(state.teamRolePolicy===1)return {state,changed:false,addedDesigners:0};
 const next=structuredClone(state);let addedDesigners=0;
 for(const p of next.projects||[])if(p.id==='p1'&&!p.members?.some(m=>m.role==='designer')){p.members??=[];p.members.push({id:'designer',name:'沈设计师',role:'designer'});addedDesigners++;}
 next.teamRolePolicy=1;return {state:next,changed:true,addedDesigners};
}
export function migrateExtraPolicy(state){
 if(state.extraPolicy===1)return {state,changed:false};
 const next=structuredClone(state);
 for(const p of next.projects||[]){p.extras=Array.isArray(p.extras)?p.extras:[];for(const m of p.members||[])if(['family','designer'].includes(m.role))m.extraPriceAuthorized=!!m.extraPriceAuthorized;}
 next.extraPolicy=1;return {state:next,changed:true};
}
export function migrateWaterproofNodePolicy(state){
 if(state.waterproofNodePolicy===1)return {state,changed:false};
 const next=structuredClone(state);
 for(const p of next.projects||[])for(const s of p.stages||[])if(s.kind==='waterproof'||s.id==='st-waterproof')s.waterproofNodes=Array.isArray(s.waterproofNodes)?s.waterproofNodes:[];
 next.waterproofNodePolicy=1;return {state:next,changed:true};
}

export function dailyStatus(p,s,date=TODAY){if(date<s.start||date>s.end||(s.excluded||[]).includes(date))return '未安排施工';return p.feed.some(f=>f.trade===s.trade&&f.date===date&&(f.publisherRole||'worker')==='worker')?'今日已更新':'今日待更新';}
export function onsiteEvidenceCounts(media=[]){return {photos:media.filter(x=>x?.kind==='image'&&x.source==='capture').length,videos:media.filter(x=>x?.kind==='video'&&x.source==='capture').length};}
export function dailyEvidenceReady(media=[]){const counts=onsiteEvidenceCounts(media);return counts.photos>=3||counts.videos>=1;}
export function stageEvidenceReady(media=[]){return onsiteEvidenceCounts(media).photos>=3;}
export function materialEvidenceReady(media=[]){const counts=onsiteEvidenceCounts(media);return counts.photos>=3&&counts.videos>=1;}
export function pendingCounts(p){return {issues:p.issues.filter(i=>['review','explanation'].includes(i.status)).length,stages:p.stages.filter(s=>s.status==='review').length,materials:p.materials.filter(m=>m.status==='pending'&&materialEvidenceReady(m.media)).length,extras:(p.extras||[]).filter(x=>['extra_pending','extra_review','extra_cancel_pending','extra_settlement'].includes(x.status)).length};}
export function extraVisibleToActor(extra,actor){return actor.role!=='worker'||(extra.confirmedVersion===extra.version&&extra.worker===actor.worker&&!!extra.start&&!!extra.end);}
export function createFinalTrialState(source){const next=structuredClone(source),p=next.projects.find(project=>project.id==='p1');if(!p)throw Error('没有可用于竣工试用的演示项目');if(p.status==='已完工')throw Error('原项目已完工，请使用未完工项目试用竣工流程');p.finalTrial={kind:'final-flow',sourceName:p.name,actualBlockers:finalStageBlockers(p)};p.name+=' · 竣工试用副本';return next;}
export function finalStageBlockers(p){if(p.finalTrial?.kind==='final-flow')return [];const previous=STAGE_TEMPLATES.filter(s=>s.kind!=='final').map(t=>p.stages.find(s=>s.id===t.id)).filter(s=>s?.status!=='passed'),issues=p.issues.filter(i=>!['closed','acknowledged'].includes(i.status)),materials=p.materials.filter(m=>m.status!=='confirmed'||!materialEvidenceReady(m.media)),blockers=[];if(previous.length)blockers.push(`前面还有 ${previous.length} 个阶段未通过`);if(issues.length)blockers.push(`还有 ${issues.length} 个项目问题未处理结束`);if(materials.length)blockers.push(`还有 ${materials.length} 个材料批次未确认或需补拍`);return blockers;}

function requireRole(actor,...roles){if(!roles.includes(actor.role))throw Error('当前身份不能执行此操作');}
function required(value,label){if(typeof value!=='string'||!value.trim())throw Error(`请填写${label}`);return value.trim();}
function dateValue(value,label){required(value,label);if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value)))throw Error(`${label}格式不正确`);return value;}
function dateTimeValue(value,label){required(value,label);const parsed=Date.parse(value);if(Number.isNaN(parsed))throw Error(`${label}格式不正确`);return {value,parsed};}
function find(list,id){const x=list.find(x=>x.id===id);if(!x)throw Error('未找到这条记录');return x;}
function expect(x,...states){if(!states.includes(x.status))throw Error('记录状态已变化，请重新查看');}
function mediaRequired(data){if(!Array.isArray(data.media)||!data.media.length)throw Error('请至少提供一张照片或一段视频');return data.media;}
function mixedEvidenceRequired(data){const media=mediaRequired(data);if(media.some(x=>!['image','video'].includes(x?.kind)||!['capture','upload'].includes(x?.source)))throw Error('问题资料只支持现场拍摄或本机上传的照片和视频');return media;}
function onsiteEvidenceRequired(data){const media=mediaRequired(data);if(!media.some(x=>['image','video'].includes(x?.kind)&&x.source==='capture'))throw Error('请使用现场拍摄的照片或视频');if(media.some(x=>x.source!=='capture'||!['image','video'].includes(x?.kind)))throw Error('此处只接受现场拍摄的照片和视频');return media;}
function dailyEvidenceRequired(data){const media=onsiteEvidenceRequired(data);if(!dailyEvidenceReady(media))throw Error('请现场拍摄至少 3 张照片，或录制 1 段视频');return media;}
function stageEvidenceRequired(data){const media=onsiteEvidenceRequired(data);if(!stageEvidenceReady(media))throw Error('阶段验收必须现场拍摄至少 3 张照片；视频可以补充，但不能代替照片');return media;}
function materialEvidenceRequired(media){if(!materialEvidenceReady(media))throw Error('请现场拍摄至少 3 张照片，并录制 1 段视频');if(media.some(x=>x.source!=='capture'||!['image','video'].includes(x?.kind)))throw Error('材料进场资料只接受现场拍摄的照片和视频');return media;}
function nonNegative(value,label){const n=Number(value);if(!Number.isFinite(n)||n<0)throw Error(`${label}不能小于 0`);return Math.round(n*100)/100;}
function extraEvidenceRequired(data){const evidence=[...(data.media||[]),...(data.files||[])];if(!evidence.length)throw Error('请至少提供现场照片、报价单或相关图纸中的一项依据');if(evidence.some(x=>!['image','pdf','dwg','file'].includes(x?.kind)))throw Error('增项依据只支持现场照片、报价单、说明文件或相关图纸');return evidence;}
function extraSnapshot(data,version,evidence){const materialCost=nonNegative(data.materialCost,'材料费'),laborCost=nonNegative(data.laborCost,'人工费'),delayDays=nonNegative(data.delayDays,'延期天数');return {version,name:required(data.name,'增项名称'),location:required(data.location,'施工位置'),stage:required(data.stage,'所属阶段'),reason:required(data.reason,'增项原因／类别'),content:required(data.content,'施工内容'),materialCost,laborCost,totalCost:Math.round((materialCost+laborCost)*100)/100,delayDays,evidence};}
function checklistRequired(stage,checks){const selected=new Set(Array.isArray(checks)?checks:[]),missing=stage.checklist.filter(c=>!selected.has(c.id));if(missing.length)throw Error(`请完成本阶段全部验收检查项，还差 ${missing.length} 项`);return stage.checklist.map(c=>c.id);}
function waterproofNodesRequired(stage){const records=stage.waterproofNodes||[],byId=new Map(records.map(record=>[record.id,record]));if(WATERPROOF_NODE_TEMPLATES.some(node=>!byId.has(node.id)))throw Error(`请先完成全部 5 个防水节点记录，当前已完成 ${records.length}/5`);const firstStart=byId.get('first-start'),firstEnd=byId.get('first-end'),secondStart=byId.get('second-start'),secondEnd=byId.get('second-end'),firstHours=(Date.parse(firstEnd.occurredAt)-Date.parse(firstStart.occurredAt))/3600000,secondHours=(Date.parse(secondEnd.occurredAt)-Date.parse(secondStart.occurredAt))/3600000;if(firstHours<72)throw Error('第一次闭水试验时间不得少于 72 小时');if(secondHours<48)throw Error('第二次闭水试验时间不得少于 48 小时');return {firstStart:firstStart.occurredAt,firstEnd:firstEnd.occurredAt,firstHours,firstWaterLevel:firstEnd.note,backfillConfirmed:true,secondWaterproofConfirmed:true,secondStart:secondStart.occurredAt,secondEnd:secondEnd.occurredAt,secondHours,secondWaterLevel:secondEnd.note,nodeIds:WATERPROOF_NODE_TEMPLATES.map(node=>node.id)};}
function uid(prefix){return prefix+Math.random().toString(36).slice(2,10);}

export function applyAction(state,actor,projectId,action,data={}){
 const next=structuredClone(state),p=getProject(next,projectId,actor),who=member(p,actor).name,time=new Date().toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}),log=(x,text)=>(x.history??=[]).push(event(who,text,time));let resultId=data.id;
 if(p.status==='已完工'&&!['createProject','reportWarranty','followupWarranty','closeWarranty','commentWarranty'].includes(action))throw Error('项目已完工，施工与验收记录已归档；如有新问题请建立售后／保修记录');
 switch(action){
 case 'createProject':{requireRole(actor,'director');const name=required(data.name,'项目名称'),keeper=required(data.keeper,'管家'),id=uid('p');next.projects.push({id,name,keeper,area:required(data.area,'面积'),layout:data.layout||'户型待补充',start:dateValue(data.start,'计划开工日'),status:'筹备中',members:[{id:'director',name:who,role:'director'},{id:keeper==='陈管家'?'keeper':'keeper2',name:keeper,role:'keeper'}],applications:[],schedules:[],availability:[],feed:[],issues:[],stages:canonicalStages(),materials:[],designs:[],extras:[],afterSales:[]});resultId=id;break;}
 case 'publishDaily':{requireRole(actor,'worker');const me=member(p,actor),text=required(data.text,'施工说明'),media=dailyEvidenceRequired(data),s=p.schedules.find(s=>s.trade===me.trade),remaining=s?.remaining||'待管家补充施工安排',expected=s?.end||'';p.feed.unshift({id:uid('f'),worker:actor.worker,name:who,trade:me.trade,publisherRole:'worker',recordType:'construction',date:TODAY,time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}),location:required(data.location,'施工位置'),text,media,remaining,expected});break;}
 case 'publishKeeperProgress':{requireRole(actor,'keeper');const stage=find(p.stages,data.stage);if(stage.kind==='final')throw Error('竣工验收请使用阶段验收流程');const text=required(data.text,'巡检说明'),media=dailyEvidenceRequired(data),s=p.schedules.find(item=>item.trade===stage.trade);p.feed.unshift({id:uid('f'),worker:'',name:who,trade:stage.trade,stage:stage.id,stageName:stage.name,publisherRole:'keeper',recordType:'keeper-inspection',date:TODAY,time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}),location:required(data.location,'施工位置'),text,media,remaining:'管家现场巡检',expected:s?.end||''});break;}
 case 'reportIssue':{const issueMedia=data.media?.length?(data.media.some(x=>!['image','video'].includes(x?.kind)||!['capture','upload'].includes(x?.source))?(()=>{throw Error('问题资料只支持现场拍摄或本机上传的照片和视频');})():data.media):[],issue={id:uid('i'),title:required(data.title,'问题标题'),description:required(data.description,'问题描述'),location:required(data.location,'问题位置'),stage:data.stage||'',status:'checking',worker:'',deadline:'',media:issueMedia,history:[event(who,'提出问题：'+data.description,time)]};if(data.stage&&!p.stages.some(s=>s.id===data.stage))throw Error('阶段不存在');p.issues.unshift(issue);resultId=issue.id;break;}
 case 'assignIssue':{requireRole(actor,'keeper');const i=find(p.issues,data.id);expect(i,'checking','working');const w=p.members.find(m=>m.id===data.worker&&m.role==='worker');if(!w)throw Error('请选择责任师傅');i.worker=w.id;i.deadline=dateValue(data.deadline,'整改截止日期');i.status='working';log(i,`安排${w.name}整改：${required(data.note,'整改要求')}；约定 ${i.deadline} 完成。`);break;}
 case 'explainIssue':{requireRole(actor,'keeper');const i=find(p.issues,data.id);expect(i,'checking','working');i.status='explanation';log(i,'认为无需整改，提交主业主确认：'+required(data.note,'检查说明与依据'));break;}
 case 'submitRectification':{requireRole(actor,'worker');const i=find(p.issues,data.id);expect(i,'working');if(i.worker!==actor.worker)throw Error('仅责任师傅可以提交本项整改');const note=required(data.note,'整改说明'),media=mixedEvidenceRequired(data);i.media.push(...media);i.status='review';log(i,'提交整改结果，申请主业主验收：'+note);break;}
 case 'acceptIssue':case 'rejectIssue':{requireRole(actor,'owner');const i=find(p.issues,data.id);expect(i,'review','explanation');const explanation=i.status==='explanation';if(action==='acceptIssue'){i.status=explanation?'acknowledged':'closed';log(i,explanation?'主业主认可无需整改说明，结束反馈。':'主业主验收通过，问题已解决。');}else{i.status='checking';log(i,(explanation?'对说明仍有异议':'整改验收不通过')+'，交管家跟进：'+required(data.note,'原因'));}break;}
 case 'commentIssue':{const i=find(p.issues,data.id);log(i,'留言：'+required(data.note,'留言'));break;}
 case 'requestStageAcceptance':{const s=find(p.stages,data.id);if(s.kind==='final')throw Error('竣工验收由管家直接提交');expect(s,'active','planned','returned');requireRole(actor,'worker');if(member(p,actor).trade!==s.trade)throw Error('请由该工种师傅申请验收');const note=required(data.note,'施工完成说明'),media=stageEvidenceRequired(data),counts=onsiteEvidenceCounts(media),application={time,by:who,note,media,photos:counts.photos,videos:counts.videos,outcome:'pending'};(s.applications??=[]).push(application);s.description=note;s.status='applied';log(s,`施工完成并现场拍摄 ${counts.photos} 张照片，申请管家验收：${note}`);break;}
 case 'returnStageApplication':{requireRole(actor,'keeper');const s=find(p.stages,data.id);expect(s,'applied');const note=required(data.note,'退回原因和继续施工内容'),application=(s.applications||[]).at(-1);if(application)Object.assign(application,{outcome:'returned',resultNote:note,resultBy:who,resultTime:time});s.status='returned';log(s,'管家现场检查未通过，退回师傅继续施工：'+note);break;}
 case 'submitWaterproofNode':{requireRole(actor,'keeper');const s=find(p.stages,data.id);if(s.kind!=='waterproof')throw Error('这不是防水阶段');expect(s,'active','planned','applied');const records=s.waterproofNodes??=[],template=WATERPROOF_NODE_TEMPLATES[records.length];if(!template)throw Error('5 个防水节点已经全部完成');if(data.nodeId!==template.id)throw Error('请按顺序记录防水节点');const occurredAt=dateTimeValue(data.occurredAt,template.timeLabel).value,note=required(data.note,template.noteLabel),media=stageEvidenceRequired(data),counts=onsiteEvidenceCounts(media),candidate=[...records,{id:template.id,occurredAt}];for(let i=1;i<candidate.length;i++)if(Date.parse(candidate[i].occurredAt)<Date.parse(candidate[i-1].occurredAt))throw Error('节点时间不能早于上一节点');if(template.id==='first-end'&&(Date.parse(occurredAt)-Date.parse(records[0].occurredAt))/3600000<72)throw Error('第一次闭水试验时间不得少于 72 小时');if(template.id==='second-end'&&(Date.parse(occurredAt)-Date.parse(records[3].occurredAt))/3600000<48)throw Error('第二次闭水试验时间不得少于 48 小时');records.push({id:template.id,name:template.name,occurredAt,note,media,photos:counts.photos,videos:counts.videos,by:who,time,revisions:[]});s.waterproofNodes=records;log(s,`完成防水节点 ${records.length}/5“${template.name}”，现场拍摄 ${counts.photos} 张照片。`);break;}
 case 'correctWaterproofNode':{requireRole(actor,'keeper');const s=find(p.stages,data.id);if(s.kind!=='waterproof')throw Error('这不是防水阶段');expect(s,'active','planned','applied');const records=s.waterproofNodes??[],index=records.findIndex(record=>record.id===data.nodeId);if(index<0)throw Error('未找到防水节点记录');const template=WATERPROOF_NODE_TEMPLATES[index],occurredAt=dateTimeValue(data.occurredAt,template.timeLabel).value,note=required(data.note,template.noteLabel),media=stageEvidenceRequired(data),reason=required(data.reason,'更正原因'),candidate=records.map((record,i)=>({...record,occurredAt:i===index?occurredAt:record.occurredAt}));for(let i=1;i<candidate.length;i++)if(Date.parse(candidate[i].occurredAt)<Date.parse(candidate[i-1].occurredAt))throw Error('节点时间必须按施工顺序排列');const byId=new Map(candidate.map(record=>[record.id,record]));if(byId.has('first-start')&&byId.has('first-end')&&(Date.parse(byId.get('first-end').occurredAt)-Date.parse(byId.get('first-start').occurredAt))/3600000<72)throw Error('第一次闭水试验时间不得少于 72 小时');if(byId.has('second-start')&&byId.has('second-end')&&(Date.parse(byId.get('second-end').occurredAt)-Date.parse(byId.get('second-start').occurredAt))/3600000<48)throw Error('第二次闭水试验时间不得少于 48 小时');const record=records[index],counts=onsiteEvidenceCounts(media);record.revisions??=[];record.revisions.push({occurredAt:record.occurredAt,note:record.note,media:record.media,photos:record.photos,videos:record.videos,by:record.by,time:record.time,correctedBy:who,correctedAt:time,reason});Object.assign(record,{occurredAt,note,media,photos:counts.photos,videos:counts.videos,by:who,time});log(s,`更正防水节点“${template.name}”：${reason}；旧记录保留。`);break;}
 case 'submitStage':{const s=find(p.stages,data.id);requireRole(actor,'keeper');if(s.kind==='final')expect(s,'active','planned');else expect(s,'applied');const checks=checklistRequired(s,data.checks),waterproof=s.kind==='waterproof'?waterproofNodesRequired(s):null,media=s.kind==='waterproof'?(s.waterproofNodes||[]).at(-1)?.media||[]:stageEvidenceRequired(data),note=required(data.note,s.kind==='final'?'竣工验收说明':'管家现场验收说明');if(s.kind==='waterproof')stageEvidenceRequired({media});if(s.kind==='final'){const blockers=finalStageBlockers(p);if(blockers.length)throw Error('暂不能提交竣工验收：'+blockers.join('；'));}else{const application=(s.applications||[]).at(-1);if(application)Object.assign(application,{outcome:'submitted',resultBy:who,resultTime:time});}const counts=onsiteEvidenceCounts(media);s.description=note;s.media.push(...media);s.submission={time,by:who,note,checks,waterproof,photos:counts.photos,videos:counts.videos};s.status='review';log(s,s.kind==='waterproof'?`管家完成 ${checks.length} 项检查和全部 5 个防水节点记录，复用第 5 节点 ${counts.photos} 张照片提交主业主验收：${note}`:`管家完成 ${checks.length} 项检查并现场拍摄 ${counts.photos} 张照片，提交主业主验收：${note}`);break;}
 case 'followupStage':{requireRole(actor,'keeper');const s=find(p.stages,data.id);expect(s,'rejected');const note=required(data.note,'处理安排');s.status=s.kind==='final'?'active':'returned';log(s,s.kind==='final'?'管家跟进并完善竣工资料：'+note:'管家根据主业主意见安排师傅继续施工：'+note);break;}
 case 'acceptStage':{requireRole(actor,'owner');const s=find(p.stages,data.id);expect(s,'review');const open=unresolved(p,s.id);if(open.length)throw Error(`本阶段还有 ${open.length} 项问题未处理结束，请逐项确认后再通过阶段验收`);if(s.kind==='final'){const blockers=finalStageBlockers(p);if(blockers.length)throw Error('暂不能通过竣工验收：'+blockers.join('；'));}s.status='passed';s.snapshots.push({time,by:who,issues:[],checks:s.submission?.checks||[],waterproof:s.submission?.waterproof||null});log(s,'全部关联问题已处理结束，主业主确认阶段验收通过。');if(s.kind==='final'){p.status='已完工';p.completedAt=time;log(s,'项目状态已转为“已完工”，原施工与验收记录归档保留。');}break;}
 case 'rejectStage':{requireRole(actor,'owner');const s=find(p.stages,data.id);expect(s,'review');s.status='rejected';log(s,'主业主不通过，交管家跟进：'+required(data.note,'不通过原因'));break;}
 case 'addMaterial':{requireRole(actor,'keeper');const quantity=required(data.quantity,'数量');if(!(Number(quantity)>0))throw Error('数量应大于 0');const media=materialEvidenceRequired(data.media||[]),m={id:uid('m'),name:required(data.name,'材料名称'),brand:required(data.brand,'品牌'),spec:required(data.spec,'型号规格'),quantity,unit:required(data.unit,'单位'),date:dateValue(data.date,'进场日期'),location:required(data.location,'使用位置'),status:'pending',media,history:[event(who,'登记新批次并提交主业主确认',time)]};p.materials.push(m);resultId=m.id;break;}
 case 'acceptMaterial':case 'rejectMaterial':{requireRole(actor,'owner');const m=find(p.materials,data.id);expect(m,'pending');if(action==='acceptMaterial'){materialEvidenceRequired(m.media||[]);m.status='confirmed';log(m,'主业主确认本批材料信息及到货情况。');}else{m.status='problem';log(m,'主业主提出问题，交管家处理：'+required(data.note,'问题说明'));}break;}
 case 'supplementMaterialEvidence':{requireRole(actor,'keeper');const m=find(p.materials,data.id);expect(m,'pending');const media=onsiteEvidenceRequired(data);materialEvidenceRequired([...(m.media||[]),...media]);m.media.push(...media);log(m,'补齐现场影像：至少 3 张现场照片和 1 段现场视频。');break;}
 case 'resubmitMaterial':{requireRole(actor,'keeper');const m=find(p.materials,data.id);expect(m,'problem');const media=materialEvidenceRequired(data.media||[]);m.status='pending';m.media.push(...media);log(m,'管家完成处理，并用最新现场影像重新提交主业主确认：'+required(data.note,'处理说明'));break;}
 case 'editMaterial':{requireRole(actor,'keeper');const m=find(p.materials,data.id);expect(m,'pending','problem');const before=`${m.name} / ${m.brand} / ${m.spec} / ${m.quantity}${m.unit} / ${m.date} / ${m.location}`,quantity=required(data.quantity,'数量');if(!(Number(quantity)>0))throw Error('数量应大于 0');for(const [k,label] of [['name','材料名称'],['brand','品牌'],['spec','型号规格'],['unit','单位'],['location','使用位置']])m[k]=required(data[k],label);m.quantity=quantity;m.date=dateValue(data.date,'进场日期');m.media.push(...(data.media||[]));log(m,'更正批次资料。更正前：'+before+'；原因：'+required(data.note,'更正原因'));break;}
 case 'saveSchedule':{requireRole(actor,'keeper');const start=dateValue(data.start,'开始日期'),end=dateValue(data.end,'结束日期');if(end<start)throw Error('结束日期不能早于开始日期');const w=p.members.find(m=>m.id===data.worker&&m.role==='worker');if(!w||w.trade!==data.trade)throw Error('主要上传责任人必须属于该工种');const excluded=(data.excluded||'').split(/[,，\s]+/).filter(Boolean);excluded.forEach(d=>dateValue(d,'停工日期'));if(excluded.some(d=>d<start||d>end))throw Error('停工日期应在安排范围内');let s=data.id?find(p.schedules,data.id):null;if(!s&&p.schedules.some(s=>s.trade===data.trade))throw Error('该工种已有安排，请修改现有安排');const before=s?`${s.start} 至 ${s.end}，原责任人 ${p.members.find(m=>m.id===s.worker)?.name}`:'新增施工安排';if(!s){s={id:uid('s'),progress:0,history:[]};p.schedules.push(s);}Object.assign(s,{trade:data.trade,worker:data.worker,start,end,excluded,remaining:required(data.remaining,'施工内容')});log(s,`${before} → ${start} 至 ${end}，责任人 ${w.name}。${excluded.length?'停工：'+excluded.join('、'):''}`);if(data.availabilityId){const a=find(p.availability,data.availabilityId);a.status='confirmed';a.confirmedStart=start;a.confirmedEnd=end;}break;}
 case 'availability':{requireRole(actor,'worker');const available=dateValue(data.date,'可进场日期');p.availability=p.availability.filter(a=>a.worker!==actor.worker||a.status==='confirmed');p.availability.push({id:uid('av'),worker:actor.worker,trade:member(p,actor).trade,date:available,note:required(data.note,'说明'),status:'pending'});break;}
 case 'applyMember':{requireRole(actor,'keeper');if(!['worker','owner','family','designer'].includes(data.role))throw Error('请选择有效身份');p.applications.push({id:uid('a'),name:required(data.name,'申请人姓名'),role:data.role,trade:data.role==='worker'?required(data.trade,'工种'):'',status:'pending'});break;}
 case 'approveMember':{requireRole(actor,'keeper');const a=find(p.applications,data.id);expect(a,'pending');if(a.role==='owner'&&p.members.some(m=>m.role==='owner'))throw Error('每个项目只设一位主业主，当前已有主业主');a.status='approved';p.members.push({id:uid('u'),name:a.name,role:a.role,trade:a.trade||''});break;}
 case 'rejectMember':{requireRole(actor,'keeper');const a=find(p.applications,data.id);expect(a,'pending');a.status='rejected';a.note=required(data.note,'未通过原因');break;}
 case 'addExtra':{requireRole(actor,'keeper');const evidence=extraEvidenceRequired(data),snapshot=extraSnapshot(data,1,evidence);if(!p.stages.some(s=>s.id===snapshot.stage))throw Error('所属阶段不存在');const x={id:uid('x'),...snapshot,status:'extra_pending',worker:'',start:'',end:'',evidence,versions:[{...structuredClone(snapshot),time,by:who}],applications:[],submission:null,cancelRequest:null,settlement:null,history:[event(who,`登记增项 V1 及工期影响，提交主业主确认。`,time)]};p.extras.unshift(x);resultId=x.id;break;}
 case 'acceptExtraProposal':case 'rejectExtraProposal':{requireRole(actor,'owner');const x=find(p.extras,data.id);expect(x,'extra_pending');if(action==='acceptExtraProposal'){x.status='extra_confirmed';x.confirmedVersion=x.version;log(x,`主业主确认 V${x.version} 的施工内容、价格及工期影响。`);}else{x.status='extra_rejected';log(x,'主业主拒绝本版增项：'+required(data.note,'拒绝原因'));}break;}
 case 'reviseExtra':{requireRole(actor,'keeper');const x=find(p.extras,data.id);expect(x,'extra_rejected','extra_confirmed');const version=(x.version||1)+1,evidence=extraEvidenceRequired(data),snapshot=extraSnapshot(data,version,evidence);if(!p.stages.some(s=>s.id===snapshot.stage))throw Error('所属阶段不存在');Object.assign(x,snapshot,{evidence,status:'extra_pending',worker:'',start:'',end:'',cancelRequest:null});x.versions??=[];x.versions.push({...structuredClone(snapshot),time,by:who});log(x,`建立增项 V${version}，旧版本保留，重新提交主业主确认。`);break;}
 case 'scheduleExtra':{requireRole(actor,'keeper');const x=find(p.extras,data.id);expect(x,'extra_confirmed');const worker=p.members.find(m=>m.id===data.worker&&m.role==='worker');if(!worker)throw Error('请选择责任师傅');const start=dateValue(data.start,'开始日期'),end=dateValue(data.end,'结束日期');if(end<start)throw Error('结束日期不能早于开始日期');Object.assign(x,{worker:worker.id,start,end,status:'extra_working'});log(x,`安排 ${worker.name} 于 ${start} 至 ${end} 施工。`);break;}
 case 'requestExtraAcceptance':{requireRole(actor,'worker');const x=find(p.extras,data.id);expect(x,'extra_working','extra_returned');if(x.worker!==actor.worker)throw Error('仅本增项责任师傅可以申请验收');const note=required(data.note,'施工完成说明'),media=stageEvidenceRequired(data),counts=onsiteEvidenceCounts(media);x.applications??=[];x.applications.push({time,by:who,note,media,photos:counts.photos,videos:counts.videos,outcome:'pending'});x.status='extra_applied';log(x,`施工完成并现场拍摄 ${counts.photos} 张照片，申请管家验收：${note}`);break;}
 case 'returnExtraApplication':{requireRole(actor,'keeper');const x=find(p.extras,data.id);expect(x,'extra_applied');const note=required(data.note,'退回原因和继续施工内容'),application=(x.applications||[]).at(-1);if(application)Object.assign(application,{outcome:'returned',resultNote:note,resultBy:who,resultTime:time});x.status='extra_returned';log(x,'管家检查后退回师傅继续施工：'+note);break;}
 case 'submitExtraAcceptance':{requireRole(actor,'keeper');const x=find(p.extras,data.id);expect(x,'extra_applied');const note=required(data.note,'管家验收说明'),media=stageEvidenceRequired(data),counts=onsiteEvidenceCounts(media),application=(x.applications||[]).at(-1);if(application)Object.assign(application,{outcome:'submitted',resultBy:who,resultTime:time});x.submission={time,by:who,note,media,photos:counts.photos,videos:counts.videos};x.status='extra_review';log(x,`管家另拍 ${counts.photos} 张现场照片并提交主业主验收：${note}`);break;}
 case 'acceptExtraCompletion':case 'rejectExtraCompletion':{requireRole(actor,'owner');const x=find(p.extras,data.id);expect(x,'extra_review');if(action==='acceptExtraCompletion'){x.status='extra_completed';log(x,'主业主确认增项施工完成。');}else{x.status='extra_followup';log(x,'主业主验收不通过，交管家跟进：'+required(data.note,'不通过原因'));}break;}
 case 'followupExtra':{requireRole(actor,'keeper');const x=find(p.extras,data.id);expect(x,'extra_followup');x.status='extra_returned';log(x,'管家安排责任师傅继续施工：'+required(data.note,'处理安排'));break;}
 case 'cancelExtraBeforeConfirmation':{requireRole(actor,'keeper');const x=find(p.extras,data.id);expect(x,'extra_pending','extra_rejected');x.status='extra_cancelled';log(x,'管家撤回并取消增项：'+required(data.note,'取消原因'));break;}
 case 'requestExtraCancel':{requireRole(actor,'keeper');const x=find(p.extras,data.id);expect(x,'extra_confirmed');x.cancelRequest={time,by:who,note:required(data.note,'取消原因')};x.status='extra_cancel_pending';log(x,'管家申请取消已确认但未开工的增项，等待主业主确认：'+x.cancelRequest.note);break;}
 case 'acceptExtraCancel':case 'rejectExtraCancel':{requireRole(actor,'owner');const x=find(p.extras,data.id);expect(x,'extra_cancel_pending');if(action==='acceptExtraCancel'){x.status='extra_cancelled';log(x,'主业主确认取消增项。');}else{x.status='extra_confirmed';log(x,'主业主不同意取消，增项恢复为待安排施工：'+required(data.note,'不同意原因'));}break;}
 case 'requestExtraSettlement':{requireRole(actor,'keeper');const x=find(p.extras,data.id);expect(x,'extra_working','extra_returned','extra_applied','extra_followup','extra_review');const media=onsiteEvidenceRequired(data),actualCost=nonNegative(data.actualCost,'实际费用');x.settlement={time,by:who,completedQuantity:required(data.completedQuantity,'已完成工程量'),actualCost,note:required(data.note,'现场情况与结算说明'),media,previousStatus:x.status};x.status='extra_settlement';log(x,'申请按已完成工程量终止结算，等待主业主确认。');break;}
 case 'acceptExtraSettlement':case 'rejectExtraSettlement':{requireRole(actor,'owner');const x=find(p.extras,data.id);expect(x,'extra_settlement');if(action==='acceptExtraSettlement'){x.status='extra_terminated';log(x,'主业主确认终止结算。');}else{x.status=x.settlement?.previousStatus||'extra_working';log(x,'主业主不同意本次终止结算：'+required(data.note,'不同意原因'));}break;}
 case 'setExtraPriceAccess':{const target=find(p.members,data.memberId);if(target.role==='family'){requireRole(actor,'owner');}else if(target.role==='designer'){requireRole(actor,'director');}else throw Error('该成员不使用增项金额授权');target.extraPriceAuthorized=!!data.allowed;break;}
 case 'addDesign':{requireRole(actor,'director','designer');const kind=data.kind;if(!['effect','drawing','panorama'].includes(kind))throw Error('资料类型不正确');const name=required(data.name,'资料名称'),version=required(data.version,'版本');if(kind==='drawing'){const files=data.files||[];if(!files.some(f=>['pdf','dwg'].includes(f.kind)))throw Error('请至少选择一个 PDF 或 DWG 文件');if(files.some(f=>!['pdf','dwg'].includes(f.kind)))throw Error('施工图只支持 PDF 或 DWG 文件');}if(kind==='effect'&&!data.files?.length)throw Error('请选择效果图');if(kind==='panorama'){let u;try{u=new URL(data.url);}catch{throw Error('请填写完整的全景链接');}if(!['https:','http:'].includes(u.protocol))throw Error('全景链接须以 https:// 或 http:// 开头');}p.designs.filter(d=>d.name===name&&d.kind===kind).forEach(d=>d.current=false);p.designs.unshift({id:uid('d'),name,version,kind,current:true,room:required(data.room,'空间'),date:TODAY,files:data.files||[],url:data.url||''});break;}
 case 'reportWarranty':{requireRole(actor,'owner','family');if(p.status!=='已完工')throw Error('项目完工后才能建立售后／保修问题记录');const w={id:uid('w'),title:required(data.title,'问题标题'),location:required(data.location,'问题位置'),description:required(data.description,'问题描述'),status:'checking',media:data.media?.length?mixedEvidenceRequired(data):[],history:[event(who,'建立售后／保修问题：'+data.description,time)]};p.afterSales.unshift(w);resultId=w.id;break;}
 case 'followupWarranty':{requireRole(actor,'keeper');const w=find(p.afterSales,data.id);expect(w,'checking','working');w.status='working';log(w,'管家记录处理进展：'+required(data.note,'处理进展'));break;}
 case 'closeWarranty':{requireRole(actor,'owner');const w=find(p.afterSales,data.id);expect(w,'working');w.status='closed';log(w,'主业主确认本次售后／保修问题已处理：'+required(data.note,'确认说明'));break;}
 case 'commentWarranty':{const w=find(p.afterSales,data.id);log(w,'留言：'+required(data.note,'留言'));break;}
 default:throw Error('未知操作');
 }
 return {state:next,id:resultId};
}
