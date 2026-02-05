#!/usr/bin/env node

/**
 * 批量将文本内容迁移到D1数据库
 * 由于D1有SQL大小限制，需要分批执行
 * 用法: node migrate-texts-batch.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置
const BATCH_SIZE = 50; // 每批处理50个文件
const MAX_SQL_SIZE = 900000; // 每个SQL文件最大900KB（D1限制1MB）

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
  return str.replace(/'/g, "''");
}

// 生成单个文件的INSERT语句
function generateInsert(file) {
  try {
    if (!fs.existsSync(file.fullPath)) {
      console.warn(`⚠️  文件不存在: ${file.fullPath}`);
      return null;
    }
    
    const content = fs.readFileSync(file.fullPath, 'utf-8');
    const title = path.basename(file.path, '.txt');
    
    // 转义SQL字符串
    const escapedTitle = escapeSql(title);
    const escapedContent = escapeSql(content);
    const escapedPath = escapeSql(file.path);
    const escapedCategory = escapeSql(file.category);
    
    return `INSERT INTO text_contents (title, content, file_path, category) VALUES ('${escapedTitle}', '${escapedContent}', '${escapedPath}', '${escapedCategory}');`;
  } catch (e) {
    console.error(`✗ 错误处理 ${file.path}:`, e.message);
    return null;
  }
}

// 生成批量SQL文件
function generateBatchSQLFiles(files) {
  const batches = [];
  let currentBatch = [];
  let currentSize = 0;
  let batchIndex = 0;
  
  console.log(`\n📊 总共 ${files.length} 个文件需要迁移\n`);
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const insert = generateInsert(file);
    
    if (!insert) continue;
    
    const insertSize = Buffer.byteLength(insert, 'utf-8');
    
    // 检查是否需要创建新批次
    if (currentBatch.length >= BATCH_SIZE || currentSize + insertSize > MAX_SQL_SIZE) {
      if (currentBatch.length > 0) {
        batches.push({
          index: batchIndex++,
          statements: currentBatch,
          size: currentSize
        });
        currentBatch = [];
        currentSize = 0;
      }
    }
    
    currentBatch.push(insert);
    currentSize += insertSize;
    
    // 显示进度
    if ((i + 1) % 100 === 0) {
      console.log(`📝 已处理: ${i + 1}/${files.length} (${Math.round((i + 1) / files.length * 100)}%)`);
    }
  }
  
  // 添加最后一批
  if (currentBatch.length > 0) {
    batches.push({
      index: batchIndex,
      statements: currentBatch,
      size: currentSize
    });
  }
  
  return batches;
}

// 写入批量SQL文件
function writeBatchFiles(batches) {
  const outputDir = path.join(__dirname, 'migrations');
  
  // 创建输出目录
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  console.log(`\n📦 生成 ${batches.length} 个批次文件...\n`);
  
  const files = [];
  
  for (const batch of batches) {
    const filename = `batch-${String(batch.index).padStart(3, '0')}.sql`;
    const filepath = path.join(outputDir, filename);
    
    const header = [
      `-- 批次 ${batch.index + 1}/${batches.length}`,
      `-- 包含 ${batch.statements.length} 条记录`,
      `-- 大小: ${Math.round(batch.size / 1024)}KB`,
      '',
    ].join('\n');
    
    const content = header + batch.statements.join('\n');
    fs.writeFileSync(filepath, content, 'utf-8');
    
    files.push(filename);
    console.log(`✓ ${filename} (${batch.statements.length} 条记录, ${Math.round(batch.size / 1024)}KB)`);
  }
  
  return { outputDir, files };
}

// 生成执行脚本
function generateExecuteScript(outputDir, files) {
  const scriptPath = path.join(__dirname, 'migrate-execute-all.sh');
  
  const lines = [
    '#!/bin/bash',
    '',
    '# 批量执行D1迁移',
    '# 用法: ./migrate-execute-all.sh [production]',
    '',
    'set -e',
    '',
    'ENV_FLAG=""',
    'if [ "$1" = "production" ]; then',
    '  ENV_FLAG="--env=production"',
    '  echo "🚀 执行生产环境迁移"',
    'else',
    '  echo "🔧 执行开发环境迁移"',
    'fi',
    '',
    'echo ""',
    'echo "⚠️  警告: 这将清空并重新导入所有文本内容"',
    'echo "按 Ctrl+C 取消，或按任意键继续..."',
    'read -n 1 -s',
    'echo ""',
    '',
    '# 首先清空表',
    'echo "🗑️  清空现有数据..."',
    'wrangler d1 execute fabushi-db $ENV_FLAG --command="DELETE FROM text_contents;"',
    'echo "✓ 数据已清空"',
    'echo ""',
    '',
    `TOTAL=${files.length}`,
    'CURRENT=0',
    '',
  ];
  
  for (const file of files) {
    lines.push('CURRENT=$((CURRENT + 1))');
    lines.push(`echo "[$CURRENT/$TOTAL] 执行 ${file}..."`);
    lines.push(`wrangler d1 execute fabushi-db $ENV_FLAG --file=migrations/${file}`);
    lines.push('');
  }
  
  lines.push('echo ""');
  lines.push('echo "✅ 所有批次执行完成！"');
  lines.push('echo ""');
  lines.push('echo "验证数据:"');
  lines.push('wrangler d1 execute fabushi-db $ENV_FLAG --command="SELECT category, COUNT(*) as count FROM text_contents GROUP BY category;"');
  
  fs.writeFileSync(scriptPath, lines.join('\n'), 'utf-8');
  fs.chmodSync(scriptPath, '755');
  
  return scriptPath;
}

// 生成README
function generateReadme(outputDir, batches, files) {
  const readmePath = path.join(outputDir, 'README.md');
  
  const content = [
    '# D1数据迁移批次文件',
    '',
    '## 概述',
    '',
    `本目录包含 ${batches.length} 个批次的SQL文件，用于将文本内容迁移到D1数据库。`,
    '',
    '## 统计信息',
    '',
    `- 总文件数: ${batches.reduce((sum, b) => sum + b.statements.length, 0)}`,
    `- 批次数: ${batches.length}`,
    `- 每批平均: ${Math.round(batches.reduce((sum, b) => sum + b.statements.length, 0) / batches.length)} 条记录`,
    '',
    '## 批次列表',
    '',
    '| 批次 | 文件名 | 记录数 | 大小 |',
    '|------|--------|--------|------|',
  ];
  
  for (const batch of batches) {
    const filename = `batch-${String(batch.index).padStart(3, '0')}.sql`;
    content.push(`| ${batch.index + 1} | ${filename} | ${batch.statements.length} | ${Math.round(batch.size / 1024)}KB |`);
  }
  
  content.push('');
  content.push('## 执行方法');
  content.push('');
  content.push('### 方式1: 使用自动脚本（推荐）');
  content.push('');
  content.push('```bash');
  content.push('# 开发环境');
  content.push('cd web');
  content.push('./migrate-execute-all.sh');
  content.push('');
  content.push('# 生产环境');
  content.push('./migrate-execute-all.sh production');
  content.push('```');
  content.push('');
  content.push('### 方式2: 手动执行单个批次');
  content.push('');
  content.push('```bash');
  content.push('# 执行单个批次');
  content.push('wrangler d1 execute fabushi-db --file=migrations/batch-000.sql');
  content.push('');
  content.push('# 生产环境');
  content.push('wrangler d1 execute fabushi-db --file=migrations/batch-000.sql --env=production');
  content.push('```');
  content.push('');
  content.push('### 方式3: 逐个执行所有批次');
  content.push('');
  content.push('```bash');
  content.push('# 开发环境');
  content.push('for file in migrations/batch-*.sql; do');
  content.push('  echo "执行 $file..."');
  content.push('  wrangler d1 execute fabushi-db --file="$file"');
  content.push('done');
  content.push('');
  content.push('# 生产环境');
  content.push('for file in migrations/batch-*.sql; do');
  content.push('  echo "执行 $file..."');
  content.push('  wrangler d1 execute fabushi-db --file="$file" --env=production');
  content.push('done');
  content.push('```');
  content.push('');
  content.push('## 验证');
  content.push('');
  content.push('```bash');
  content.push('# 查看总数');
  content.push('wrangler d1 execute fabushi-db --command="SELECT COUNT(*) as total FROM text_contents;"');
  content.push('');
  content.push('# 按分类统计');
  content.push('wrangler d1 execute fabushi-db --command="SELECT category, COUNT(*) as count FROM text_contents GROUP BY category;"');
  content.push('');
  content.push('# 测试搜索');
  content.push('wrangler d1 execute fabushi-db --command="SELECT title FROM text_contents WHERE title LIKE \'%心经%\' LIMIT 5;"');
  content.push('```');
  content.push('');
  content.push('## 注意事项');
  content.push('');
  content.push('1. **执行顺序**: 必须按批次顺序执行（batch-000, batch-001, ...）');
  content.push('2. **清空数据**: 执行前会清空 text_contents 表');
  content.push('3. **执行时间**: 每批次约需要5-10秒，总共约需要 ' + Math.round(batches.length * 7 / 60) + ' 分钟');
  content.push('4. **网络稳定**: 确保网络连接稳定，避免中断');
  content.push('5. **备份**: 如有重要数据，请先备份');
  content.push('');
  content.push('## 回滚');
  content.push('');
  content.push('如需回滚，执行：');
  content.push('');
  content.push('```bash');
  content.push('wrangler d1 execute fabushi-db --command="DELETE FROM text_contents;"');
  content.push('```');
  content.push('');
  content.push('---');
  content.push('');
  content.push('生成时间: ' + new Date().toISOString());
  
  fs.writeFileSync(readmePath, content.join('\n'), 'utf-8');
  
  return readmePath;
}

// 主函数
function main() {
  console.log('🚀 开始批量迁移准备...\n');
  
  // 1. 扫描文件
  console.log('📂 扫描文本文件...');
  const files = scanTextFiles();
  console.log(`✓ 找到 ${files.length} 个文本文件\n`);
  
  if (files.length === 0) {
    console.error('❌ 没有找到任何文本文件！');
    process.exit(1);
  }
  
  // 2. 生成批次
  const batches = generateBatchSQLFiles(files);
  
  // 3. 写入文件
  const { outputDir, files: batchFiles } = writeBatchFiles(batches);
  
  // 4. 生成执行脚本
  console.log('\n📜 生成执行脚本...');
  const scriptPath = generateExecuteScript(outputDir, batchFiles);
  console.log(`✓ ${scriptPath}\n`);
  
  // 5. 生成README
  console.log('📖 生成README...');
  const readmePath = generateReadme(outputDir, batches, batchFiles);
  console.log(`✓ ${readmePath}\n`);
  
  // 6. 显示总结
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 批量迁移文件生成完成！');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log(`📊 统计信息:`);
  console.log(`   - 总文件数: ${files.length}`);
  console.log(`   - 批次数: ${batches.length}`);
  console.log(`   - 输出目录: ${outputDir}`);
  console.log('');
  console.log('🚀 执行迁移:');
  console.log('   开发环境: ./migrate-execute-all.sh');
  console.log('   生产环境: ./migrate-execute-all.sh production');
  console.log('');
  console.log('📖 详细说明: migrations/README.md');
  console.log('');
}

main();
