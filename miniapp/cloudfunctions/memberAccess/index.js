const cloud = require('wx-server-sdk');
const { createService, AppError } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async event => {
  try {
    // 首次使用时用户或负责人记录可能尚不存在，由业务层处理空结果。
    const service = createService(cloud.database({ throwOnNotFound: false }));
    const result = await service.execute(event || {}, cloud.getWXContext());
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, code: error.code, message: error.message };
    console.error('memberAccess failed', error && error.stack ? error.stack : error);
    return { ok: false, code: 'SERVER_ERROR', message: '云端处理失败，请稍后重试。' };
  }
};
