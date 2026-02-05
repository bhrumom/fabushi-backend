#!/usr/bin/env node

/**
 * 查找并重新上传所有失败的文件
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProduction = process.argv[2] === 'production';
const envFlag = isProduction ? '--env=production' : '';
const remoteFlag = '--remote';

// 扫描所有文本文件
function scanAllFiles() {
  const files = [];
  const baseDir = path.join(__dirname, '../assets/built_in');
  
  function scan(dir, category) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        scan(fullPath, category || item);
      } else if (item.endsWith('.txt')) {
        const relativePath = fullPath.replace(/.*assets\/built_in\//, 'assets/built_in/');
        files.push({
          path: relativePath,
          fullPath: fullPath,
          category: category || (relativePath.includes('经文') ? '经文' : relativePath.includes('咒语') ? '咒语' : '乾隆大藏经')
        });
      }
    }
  }
  
  scan(baseDir);
  return files;
}

// 获取已存在的文件
function getExistingFiles() {
  try {
    const result = execSync(`wrangler d1 execute fabushi-db ${envFlag} ${remoteFlag} --command="SELECT file_path FROM text_contents"`, { encoding: 'utf-8' });
    const paths = new Set();
    const matches = result.matchAll(/"file_path":"([^"]+)"/g);
    for (const match of matches) {
      paths.add(match[1]);
    }
    return paths;
  } catch (e) {
    console.error('❌ 无法获取已存在文件列表');
    return new Set();
  }
}

function escapeSql(str) {
  return str.replace(/'/g, "''").replace(/\\/g, '\\\\');
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  查找并重新上传失败文件');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  // 1. 扫描所有文件
  console.log('📂 扫描所有文本文件...');
  const allFiles = scanAllFiles();
  console.log(`✓ 找到 ${allFiles.length} 个文本文件\n`);
  
  // 2. 获取已存在的文件
  console.log('🔍 检查数据库中已存在的文件...');
  const existingFiles = getExistingFiles();
  console.log(`✓ 数据库中有 ${existingFiles.size} 个文件\n`);
  
  // 3. 找出失败的文件
  const failedFiles = allFiles.filter(f => !existingFiles.has(f.path));
  console.log(`❌ 发现 ${failedFiles.length} 个失败文件\n`);
  
  if (failedFiles.length === 0) {
    console.log('✅ 所有文件都已成功上传！');
    return;
  }
  
  // 4. 显示失败文件列表
  console.log('失败文件列表:');
  failedFiles.slice(0, 20).forEach((f, i) => {
    console.log(`   ${i + 1}. ${f.path}`);
  });
  if (failedFiles.length > 20) {
    console.log(`   ... 还有 ${failedFiles.length - 20} 个文件`);
  }
  console.log('');
  
  // 5. 询问是否继续
  console.log('准备重新上传这些文件...\n');
  
  // 6. 逐个重试
  console.log('📝 开始重新上传...\n');
  
  let successCount = 0;
  let failCount = 0;
  const stillFailed = [];
  
  for (let i = 0; i < failedFiles.length; i++) {
    const file = failedFiles[i];
    const title = path.basename(file.path, '.txt');
    const shortTitle = title.length > 40 ? title.substring(0, 37) + '...' : title;
    
    process.stdout.write(`[${i + 1}/${failedFiles.length}] ${shortTitle} `);
    
    try {
      const content = fs.readFileSync(file.fullPath, 'utf-8');
      
      // 检查文件大小
      const sizeKB = Buffer.byteLength(content, 'utf-8') / 1024;
      if (sizeKB > 1024) {
        console.log(`⊘ (${sizeKB.toFixed(0)}KB 过大)`);
        stillFailed.push({ file: file.path, reason: '文件过大' });
        failCount++;
        continue;
      }
      
      const sql = `INSERT OR REPLACE INTO text_contents (title, content, file_path, category) VALUES ('${escapeSql(title)}', '${escapeSql(content)}', '${escapeSql(file.path)}', '${escapeSql(file.category)}');`;
      
      const tempFile = path.join(__dirname, `temp-retry-${i}.sql`);
      fs.writeFileSync(tempFile, sql, 'utf-8');
      
      execSync(`wrangler d1 execute fabushi-db ${envFlag} ${remoteFlag} --file="${tempFile}"`, { stdio: 'pipe' });
      
      // 清理临时文件
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
      
      console.log('✓');
      successCount++;
    } catch (e) {
      console.log(`✗ (${e.message.substring(0, 30)})`);
      stillFailed.push({ file: file.path, reason: e.message.substring(0, 50) });
      failCount++;
    }
    
    // 每10个显示进度
    if ((i + 1) % 10 === 0) {
      console.log(`   进度: ${Math.round(((i + 1) / failedFiles.length) * 100)}% (成功: ${successCount}, 失败: ${failCount})`);
    }
  }
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 重试完成！');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`📊 统计:`);
  console.log(`   - 重试文件数: ${failedFiles.length}`);
  console.log(`   - 成功: ${successCount}`);
  console.log(`   - 失败: ${failCount}\n`);
  
  if (stillFailed.length > 0) {
    console.log('❌ 仍然失败的文件:');
    stillFailed.slice(0, 10).forEach(f => {
      console.log(`   - ${path.basename(f.file)}`);
      console.log(`     原因: ${f.reason}`);
    });
    if (stillFailed.length > 10) {
      console.log(`   ... 还有 ${stillFailed.length - 10} 个文件`);
    }
    console.log(`\n💡 建议:`);
    console.log(`   1. 检查文件编码是否为 UTF-8`);
    console.log(`   2. 检查文件大小是否超过 1MB`);
    console.log(`   3. 检查文件内容是否包含特殊字符`);
  } else {
    console.log('🎉 所有文件都已成功上传！');
  }
  
  // 7. 验证最终结果
  console.log('\n🔍 验证最终数据...\n');
  try {
    execSync(`wrangler d1 execute fabushi-db ${envFlag} ${remoteFlag} --command="SELECT category, COUNT(*) as count FROM text_contents GROUP BY category"`, { stdio: 'inherit' });
  } catch (e) {
    console.error('验证失败');
  }
}

main().catch(console.error);
