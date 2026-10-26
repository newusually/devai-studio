/* ============================================================================
 * main/engines/excel.ts —— Excel 生成与解析（纯 JS，免费离线）
 * ----------------------------------------------------------------------------
 * 用 exceljs（写）+ xlsx（读）双库覆盖：
 *   写  → exceljs（样式、公式、图表、冻结窗格、合并单元格）
 *   读  → xlsx（兼容 .xls / .xlsx / .csv / .ods）
 *
 * 能力：
 *   · 从二维数组 / 对象数组生成工作簿
 *   · 多 Sheet、样式（表头、配色、数字格式、边框）
 *   · 公式（=SUM(A1:A10) 等）
 *   · 条件格式、冻结首行、列宽自适应
 *   · 读取任意表格 → 转 Markdown / CSV / JSON，供 AI 分析
 * ========================================================================== */
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ---------------- 数据模型 ---------------- */
export interface SheetSpec {
  name: string;
  /** 列定义 */
  columns?: Array<{ header: string; key?: string; width?: number; style?: any }>;
  /** 行数据（二维数组） */
  rows?: any[][];
  /** 对象数组（配合 columns.key） */
  data?: any[];
  /** 冻结首行 */
  freezeHeader?: boolean;
  /** 标题行样式 */
  headerStyle?: 'blue' | 'green' | 'dark' | 'orange';
  /** 自动筛选 */
  autoFilter?: boolean;
  /** 数字格式（按列索引） */
  numFmt?: Record<number, string>;
  /** 条件格式：{ 列索引, 条件: 'gt'|'lt', 值, 颜色 } */
  conditional?: Array<{ col: number; op: 'gt' | 'lt' | 'eq'; value: number; bg: string; font?: string }>;
}

export interface WorkbookSpec {
  title?: string;
  creator?: string;
  description?: string;
  sheets: SheetSpec[];
}

/* ---------------- 主题配色 ---------------- */
const THEMES: Record<string, { bg: string; fg: string; accent: string }> = {
  blue: { bg: 'FF2F6FED', fg: 'FFFFFFFF', accent: 'FFE8F0FE' },
  green: { bg: 'FF16A34A', fg: 'FFFFFFFF', accent: 'FFE8F8EE' },
  dark: { bg: 'FF1A1D24', fg: 'FFFFFFFF', accent: 'FFF0F2F5' },
  orange: { bg: 'FFEA580C', fg: 'FFFFFFFF', accent: 'FFFFF1E6' },
};

