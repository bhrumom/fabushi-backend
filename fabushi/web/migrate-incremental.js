#!/usr/bin/env node

/**
 * 增量更新文本内容到D1
 * 只添加新文件，不影响现有数据
 * 用法: node migrate-incremental.js [production]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProduction = process.argv[2] === 'production';
const envFlag = isProduction ? '--env=production' : '';

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  D1增量更新 - 只添加新文件');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

// 获取现有文件路径
function getExistingPaths() {
  try {
    const result = execSync(
      `wrangler d1 execute fabushi-db ${envFlag} --command="SELECT file_path FROM text_contents;" --json`,
      { encoding: 'utf-8' }
    );
    const data = JSON.parse(result);
    return new Set(data[0]?.results?.map(r => r.file_path) || []);
  } catch (e) {
    console.warn('⚠️  无法获取现有数据，将导入所有文件');
    return new Set();
  }
}

// 扫描所有文本文件
function scanAllFiles() {
  const files = [];
  const baseDir = path.join(__dirname, '../assets/built_in');
  
  const categories = [
    { dir: '经文', category: '经文' },
    { dir: '咒语', category: '咒语' },
    { dir: '乾隆大藏经txt版', category: '乾隆大藏经' }
  ];
  
  for (const { dir, category } of categories) {
    const fullDir = path.join(baseDir, dir);
    if (fs.existsSync(fullDir)) {
      scanDirectory(fullDir, category, files);
    }
  }
  
  return files;
}

function scanDirectory(dir, category, files) {
  const items = fs.readdirSync(dir);
  
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      scanDirectory(fullPath, category, files);
    } else if (item.endsWith('.txt')) {
      const relativePath = fullPath.replace(/.*assets\/built_in\//, 'assets/built_in/');
      files.push({
        path: relativePath,
        fullPath: fullPath,
        category: category
      });
    }
  }
}

// 转义SQL
function escapeSql(str) {
  return str.replace(/'/g, "''").replace(/\\/g, '\\\\');
}

// 执行D1命令
function executeD1Command(sql) {
  try {
    execSync(`wrangler d1 execute fabushi-db ${envFlag} --command="${sql}"`, { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.error(`❌ 执行失败: ${e.message}`);
    return false;
  }
}

// 主函数
async function main() {
  // 1. 获取现有文件
  console.log('📂 获取现有文件列表...');
  const existingPaths = getExistingPaths();
  console.log(`✓ 现有文件: ${existingPaths.size} 个\n`);
  
  // 2. 扫描所有文件
  console.log('📂 扫描本地文件...');
  const allFiles = scanAllFiles();
  console.log(`✓ 本地文件: ${allFiles.length} 个\n`);
  
  // 3. 找出新文件
  const newFiles = allFiles.filter(f => !existingPaths.has(f.path));
  
  if (newFiles.length === 0) {
    console.log('✅ 没有新文件需要添加！');
    return;
  }
  
  console.log(`📝 发现 ${newFiles.length} 个新文件:\n`);
  newFiles.forEach(f => console.log(`   - ${f.path}`));
  console.log('');
  
  // 4. 批量插入
  console.log('📝 开始插入新文件...\n');
  
  const BATCH_SIZE = 10;
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < newFiles.length; i += BATCH_SIZE) {
    const batch = newFiles.slice(i, Math.min(i + BATCH_SIZE, newFiles.length));
    const inserts = [];
    
    for (const file of batch) {
      try {
        const content = fs.readFileSync(file.fullPath, 'utf-8');
        const title = path.basename(file.path, '.txt');
        
        inserts.push(
          `INSERT INTO text_contents (title, content, file_path, category) VALUES ('${escapeSql(title)}', '${escapeSql(content)}', '${escapeSql(file.path)}', '${escapeSql(file.category)}')`
        );
      } catch (e) {
        console.error(`❌ 读取失败: ${file.path}`);
      }
    }
    
    if (inserts.length > 0) {
      const sql = inserts.join('; ') + ';';
      if (executeD1Command(sql)) {
        successCount += inserts.length;
        console.log(`✓ [${i + 1}-${i + inserts.length}/${newFiles.length}] 插入成功`);
      } else {
        failCount += inserts.length;
        console.log(`✗ [${i + 1}-${i + inserts.length}/${newFiles.length}] 插入失败`);
      }
    }
  }
  
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 增量更新完成！');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log(`📊 统计:`);
  console.log(`   - 新文件: ${newFiles.length}`);
  console.log(`   - 成功: ${successCount}`);
  console.log(`   - 失败: ${failCount}`);
  console.log('');
  
  // 5. 验证
  console.log('🔍 验证数据...\n');
  try {
    execSync(`wrangler d1 execute fabushi-db ${envFlag} --command="SELECT category, COUNT(*) as count FROM text_contents GROUP BY category"`, { stdio: 'inherit' });
  } catch (e) {
    console.error('验证失败');
  }
}

main().catch(console.error);
