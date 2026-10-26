/* ============================================================================
 * scripts/bundle-ollama.js —— 打包前自动把本地 Ollama 运行时复制到 resources/ollama/
 * ----------------------------------------------------------------------------
 *  · 该目录已被 .gitignore 忽略（约 1.1GB 二进制不入库）。
 *  · 仅复制 CPU 版：排除 CUDA/ROCm 的 cuda_v12 / cuda_v13 体积大户，
 *    保证安装包自包含且体积可控（GPU 用户可另行安装标准 Ollama，app 会优先采用）。
 *  · 源路径：环境变量 OLLAMA_SRC，缺省 F:/dev-ai/ollama。
 *  · 已存在且大小一致则跳过，避免每次 dist 重复复制 1.1GB。
 * ========================================================================== */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const src = process.env.OLLAMA_SRC || 'F:/dev-ai/ollama';
const dest = path.join(__dirname, '..', 'resources', 'ollama');
const srcExe = path.join(src, 'ollama.exe');
const destExe = path.join(dest, 'ollama.exe');

if (!fs.existsSync(srcExe)) {
  console.log('[bundle-ollama] 源 Ollama 不存在: ' + srcExe);
  console.log('[bundle-ollama] 跳过复制 —— 请先安装 Ollama，或设置环境变量 OLLAMA_SRC 指向其安装目录');
  process.exit(0);
}

// 已存在且大小一致则跳过
if (fs.existsSync(destExe) && fs.statSync(destExe).size === fs.statSync(srcExe).size) {
  console.log('[bundle-ollama] resources/ollama 已是最新，跳过复制');
  process.exit(0);
}

console.log('[bundle-ollama] 从 ' + src + ' 复制 Ollama 运行时 → ' + dest);
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

function run(cmd) {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (e) {
    // robocopy 退出码 1 表示“已复制成功”，并非错误，故忽略非 0
  }
}

if (process.platform === 'win32') {
  // 仅复制 ollama.exe
  run(`robocopy "${src}" "${dest}" ollama.exe /NFL /NDL /NJH /NJS`);
  // 复制 lib（排除 CUDA 体积大户 cuda_v12 / cuda_v13）
  run(`robocopy "${path.join(src, 'lib')}" "${path.join(dest, 'lib')}" /E /XD cuda_v12 cuda_v13 /NFL /NDL /NJH /NJS`);
} else {
  run(`cp "${srcExe}" "${destExe}"`);
  run(`cp -r "${path.join(src, 'lib')}" "${path.join(dest, 'lib')}"`);
  run(`rm -rf "${path.join(dest, 'lib', 'ollama', 'cuda_v12')}" "${path.join(dest, 'lib', 'ollama', 'cuda_v13')}"`);
}

console.log('[bundle-ollama] 完成（resources/ollama 已就绪，将被 extraResources 打包到安装目录/resources/ollama）');
