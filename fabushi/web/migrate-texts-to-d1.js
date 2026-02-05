#!/usr/bin/env node

/**
 * 将文本内容迁移到D1数据库
 * 用法: node migrate-texts-to-d1.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 文本文件列表
const TEXT_FILES = [
  // 经文
  { path: 'assets/built_in/经文/般若波罗蜜多心经.txt', category: '经文' },
  { path: 'assets/built_in/经文/妙法莲华经精选.txt', category: '经文' },
  { path: 'assets/built_in/经文/智慧法语.txt', category: '经文' },
  { path: 'assets/built_in/经文/阿弥陀佛圣号.txt', category: '经文' },
  // 咒语
  { path: 'assets/built_in/咒语/772陀罗尼梵音(hum版).txt', category: '咒语' },
  { path: 'assets/built_in/咒语/慈悲咒语.txt', category: '咒语' },
  { path: 'assets/built_in/咒语/和平祈愿.txt', category: '咒语' },
];

// 读取乾隆大藏经文件列表
function getQianlongFiles() {
  const qianlongDir = path.join(__dirname, '../assets/built_in/乾隆大藏经txt版');
  const files = [];
  
  try {
    const items = fs.readdirSync(qianlongDir, { recursive: true });
    for (const item of items) {
      if (item.endsWith('.txt')) {
        files.push({
          path: `assets/built_in/乾隆大藏经txt版/${item}`,
          category: '乾隆大藏经'
        });
      }
    }
  } catch (e) {
    console.warn('无法读取乾隆大藏经目录:', e.message);
  }
  
  return files;
}

// 生成SQL插入语句
function generateInsertSQL() {
  const allFiles = [...TEXT_FILES, ...getQianlongFiles()];
  const statements = [];
  
  statements.push('-- 清空现有数据');
  statements.push('DELETE FROM text_contents;');
  statements.push('');
  statements.push('-- 插入文本内容');
  
  for (const file of allFiles) {
    const fullPath = path.join(__dirname, '..', file.path);
    
    try {
      if (!fs.existsSync(fullPath)) {
        console.warn(`文件不存在: ${fullPath}`);
        continue;
      }
      
      const content = fs.readFileSync(fullPath, 'utf-8');
      const title = path.basename(file.path, '.txt');
      
      // 转义SQL字符串
      const escapedTitle = title.replace(/'/g, "''");
      const escapedContent = content.replace(/'/g, "''");
      const escapedPath = file.path.replace(/'/g, "''");
      const escapedCategory = file.category.replace(/'/g, "''");
      
      statements.push(
        `INSERT INTO text_contents (title, content, file_path, category) VALUES ('${escapedTitle}', '${escapedContent}', '${escapedPath}', '${escapedCategory}');`
      );
      
      console.log(`✓ 处理: ${title} (${content.length} 字符)`);
    } catch (e) {
      console.error(`✗ 错误处理 ${file.path}:`, e.message);
    }
  }
  
  return statements.join('\n');
}

// 主函数
function main() {
  console.log('开始生成迁移SQL...\n');
  
  const sql = generateInsertSQL();
  const outputPath = path.join(__dirname, 'migrate-texts.sql');
  
  fs.writeFileSync(outputPath, sql, 'utf-8');
  
  console.log(`\n✓ SQL文件已生成: ${outputPath}`);
  console.log('\n执行迁移命令:');
  console.log(`  wrangler d1 execute fabushi-db --file=migrate-texts.sql`);
  console.log('或生产环境:');
  console.log(`  wrangler d1 execute fabushi-db --file=migrate-texts.sql --env=production`);
}

main();
