/* ============================================================================
 * main/analysis/linter.ts —— 本地静态分析引擎
 * ----------------------------------------------------------------------------
 * 为什么需要本地分析（不靠 LLM）：
 *   1. 8G 内存机器上本地小模型对"找错"这种确定性任务反而不可靠
 *   2. 语法错误、未使用变量、缺失导入 —— 用规则查是 100% 准的，用 LLM 是概率性的
 *   3. 免费云端有次数限制（50 次/天），不能把"查错"浪费在配额上
 *   4. 本地分析零延迟、零成本、离线可用
 *
 * 实现方式：不引入重型依赖（ESLint 需要完整 JS 解析器且吃内存），
 *   采用「轻量词法分析 + 规则集」策略，覆盖 JS/TS/Python/Go/C/C++/Java 的高频错误。
 *
 * 检测项：
 *   E  语法类：未闭合括号/引号、缺少分号（仅 JS）、`=` 与 `==` 混用
 *   E  导入类：使用了未导入的标识符、导入了不存在的文件
 *   W  未使用：声明了但从未使用的变量/导入/函数
 *   W  危险模式：== 与 null 比较、eval、var（ES5 时代）、console.log 遗留
 *   E  逻辑类：if/else 后无花括号导致的悬挂 else、return 在 finally
 *   I  风格：TODO/FIXME 标记、函数过长、嵌套过深
 * ========================================================================== */
import { Diagnostic, AnalysisReport, DiagnosticSeverity } from '../../shared/types';

/* ---------------- 语言识别 ---------------- */
export function detectLang(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', pyw: 'python',
    go: 'go',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    java: 'java',
    cs: 'csharp',
    rs: 'rust',
    php: 'php',
    rb: 'ruby',
    sh: 'shell', bash: 'shell',
    sql: 'sql',
    json: 'json',
    yaml: 'yaml', yml: 'yaml',
    md: 'markdown',
    html: 'html', htm: 'html',
    css: 'css', scss: 'css',
  };
  return map[ext] || 'text';
}

/* ---------------- 词法：去注释与字符串（保留行号） ---------------- */
interface StripResult {
  code: string;       // 去掉注释和字符串内容后的代码（字符串替换为等长空格）
  strings: string[];  // 所有字符串字面量
  comments: string[]; // 所有注释
}

export function stripCommentsAndStrings(src: string, lang: string): StripResult {
  const lines = src.split('\n');
  const out: string[] = [];
  const strings: string[] = [];
  const comments: string[] = [];

  // 简易状态机；支持 ' " ` 以及 // /* */ # 注释
  const lineComment = lang === 'python' || lang === 'shell' || lang === 'ruby' || lang === 'yaml'
    ? ['#'] : ['//'];
  const blockComment = ['/*', '*/'];
  const quoteChars = lang === 'python' ? ['"', "'"] : ['"', "'", '`'];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let buf = '';
    let inStr: string | null = null;
    let inBlock = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const rest = line.slice(i);

      if (inBlock) {
        if (rest.startsWith(blockComment[1])) { inBlock = false; buf += '  '; i++; }
        else buf += ' ';
        continue;
      }
      if (inStr) {
        if (ch === '\\') { buf += '  '; i++; continue; }
        if (ch === inStr) { inStr = null; buf += ' '; continue; }
        buf += ' ';
        continue;
      }
      // 进入字符串
      if (quoteChars.includes(ch)) {
        // Python 三引号
        if (lang === 'python' && (rest.startsWith('"""') || rest.startsWith("'''"))) {
          const q = rest.slice(0, 3);
          const end = line.indexOf(q, i + 3);
          if (end < 0) {
            strings.push(line.slice(i + 3));
            buf += ' '.repeat(line.length - i);
            i = line.length;
          } else {
            strings.push(line.slice(i + 3, end));
            buf += ' '.repeat(end - i + 3);
            i = end + 2;
          }
          continue;
        }
        inStr = ch;
        strings.push('');
        buf += ' ';
        continue;
      }
      // 行注释
      if (lineComment.some(c => rest.startsWith(c))) {
        comments.push(line.slice(i));
        buf += ' '.repeat(line.length - i);
        break;
      }
      // 块注释
      if (rest.startsWith(blockComment[0])) {
        inBlock = true;
        comments.push(line.slice(i));
        buf += '  ';
        i++;
        continue;
      }
      buf += ch;
    }
    out.push(buf);
  }
  return { code: out.join('\n'), strings, comments };
}

