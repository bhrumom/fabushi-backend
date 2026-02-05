import { jsonResponse } from '../utils/response.js';

// 使用D1数据库搜索文本
export async function handleSearch(request, env, db) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') || '';
    const category = url.searchParams.get('category'); // 可选：按分类筛选
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');

    if (!query) {
      return jsonResponse({ query: '', total: 0, results: [] });
    }

    // 使用 FTS5 进行极端性能搜索
    let sql = `
      SELECT 
        f.id, f.title, 
        tc.file_path, tc.category,
        snippet(text_contents_fts, 1, '<b>', '</b>', '...', 64) as snippet
      FROM text_contents_fts f
      JOIN text_contents tc ON f.rowid = tc.id
      WHERE text_contents_fts MATCH ?
    `;

    const params = [query];

    // 添加分类筛选
    if (category) {
      sql += ' AND tc.category = ?';
      params.push(category);
    }

    // 排序：使用 FTS5 默认排名
    sql += ' ORDER BY rank';

    // 分页
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const { results } = await db.prepare(sql).bind(...params).all();

    // 格式化结果
    const formattedResults = results.map(row => {
      return {
        id: row.file_path,
        title: row.title,
        path: row.file_path,
        category: row.category,
        preview: row.snippet,
        titleMatch: false // FTS5 已经自动处理了排名
      };
    });

    // 获取总数
    let countSql = 'SELECT COUNT(*) as total FROM text_contents_fts WHERE text_contents_fts MATCH ?';
    const countParams = [query];
    if (category) {
      countSql = `
        SELECT COUNT(*) as total 
        FROM text_contents_fts f
        JOIN text_contents tc ON f.rowid = tc.id
        WHERE text_contents_fts MATCH ? AND tc.category = ?
      `;
      countParams.push(category);
    }
    const { total } = await db.prepare(countSql).bind(...countParams).first();

    return jsonResponse({
      query,
      category: category || 'all',
      total: total || 0,
      limit,
      offset,
      results: formattedResults
    });
  } catch (error) {
    console.error('Search error:', error);
    return jsonResponse({
      error: error.message,
      query: query || '',
      total: 0,
      results: []
    }, 500);
  }
}

// 获取经文内容（从D1）
export async function handleGetTextContent(request, env, db) {
  try {
    const url = new URL(request.url);
    const path = url.searchParams.get('path');

    if (!path) {
      return jsonResponse({ error: '缺少path参数' }, 400);
    }

    const result = await db
      .prepare('SELECT title, content, file_path, category FROM text_contents WHERE file_path = ?')
      .bind(path)
      .first();

    if (!result) {
      return jsonResponse({ error: '未找到内容' }, 404);
    }

    return jsonResponse({
      title: result.title,
      content: result.content,
      path: result.file_path,
      category: result.category
    });
  } catch (error) {
    console.error('Get text content error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// 获取所有分类
export async function handleGetCategories(request, env, db) {
  try {
    const { results } = await db
      .prepare('SELECT DISTINCT category, COUNT(*) as count FROM text_contents GROUP BY category')
      .all();

    return jsonResponse({
      categories: results.map(r => ({
        name: r.category,
        count: r.count
      }))
    });
  } catch (error) {
    console.error('Get categories error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}
