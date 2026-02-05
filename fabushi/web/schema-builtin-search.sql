-- 内置内容全文搜索数据库Schema
-- 支持乾隆大藏经等内置文本的存储和搜索

-- 创建texts表存储文本内容
CREATE TABLE IF NOT EXISTS texts (
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
);

-- 创建FTS5虚拟表用于全文搜索
CREATE VIRTUAL TABLE IF NOT EXISTS texts_fts USING fts5(
    title,
    content,
    category,
    content='texts',
    content_rowid='rowid'
);

-- 创建触发器保持FTS表同步
CREATE TRIGGER IF NOT EXISTS texts_ai AFTER INSERT ON texts BEGIN
    INSERT INTO texts_fts(rowid, title, content, category) 
    VALUES (new.rowid, new.title, new.content, new.category);
END;

CREATE TRIGGER IF NOT EXISTS texts_ad AFTER DELETE ON texts BEGIN
    INSERT INTO texts_fts(texts_fts, rowid, title, content, category) 
    VALUES('delete', old.rowid, old.title, old.content, old.category);
END;

CREATE TRIGGER IF NOT EXISTS texts_au AFTER UPDATE ON texts BEGIN
    INSERT INTO texts_fts(texts_fts, rowid, title, content, category) 
    VALUES('delete', old.rowid, old.title, old.content, old.category);
    INSERT INTO texts_fts(rowid, title, content, category) 
    VALUES (new.rowid, new.title, new.content, new.category);
END;

-- 创建索引优化查询性能
CREATE INDEX IF NOT EXISTS idx_texts_category ON texts(category);
CREATE INDEX IF NOT EXISTS idx_texts_source ON texts(source);
CREATE INDEX IF NOT EXISTS idx_texts_created_at ON texts(created_at);
CREATE INDEX IF NOT EXISTS idx_texts_word_count ON texts(word_count);

-- 创建统计表
CREATE TABLE IF NOT EXISTS search_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    category TEXT,
    result_count INTEGER DEFAULT 0,
    search_time REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_search_stats_query ON search_stats(query);
CREATE INDEX IF NOT EXISTS idx_search_stats_created_at ON search_stats(created_at);