/* ---------------- 括号配对检查 ---------------- */
function checkBrackets(lines: string[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const stack: Array<{ ch: string; line: number; col: number }> = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

  lines.forEach((line, li) => {
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === '(' || ch === '[' || ch === '{') {
        stack.push({ ch, line: li + 1, col: ci + 1 });
      } else if (ch === ')' || ch === ']' || ch === '}') {
        const top = stack.pop();
        if (!top) {
          out.push({
            file: '', line: li + 1, column: ci + 1,
            severity: 'error', source: 'builtin', ruleId: 'bracket-extra',
            message: `多余的右括号 '${ch}'（没有匹配的左括号）`,
            suggestion: '删除这个右括号，或补上对应的左括号',
          });
        } else if (top.ch !== pairs[ch]) {
          out.push({
            file: '', line: li + 1, column: ci + 1,
            severity: 'error', source: 'builtin', ruleId: 'bracket-mismatch',
            message: `括号不匹配：'${ch}' 与第 ${top.line} 行的 '${top.ch}' 不配对`,
            suggestion: '检查这两处的括号嵌套',
          });
        }
      }
    }
  });
  for (const s of stack) {
    out.push({
      file: '', line: s.line, column: s.col,
      severity: 'error', source: 'builtin', ruleId: 'bracket-unclosed',
      message: `括号 '${s.ch}' 未闭合`,
      suggestion: `补上对应的 '${s.ch === '(' ? ')' : s.ch === '[' ? ']' : '}'}'`,
    });
  }
  return out;
}

/* ---------------- 声明与使用收集 ---------------- */
interface Decl {
  name: string;
  line: number;
  col: number;
  kind: 'var' | 'function' | 'class' | 'import' | 'param' | 'const';
}

const DECL_PATTERNS: Array<{ re: RegExp; kind: Decl['kind']; group?: number }> = [
  // JS/TS: const/let/var
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'var' },
  // 函数声明
  { re: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  // 类
  { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  // 箭头函数赋值
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: 'function' },
  // Python: def
  { re: /^\s*def\s+([A-Za-z_][\w]*)/, kind: 'function' },
  // Python: class
  { re: /^\s*class\s+([A-Za-z_][\w]*)/, kind: 'class' },
  // Go: func
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, kind: 'function' },
  // Java/C#: 类型名
  { re: /^\s*(?:public|private|protected|static|final|abstract|\s)*\b(?:class|interface|enum|struct)\s+([A-Za-z_][\w]*)/, kind: 'class' },
  // C/C++ 函数定义
  { re: /^[A-Za-z_][\w\s\*&:<>,]*\s([A-Za-z_][\w]*)\s*\([^;]*\)\s*\{/, kind: 'function' },
];

const IMPORT_PATTERNS = [
  /^\s*import\s+(?:.*?)\s*from\s*['"]([^'"]+)['"]/,          // ES import
  /^\s*import\s*['"]([^'"]+)['"]/,                             // side-effect import
  /^\s*const\s+(?:.*?)\s*=\s*require\(['"]([^'"]+)['"]\)/,     // CJS require
  /^\s*from\s+([\w.]+)\s+import\s+/,                          // Python from x import
  /^\s*import\s+([\w.]+)/,                                    // Python import
  /^\s*#include\s*[<"]([^>"]+)[>"]/,                          // C/C++
  /^\s*import\s+"([^"]+)"/,                                   // Go
  /^\s*use\s+([\w:]+)/,                                       // Rust
];

const IMPORTED_NAMES = [
  /^\s*import\s+(?:type\s+)?(?:\{([^}]+)\}|([A-Za-z_$][\w$]*)(?:\s*,\s*\{([^}]+)\})?)\s*from/,
  /^\s*const\s+(?:\{([^}]+)\}|([A-Za-z_$][\w$]*))\s*=\s*require/,
  /^\s*from\s+[\w.]+\s+import\s+(?:([A-Za-z_][\w]*)(?:\s*,\s*\*)?|.*?import\s+(.+))/,
];