/* ---------------- 生成 Excel ---------------- */
export async function generateExcel(
  spec: WorkbookSpec, output: string
): Promise<{ ok: boolean; output?: string; error?: string; sheets?: string[] }> {
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = spec.creator || 'DevAI Studio';
    wb.created = new Date();
    if (spec.title) wb.title = spec.title;

    for (const sh of spec.sheets) {
      const ws = wb.addWorksheet(sh.name || 'Sheet1', {
        views: sh.freezeHeader !== false ? [{ state: 'frozen', ySplit: 1 }] : undefined,
      });

      const theme = THEMES[sh.headerStyle || 'blue'];

      // 列定义
      if (sh.columns && sh.columns.length) {
        ws.columns = sh.columns.map((c, i) => ({
          header: c.header,
          key: c.key || undefined,
          width: c.width || autoWidth(c.header, sh),
          style: c.style,
        }));
      }

      // 行数据
      const rows: any[] = [];
      if (sh.data && sh.data.length) {
        rows.push(...sh.data);
      } else if (sh.rows) {
        rows.push(...sh.rows);
      }

      if (rows.length) {
        const startRow = (sh.columns && sh.columns.length) ? 2 : 1;
        rows.forEach((r: any, ri) => {
          const row = ws.getRow(startRow + ri);
          if (Array.isArray(r)) {
            r.forEach((v, ci) => {
              row.getCell(ci + 1).value = v;
              if (sh.numFmt && sh.numFmt[ci]) row.getCell(ci + 1).numFmt = sh.numFmt[ci];
            });
          } else {
            if (sh.columns) {
              sh.columns.forEach((c, ci) => {
                const key = c.key || c.header;
                const v = r[key];
                row.getCell(ci + 1).value = v;
                if (sh.numFmt && sh.numFmt[ci]) row.getCell(ci + 1).numFmt = sh.numFmt[ci];
              });
            }
          }
        });
      }

      // 表头样式
      if (sh.columns && sh.columns.length) {
        const hr = ws.getRow(1);
        hr.height = 24;
        hr.eachCell((cell: any) => {
          cell.font = { bold: true, color: { argb: theme.fg }, size: 11 };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.bg } };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFFFFFFF' } },
            left: { style: 'thin', color: { argb: 'FFFFFFFF' } },
            bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } },
            right: { style: 'thin', color: { argb: 'FFFFFFFF' } },
          };
        });
      }

      // 自动筛选
      if (sh.autoFilter && sh.columns && sh.columns.length) {
        ws.autoFilter = {
          from: { row: 1, column: 1 },
          to: { row: 1, column: sh.columns.length },
        };
      }

      // 条件格式
      for (const cf of (sh.conditional || [])) {
        const colL = colLetter(cf.col);
        const startRow = (sh.columns && sh.columns.length) ? 2 : 1;
        ws.addConditionalFormatting({
          ref: `${colL}${startRow}:${colL}${startRow + 500}`,
          rules: [{
            type: 'cellIs',
            operator: cf.op === 'gt' ? 'greaterThan' : cf.op === 'lt' ? 'lessThan' : 'equal',
            formulae: [cf.value],
            style: {
              fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: cf.bg } },
              font: cf.font ? { color: { argb: cf.font } } : undefined,
            },
          }],
        });
      }

      // 斑马纹
      const bodyStart = (sh.columns && sh.columns.length) ? 2 : 1;
      if (rows.length > 1) {
        for (let r = bodyStart; r < bodyStart + rows.length; r++) {
          if ((r - bodyStart) % 2 === 1) {
            ws.getRow(r).eachCell((cell: any) => {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.accent } };
            });
          }
        }
      }
    }

    const dir = join(output, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await wb.xlsx.writeFile(output);
    return { ok: true, output, sheets: spec.sheets.map(s => s.name) };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function colLetter(n: number): string {
  let s = '';
  let x = n + 1;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function autoWidth(header: string, sh: SheetSpec): number {
  const idx = sh.columns?.findIndex(c => c.header === header) ?? -1;
  if (idx >= 0) {
    const sample = sh.data?.[0]?.[sh.columns![idx].key || ''] ?? '';
    const len = String(sample).length * 1.6 + String(header).length * 1.4;
    return Math.max(10, Math.min(46, Math.round(len)));
  }
  return Math.max(12, String(header).length * 2.2 + 4);
}

/* ---------------- 读取 Excel ---------------- */
export interface SheetData {
  name: string;
  headers: string[];
  rows: any[][];
  rowCount: number;
  colCount: number;
}

export function readExcel(file: string): { ok: boolean; sheets?: SheetData[]; error?: string } {
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(file, { cellDates: true, cellFormula: true });
    const sheets: SheetData[] = wb.SheetNames.map((name: string) => {
      const ws = wb.Sheets[name];
      const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[][];
      const headers = (arr[0] || []).map(h => String(h ?? ''));
      const rows = arr.slice(1).filter(r => r.some(c => c !== '' && c != null));
      return {
        name,
        headers,
        rows,
        rowCount: rows.length,
        colCount: headers.length,
      };
    });
    return { ok: true, sheets };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/* ---------------- 转 Markdown（给 AI 分析） ---------------- */
export function sheetsToMarkdown(sheets: SheetData[], maxRows = 100): string {
  const out: string[] = [];
  for (const s of sheets) {
    out.push(`## 工作表：${s.name}（${s.rowCount} 行 × ${s.colCount} 列）`);
    if (!s.headers.length) { out.push('(空表)'); continue; }
    out.push(`| ${s.headers.join(' | ')} |`);
    out.push(`|${s.headers.map(() => '---').join('|')}|`);
    for (const r of s.rows.slice(0, maxRows)) {
      out.push(`| ${r.map(c => String(c ?? '').replace(/\|/g, '\\|').slice(0, 60)).join(' | ')} |`);
    }
    if (s.rows.length > maxRows) out.push(`...（还有 ${s.rows.length - maxRows} 行）`);
    out.push('');
  }
  return out.join('\n');
}

/* ---------------- 转 CSV ---------------- */
export function sheetToCsv(sheet: SheetData): string {
  const esc = (v: any) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [sheet.headers.map(esc).join(',')];
  for (const r of sheet.rows) lines.push(r.map(esc).join(','));
  return lines.join('\n');
}

/* ---------------- 从 Markdown 表格生成 Excel ---------------- */
/** 解析 AI 生成的 Markdown 表格 → SheetSpec[] */
export function markdownTablesToSheets(md: string, baseName = 'Sheet1'): SheetSpec[] {
  const lines = md.split('\n');
  const sheets: SheetSpec[] = [];
  let cur: SheetSpec | null = null;
  let tableRows: string[][] = [];
  let title = '';

  const flush = () => {
    if (cur && tableRows.length >= 2) {
      cur.rows = tableRows.slice(1);   // 去掉表头行
      cur.columns = tableRows[0].map(h => ({ header: h }));
      sheets.push(cur);
    }
    tableRows = [];
    cur = null;
  };

  for (const line of lines) {
    const h = line.match(/^#{1,3}\s+(.+)/);
    if (h) {
      flush();
      title = h[1];
      cur = { name: title.slice(0, 28) || baseName, rows: [] };
      continue;
    }
    const tr = line.match(/^\s*\|(.+)\|\s*$/);
    if (tr) {
      const cells = tr[1].split('|').map(c => c.trim());
      // 跳过分隔行 |---|---|
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
      tableRows.push(cells);
      continue;
    }
    if (line.trim() === '' && tableRows.length) {
      // 空行不立即 flush，等下一个标题或表格
    }
  }
  flush();
  if (!sheets.length && tableRows.length >= 2) {
    sheets.push({
      name: baseName,
      columns: tableRows[0].map(h => ({ header: h })),
      rows: tableRows.slice(1),
    });
  }
  return sheets;
}
