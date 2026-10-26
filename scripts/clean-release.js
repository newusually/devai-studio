const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const releaseDir = path.join(__dirname, '..', 'release');
if (!fs.existsSync(releaseDir)) { console.log('[clean-release] release 目录不存在，无需清理'); process.exit(0); }

const entries = fs.readdirSync(releaseDir, { withFileTypes: true });
let removed = 0, failed = 0;
for (const e of entries) {
  const full = path.join(releaseDir, e.name);
  try {
    fs.rmSync(full, { recursive: true, force: true });
    removed++;
  } catch (err) {
    // 忽略清理失败（可能被占用），记录并继续
    failed++;
    console.log(`[clean-release] 清理失败(忽略): ${e.name}: ${err.message}`);
  }
}
console.log(`[clean-release] 清理完成: 删除 ${removed} 项, 失败跳过 ${failed} 项`);