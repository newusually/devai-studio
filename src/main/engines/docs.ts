/* ============================================================================
 * main/engines/docs.ts —— 多格式文档生成器
 * ----------------------------------------------------------------------------
 * 输出格式：
 *   PPTX  → pptxgenjs（纯 JS 生成，不需要装 Office）
 *   PDF   → PDFKit（纯 JS）+ Electron Chromium 打印（HTML→PDF，保真度最高）
 *   DOCX  → docx 库（纯 JS）
 *   HTML  → 自带样式模板（可打印成 PDF）
 *   MD    → Markdown
 *
 * 全部免费、纯本地、离线可用。
 * ========================================================================== */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

/* ---------------- 通用文档结构 ---------------- */
export interface DocBlock {
  type: 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'code' | 'table' | 'quote' | 'image' | 'divider' | 'pagebreak';
  text?: string;
  items?: string[];
  /** 代码块语言 */
  lang?: string;
  /** 表格：首行为表头 */
  rows?: string[][];
  /** 图片路径 */
  src?: string;
  /** 引文来源 */
  cite?: string;
}

export interface DocModel {
  title: string;
  subtitle?: string;
  author?: string;
  date?: string;
  /** 封面图 */
  cover?: string;
  blocks: DocBlock[];
}

/* ---------------- Markdown ---------------- */
export function toMarkdown(doc: DocModel): string {
  const out: string[] = [`# ${doc.title}`, ''];
  if (doc.subtitle) out.push(`> ${doc.subtitle}`, '');
  if (doc.author || doc.date) {
    out.push(`*${[doc.author, doc.date].filter(Boolean).join(' · ')}*`, '');
  }
  for (const b of doc.blocks) {
    switch (b.type) {
      case 'h1': out.push(`# ${b.text || ''}`, ''); break;
      case 'h2': out.push(`## ${b.text || ''}`, ''); break;
      case 'h3': out.push(`### ${b.text || ''}`, ''); break;
      case 'p': out.push(b.text || '', ''); break;
      case 'ul': out.push((b.items || []).map(i => `- ${i}`).join('\n'), ''); break;
      case 'ol': out.push((b.items || []).map((i, n) => `${n + 1}. ${i}`).join('\n'), ''); break;
      case 'code': out.push('```' + (b.lang || ''), b.text || '', '```', ''); break;
      case 'quote': out.push(`> ${b.text || ''}${b.cite ? `\n> — ${b.cite}` : ''}`, ''); break;
      case 'divider': out.push('---', ''); break;
      case 'pagebreak': out.push('<!-- pagebreak -->', ''); break;
      case 'table':
        if (b.rows && b.rows.length) {
          out.push(`| ${b.rows[0].join(' | ')} |`);
          out.push(`|${b.rows[0].map(() => '---').join('|')}|`);
          b.rows.slice(1).forEach(r => out.push(`| ${r.join(' | ')} |`));
          out.push('');
        }
        break;
      case 'image':
        if (b.src) out.push(`![${b.text || ''}](${b.src})`, '');
        break;
    }
  }
  return out.join('\n');
}

