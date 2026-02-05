/**
 * 内置内容迁移到D1数据库处理器
 * 支持全文搜索和批量插入
 */

export async function handleBuiltinMigration(request, env) {
    try {
        const { texts } = await request.json();
        
        if (!texts || !Array.isArray(texts)) {
            return new Response(JSON.stringify({
                success: false,
                error: "Invalid texts data"
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        console.log(`📥 接收到 ${texts.length} 个文本进行迁移`);

        // 准备批量插入语句
        const insertPromises = texts.map(async (text) => {
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
            const insertQuery = `
                INSERT OR REPLACE INTO texts (
                    id, title, content, file_path, category, 
                    file_name, word_count, source, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            `;

            await env.DB.prepare(insertQuery)
                .bind(id, title, content, filePath, category, fileName, wordCount, source)
                .run();

            // 插入到FTS表用于全文搜索
            const ftsQuery = `
                INSERT OR REPLACE INTO texts_fts (
                    rowid, title, content, category
                ) VALUES (?, ?, ?, ?)
            `;

            // 使用文本ID的哈希作为rowid
            const rowid = parseInt(id.substring(0, 8), 16);
            
            await env.DB.prepare(ftsQuery)
                .bind(rowid, title, content, category)
                .run();

            return { id, title, success: true };
        });

        // 执行所有插入操作
        const results = await Promise.allSettled(insertPromises);
        
        // 统计结果
        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;

        console.log(`✅ 成功插入: ${successful} 个文本`);
        if (failed > 0) {
            console.log(`❌ 插入失败: ${failed} 个文本`);
        }

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
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('❌ 迁移失败:', error);
        
        return new Response(JSON.stringify({
            success: false,
            error: error.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * 全文搜索处理器
 */
export async function handleFullTextSearch(request, env) {
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
                headers: { 'Content-Type': 'application/json' }
            });
        }

        console.log(`🔍 全文搜索: "${query}" 分类: ${category || '全部'}`);

        // 构建FTS查询
        let ftsQuery = `
            SELECT 
                t.id,
                t.title,
                t.content,
                t.file_path,
                t.category,
                t.file_name,
                t.word_count,
                t.source,
                t.created_at,
                snippet(texts_fts, 1, '<mark>', '</mark>', '...', 32) as snippet,
                rank
            FROM texts_fts 
            JOIN texts t ON texts_fts.rowid = (
                SELECT rowid FROM texts WHERE id = t.id LIMIT 1
            )
            WHERE texts_fts MATCH ?
        `;

        let params = [query];

        // 添加分类过滤
        if (category && category !== 'all') {
            ftsQuery += ` AND t.category = ?`;
            params.push(category);
        }

        // 添加排序和分页
        ftsQuery += ` ORDER BY rank LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        // 执行搜索
        const searchResults = await env.DB.prepare(ftsQuery)
            .bind(...params)
            .all();

        // 获取总数
        let countQuery = `
            SELECT COUNT(*) as total
            FROM texts_fts 
            JOIN texts t ON texts_fts.rowid = (
                SELECT rowid FROM texts WHERE id = t.id LIMIT 1
            )
            WHERE texts_fts MATCH ?
        `;

        let countParams = [query];
        if (category && category !== 'all') {
            countQuery += ` AND t.category = ?`;
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
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('❌ 搜索失败:', error);
        
        return new Response(JSON.stringify({
            success: false,
            error: error.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * 获取分类列表
 */
export async function handleGetCategories(request, env) {
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
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('❌ 获取分类失败:', error);
        
        return new Response(JSON.stringify({
            success: false,
            error: error.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}