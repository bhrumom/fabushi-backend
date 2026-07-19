// 配置常量
export const ADMIN_EMAIL = '1315518325@qq.com';

export const ADMIN_PRICES = {
  'monthly': '0.01',
  'quarterly': '0.01',
  'yearly': '0.01'
};

export const MEMBERSHIP_PLANS = {
  'monthly': {
    name: '月度会员',
    duration: 30 * 24 * 60 * 60 * 1000,
    price: '21.00',
    adminPrice: '0.01'
  },
  'quarterly': {
    name: '季度会员',
    duration: 90 * 24 * 60 * 60 * 1000,
    price: '63.00',
    adminPrice: '0.01'
  },
  'yearly': {
    name: '年度会员',
    duration: 365 * 24 * 60 * 60 * 1000,
    price: '252.00',
    adminPrice: '0.01'
  }
};

export const ASSET_PRODUCTS = {
  'zen_buddha_asset': {
    name: '3D佛像素材',
    price: '33.00',
    adminPrice: '0.01',
    productType: 'asset_unlock'
  }
};

export const REDEEM_CODE_TYPES = {
  'trial_7': { name: '7天试用', days: 7, type: 'trial' },
  'monthly': { name: '月度会员', days: 30, type: 'premium' },
  'quarterly': { name: '季度会员', days: 90, type: 'premium' },
  'yearly': { name: '年度会员', days: 365, type: 'premium' }
};

export const APPLE_IAP_PRODUCTS = {
  'monthly': {
    name: '月度会员',
    duration: 30 * 24 * 60 * 60 * 1000,
    price: '21.00',
    plan: 'monthly',
    productType: 'membership'
  },
  'Quarterly': {
    name: '季度会员',
    duration: 90 * 24 * 60 * 60 * 1000,
    price: '63.00',
    plan: 'quarterly',
    productType: 'membership'
  },
  'Annual': {
    name: '年度会员',
    duration: 365 * 24 * 60 * 60 * 1000,
    price: '252.00',
    plan: 'yearly',
    productType: 'membership'
  },
  'zen_buddha_asset': {
    name: '3D佛像素材',
    price: '33.00',
    plan: 'zen_buddha_asset',
    productType: 'asset_unlock'
  }
};

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
  'Content-Type': 'application/json'
};
