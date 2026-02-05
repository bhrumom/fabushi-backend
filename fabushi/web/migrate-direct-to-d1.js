#!/usr/bin/env node

/**
 * 直接将文本内容写入D1数据库（无中间文件）
 * 用法: node migrate-direct-to-d1.js [production]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置
const BATCH_SIZE = 1; // 每批1条，避免文件过大导致SQLITE_TOOBIG
const isProduction = process.argv[2] === 'production';
const envFlag = isProduction ? '--env=production' : '';
const remoteFlag = '--remote'; // 使用远程D1，无大小限制

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  D1直接迁移 - 实时写入');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log(`🎯 环境: ${isProduction ? '生产环境' : '开发环境'}`);
console.log('');

// 扫描所有文本文件
function scanTextFiles() {
  const files = [];
  const baseDir = path.join(__dirname, '../assets/built_in');
  
  // 扫描经文
  const jingwenDir = path.join(baseDir, '经文');
  if (fs.existsSync(jingwenDir)) {
    const items = fs.readdirSync(jingwenDir);
    for (const item of items) {
      if (item.endsWith('.txt')) {
        files.push({
          path: `assets/built_in/经文/${item}`,
          fullPath: path.join(jingwenDir, item),
          category: '经文'
        });
      }
    }
  }
  
  // 扫描咒语
  const zhouyuDir = path.join(baseDir, '咒语');
  if (fs.existsSync(zhouyuDir)) {
    const items = fs.readdirSync(zhouyuDir);
    for (const item of items) {
      if (item.endsWith('.txt')) {
        files.push({
          path: `assets/built_in/咒语/${item}`,
          fullPath: path.join(zhouyuDir, item),
          category: '咒语'
        });
      }
    }
  }
  
  // 扫描乾隆大藏经
  const qianlongDir = path.join(baseDir, '乾隆大藏经txt版');
  if (fs.existsSync(qianlongDir)) {
    scanDirectory(qianlongDir, '乾隆大藏经', files);
  }
  
  return files;
}

// 递归扫描目录
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

// 转义SQL字符串
function escapeSql(str) {
  return str.replace(/'/g, "''").replace(/\\/g, '\\\\');
}

// 执行D1命令
function executeD1Command(sql) {
  try {
    const cmd = `wrangler d1 execute fabushi-db ${envFlag} --command="${sql}"`;
    execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.error(`❌ 执行失败: ${e.message}`);
    return false;
  }
}

// 单条插入（使用SQL文件避免命令行限制）
function insertSingle(file, index) {
  try {
    if (!fs.existsSync(file.fullPath)) {
      return { success: false, skipped: true };
    }
    
    const content = fs.readFileSync(file.fullPath, 'utf-8');
    const title = path.basename(file.path, '.txt');
    
    const sql = `INSERT INTO text_contents (title, content, file_path, category) VALUES ('${escapeSql(title)}', '${escapeSql(content)}', '${escapeSql(file.path)}', '${escapeSql(file.category)}');`;
    
    // 写入临时SQL文件
    const tempFile = path.join(__dirname, `temp-insert-${index}.sql`);
    fs.writeFileSync(tempFile, sql, 'utf-8');
    
    try {
      const output = execSync(`wrangler d1 execute fabushi-db ${envFlag} ${remoteFlag} --file="${tempFile}"`, { encoding: 'utf-8', stdio: 'pipe' });
      fs.unlinkSync(tempFile);
      return { success: true };
    } catch (e) {
      const errorMsg = e.stderr || e.stdout || e.message;
      fs.unlinkSync(tempFile);
      return { success: false, skipped: false, error: errorMsg.substring(0, 100), file: file.path };
    }
  } catch (e) {
    return { success: false, skipped: false };
  }
}

// 主函数
async function main() {
  // 1. 扫描文件
  console.log('📂 扫描文本文件...');
  const files = scanTextFiles();
  console.log(`✓ 找到 ${files.length} 个文本文件\n`);
  
  if (files.length === 0) {
    console.error('❌ 没有找到任何文本文件！');
    process.exit(1);
  }
  
  // 2. 检查表是否存在
  console.log('🔍 检查数据库...');
  try {
    const result = execSync(`wrangler d1 execute fabushi-db ${envFlag} ${remoteFlag} --command="SELECT COUNT(*) as count FROM text_contents"`, { encoding: 'utf-8', stdio: 'pipe' });
    const match = result.match(/"count":(\d+)/);
    const existingCount = match ? parseInt(match[1]) : 0;
    console.log(`✓ 现有数据: ${existingCount} 条\n`);
    
    if (existingCount > 0) {
      console.log('⚠️  数据库已有数据，将进行增量导入');
      console.log('⚠️  如需清空重导，请手动执行:');
      console.log(`   wrangler d1 execute fabushi-db ${envFlag} ${remoteFlag} --command="DELETE FROM text_contents"`);
      console.log('');
    }
  } catch (e) {
    console.log('✓ 表为空或不存在\n');
  }
  
  // 4. 逐条插入
  console.log('📝 开始插入数据...\n');
  
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  const failedFiles = [];
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const progress = Math.round(((i + 1) / files.length) * 100);
    
    process.stdout.write(`[${i + 1}/${files.length}] `);
    
    const result = insertSingle(file, i);
    
    if (result.success) {
      successCount++;
      console.log('✓');
    } else if (result.skipped) {
      skippedCount++;
      console.log('⊘');
    } else {
      failCount++;
      failedFiles.push(result.file || file.path);
      console.log('✗');
    }
    
    if (progress % 10 === 0 && (i + 1) !== files.length) {
      console.log(`   进度: ${progress}% (成功: ${successCount}, 跳过: ${skippedCount}, 失败: ${failCount})`);
    }
  }
  
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 迁移完成！');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log(`📊 统计:`);
  console.log(`   - 总文件数: ${files.length}`);
  console.log(`   - 成功: ${successCount}`);
  console.log(`   - 跳过: ${skippedCount}`);
  console.log(`   - 失败: ${failCount}`);
  console.log('');
  
  if (failedFiles.length > 0) {
    console.log('❌ 失败文件列表:');
    failedFiles.slice(0, 10).forEach(f => console.log(`   - ${f}`));
    if (failedFiles.length > 10) {
      console.log(`   ... 还有 ${failedFiles.length - 10} 个文件`);
    }
    console.log('');
    console.log('⚠️  失败原因可能是:');
    console.log('   1. 文件编码问题（非 UTF-8）');
    console.log('   2. 文件过大（>1MB）');
    console.log('   3. 特殊字符无法转义');
    console.log('');
  }
  
  // 5. 验证
  console.log('🔍 验证数据...\n');
  try {
    execSync(`wrangler d1 execute fabushi-db ${envFlag} ${remoteFlag} --command="SELECT category, COUNT(*) as count FROM text_contents GROUP BY category"`, { stdio: 'inherit' });
  } catch (e) {
    console.error('验证失败');
  }
  
  console.log('');
  console.log('📝 下一步:');
  console.log('   1. 测试搜索: wrangler dev');
  console.log('   2. 部署应用: wrangler deploy');
  console.log('');
}

main().catch(console.error);
