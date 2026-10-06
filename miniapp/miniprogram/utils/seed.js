const { day, shift } = require('./date');

const SPACES = ['全屋', '厨房', '餐厅', '前阳台', '后阳台', '洗衣房', '主卧', '次卧1', '次卧2', '儿童房', '书房', '客卫', '主卫'];
const STAGES = ['拆改', '砌墙', '水电隐蔽工程', '防水与闭水试验', '泥瓦铺贴', '木工施工', '油漆施工', '美缝', '安装与收口', '保洁', '竣工验收与交付'];

function createSeed(today = day()) {
  const accounts = [
    { id: 'lead', name: '示例负责人', label: '示例负责人 · 全部项目', leader: true },
    { id: 'manager', name: '示例管家', label: '示例管家 · 安排施工' },
    { id: 'electric', name: '示例水电师傅甲', label: '示例水电师傅甲 · 主要上传人' },
    { id: 'helper', name: '示例水电师傅乙', label: '示例水电师傅乙 · 可补充记录' },
    { id: 'mason', name: '示例泥瓦师傅', label: '示例泥瓦师傅 · 同日施工' },
    { id: 'carpenter', name: '示例木工师傅', label: '示例木工师傅 · 已加入未进场' },
    { id: 'owner', name: '示例主业主', label: '示例主业主 · 查看进度' },
    { id: 'designer', name: '示例设计师', label: '示例设计师 · 查看进度' },
    { id: 'family', name: '示例家庭成员', label: '示例家庭成员 · 查看进度' },
    { id: 'other', name: '示例乙项目业主', label: '示例乙项目业主 · 仅乙项目' },
    { id: 'outsider', name: '示例未加入账号', label: '示例未加入账号 · 无项目' },
    { id: 'exited', name: '示例已退出师傅', label: '示例已退出师傅 · 无访问权' }
  ];
  const member = (userId, roles, trades = [], projectId = 'demo-a', status = 'active') => ({ projectId, userId, roles, trades, status });
  const schedule = (id, trade, stage, workerId, start, end, content, restDays = []) => ({
    id, projectId: 'demo-a', trade, stage, workerId, start, end, content, expected: end, restDays, version: 1,
    history: [], updatedAt: `${today} 07:30:00`, updatedBy: '示例管家', actorRole: '管家'
  });
  const schedules = [
    schedule('electric-plan', '水电', '水电隐蔽工程', 'electric', shift(today, -2), shift(today, 3), '厨房水管布设、插座定位及回路核对', [shift(today, 1)]),
    schedule('mason-plan', '泥瓦', '砌墙', 'mason', today, shift(today, 2), '客卫隔墙砌筑，与水电师傅交接预留位置'),
    schedule('wood-plan', '木工', '木工施工', 'carpenter', shift(today, 5), shift(today, 9), '客厅吊顶放线及基层施工')
  ];
  const yesterday = shift(today, -1);
  return {
    schema: 1, seedDate: today, currentUserId: 'manager', accounts,
    projects: [
      { id: 'demo-a', name: '示例甲 · 晴川居', address: '虚构地址 · 示例楼栋 A', stage: '水电、砌墙协同施工', status: '施工中' },
      { id: 'demo-b', name: '示例乙 · 云杉居', address: '虚构地址 · 示例楼栋 B', stage: '尚未安排施工', status: '准备中' }
    ],
    members: [member('lead', ['负责人']), member('manager', ['管家']), member('electric', ['师傅'], ['水电']), member('helper', ['师傅'], ['水电']), member('mason', ['师傅'], ['泥瓦']), member('carpenter', ['师傅'], ['木工']), member('owner', ['主业主']), member('designer', ['设计师']), member('family', ['家庭成员']), member('exited', ['师傅'], ['水电'], 'demo-a', 'exited'), member('lead', ['负责人'], [], 'demo-b'), member('other', ['主业主'], [], 'demo-b')],
    schedules,
    records: [{
      id: 'seed-record', requestId: 'seed-record', projectId: 'demo-a', scheduleId: 'electric-plan', trade: '水电', stage: '水电隐蔽工程',
      authorId: 'electric', authorName: '示例水电师傅甲', actorRole: '师傅', kind: 'worker', date: yesterday, createdAt: `${yesterday} 16:30:00`,
      location: '厨房、餐厅', note: '虚构示例：已完成厨房插座定位，现场尺寸待继续核对。',
      scheduleSnapshot: JSON.parse(JSON.stringify(schedules[0])),
      media: [1, 2, 3].map(n => ({ id: `seed-photo-${n}`, type: 'image', source: 'simulated', capturedAt: `${yesterday} 16:20:0${n}`, path: '', duration: 0 }))
    }]
  };
}

module.exports = { createSeed, SPACES, STAGES };
