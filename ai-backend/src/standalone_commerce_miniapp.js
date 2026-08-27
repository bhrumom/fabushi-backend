import { normalizeMiniAppManifest } from './miniapp_marketplace.js';

export const STANDALONE_COMMERCE_SITE_URL = 'https://shop.ombhrum.com';
export const STANDALONE_COMMERCE_MCP_URL = `${STANDALONE_COMMERCE_SITE_URL}/api/fabushi/mcp`;
export const STANDALONE_COMMERCE_MANIFEST_URL = `${STANDALONE_COMMERCE_SITE_URL}/.well-known/fabushi.json`;

export function standaloneCommerceMiniAppManifest(overrides = {}) {
  const homepage = overrides.homepage ?? STANDALONE_COMMERCE_SITE_URL;
  const mcpUrl = overrides.mcpUrl ?? `${homepage.replace(/\/$/, '')}/api/fabushi/mcp`;
  const manifestUrl = overrides.manifestUrl ?? `${homepage.replace(/\/$/, '')}/.well-known/fabushi.json`;

  return normalizeMiniAppManifest({
    id: 'fabushi-store',
    version: '1.0.0',
    title: 'Fabushi 跨境商城',
    description: '可在普通浏览器独立购物，也可上架 Fabushi 后由 AI 搜索商品、管理购物车并在明确确认后提交订单。',
    publisher: {
      id: 'fabushi-official',
      displayName: 'Fabushi 官方',
      verified: true,
      website: 'https://fabushi.ombhrum.com',
    },
    categories: ['official', 'shopping', 'ecommerce'],
    tags: ['独立站', '跨境电商', '购物', 'medusa', 'ai-commerce', 'webmcp'],
    locales: ['zh-cn', 'en'],
    homepage,
    featured: true,
    bot: {
      id: 'fabushi-store-bot',
      username: 'fabushi_store_bot',
      displayName: 'Fabushi 跨境商城',
      description: '用自然语言搜商品、选规格、加入购物车；支付和最终下单保持用户确认。',
      naturalLanguage: true,
    },
    surfaces: [
      {
        id: 'commerce-mcp',
        kind: 'mcp-http',
        title: 'AI Commerce MCP',
        url: mcpUrl,
        platforms: ['desktop', 'mobile', 'web', 'cli'],
        priority: 100,
      },
      {
        id: 'storefront',
        kind: 'web',
        title: '独立站',
        url: homepage,
        platforms: ['desktop', 'mobile', 'web'],
        priority: 90,
      },
    ],
    commands: [
      {
        name: 'search_products',
        description: '按关键词搜索商品和可购买规格',
        surfaceId: 'commerce-mcp',
        tool: 'search_products',
        aliases: ['搜索商品', '搜商品'],
        naturalLanguageHints: ['帮我找', '有没有', '搜索商品', '推荐商品'],
      },
      {
        name: 'get_product',
        description: '查看商品详情、规格、价格和库存',
        surfaceId: 'commerce-mcp',
        tool: 'get_product',
        aliases: ['商品详情'],
      },
      {
        name: 'create_cart',
        description: '创建购物车',
        surfaceId: 'commerce-mcp',
        tool: 'create_cart',
      },
      {
        name: 'get_cart',
        description: '查看购物车及价格汇总',
        surfaceId: 'commerce-mcp',
        tool: 'get_cart',
        aliases: ['购物车'],
      },
      {
        name: 'add_to_cart',
        description: '把指定规格加入购物车',
        surfaceId: 'commerce-mcp',
        tool: 'add_to_cart',
        approval: 'required',
        naturalLanguageHints: ['加入购物车', '我要这个', '选这个规格'],
      },
      {
        name: 'remove_from_cart',
        description: '从购物车移除商品',
        surfaceId: 'commerce-mcp',
        tool: 'remove_from_cart',
        approval: 'required',
      },
      {
        name: 'prepare_checkout',
        description: '生成可在浏览器或 Fabushi 内继续完成地址、物流和支付的结账链接',
        surfaceId: 'commerce-mcp',
        tool: 'prepare_checkout',
        approval: 'required',
        naturalLanguageHints: ['去结账', '准备下单'],
      },
      {
        name: 'place_order',
        description: '在地址、配送和支付均已就绪后提交订单',
        surfaceId: 'commerce-mcp',
        tool: 'place_order',
        approval: 'destructive',
        naturalLanguageHints: ['确认下单', '提交订单', '购买'],
      },
    ],
    distribution: {
      installMode: 'metadata',
      repository: 'https://github.com/bhrumom/fabushi',
      sourceRef: 'main',
      manifestUrl,
      license: 'MIT-derived-overlay',
    },
    permissions: ['network', 'commerce.purchase'],
    review: {
      state: 'approved',
      reviewer: 'fabushi-release-policy',
      reviewedAt: 1,
    },
    stats: { monthlyActiveUsers: 0 },
  });
}