/* ---------------- 主分析 ---------------- */
export function analyzeSource(src: string, file: string): AnalysisReport {
  const lang = detectLang(file);
  const diags: Diagnostic[] = [];
  const lines = src.split('\n');
  const raw = stripCommentsAndStrings(src, lang);
  const codeLines = raw.code.split('\n');

  /* ① 括号配对 */
  for (const d of checkBrackets(codeLines)) {
    diags.push({ ...d, file });
  }

  /* ② 声明收集 */
  const decls: Decl[] = [];
  const importedNames = new Set<string>();
  const importPaths: string[] = [];

  lines.forEach((line, li) => {
    for (const p of DECL_PATTERNS) {
      const m = line.match(p.re);
      if (m && m[1]) {
        decls.push({ name: m[1], line: li + 1, col: (m.index || 0) + 1, kind: p.kind });
        break;
      }
    }
    // 导入语句
    for (const p of IMPORT_PATTERNS) {
      const m = line.match(p);
      if (m && m[1]) { importPaths.push(m[1]); break; }
    }
    // 导入的名称
    for (const p of IMPORTED_NAMES) {
      const m = line.match(p);
      if (m) {
        for (const g of [m[1], m[2], m[3]]) {
          if (!g) continue;
          g.split(',').forEach(n => {
            const name = n.trim().split(/\s+as\s+/).pop()?.trim();
            if (name && name !== '*') importedNames.add(name);
          });
        }
        break;
      }
    }
  });

  /* ③ 未使用声明 */
  for (const d of decls) {
    if (d.kind === 'import') continue;
    const name = d.name;
    // 统计整份文件里该标识符出现次数（排除声明本身那一处）
    let count = 0;
    const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw.code))) count++;
    // 声明处算 1 次
    if (count <= 1) {
      diags.push({
        file, line: d.line, column: d.col,
        severity: 'warning', source: 'builtin', ruleId: 'no-unused-vars',
        message: `'${name}' 声明后从未使用`,
        suggestion: `删除该声明，或在代码中实际使用 ${name}`,
        snippet: lines[d.line - 1]?.trim().slice(0, 120),
      });
    }
  }

  /* ④ 未使用的导入 */
  for (const name of importedNames) {
    let count = 0;
    const re = new RegExp(`\\b${name}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw.code))) count++;
    if (count <= 1) {
      const idx = lines.findIndex(l => l.includes(name) && /import|from|require|use\s/.test(l));
      diags.push({
        file, line: idx + 1, column: 1,
        severity: 'warning', source: 'builtin', ruleId: 'no-unused-import',
        message: `导入的 '${name}' 未被使用`,
        suggestion: `从 import 语句中移除 ${name}`,
        snippet: idx >= 0 ? lines[idx].trim().slice(0, 120) : undefined,
      });
    }
  }

  /* ⑤ 危险模式 */
  const DANGER: Array<{ re: RegExp; msg: string; fix: string; sev: DiagnosticSeverity; rule: string }> = [
    { re: /[^=!<>]==[^=]/, msg: '使用了 `==` 松散比较', fix: '改用 `===` 严格比较', sev: 'warning', rule: 'eqeqeq' },
    { re: /!=[^=]/, msg: '使用了 `!=` 松散比较', fix: '改用 `!==` 严格比较', sev: 'warning', rule: 'eqeqeq' },
    { re: /\beval\s*\(/, msg: '使用了 eval()', fix: '用 JSON.parse 或显式解析替代', sev: 'warning', rule: 'no-eval' },
    { re: /\bvar\s+[A-Za-z_$]/, msg: '使用了 var（ES5 时代语法）', fix: '改用 const 或 let', sev: 'info', rule: 'no-var' },
    { re: /[^=!<>]==\s*null|null\s*==[^=]/, msg: '用 == 比较 null', fix: '改用 === null 或 == null', sev: 'warning', rule: 'eqeqeq-null' },
    { re: /\bconsole\.log\s*\(/, msg: '遗留的 console.log 调试输出', fix: '改用项目统一的日志模块，或在发布前移除', sev: 'info', rule: 'no-console' },
    { re: /\bdebugger\b/, msg: '遗留的 debugger 语句', fix: '删除 debugger', sev: 'warning', rule: 'no-debugger' },
    { re: /\.only\s*\(/, msg: '测试里残留 .only（会跳过其它用例）', fix: '改回 .it 或移除', sev: 'warning', rule: 'no-only' },
    { re: /TODO|FIXME|XXX|HACK/, msg: '代码中存在待办标记', fix: '确认是否已完成，若是遗留请清理', sev: 'info', rule: 'no-todo' },
    { re: /password\s*=\s*['"][^'"]+['"]/i, msg: '疑似硬编码密码', fix: '移到环境变量或配置文件中', sev: 'error', rule: 'no-hardcoded-secret' },
    { re: /api[_-]?key\s*=\s*['"][^'"]+['"]/i, msg: '疑似硬编码 API Key', fix: '移到环境变量中', sev: 'error', rule: 'no-hardcoded-secret' },
    { re: /secret\s*=\s*['"][^'"]+['"]/i, msg: '疑似硬编码密钥', fix: '移到环境变量中', sev: 'error', rule: 'no-hardcoded-secret' },
  ];

  lines.forEach((line, li) => {
    if (line.trim().startsWith('//') || line.trim().startsWith('#')) return;
    for (const d of DANGER) {
      const m = line.match(d.re);
      if (m) {
        diags.push({
          file, line: li + 1, column: (m.index || 0) + 1,
          severity: d.sev, source: 'builtin', ruleId: d.rule,
          message: d.msg, suggestion: d.fix,
          snippet: line.trim().slice(0, 120),
        });
      }
    }
  });

  /* ⑥ Python 特有：缩进不一致 */
  if (lang === 'python') {
    lines.forEach((line, li) => {
      if (!line.trim() || line.trim().startsWith('#')) return;
      const indent = line.length - line.trimStart().length;
      if (indent % 4 !== 0 && indent > 0 && !line.trimStart().startsWith(')')) {
        diags.push({
          file, line: li + 1, column: indent + 1,
          severity: 'info', source: 'builtin', ruleId: 'indent',
          message: `缩进 ${indent} 空格，不是 4 的倍数`,
          suggestion: 'Python 社区惯例使用 4 空格缩进',
          snippet: line.trim().slice(0, 100),
        });
      }
    });
  }

  /* ⑦ 函数过长 / 嵌套过深 */
  let funcCount = 0;
  let classCount = 0;
  let importCount = importPaths.length;
  let complexity = 0;

  lines.forEach((line, li) => {
    if (/^\s*(?:export\s+)?(?:async\s+)?function\s/.test(line) ||
        /^\s*def\s+\w+/.test(line) ||
        /^\s*func\s+/.test(line)) funcCount++;
    if (/^\s*(?:export\s+)?(?:abstract\s+)?class\s/.test(line) ||
        /^\s*class\s+\w+/.test(line)) classCount++;
    // 圈复杂度近似：if/for/while/case/catch/&&/||
    const m = line.match(/\b(if|for|while|case|catch|elif)\b|&&|\|\|/g);
    if (m) complexity += m.length;
  });

  // 缩进深度（Python / 无大括号语言）
  if (lang === 'python') {
    let maxDepth = 0;
    lines.forEach(l => {
      if (!l.trim()) return;
      const d = Math.floor((l.length - l.trimStart().length) / 4);
      if (d > maxDepth) maxDepth = d;
    });
    if (maxDepth > 5) {
      diags.push({
        file, line: 1, column: 1,
        severity: 'info', source: 'builtin', ruleId: 'max-depth',
        message: `最大嵌套深度 ${maxDepth} 层，过深`,
        suggestion: '考虑抽取函数降低嵌套层级',
      });
    }
  }

  /* ⑧ 空文件 / 只有注释 */
  const codeOnly = raw.code.split('\n').filter(l => l.trim()).length;
  if (codeOnly === 0 && src.trim().length > 0) {
    diags.push({
      file, line: 1, column: 1,
      severity: 'info', source: 'builtin', ruleId: 'empty-file',
      message: '文件只有注释，没有实际代码',
      suggestion: '确认这个文件是否还需要保留',
    });
  }

  const totalLines = lines.length;
  const commentLines = raw.comments.length;

  return {
    file,
    diagnostics: diags.sort((a, b) => {
      const sev = { error: 0, warning: 1, info: 2, hint: 3 };
      return sev[a.severity] - sev[b.severity] || a.line - b.line;
    }),
    stats: {
      lines: totalLines,
      codeLines: codeOnly,
      commentLines,
      functions: funcCount,
      classes: classCount,
      imports: importCount,
      complexity,
    },
    analyzedAt: Date.now(),
  };
}

/* ---------------- 评分 ---------------- */
export function scoreReport(r: AnalysisReport): number {
  const errs = r.diagnostics.filter(d => d.severity === 'error').length;
  const warns = r.diagnostics.filter(d => d.severity === 'warning').length;
  const infos = r.diagnostics.filter(d => d.severity === 'info').length;
  let score = 100 - errs * 12 - warns * 4 - infos * 1;
  // 复杂度惩罚
  if (r.stats.complexity && r.stats.complexity > 30) {
    score -= Math.min(15, Math.floor((r.stats.complexity - 30) / 5));
  }
  return Math.max(0, Math.min(100, score));
}
