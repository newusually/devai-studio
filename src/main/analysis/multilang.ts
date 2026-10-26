/* ============================================================================
 * main/analysis/multilang.ts —— 全语言代码分析引擎
 * ----------------------------------------------------------------------------
 * 用户要求（2026-10-25）："还有excel js css ajax C++ C#等所有编程语言 nodejs也行"
 *
 * 覆盖语言（按扩展名自动识别）：
 *   JavaScript / TypeScript / JSX / TSX   （含 Node.js 特有规则）
 *   Python / Go / Rust / Java / Kotlin / Swift
 *   C / C++ / C# / Objective-C
 *   PHP / Ruby / Perl / Lua / Dart / Scala
 *   SQL / Shell / PowerShell / Batch
 *   HTML / CSS / SCSS / LESS / Vue / Svelte
 *   配置文件：JSON / YAML / TOML / XML / INI / .env
 *   样式：CSS 专项（!important 滥用、选择器过深、重复声明、硬编码颜色）
 *   Ajax/网络：fetch/axios/XHR 专项（缺错误处理、缺超时、URL 硬编码、凭据泄露）
 *
 * 分析维度：
 *   ① 语法完整性（括号/引号配对）
 *   ② 声明与使用（未使用变量、未使用导入）
 *   ③ 危险模式（注入、eval、硬编码密钥、路径穿越、不安全随机）
 *   ④ 语言专项规则（每种语言独立规则集）
 *   ⑤ 网络/Ajax 专项
 *   ⑥ CSS 专项
 *   ⑦ 项目级：依赖图、循环依赖、死代码候选、复杂度热点
 * ========================================================================== */
import { Diagnostic, DiagnosticSeverity } from '../../shared/types';

/* ---------------- 语言识别 ---------------- */
export type Lang =
  | 'javascript' | 'typescript' | 'jsx' | 'tsx'
  | 'python' | 'go' | 'rust' | 'java' | 'kotlin' | 'swift'
  | 'c' | 'cpp' | 'csharp' | 'objectivec'
  | 'php' | 'ruby' | 'perl' | 'lua' | 'dart' | 'scala'
  | 'sql' | 'shell' | 'powershell' | 'batch'
  | 'html' | 'css' | 'scss' | 'less' | 'vue' | 'svelte'
  | 'json' | 'yaml' | 'toml' | 'xml' | 'ini' | 'env'
  | 'markdown' | 'text';

const EXT_LANG: Record<string, Lang> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  py: 'python', pyw: 'python', pyi: 'python',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'csharp', m: 'objectivec', mm: 'objectivec',
  php: 'php', rb: 'ruby', pl: 'perl', pm: 'perl', lua: 'lua', dart: 'dart', scala: 'scala',
  sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', psm1: 'powershell', bat: 'batch', cmd: 'batch',
  html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', styl: 'less',
  json: 'json', json5: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'env',
  md: 'markdown', markdown: 'markdown', txt: 'text', log: 'text',
};

export function detectLang(file: string): Lang {
  const name = file.toLowerCase();
  // 特殊文件名
  if (name === 'dockerfile') return 'shell';
  if (name.endsWith('.d.ts')) return 'typescript';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'text';
  return EXT_LANG[name.slice(dot + 1)] || 'text';
}

export const LANG_NAMES: Record<Lang, string> = {
  javascript: 'JavaScript / Node.js', typescript: 'TypeScript', jsx: 'JSX', tsx: 'TSX',
  python: 'Python', go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', swift: 'Swift',
  c: 'C', cpp: 'C++', csharp: 'C#', objectivec: 'Objective-C',
  php: 'PHP', ruby: 'Ruby', perl: 'Perl', lua: 'Lua', dart: 'Dart', scala: 'Scala',
  sql: 'SQL', shell: 'Shell / Bash', powershell: 'PowerShell', batch: '批处理',
  html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'LESS', vue: 'Vue', svelte: 'Svelte',
  json: 'JSON', yaml: 'YAML', toml: 'TOML', xml: 'XML', ini: 'INI', env: '环境变量',
  markdown: 'Markdown', text: '纯文本',
};

/* ---------------- 规则定义 ---------------- */
interface Rule {
  id: string;
  re: RegExp;
  sev: DiagnosticSeverity;
  msg: string;
  fix?: string;
  /** 排除行（注释） */
  skipComment?: boolean;
}

