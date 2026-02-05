#!/usr/bin/env node

/**
 * 重新上传失败的文件到D1
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

// 失败的文件列表（从日志中提取）
const failedFiles = [
  'assets/built_in/咒语/772陀罗尼梵音(hum版).txt',
  'assets/built_in/乾隆大藏经txt版/大乘五大部外重译经/第0122部～金光明最胜王经十卷.txt',
  'assets/built_in/乾隆大藏经txt版/大乘五大部外重译经/第0123部～金光明经四卷.txt',
  'assets/built_in/乾隆大藏经txt版/大乘五大部外重译经/第0124部～等集众德三昧经三卷.txt',
  'assets/built_in/乾隆大藏经txt版/大乘五大部外重译经/第0125部～集一切福德三昧经三卷.txt',
  'assets/built_in/乾隆大藏经txt版/大乘五大部外重译经/第0126部～合部金光明经八卷.txt',
  'assets/built_in/乾隆大藏经txt版/大乘五大部外重译经/第0130部～妙法莲华经七卷.txt',
  'assets/built_in/乾隆大藏经txt版/大乘五大部外重译经/第0134部～正法华经十卷.txt',
  'assets/built_in/乾隆大藏经txt版/大乘五大部外重译经/第0135部～添品妙法莲华经八卷.txt',
  'assets/built_in/乾隆大藏经txt版/大乘五大部外重译经/第0138部～悲华经十卷.txt',
];

function escapeSql(str) {
  return str.replace(/'/g, "''").replace(/\\/g, '\\\\');
}

function getCategory(filePath) {
  if (filePath.includes('经文')) return '经文';
  if (filePath.includes('咒语')) return '咒语';
  if (filePath.includes('乾隆大藏经')) return '乾隆大藏经';
  return '其他';
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  重新上传失败文件');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  // 1. 获取所有失败文件
  console.log('📂 扫描失败文件...');
  const baseDir = path.join(__dirname, '..');
  const allFailedFiles = [];
  
  for (const filePath of failedFiles) {
    const fullPath = path.join(baseDir, filePath);
    if (fs.existsSync(fullPath)) {
      allFailedFiles.push({
        path: filePath,
        fullPath: fullPath,
        category: getCategory(filePath)
      });
    }
  }
  
  console.log(`✓ 找到 ${allFailedFiles.length} 个失败文件\n`);
  
  // 2. 逐个重试
  console.log('📝 开始重新上传...\n');
  
  let successCount = 0;
  let failCount = 0;
  const stillFailed = [];
  
  for (let i = 0; i < allFailedFiles.length; i++) {
    const file = allFailedFiles[i];
    const title = path.basename(file.path, '.txt');
    
    process.stdout.write(`[${i + 1}/${allFailedFiles.length}] ${title.substring(0, 40)}... `);
    
    try {
      const content = fs.readFileSync(file.fullPath, 'utf-8');
      
      // 检查文件大小
      const sizeKB = Buffer.byteLength(content, 'utf-8') / 1024;
      if (sizeKB > 1024) {
        console.log(`⊘ 跳过 (${sizeKB.toFixed(0)}KB 过大)`);
        stillFailed.push({ file: file.path, reason: '文件过大' });
        failCount++;
        continue;
      }
      
      const sql = `INSERT OR REPLACE INTO text_contents (title, content, file_path, category) VALUES ('${escapeSql(title)}', '${escapeSql(content)}', '${escapeSql(file.path)}', '${escapeSql(file.category)}');`;
      
      const tempFile = path.join(__dirname, `temp-retry-${i}.sql`);
      fs.writeFileSync(tempFile, sql, 'utf-8');
      
      execSync(`wrangler d1 execute fabushi-db ${envFlag} ${remoteFlag} --file="${tempFile}"`, { stdio: 'pipe' });
      fs.unlinkSync(tempFile);
      
      console.log('✓');
      successCount++;
    } catch (e) {
      console.log('✗');
      stillFailed.push({ file: file.path, reason: e.message.substring(0, 50) });
      failCount++;
    }
  }
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 重试完成！');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`📊 统计:`);
  console.log(`   - 重试文件数: ${allFailedFiles.length}`);
  console.log(`   - 成功: ${successCount}`);
  console.log(`   - 失败: ${failCount}\n`);
  
  if (stillFailed.length > 0) {
    console.log('❌ 仍然失败的文件:');
    stillFailed.forEach(f => console.log(`   - ${f.file}`));
    console.log(`\n💡 建议: 检查这些文件的编码或大小`);
  }
}

main().catch(console.error);