/* ---------------- HTML ---------------- */
export function toHtml(doc: DocModel): string {
  const esc = (s: string) => (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const body = doc.blocks.map(b => {
    switch (b.type) {
      case 'h1': return `<h1>${esc(b.text || '')}</h1>`;
      case 'h2': return `<h2>${esc(b.text || '')}</h2>`;
      case 'h3': return `<h3>${esc(b.text || '')}</h3>`;
      case 'p': return `<p>${esc(b.text || '')}</p>`;
      case 'ul': return `<ul>${(b.items || []).map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
      case 'ol': return `<ol>${(b.items || []).map(i => `<li>${esc(i)}</li>`).join('')}</ol>`;
      case 'code': return `<pre class="code"><code>${esc(b.text || '')}</code></pre>`;
      case 'quote': return `<blockquote>${esc(b.text || '')}${b.cite ? `<cite>${esc(b.cite)}</cite>` : ''}</blockquote>`;
      case 'divider': return `<hr>`;
      case 'pagebreak': return `<div class="pagebreak"></div>`;
      case 'table':
        if (b.rows && b.rows.length) {
          const head = `<tr>${b.rows[0].map(c => `<th>${esc(c)}</th>`).join('')}</tr>`;
          const rest = b.rows.slice(1).map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
          return `<table><thead>${head}</thead><tbody>${rest}</tbody></table>`;
        }
        return '';
      case 'image':
        return b.src ? `<figure><img src="${esc(b.src)}"><figcaption>${esc(b.text || '')}</figcaption></figure>` : '';
      default: return '';
    }
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.title)}</title>
<style>
  :root{--bg:#fff;--fg:#1a1d24;--sub:#5b6472;--acc:#2f6fed;--line:#e3e7ee;--code:#f5f7fa}
  *{box-sizing:border-box}
  body{margin:0;padding:48px 60px;background:var(--bg);color:var(--fg);
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;
       line-height:1.75;font-size:15px;-webkit-font-smoothing:antialiased}
  .cover{text-align:center;padding:80px 0 60px;border-bottom:2px solid var(--line);margin-bottom:40px;page-break-after:always}
  .cover h1{font-size:40px;margin:0 0 14px;letter-spacing:-.5px}
  .cover .sub{font-size:17px;color:var(--sub);margin-bottom:20px}
  .cover .meta{font-size:13px;color:var(--sub)}
  h1{font-size:28px;margin:38px 0 14px;padding-bottom:9px;border-bottom:1px solid var(--line)}
  h2{font-size:21px;margin:30px 0 11px}
  h3{font-size:17px;margin:22px 0 9px;color:#333}
  p{margin:0 0 13px}
  ul,ol{margin:0 0 13px;padding-left:26px}
  li{margin-bottom:5px}
  pre.code{background:var(--code);border:1px solid var(--line);border-radius:7px;
          padding:13px 15px;overflow-x:auto;margin:0 0 15px}
  pre.code code{font-family:"Cascadia Code",Consolas,monospace;font-size:13px;line-height:1.6}
  blockquote{margin:0 0 15px;padding:11px 17px;background:var(--code);
             border-left:3px solid var(--acc);border-radius:0 6px 6px 0;color:#3d4552}
  blockquote cite{display:block;margin-top:6px;font-size:12px;color:var(--sub);font-style:normal}
  table{border-collapse:collapse;width:100%;margin:0 0 17px;font-size:14px}
  th,td{border:1px solid var(--line);padding:8px 11px;text-align:left}
  th{background:var(--code);font-weight:650}
  figure{margin:0 0 17px}figure img{max-width:100%;border-radius:7px}
  figcaption{font-size:12px;color:var(--sub);margin-top:6px}
  hr{border:none;border-top:1px solid var(--line);margin:28px 0}
  .pagebreak{page-break-after:always;height:0}
  @media print{
    body{padding:0;font-size:12pt}
    @page{size:A4;margin:18mm 16mm}
    h1,h2,h3{page-break-after:avoid}
    pre,table,figure{page-break-inside:avoid}
    .cover{padding-top:120px}
  }
</style>
</head>
<body>
${doc.cover || doc.subtitle || doc.author ? `<div class="cover">
  <h1>${esc(doc.title)}</h1>
  ${doc.subtitle ? `<div class="sub">${esc(doc.subtitle)}</div>` : ''}
  ${doc.author || doc.date ? `<div class="meta">${esc([doc.author, doc.date].filter(Boolean).join(' · '))}</div>` : ''}
</div>` : ''}
${body}
</body>
</html>`;
}

/* ---------------- PPTX ---------------- */
export async function toPptx(doc: DocModel, output: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    const PptxGenJS = require('pptxgenjs');
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';   // 16:9
    pptx.author = doc.author || 'DevAI Studio';
    pptx.title = doc.title;
    if (doc.subtitle) pptx.subject = doc.subtitle;

    const C = {
      acc: '2F6FED', dark: '1A1D24', sub: '5B6472',
      line: 'E3E7EE', bg: 'FFFFFF', code: 'F5F7FA',
    };

    // 封面
    const cover = pptx.addSlide();
    cover.background = { color: C.bg };
    cover.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: '100%', h: 0.12, fill: { color: C.acc },
    });
    cover.addText(doc.title, {
      x: 0.6, y: 2.1, w: 8.8, h: 1.3,
      fontSize: 40, bold: true, color: C.dark, fontFace: 'Microsoft YaHei',
    });
    if (doc.subtitle) {
      cover.addText(doc.subtitle, {
        x: 0.6, y: 3.4, w: 8.8, h: 0.6,
        fontSize: 18, color: C.sub, fontFace: 'Microsoft YaHei',
      });
    }
    cover.addText([doc.author, doc.date].filter(Boolean).join('  ·  '), {
      x: 0.6, y: 4.4, w: 8.8, h: 0.4,
      fontSize: 12, color: C.sub, fontFace: 'Microsoft YaHei',
    });

    // 内容
    let cur: any = null;
    const newSlide = (title?: string) => {
      const s = pptx.addSlide();
      s.background = { color: C.bg };
      if (title) {
        s.addText(title, {
          x: 0.5, y: 0.32, w: 9, h: 0.6,
          fontSize: 24, bold: true, color: C.dark, fontFace: 'Microsoft YaHei',
        });
        s.addShape(pptx.ShapeType.line, {
          x: 0.5, y: 0.98, w: 9, h: 0, line: { color: C.acc, width: 2.5 },
        });
      }
      return s;
    };

    for (const b of doc.blocks) {
      switch (b.type) {
        case 'h1':
        case 'h2':
          cur = newSlide(b.text || '');
          break;
        case 'h3':
          if (!cur) cur = newSlide();
          cur.addText(b.text || '', {
            x: 0.6, y: 1.15, w: 8.8, h: 0.5,
            fontSize: 18, bold: true, color: C.dark, fontFace: 'Microsoft YaHei',
          });
          break;
        case 'p':
          if (!cur) cur = newSlide();
          cur.addText(b.text || '', {
            x: 0.6, y: 1.2, w: 8.8, h: 1.0,
            fontSize: 14, color: C.dark, fontFace: 'Microsoft YaHei',
            valign: 'top', lineSpacingMultiple: 1.25,
          });
          break;
        case 'ul':
        case 'ol': {
          if (!cur) cur = newSlide();
          const items = (b.items || []).map(t => ({
            text: t,
            options: { bullet: b.type === 'ul' ? { code: '2022' } : false, indentLevel: 0 },
          }));
          cur.addText(items as any, {
            x: 0.7, y: 1.2, w: 8.7, h: 2.4,
            fontSize: 14, color: C.dark, fontFace: 'Microsoft YaHei',
            valign: 'top', lineSpacingMultiple: 1.3,
          });
          break;
        }
        case 'code':
          if (!cur) cur = newSlide();
          cur.addShape(pptx.ShapeType.roundRect, {
            x: 0.6, y: 1.2, w: 8.8, h: 1.8,
            fill: { color: C.code }, line: { color: C.line, width: 1 }, rectRadius: 0.06,
          });
          cur.addText(b.text || '', {
            x: 0.75, y: 1.3, w: 8.5, h: 1.6,
            fontSize: 11, color: '2C3440', fontFace: 'Consolas', valign: 'top',
          });
          break;
        case 'quote':
          if (!cur) cur = newSlide();
          cur.addShape(pptx.ShapeType.rect, {
            x: 0.6, y: 1.2, w: 0.05, h: 1.0, fill: { color: C.acc },
          });
          cur.addText(b.text || '', {
            x: 0.8, y: 1.2, w: 8.5, h: 0.8,
            fontSize: 14, italic: true, color: '3D4552', fontFace: 'Microsoft YaHei',
          });
          break;
        case 'table': {
          if (!cur) cur = newSlide();
          if (b.rows && b.rows.length) {
            const headOpts: any = {
              bold: true, color: C.dark, fill: { color: C.code },
              fontFace: 'Microsoft YaHei', fontSize: 12,
              border: { type: 'solid', color: C.line, pt: 1 },
              valign: 'middle',
            };
            const cellOpts: any = {
              color: C.dark, fontFace: 'Microsoft YaHei', fontSize: 11,
              border: { type: 'solid', color: C.line, pt: 1 }, valign: 'middle',
            };
            const rows = b.rows.map((r, ri) => r.map(c => ({
              text: c, options: ri === 0 ? headOpts : cellOpts,
            })));
            cur.addTable(rows as any, {
              x: 0.6, y: 1.2, w: 8.8, autoPage: true,
            });
          }
          break;
        }
        case 'image':
          if (!cur) cur = newSlide();
          if (b.src && existsSync(b.src)) {
            cur.addImage({ path: b.src, x: 1.6, y: 1.3, w: 6.8, h: 3.4 });
            if (b.text) {
              cur.addText(b.text, {
                x: 0.6, y: 4.8, w: 8.8, h: 0.4,
                fontSize: 11, color: C.sub, align: 'center', fontFace: 'Microsoft YaHei',
              });
            }
          }
          break;
        case 'divider':
          if (!cur) cur = newSlide();
          cur.addShape(pptx.ShapeType.line, {
            x: 0.6, y: 1.3, w: 8.8, h: 0, line: { color: C.line, width: 1 },
          });
          break;
        case 'pagebreak':
          cur = null;
          break;
      }
    }

    const dir = join(output, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await pptx.writeFile({ fileName: output });
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/* ---------------- DOCX ---------------- */
export async function toDocx(model: DocModel, output: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    const d = require('docx');
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
      Table, TableRow, TableCell, WidthType, ImageRun, BorderStyle } = d;

    const children: any[] = [];

    if (model.title) {
      children.push(new Paragraph({
        children: [new TextRun({ text: model.title, bold: true, size: 56 })],
        alignment: AlignmentType.CENTER, spacing: { after: 240 },
      }));
    }
    if (model.subtitle) {
      children.push(new Paragraph({
        children: [new TextRun({ text: model.subtitle, size: 26, color: '5B6472' })],
        alignment: AlignmentType.CENTER, spacing: { after: 160 },
      }));
    }
    if (model.author || model.date) {
      children.push(new Paragraph({
        children: [new TextRun({ text: [model.author, model.date].filter(Boolean).join(' · '), size: 20, color: '8A93A3' })],
        alignment: AlignmentType.CENTER, spacing: { after: 400 },
      }));
    }

    for (const b of model.blocks) {
      switch (b.type) {
        case 'h1':
          children.push(new Paragraph({
            children: [new TextRun({ text: b.text || '', bold: true, size: 36 })],
            heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 160 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '2F6FED', space: 6 } },
          }));
          break;
        case 'h2':
          children.push(new Paragraph({
            children: [new TextRun({ text: b.text || '', bold: true, size: 30 })],
            heading: HeadingLevel.HEADING_2, spacing: { before: 260, after: 130 },
          }));
          break;
        case 'h3':
          children.push(new Paragraph({
            children: [new TextRun({ text: b.text || '', bold: true, size: 26 })],
            heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 100 },
          }));
          break;
        case 'p':
          children.push(new Paragraph({
            children: [new TextRun({ text: b.text || '', size: 22 })],
            spacing: { after: 140 }, lineSpacing: 340,
          }));
          break;
        case 'ul':
          for (const it of b.items || []) {
            children.push(new Paragraph({
              children: [new TextRun({ text: it, size: 22 })],
              bullet: { level: 0 }, spacing: { after: 60 },
            }));
          }
          break;
        case 'ol':
          (b.items || []).forEach((it, i) => {
            children.push(new Paragraph({
              children: [new TextRun({ text: `${i + 1}. ${it}`, size: 22 })],
              spacing: { after: 60 },
            }));
          });
          break;
        case 'code':
          children.push(new Paragraph({
            children: [new TextRun({ text: b.text || '', font: 'Consolas', size: 18 })],
            shading: { fill: 'F5F7FA' }, spacing: { before: 100, after: 160 },
          }));
          break;
        case 'quote':
          children.push(new Paragraph({
            children: [new TextRun({ text: b.text || '', italics: true, size: 21, color: '3D4552' })],
            indent: { left: 400 }, spacing: { before: 100, after: 140 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: '2F6FED', space: 10 } },
          }));
          break;
        case 'table':
          if (b.rows && b.rows.length) {
            const t = new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: b.rows.map((r, ri) => new TableRow({
                children: r.map(c => new TableCell({
                  children: [new Paragraph({
                    children: [new TextRun({ text: c, bold: ri === 0, size: 20 })],
                  })],
                })),
              })),
            });
            children.push(t);
            children.push(new Paragraph({ spacing: { after: 160 } }));
          }
          break;
        case 'divider':
          children.push(new Paragraph({
            children: [new TextRun({ text: '─'.repeat(40), color: 'E3E7EE' })],
            spacing: { before: 160, after: 160 },
          }));
          break;
        case 'pagebreak':
          children.push(new Paragraph({ pageBreakBefore: true }));
          break;
        case 'image':
          if (b.src && existsSync(b.src)) {
            children.push(new Paragraph({
              children: [new ImageRun({ data: require('node:fs').readFileSync(b.src), transformation: { width: 560, height: 320 } })],
              alignment: AlignmentType.CENTER, spacing: { before: 140, after: 100 },
            }));
            if (b.text) {
              children.push(new Paragraph({
                children: [new TextRun({ text: b.text, size: 18, color: '8A93A3' })],
                alignment: AlignmentType.CENTER,
              }));
            }
          }
          break;
      }
    }

    const document = new Document({
      sections: [{
        properties: {},
        children,
      }],
    });
    const buf = await Packer.toBuffer(document);
    const dir = join(output, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(output, buf);
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/* ---------------- PDF（PDFKit） ---------------- */
export async function toPdf(doc: DocModel, output: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    const PDFDocument = require('pdfkit');
    const fs = require('node:fs');
    const dir = join(output, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const pdf = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
    const stream = fs.createWriteStream(output);
    pdf.pipe(stream);

    /* 中文字体（PDFKit 不支持 .ttc 字体集合，必须用单个 TTF）
     * 优先级：simhei.ttf（黑体，最兼容） → Deng.ttf（等线） → 其他 TTF
     * 都不可用时降级 Helvetica（中文会变方块，但不会崩） */
    const FONT_CANDIDATES = [
      'C:\\Windows\\Fonts\\simhei.ttf',
      'C:\\Windows\\Fonts\\Deng.ttf',
      'C:\\Windows\\Fonts\\Dengb.ttf',
      'C:\\Windows\\Fonts\\msyh.ttf',
      'C:\\Windows\\Fonts\\simfang.ttf',
    ];
    const fontFile = FONT_CANDIDATES.find(p => existsSync(p));
    let hasCJK = false;
    if (fontFile) {
      try {
        pdf.registerFont('cjk', fontFile);
        hasCJK = true;
      } catch (e: any) {
        console.warn('[pdf] 中文字体注册失败:', e?.message);
      }
    }
    const F = hasCJK ? 'cjk' : 'Helvetica';

    const ACC = '#2F6FED', DARK = '#1A1D24', SUB = '#5B6472', LINE = '#E3E7EE';

    if (doc.title) {
      pdf.moveDown(2);
      pdf.fontSize(26).fillColor(DARK).font(F).text(doc.title, { align: 'center' });
      if (doc.subtitle) {
        pdf.moveDown(0.5);
        pdf.fontSize(13).fillColor(SUB).text(doc.subtitle, { align: 'center' });
      }
      if (doc.author || doc.date) {
        pdf.moveDown(1);
        pdf.fontSize(9).fillColor(SUB).text([doc.author, doc.date].filter(Boolean).join(' · '), { align: 'center' });
      }
      pdf.moveDown(1.5);
      // 分隔线
      const y = pdf.y;
      pdf.moveTo(56, y).lineTo(539, y).lineWidth(2).strokeColor(ACC).stroke();
      pdf.moveDown(1.5);
      pdf.addPage();
    }

    for (const b of doc.blocks) {
      switch (b.type) {
        case 'h1':
          pdf.moveDown(0.8);
          pdf.fontSize(19).fillColor(DARK).font(F).text(b.text || '', { width: 483 });
          const yy = pdf.y + 4;
          pdf.moveTo(56, yy).lineTo(539, yy).lineWidth(1).strokeColor(LINE).stroke();
          pdf.moveDown(0.5);
          break;
        case 'h2':
          pdf.moveDown(0.6);
          pdf.fontSize(15).fillColor(DARK).font(F).text(b.text || '', { width: 483 });
          pdf.moveDown(0.3);
          break;
        case 'h3':
          pdf.moveDown(0.4);
          pdf.fontSize(12.5).fillColor('#333').font(F).text(b.text || '', { width: 483 });
          pdf.moveDown(0.2);
          break;
        case 'p':
          pdf.fontSize(10.5).fillColor(DARK).font(F).text(b.text || '', {
            width: 483, align: 'justify', lineGap: 2.5,
          });
          pdf.moveDown(0.45);
          break;
        case 'ul':
          for (const it of b.items || []) {
            pdf.fontSize(10.5).fillColor(DARK).font(F).text(`•  ${it}`, { width: 465, indent: 12, lineGap: 2 });
          }
          pdf.moveDown(0.4);
          break;
        case 'ol':
          (b.items || []).forEach((it, i) => {
            pdf.fontSize(10.5).fillColor(DARK).font(F).text(`${i + 1}.  ${it}`, { width: 465, indent: 12, lineGap: 2 });
          });
          pdf.moveDown(0.4);
          break;
        case 'code':
          pdf.moveDown(0.2);
          const codeLines = (b.text || '').split('\n');
          const codeH = codeLines.length * 13 + 16;
          const cy = pdf.y;
          pdf.rect(56, cy, 483, codeH).fill('#F5F7FA');
          pdf.fillColor('#2C3440').font('Courier').fontSize(8.5);
          codeLines.forEach((l, i) => {
            pdf.text(l, 64, cy + 8 + i * 13, { width: 465, lineBreak: false });
          });
          pdf.y = cy + codeH + 8;
          pdf.font(F);
          break;
        case 'quote':
          pdf.moveDown(0.3);
          const qy = pdf.y;
          pdf.rect(56, qy, 3, 30).fill(ACC);
          pdf.fontSize(10.5).fillColor('#3D4552').font(F).text(b.text || '', { width: 460, x: 68, lineGap: 2 });
          if (b.cite) pdf.fontSize(8.5).fillColor(SUB).text(`— ${b.cite}`, { width: 460, x: 68 });
          pdf.moveDown(0.4);
          break;
        case 'table':
          if (b.rows && b.rows.length) {
            const cols = b.rows[0].length;
            const cw = 483 / cols;
            let ty = pdf.y + 4;
            b.rows.forEach((r, ri) => {
              const rh = 20;
              if (ri === 0) pdf.rect(56, ty, 483, rh).fill('#F5F7FA');
              pdf.rect(56, ty, 483, rh).lineWidth(0.5).strokeColor(LINE).stroke();
              r.forEach((c, ci) => {
                pdf.fontSize(9).fillColor(ri === 0 ? DARK : '#3D4552').font(F)
                  .text(String(c).slice(0, 30), 60 + ci * cw, ty + 6, { width: cw - 8, lineBreak: false, ellipsis: true });
              });
              ty += rh;
            });
            pdf.y = ty + 6;
          }
          break;
        case 'divider':
          pdf.moveDown(0.4);
          const dy = pdf.y;
          pdf.moveTo(56, dy).lineTo(539, dy).lineWidth(0.5).strokeColor(LINE).stroke();
          pdf.moveDown(0.5);
          break;
        case 'pagebreak':
          pdf.addPage();
          break;
        case 'image':
          if (b.src && existsSync(b.src)) {
            try {
              pdf.image(b.src, { fit: [483, 280], align: 'center' });
              if (b.text) pdf.fontSize(8.5).fillColor(SUB).text(b.text, { align: 'center' });
              pdf.moveDown(0.5);
            } catch (e) { }
          }
          break;
      }
    }

    pdf.end();
    await new Promise<void>((resolve, reject) => {
      stream.on('finish', () => resolve());
      stream.on('error', reject);
    });
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/* ---------------- 统一入口 ---------------- */
export async function generateDoc(
  doc: DocModel, output: string, format: 'md' | 'html' | 'pptx' | 'docx' | 'pdf'
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const dir = join(output, '..');
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch (e) { }
  switch (format) {
    case 'md':
      writeFileSync(output, toMarkdown(doc), 'utf8');
      return { ok: true, output };
    case 'html':
      writeFileSync(output, toHtml(doc), 'utf8');
      return { ok: true, output };
    case 'pptx': return toPptx(doc, output);
    case 'docx': return toDocx(doc, output);
    case 'pdf': return toPdf(doc, output);
    default: return { ok: false, error: `未知格式 ${format}` };
  }
}

/** 从 AI 返回的 Markdown 解析成 DocModel（简化版） */
export function parseMarkdownToDoc(md: string, title?: string): DocModel {
  const lines = md.split('\n');
  const blocks: DocBlock[] = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];

  const flushCode = () => {
    if (codeBuf.length) {
      blocks.push({ type: 'code', text: codeBuf.join('\n'), lang: codeLang });
      codeBuf = [];
    }
  };

  for (const line of lines) {
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      if (inCode) { flushCode(); inCode = false; codeLang = ''; }
      else { inCode = true; codeLang = fence[1] || ''; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    const h1 = line.match(/^#\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    if (h1) { blocks.push({ type: 'h1', text: h1[1] }); continue; }
    if (h2) { blocks.push({ type: 'h2', text: h2[1] }); continue; }
    if (h3) { blocks.push({ type: 'h3', text: h3[1] }); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.+)/);
    if (ul) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'ul') last.items!.push(ul[1]);
      else blocks.push({ type: 'ul', items: [ul[1]] });
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.+)/);
    if (ol) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'ol') last.items!.push(ol[1]);
      else blocks.push({ type: 'ol', items: [ol[1]] });
      continue;
    }
    const quote = line.match(/^>\s*(.+)/);
    if (quote) { blocks.push({ type: 'quote', text: quote[1] }); continue; }
    if (/^---+$/.test(line.trim())) { blocks.push({ type: 'divider' }); continue; }
    if (!line.trim()) continue;
    blocks.push({ type: 'p', text: line });
  }
  flushCode();

  // 提取标题
  let t = title || '';
  if (!t) {
    const firstH1 = blocks.find(b => b.type === 'h1');
    t = firstH1?.text || '未命名文档';
  }
  return { title: t, blocks };
}