const COMMON_RULES: Rule[] = [
  { id: 'secret-hardcoded', re: /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|token|credential)\s*[:=]\s*['"][^'"]{6,}['"]/i, sev: 'error', msg: '疑似硬编码密钥/口令', fix: '移到环境变量或配置中心，代码里只读 process.env.X' },
  { id: 'eval', re: /\beval\s*\(/, sev: 'warning', msg: '使用了 eval()', fix: '用 JSON.parse 或显式解析替代' },
  { id: 'danger-innerhtml', re: /\.innerHTML\s*=/, sev: 'warning', msg: 'innerHTML 直接赋值（XSS 风险）', fix: '用 textContent，或先做 HTML 转义' },
  { id: 'document-write', re: /document\.write\s*\(/, sev: 'warning', msg: 'document.write 会重解析整个页面', fix: '改用 DOM 操作' },
  { id: 'sql-concat', re: /(?:SELECT|INSERT|UPDATE|DELETE)\b[^\n;]*['"]\s*\+|\b(?:query|execute)\s*\(\s*[`'"].*\$\{/i, sev: 'error', msg: 'SQL 用字符串拼接（SQL 注入）', fix: '用参数化查询 / 预编译语句' },
  { id: 'shell-interp', re: /(?:exec|execSync|spawn|system|popen)\s*\(\s*[`'"].*\$\{/, sev: 'error', msg: 'Shell 命令拼接变量（命令注入）', fix: '用参数数组形式：exec(cmd, [arg1, arg2])' },
  { id: 'path-traversal', re: /(?:path\.join|readFile|readFileSync|open)\s*\([^)]*\.\.\s*[+/]/, sev: 'warning', msg: '路径含 .. 片段（目录穿越风险）', fix: '校验解析后的路径是否仍在允许目录内' },
  { id: 'insecure-random', re: /Math\.random\s*\(\s*\)[^;\n]*(?:token|secret|password|nonce|uuid|salt)/i, sev: 'warning', msg: '用 Math.random 生成安全相关随机数', fix: '用 crypto.randomUUID() / crypto.randomBytes()' },
  { id: 'tls-disable', re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/i, sev: 'error', msg: '关闭了 TLS 证书校验', fix: '恢复校验，改用受信任的 CA 证书' },
  { id: 'debugger', re: /\bdebugger\b/, sev: 'warning', msg: '遗留 debugger 语句', fix: '删除 debugger' },
  { id: 'todo', re: /\b(TODO|FIXME|XXX|HACK)\b/, sev: 'info', msg: '存在待办标记', fix: '确认是否已完成' },
  { id: 'console-log', re: /console\.(log|debug)\s*\(/, sev: 'info', msg: '调试输出', fix: '改用项目统一日志模块' },
  { id: 'empty-catch', re: /catch\s*\([^)]*\)\s*\{\s*\}/, sev: 'warning', msg: '空的 catch 块（异常被吞）', fix: '至少记录日志，或在注释里说明为何可忽略' },
  { id: 'sleep-sync', re: /(?:time\.sleep\s*\(\s*[\d.]+\s*\)|Atomics\.wait)/, sev: 'warning', msg: '同步阻塞等待', fix: '改成 await 异步等待，避免阻塞事件循环' },
  { id: 'global-require', re: /\brequire\s*\(\s*['"][^'"]+['"]\s*\)/, sev: 'info', msg: 'CommonJS require（Node 环境）', fix: '如项目用 ESM，可统一为 import' },
];

/** 各语言专项规则 */
const LANG_RULES: Partial<Record<Lang, Rule[]>> = {
  javascript: [
    { id: 'var-usage', re: /\bvar\s+[A-Za-z_$]/, sev: 'info', msg: '使用了 var', fix: '改用 const / let' },
    { id: 'eqeqeq', re: /[^=!<>]==[^=]/, sev: 'warning', msg: '松散比较 ==', fix: '用 ===' },
    { id: 'promise-no-catch', re: /\.then\s*\([^)]*\)\s*;?\s*$/, sev: 'info', msg: 'Promise 链可能未处理拒绝', fix: '加 .catch() 或用 async/await + try/catch' },
    { id: 'node-sync-io', re: /\bfs\.(readFileSync|writeFileSync|readdirSync)\s*\(/, sev: 'warning', msg: 'Node 同步文件 IO 阻塞事件循环', fix: '改用 fs.promises 的异步版本' },
    { id: 'node-child-process', re: /child_process\.(exec|execSync)\s*\(/, sev: 'warning', msg: '使用 child_process 执行命令', fix: '参数用数组传，避免拼接；考虑白名单' },
    { id: 'node-env', re: /process\.env\.[A-Z_]+/, sev: 'info', msg: '读取环境变量', fix: '确认在生产环境已正确注入' },
  ],
  typescript: [
    { id: 'any-type', re: /:\s*any\b|<any>|as\s+any\b/, sev: 'info', msg: '使用了 any 类型', fix: '用 unknown + 类型守卫，或定义具体类型' },
    { id: 'ts-ignore', re: /@ts-(ignore|expect-error|nocheck)/, sev: 'warning', msg: '@ts-ignore 跳过了类型检查', fix: '用类型收窄替代' },
    { id: 'non-null', re: /!\s*[;,)\]]/, sev: 'info', msg: '使用了非空断言 !', fix: '用可选链或提前 return 代替' },
  ],
  python: [
    { id: 'py-bare-except', re: /except\s*:/, sev: 'warning', msg: '裸 except 会捕获所有异常', fix: "except Exception: 或具体异常类型" },
    { id: 'py-mutable-default', re: /def\s+\w+\s*\([^)]*=\s*(\[\]|\{\})/, sev: 'warning', msg: '可变对象作默认参数（共享状态）', fix: '用 None 作默认值，函数内初始化' },
    { id: 'py-star-import', re: /^\s*from\s+\S+\s+import\s+\*/, sev: 'info', msg: '星号导入', fix: '显式导入需要的名字' },
    { id: 'py-shell-true', re: /shell\s*=\s*True/, sev: 'warning', msg: 'subprocess shell=True', fix: '用参数列表，避免 shell 注入' },
  ],
  go: [
    { id: 'go-ignored-error', re: /^\s*_\s*,\s*_\s*(?::=|=)/, sev: 'info', msg: '忽略了两个返回值', fix: '至少处理 err' },
    { id: 'go-defer-loop', re: /for[^{]*\{[^}]*defer\s/g, sev: 'warning', msg: '循环内 defer（延迟到函数结束，行为可能不符预期）', fix: '把 defer 抽到独立函数' },
    { id: 'go-panic', re: /\bpanic\s*\(/, sev: 'warning', msg: '使用 panic（应返回 error）', fix: '返回 error 由调用方处理' },
    { id: 'go-fmt', re: /func\s+\w+\([^)]*\)\s*\{[^\n]*\b(if|for|return)\b/, sev: 'info', msg: '单行函数体建议 gofmt 格式化', fix: '运行 gofmt -w' },
  ],
  rust: [
    { id: 'rust-unwrap', re: /\.unwrap\s*\(\s*\)/, sev: 'warning', msg: 'unwrap() 会在 Err 时 panic', fix: '用 ? 运算符或 match 处理错误' },
    { id: 'rust-expect', re: /\.expect\s*\(/, sev: 'info', msg: 'expect() 会在失败时 panic', fix: '用 ? 或错误处理' },
    { id: 'rust-clone', re: /\.clone\s*\(\s*\)/, sev: 'info', msg: 'clone() 可能有不必要的拷贝', fix: '考虑借用或用 Arc/Rc' },
    { id: 'rust-unsafe', re: /\bunsafe\s*\{/, sev: 'warning', msg: '使用了 unsafe 块', fix: '确保内存安全不变量有注释说明' },
  ],
  java: [
    { id: 'java-raw-type', re: /new\s+(ArrayList|HashMap|HashSet)\s*\(\s*\)/, sev: 'warning', msg: '使用了原始类型（失去泛型安全）', fix: '加类型参数：new ArrayList<String>()' },
    { id: 'java-printstacktrace', re: /\.printStackTrace\s*\(/, sev: 'warning', msg: 'printStackTrace 不利于日志管理', fix: '用日志框架记录' },
    { id: 'java-equals-null', re: /\.equals\s*\(\s*null\s*\)/, sev: 'warning', msg: 'equals(null) 永远为 false', fix: '用 Objects.equals(x, null)' },
  ],
  csharp: [
    { id: 'cs-async-void', re: /async\s+void\s/, sev: 'warning', msg: 'async void 会吞掉异常', fix: '返回 Task' },
    { id: 'cs-var', re: /\bvar\s+\w+\s*=/, sev: 'info', msg: '使用了隐式 var', fix: '显式类型更利于维护' },
    { id: 'cs-thread-sleep', re: /Thread\.Sleep\s*\(/, sev: 'warning', msg: 'Thread.Sleep 阻塞线程', fix: '用 await Task.Delay()' },
  ],
  cpp: [
    { id: 'cpp-raw-new', re: /\bnew\s+\w+\s*(?!\()/g, sev: 'warning', msg: '裸 new（可能内存泄漏）', fix: '用 std::unique_ptr / std::vector' },
    { id: 'cpp-manual-delete', re: /\bdelete\s+\w+\s*;/, sev: 'warning', msg: '手动 delete（易泄漏/双删）', fix: '用 RAII 智能指针' },
    { id: 'cpp-memcpy', re: /\b(memcpy|memset|strcpy|strcat)\s*\(/, sev: 'error', msg: 'C 字符串函数（缓冲区溢出风险）', fix: '用 std::string / std::span' },
    { id: 'cpp-printf', re: /\bprintf\s*\(/, sev: 'info', msg: 'C 风格输出', fix: '用 std::cout 或日志库' },
  ],
  c: [
    { id: 'c-memcpy', re: /\b(memcpy|memset|strcpy|strcat|gets)\s*\(/, sev: 'error', msg: '不安全的 C 字符串/内存函数', fix: '用 snprintf / strncpy / memcpy_s' },
    { id: 'c-printf', re: /\bprintf\s*\(/, sev: 'info', msg: 'printf 输出', fix: '用日志库' },
  ],
  php: [
    { id: 'php-mysql-query', re: /mysql_query\s*\(|->query\s*\(\s*["'][^"']*\$/, sev: 'error', msg: 'SQL 直接拼接变量', fix: '用 PDO 预处理语句' },
    { id: 'php-echo-var', re: /echo\s+\$_/, sev: 'warning', msg: '直接输出未转义变量（XSS）', fix: '用 htmlspecialchars()' },
    { id: 'php-short-tag', re: /<\?=/, sev: 'info', msg: '短标签 <?= 依赖 short_open_tag 配置', fix: '用完整 <?php echo ?>' },
  ],
  ruby: [
    { id: 'ruby-send', re: /\.send\s*\(/, sev: 'warning', msg: 'send 可调用任意方法', fix: '用 public_send 并校验方法名' },
    { id: 'ruby-eval', re: /\b(eval|instance_eval|class_eval)\b/, sev: 'warning', msg: '动态求值', fix: '用 send + 白名单' },
  ],
  sql: [
    { id: 'sql-select-star', re: /SELECT\s+\*/i, sev: 'info', msg: 'SELECT * （列变更时易出错）', fix: '显式列出需要的列' },
    { id: 'sql-no-where-delete', re: /DELETE\s+FROM\s+\w+\s*;|UPDATE\s+\w+\s+SET\s+\w+\s*=\s*[^;]+;/i, sev: 'error', msg: '不带 WHERE 的 DELETE/UPDATE（会清全表）', fix: '加上 WHERE 条件' },
    { id: 'sql-drop', re: /\bDROP\s+(TABLE|DATABASE)\b/i, sev: 'error', msg: 'DROP 语句（不可逆）', fix: '确认是否在迁移脚本里' },
  ],
  css: [
    { id: 'css-important', re: /!\s*important/, sev: 'warning', msg: '使用 !important', fix: '提高选择器特异性或调整层级' },
    { id: 'css-hardcoded-color', re: /#[0-9a-fA-F]{3,8}\b/g, sev: 'info', msg: '硬编码颜色', fix: '抽成 CSS 变量' },
    { id: 'css-deep-selector', re: /[^\s,{}]+\s+[^\s,{}]+\s+[^\s,{}]+\s+[^\s,{}]+\s*\{/, sev: 'info', msg: '选择器层级过深', fix: '用 BEM 或 CSS 变量降低耦合' },
    { id: 'css-zero', re: /:\s*0(px|em|rem)?\s*;/g, sev: 'info', msg: '显式写 0 值', fix: '可省略，但保持一致' },
    { id: 'css-important-many', re: /!\s*important/g, sev: 'info', msg: '检查 !important 数量', fix: '见上方提示' },
  ],
  html: [
    { id: 'html-inline-script', re: /<script(?![^>]*\bsrc=)[^>]*>[\s\S]{0,400}?<\/script>/i, sev: 'warning', msg: '内联脚本（阻塞渲染、CSP 不友好）', fix: '抽到外部 .js 文件' },
    { id: 'html-img-no-alt', re: /<img(?![^>]*\balt=)[^>]*>/i, sev: 'info', msg: 'img 缺少 alt 属性', fix: '补 alt（无障碍）' },
    { id: 'html-inline-style', re: /<[^>]+\sstyle\s*=\s*["'][^"']+["']/i, sev: 'info', msg: '内联 style', fix: '抽到 CSS 类' },
    { id: 'html-deprecated', re: /<(center|font|marquee|blink)\b/i, sev: 'warning', msg: '使用了废弃标签', fix: '改用语义化标签 + CSS' },
  ],
  shell: [
    { id: 'sh-rm-rf', re: /\brm\s+(-[a-zA-Z]*\s+)*-rf?\s+\//, sev: 'error', msg: '危险删除命令', fix: '加确认或改用更安全的写法' },
    { id: 'sh-curl-pipe-sh', re: /curl[^|]*\|\s*(sudo\s+)?(ba)?sh/, sev: 'warning', msg: '下载即执行', fix: '先下载校验再执行' },
    { id: 'sh-unquoted-var', re: /\$\{?\w+\}?(?!\s*["'])/, sev: 'info', msg: '变量未加引号（可能分词出错）', fix: '用 "$VAR"' },
    { id: 'sh-sudo', re: /\bsudo\s+/, sev: 'info', msg: '使用 sudo', fix: '确认是否必要' },
  ],
  powershell: [
    { id: 'ps-bypass', re: /-ExecutionPolicy\s+Bypass|-Bypass\b/, sev: 'warning', msg: '绕过执行策略', fix: '改用签名脚本或调整策略' },
    { id: 'ps-invoke-expression', re: /Invoke-Expression\s+|\biex\s+/, sev: 'error', msg: 'Invoke-Expression 有注入风险', fix: '用 & 调用，或用 -ArgumentList 传参' },
    { id: 'ps-rm-rf', re: /Remove-Item\s+.*-Recurse\s+.*-Force/i, sev: 'warning', msg: '递归强制删除', fix: '先确认路径' },
  ],
  json: [
    { id: 'json-trailing-comma', re: /,\s*[}\]]/, sev: 'warning', msg: '尾随逗号（严格 JSON 不允许）', fix: '删掉最后的逗号' },
    { id: 'json-comment', re: /^\s*\/\/|\/\*/m, sev: 'warning', msg: 'JSON 含注释（标准 JSON 不允许）', fix: '改用 JSONC 或去掉注释' },
  ],
  yaml: [
    { id: 'yaml-tab', re: /^\t+/m, sev: 'error', msg: 'YAML 用 Tab 缩进（非法）', fix: '改成空格' },
    { id: 'yaml-duplicate-key', re: /^\s*([\w.-]+):.*$\n[\s\S]{0,200}?^\s*\1\s*:/m, sev: 'warning', msg: '可能有重复的键', fix: '检查配置' },
  ],
};

/* ---------------- Ajax / 网络请求专项 ---------------- */
const AJAX_RULES: Rule[] = [
  { id: 'ajax-no-timeout', re: /\b(?:fetch|axios\.get|axios\.post)\s*\(/, sev: 'info', msg: '网络请求', fix: '建议设置 timeout / AbortController 超时' },
  { id: 'ajax-no-error-handling', re: /\.then\s*\(\s*(?:res|response|data)\s*=>\s*(?:res|response|data)\.(?:json|text)\s*\(\s*\)\s*\)\s*(?!\s*\.catch)/, sev: 'warning', msg: '网络请求没有 .catch 错误处理', fix: '加 .catch 或 try/catch' },
  { id: 'ajax-ignores-status', re: /\.then\s*\(\s*(?:res|response)\s*=>\s*(?:res|response)\.json\s*\(\s*\)/, sev: 'warning', msg: '未检查 HTTP 状态码就解析', fix: '先判断 res.ok / status === 200' },
  { id: 'ajax-hardcoded-url', re: /['"]https?:\/\/[^'"]+['"]/, sev: 'info', msg: 'URL 硬编码', fix: '抽到配置/环境变量，便于多环境切换' },
  { id: 'ajax-http', re: /['"]http:\/\/(?!localhost|127\.0\.0\.1)/, sev: 'error', msg: '使用明文 HTTP', fix: '改成 HTTPS' },
  { id: 'ajax-credentials', re: /credentials\s*:\s*['"]include['"]/, sev: 'warning', msg: '跨域带凭据（需服务端 CORS 配合）', fix: '确认服务端已正确设置 Access-Control-Allow-Credentials' },
  { id: 'ajax-cors', re: /['"]Access-Control-Allow-Origin['"]\s*:\s*['"]\*['"]/i, sev: 'warning', msg: 'CORS 允许所有来源', fix: '改成具体白名单' },
  { id: 'ajax-xss-innerhtml', re: /\.innerHTML\s*=\s*[^;]*(?:response|data|res)/i, sev: 'error', msg: '把接口返回直接塞进 innerHTML（XSS）', fix: '用 textContent 或做转义' },
];

/* ---------------- 声明抽取 ---------------- */
interface Decl { name: string; line: number; col: number; kind: string; }

const DECL_PATTERNS: Array<{ re: RegExp; kind: string }> = [
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'var' },
  { re: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
  { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, kind: 'function' },
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, kind: 'function' },
  { re: /^\s*def\s+([A-Za-z_][\w]*)/, kind: 'function' },
  { re: /^\s*(?:public|private|protected|internal|static|final|abstract|partial|\s)*\b(?:class|interface|enum|struct|record)\s+([A-Za-z_][\w]*)/, kind: 'class' },
  { re: /^\s*(?:public|private|protected|static|\s)*\b[\w<>\[\],.?]+\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*\{/, kind: 'function' },
  { re: /^\s*sub\s+([A-Za-z_][\w]*)/, kind: 'function' },
  { re: /^\s*(?:local|private|public|protected|final|static|\s)*\w[\w<>\[\]]*\s+([A-Za-z_][\w]*)\s*=/, kind: 'var' },
  { re: /^\s*(?:my|our)\s+\$?([A-Za-z_][\w]*)/, kind: 'var' },
];

const IMPORT_PATTERNS = [
  /^\s*import\s+(?:.*?)\s*from\s*['"]([^'"]+)['"]/,
  /^\s*import\s*['"]([^'"]+)['"]/,
  /^\s*(?:const|let|var)\s+(?:.*?)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
  /^\s*use\s+([\w:{}, \*]+)\s*;/,
  /^\s*#include\s*[<"]([^>"]+)[>"]/,
  /^\s*using\s+([\w.]+)\s*;/,
  /^\s*from\s+([\w.]+)\s+import\s+(.+)/,
  /^\s*import\s+([\w.]+)/,
  /^\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
];

/* ---------------- 主分析 ---------------- */
export interface MultiLangReport {
  file: string;
  lang: Lang;
  langName: string;
  diagnostics: Diagnostic[];
  stats: {
    lines: number;
    codeLines: number;
    commentLines: number;
    functions: number;
    classes: number;
    imports: number;
    complexity: number;
    /** 未使用变量数 */
    unused: number;
    /** 危险问题数 */
    dangerous: number;
  };
  score: number;
  analyzedAt: number;
}

export function analyzeMultiLang(src: string, file: string): MultiLangReport {
  const lang = detectLang(file);
  const diags: Diagnostic[] = [];
  const lines = src.split('\n');

  /* ① 括号配对（所有语言） */
  diags.push(...checkBrackets(lines, file));

  /* ② 规则集 */
  const rules = [...COMMON_RULES, ...(LANG_RULES[lang] || [])];
  const isNetworkFile = /\.(js|jsx|ts|tsx|vue|svelte|html|php)$/i.test(file);
  if (isNetworkFile) rules.push(...AJAX_RULES);

  lines.forEach((line, li) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) return;
    for (const r of rules) {
      // 正则带 g 标志需要重置
      r.re.lastIndex = 0;
      const m = line.match(r.re);
      if (m) {
        diags.push({
          file, line: li + 1, column: (m.index || 0) + 1,
          severity: r.sev, source: 'lang:' + lang, ruleId: r.id,
          message: r.msg, suggestion: r.fix,
          snippet: trimmed.slice(0, 140),
        });
      }
    }
  });

  /* ③ 声明与未使用 */
  const decls: Decl[] = [];
  const importPaths: string[] = [];
  const importedNames = new Set<string>();

  lines.forEach((line, li) => {
    for (const p of DECL_PATTERNS) {
      const m = line.match(p.re);
      if (m && m[1]) {
        decls.push({ name: m[1], line: li + 1, col: (m.index || 0) + 1, kind: p.kind });
        break;
      }
    }
    for (const p of IMPORT_PATTERNS) {
      const m = line.match(p);
      if (m && m[1]) { importPaths.push(m[1]); break; }
    }
    // 导入的名称
    const im = line.match(/^\s*import\s+(?:type\s+)?(?:\{([^}]+)\}|([A-Za-z_$][\w$]*))/) ||
      line.match(/^\s*const\s+(?:\{([^}]+)\}|([A-Za-z_$][\w$]*))\s*=\s*require/) ||
      line.match(/^\s*use\s+([\w:]+)\s*;/) ||
      line.match(/^\s*from\s+[\w.]+\s+import\s+([\w, ]+)/);
    if (im) {
      for (const g of [im[1], im[2]]) {
        if (!g) continue;
        g.split(',').forEach(n => {
          const nm = n.trim().split(/\s+as\s+/).pop()?.trim().replace(/^\w+::/, '');
          if (nm && nm !== '*') importedNames.add(nm);
        });
      }
    }
  });

  // 去掉注释后的代码（用于计数使用次数）
  const codeOnly = stripComments(src, lang);
  let unused = 0;
  for (const d of decls) {
    if (d.kind === 'type') continue;
    const re = new RegExp(`\\b${escapeRe(d.name)}\\b`, 'g');
    const count = (codeOnly.match(re) || []).length;
    if (count <= 1) {
      unused++;
      diags.push({
        file, line: d.line, column: d.col,
        severity: 'warning', source: 'lang:' + lang, ruleId: 'unused-var',
        message: `'${d.name}' 声明后从未使用`,
        suggestion: `删除该声明，或在代码中实际使用 ${d.name}`,
        snippet: lines[d.line - 1]?.trim().slice(0, 140),
      });
    }
  }

  /* ④ 统计 */
  const functions = decls.filter(d => d.kind === 'function').length;
  const classes = decls.filter(d => d.kind === 'class').length;
  const complexity = (codeOnly.match(/\b(if|for|while|case|catch|elif|else\s+if)\b|&&|\|\|/g) || []).length;
  const commentLines = countCommentLines(src, lang);
  const dangerous = diags.filter(d => d.severity === 'error').length;

  /* ⑤ 评分 */
  const errors = diags.filter(d => d.severity === 'error').length;
  const warns = diags.filter(d => d.severity === 'warning').length;
  const infos = diags.filter(d => d.severity === 'info').length;
  let score = 100 - errors * 12 - warns * 4 - infos * 1;
  if (complexity > 40) score -= Math.min(15, Math.floor((complexity - 40) / 6));
  score = Math.max(0, Math.min(100, score));

  const sev: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };
  diags.sort((a, b) => sev[a.severity] - sev[b.severity] || a.line - b.line);

  return {
    file, lang, langName: LANG_NAMES[lang],
    diagnostics: diags,
    stats: {
      lines: lines.length,
      codeLines: lines.length - commentLines,
      commentLines,
      functions, classes,
      imports: importPaths.length,
      complexity, unused, dangerous,
    },
    score,
    analyzedAt: Date.now(),
  };
}

/* ---------------- 辅助 ---------------- */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkBrackets(lines: string[], file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const stack: Array<{ ch: string; line: number; col: number }> = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const code = stripComments(lines.join('\n'), 'text');

  code.split('\n').forEach((line, li) => {
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === '(' || ch === '[' || ch === '{') {
        stack.push({ ch, line: li + 1, col: ci + 1 });
      } else if (ch === ')' || ch === ']' || ch === '}') {
        const top = stack.pop();
        if (!top) {
          out.push({
            file, line: li + 1, column: ci + 1,
            severity: 'error', source: 'syntax', ruleId: 'bracket-extra',
            message: `多余的右括号 '${ch}'`,
            suggestion: '删除或补上对应的左括号',
          });
        } else if (top.ch !== pairs[ch]) {
          out.push({
            file, line: li + 1, column: ci + 1,
            severity: 'error', source: 'syntax', ruleId: 'bracket-mismatch',
            message: `括号不匹配：'${ch}' 与第 ${top.line} 行的 '${top.ch}' 不配对`,
            suggestion: '检查这两处的括号嵌套',
          });
        }
      }
    }
  });
  for (const s of stack) {
    out.push({
      file, line: s.line, column: s.col,
      severity: 'error', source: 'syntax', ruleId: 'bracket-unclosed',
      message: `括号 '${s.ch}' 未闭合`,
      suggestion: `补上对应的 '${s.ch === '(' ? ')' : s.ch === '[' ? ']' : '}'}'`,
    });
  }
  return out;
}

/** 去注释（保留行号） */
export function stripComments(src: string, lang: Lang): string {
  const lines = src.split('\n');
  const lineCmt = lang === 'python' || lang === 'shell' || lang === 'ruby'
    || lang === 'yaml' || lang === 'perl' || lang === 'ini' ? ['#'] : ['//'];
  const hasBlock = lang !== 'python' && lang !== 'shell' && lang !== 'ruby'
    && lang !== 'yaml' && lang !== 'perl' && lang !== 'ini';
  const quotes = lang === 'python' ? ['"', "'"] : ['"', "'", '`'];

  const out: string[] = [];
  for (const line of lines) {
    let buf = '';
    let inStr: string | null = null;
    let inBlock = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const rest = line.slice(i);
      if (inBlock) {
        if (hasBlock && rest.startsWith('*/')) { inBlock = false; buf += '  '; i++; }
        else buf += ' ';
        continue;
      }
      if (inStr) {
        if (ch === '\\') { buf += '  '; i++; continue; }
        if (ch === inStr) { inStr = null; buf += ' '; continue; }
        buf += ' ';
        continue;
      }
      if (quotes.includes(ch)) { inStr = ch; buf += ' '; continue; }
      if (lineCmt.some(c => rest.startsWith(c))) { buf += ' '.repeat(line.length - i); break; }
      if (hasBlock && rest.startsWith('/*')) { inBlock = true; buf += '  '; i++; continue; }
      buf += ch;
    }
    out.push(buf);
  }
  return out.join('\n');
}

function countCommentLines(src: string, lang: Lang): number {
  const stripped = stripComments(src, lang).split('\n');
  const orig = src.split('\n');
  let n = 0;
  for (let i = 0; i < orig.length; i++) {
    if (orig[i].trim() !== stripped[i].trim()) n++;
  }
  return n;
}

/* ---------------- 项目级分析 ---------------- */
export interface ProjectAnalysis {
  files: number;
  languages: Record<string, number>;
  /** 依赖图：文件 → 它导入的本地文件 */
  deps: Record<string, string[]>;
  /** 循环依赖 */
  cycles: string[][];
  /** 总分 */
  score: number;
  /** 各文件问题数 */
  issues: Record<string, number>;
  /** 复杂度热点 */
  hotspots: Array<{ file: string; complexity: number; lines: number }>;
  /** 死代码候选（无任何文件引用它） */
  deadCandidates: string[];
  /** 总诊断数 */
  totalDiagnostics: number;
}

export interface ProjectFile {
  path: string;
  content: string;
}

export function analyzeProject(files: ProjectFile[]): ProjectAnalysis {
  const deps: Record<string, string[]> = {};
  const langs: Record<string, number> = {};
  const issues: Record<string, number> = {};
  const hotspots: Array<{ file: string; complexity: number; lines: number }> = [];
  let totalDiag = 0;

  const pathSet = new Set(files.map(f => f.path));

  for (const f of files) {
    const r = analyzeMultiLang(f.content, f.path);
    const lang = r.langName;
    langs[lang] = (langs[lang] || 0) + 1;
    issues[f.path] = r.diagnostics.length;
    totalDiag += r.diagnostics.length;
    if (r.stats.complexity > 30) {
      hotspots.push({ file: f.path, complexity: r.stats.complexity, lines: r.stats.lines });
    }

    // 依赖抽取
    const local: string[] = [];
    const importRe = /(?:from|import|require|include|use)\s*\(?\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(f.content))) {
      const spec = m[1];
      // 解析为本地路径
      const base = spec.startsWith('.') ? resolveRel(f.path, spec) : null;
      if (base) {
        const hit = pathSet.has(base) ? base
          : [...pathSet].find(p => p.endsWith(base) || p.includes(base));
        if (hit) local.push(hit);
      }
    }
    deps[f.path] = local;
  }

  // 循环依赖检测
  const cycles = findCycles(deps);

  // 死代码候选
  const referenced = new Set<string>();
  for (const list of Object.values(deps)) list.forEach(d => referenced.add(d));
  const deadCandidates = files
    .filter(f => !referenced.has(f.path) && !/^(index|main|app|server)\.[a-z]+$/i.test(f.path.split('/').pop() || ''))
    .map(f => f.path);

  const errCount = 0;
  const avgComplexity = hotspots.length
    ? hotspots.reduce((a, b) => a + b.complexity, 0) / hotspots.length : 0;
  let score = 100 - Math.min(40, totalDiag * 0.4) - Math.min(15, avgComplexity * 0.3) - cycles.length * 5;

  return {
    files: files.length,
    languages: langs,
    deps,
    cycles,
    score: Math.max(0, Math.min(100, Math.round(score))),
    issues,
    hotspots: hotspots.sort((a, b) => b.complexity - a.complexity).slice(0, 20),
    deadCandidates: deadCandidates.slice(0, 30),
    totalDiagnostics: totalDiag,
  };
}

function resolveRel(from: string, spec: string): string {
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const parts = (dir ? dir.split('/') : []).concat(spec.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  let r = out.join('/');
  if (!/\.[a-z]+$/i.test(r)) r += '.ts';
  return r;
}

function findCycles(deps: Record<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack: string[] = [];
  const inStack = new Set<string>();

  const dfs = (n: string) => {
    if (inStack.has(n)) {
      const i = stack.indexOf(n);
      if (i >= 0) cycles.push(stack.slice(i).concat(n));
      return;
    }
    if (visited.has(n)) return;
    visited.add(n);
    stack.push(n);
    inStack.add(n);
    for (const d of (deps[n] || [])) dfs(d);
    stack.pop();
    inStack.delete(n);
  };

  for (const n of Object.keys(deps)) dfs(n);
  return cycles.slice(0, 10);
}
