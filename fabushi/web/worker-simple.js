// 简化版Worker - 专门处理内置内容迁移
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// 创建表的SQL语句
const CREATE_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS texts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    file_path TEXT NOT NULL,
    category TEXT NOT NULL,
    file_name TEXT NOT NULL,
    word_count INTEGER DEFAULT 0,
    source TEXT DEFAULT 'builtin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_texts_category ON texts(category)`,
  `CREATE INDEX IF NOT EXISTS idx_texts_source ON texts(source)`,
  `CREATE INDEX IF NOT EXISTS idx_texts_created_at ON texts(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_texts_word_count ON texts(word_count)`
];

async function ensureTablesExist(env) {
  try {
    for (const sql of CREATE_TABLES_SQL) {
      await env.DB.prepare(sql).run();
    }
    console.log('✅ 数据库表结构检查完成');
    return true;
  } catch (error) {
    console.error('❌ 创建表失败:', error);
    return false;
  }
}

async function handleBuiltinMigration(request, env) {
  try {
    // 首先确保表存在
    const tablesReady = await ensureTablesExist(env);
    if (!tablesReady) {
      return new Response(JSON.stringify({
        success: false,
        error: "Failed to create database tables"
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    const { texts } = await request.json();
    
    if (!texts || !Array.isArray(texts)) {
      return new Response(JSON.stringify({
        success: false,
        error: "Invalid texts data"
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    console.log(`📥 接收到 ${texts.length} 个文本进行迁移`);

    let successful = 0;
    let failed = 0;

    // 逐个处理文本以避免批量操作问题
    for (const text of texts) {
      try {
        const {
          id,
          title,
          content,
          filePath,
          category,
          fileName,
          wordCount,
          source = 'builtin'
        } = text;

        // 插入到texts表
        await env.DB.prepare(`
          INSERT OR REPLACE INTO texts (
            id, title, content, file_path, category, 
            file_name, word_count, source, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).bind(id, title, content, filePath, category, fileName, wordCount, source).run();

        successful++;
        console.log(`✅ 插入成功: ${title}`);

      } catch (error) {
        failed++;
        console.error(`❌ 插入失败: ${text.title}`, error);
      }
    }

    console.log(`📊 迁移完成 - 成功: ${successful}, 失败: ${failed}`);

    return new Response(JSON.stringify({
      success: true,
      message: `Successfully migrated ${successful} texts`,
      stats: {
        total: texts.length,
        successful,
        failed
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });

  } catch (error) {
    console.error('❌ 迁移失败:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}

async function handleFullTextSearch(request, env) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    const category = url.searchParams.get('category');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const offset = parseInt(url.searchParams.get('offset') || '0');

    if (!query || query.trim().length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: "Search query is required"
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    console.log(`🔍 全文搜索: "${query}" 分类: ${category || '全部'}`);

    // 简化的搜索查询
    let searchQuery = `
      SELECT 
        id, title, content, file_path, category, 
        file_name, word_count, source, created_at
      FROM texts
      WHERE (title LIKE ? OR content LIKE ?)
    `;

    let params = [`%${query}%`, `%${query}%`];

    // 添加分类过滤
    if (category && category !== 'all') {
      searchQuery += ` AND category = ?`;
      params.push(category);
    }

    // 添加排序和分页
    searchQuery += ` ORDER BY 
      CASE 
        WHEN title LIKE ? THEN 1 
        ELSE 2 
      END,
      word_count DESC 
      LIMIT ? OFFSET ?`;
    
    params.push(`%${query}%`, limit, offset);

    // 执行搜索
    const searchResults = await env.DB.prepare(searchQuery)
      .bind(...params)
      .all();

    // 获取总数
    let countQuery = `
      SELECT COUNT(*) as total
      FROM texts
      WHERE (title LIKE ? OR content LIKE ?)
    `;

    let countParams = [`%${query}%`, `%${query}%`];
    if (category && category !== 'all') {
      countQuery += ` AND category = ?`;
      countParams.push(category);
    }

    const countResult = await env.DB.prepare(countQuery)
      .bind(...countParams)
      .first();

    const total = countResult?.total || 0;

    console.log(`📊 搜索结果: ${searchResults.results?.length || 0} 条，总计: ${total} 条`);

    return new Response(JSON.stringify({
      success: true,
      data: {
        results: searchResults.results || [],
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total
        },
        query,
        category
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });

  } catch (error) {
    console.error('❌ 搜索失败:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}

async function handleGetCategories(request, env) {
  try {
    const categoriesResult = await env.DB.prepare(`
      SELECT category, COUNT(*) as count
      FROM texts
      WHERE source = 'builtin'
      GROUP BY category
      ORDER BY count DESC
    `).all();

    return new Response(JSON.stringify({
      success: true,
      data: categoriesResult.results || []
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });

  } catch (error) {
    console.error('❌ 获取分类失败:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    // CORS预检
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // 健康检查
      if (pathname === '/health') {
        return new Response(JSON.stringify({ 
          status: 'ok', 
          timestamp: new Date().toISOString() 
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }

      // 内置内容迁移API
      if (pathname === '/migrate-builtin-complete' && method === 'POST') {
        return await handleBuiltinMigration(request, env);
      }

      // 全文搜索API
      if (pathname === '/api/builtin/search' && method === 'GET') {
        return await handleFullTextSearch(request, env);
      }

      // 获取分类API
      if (pathname === '/api/builtin/categories' && method === 'GET') {
        return await handleGetCategories(request, env);
      }

      // 静态文件服务
      if (env.ASSETS) {
        let assetResponse = await env.ASSETS.fetch(request);

        // SPA fallback
        if (assetResponse.status === 404 && !pathname.startsWith('/api/') && !/\.[^/]+$/.test(pathname)) {
          const spaRequest = new Request(new URL('/index.html', request.url), request);
          assetResponse = await env.ASSETS.fetch(spaRequest);
        }

        // 添加CORS头
        const newResponse = new Response(
          method === 'HEAD' ? null : assetResponse.body,
          {
            status: assetResponse.status,
            statusText: assetResponse.statusText,
            headers: assetResponse.headers
          }
        );

        Object.entries(CORS_HEADERS).forEach(([key, value]) => {
          newResponse.headers.set(key, value);
        });

        return newResponse;
      }

      return new Response('Not Found', { 
        status: 404, 
        headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS }
      });

    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({
        error: 'Internal Server Error',
        message: error.message
      }), { 
        status: 500, 
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }
  }
};