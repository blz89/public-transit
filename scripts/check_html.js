#!/usr/bin/env node
/**
 * travel HTML 出品校验（流程一、流程二通用）
 *
 * 用法: node scripts/check_html.js <out.html>
 *
 * 三类检查：
 *   A. 结构（静态）：DOCTYPE / charset / viewport / 导航与章节 / 无未渲染占位符
 *   B. 自包含（静态）：不得引用任何外部资源（CDN、外链样式、外链脚本、外链图片、iframe）
 *      —— 交付物必须是**单文件**，双击就能看、断网也能看
 *   C. 溢出（真实浏览器，三种视口）：
 *      C1 宽屏 1280  —— 屏幕上主用形态
 *      C2 窄窗口 375 —— 窗口被缩小时不得破版
 *      C3 A4 打印版式 703px —— **客户自行用浏览器打印时就按这个宽度排版**，
 *         这里超出的内容打印时会被直接裁掉，所以必须为 0
 *
 * 退出码：0 = PASS；1 = 有 FAIL。C 项在取不到浏览器时降级为 SKIP（不阻断交付，但会明确提示）。
 */

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

// A4 纵向正文宽（210mm - 左右各 12mm 边距，按 96dpi）
const A4_CONTENT_PX = 703;

const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });
const FAIL = 'FAIL', PASS = 'PASS', SKIP = 'SKIP', WARN = 'WARN';

function probeScript(limitExpr) {
  return `
<script>
(function(){
  var limit = ${limitExpr};
  var vw = document.documentElement.clientWidth;
  var worst = '', worstRight = 0, over = [];
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i], r = el.getBoundingClientRect();
    if (r.width <= 0) continue;
    if (r.right > worstRight) {
      worstRight = r.right;
      worst = el.className ? '.' + String(el.className).split(' ').join('.') : el.tagName;
    }
    if (r.right > limit + 2) {
      over.push((el.className ? '.' + String(el.className).split(' ').join('.') : el.tagName) + '@' + Math.round(r.right));
    }
  }
  document.documentElement.setAttribute('data-dsh-check',
    Math.round(limit) + '|' + vw + '|' + over.length + '|' + worst + '|' +
    Math.round(worstRight) + '|' + over.slice(0, 5).join(' '));
})();
</script>
`;
}

function measure(edge, tmpDir, htmlText, opts) {
  const probeFile = path.join(tmpDir, 'probe-' + opts.id + '.html');
  fs.writeFileSync(probeFile, htmlText.replace('</body>', probeScript(opts.limit) + '</body>'), 'utf8');
  const url = 'file:///' + probeFile.replace(/\\/g, '/').replace(/ /g, '%20');
  let dom;
  try {
    dom = execFileSync(edge, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + path.join(tmpDir, 'prof'),
      '--window-size=' + opts.windowW + ',' + opts.windowH,
      '--dump-dom', url,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
  } catch (e) {
    add(SKIP, 'C ' + opts.label, '浏览器调用失败：' + String(e.message || e).slice(0, 120));
    return;
  }
  const m = dom.match(/data-dsh-check="([^"]*)"/);
  if (!m) {
    add(WARN, 'C ' + opts.label, '未取到量测结果（探针未执行），请人工过一眼');
    return;
  }
  const [limit, vw, overCount, worst, worstRight, overList] = m[1].split('|');
  if (Number(overCount) === 0) {
    add(PASS, 'C ' + opts.label, `限宽 ${limit}px（视口 ${vw}px）无元素超出；最宽元素 ${worst} 到 ${worstRight}px`);
  } else {
    add(FAIL, 'C ' + opts.label,
      `限宽 ${limit}px 下有 ${overCount} 个元素超出：${overList}${opts.critical ? '——打印时会被直接裁掉，必须修' : '——会被切掉，必须修'}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  // --spots：景点页模式 —— 放行"评价来源行"里的平台名（马蜂窝/去哪儿/大众点评/欣欣）
  const isSpots = argv.includes('--spots');
  const file = argv.find(a => !a.startsWith('-'));
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log([
      'check_html.js —— 成品 HTML 出品校验（必须 PASS 才能交付）',
      '',
      '用法:',
      '  node scripts/check_html.js <out.html>',
      '',
      '它做三类检查:',
      '  A 结构与空占位: DOCTYPE / charset / viewport / 导航与章节是否齐全；',
      '    正文不得出现空壳（空序号行、空单元格、空标题、空数值、空的元信息/注脚），',
      '    以及 undefined / NaN / [object Object]；锚点 id 必须唯一（重复 = 整页被渲染两遍）。',
      '  B 自包含: 不得引用任何外部资源（link / script / img / iframe / 媒体标签 /',
      '    @import / 非 data: 的 CSS url）。允许的只有 <a href> 出站链接。',
      '  C 溢出: 用本机 Edge 无头在三种宽度下真实量测——宽屏 1280 / 窄窗口 375 /',
      '    A4 打印版式 703px。任何元素横向超出限宽都是 FAIL（打印时会被直接裁掉）。',
      '',
      '退出码: 0 = PASS；1 = 有 FAIL。取不到浏览器时 C 项降级为 SKIP（不阻断交付，但会提示）。',
      '报错处理: 改数据（或生成器）后**重新生成 HTML 再跑一遍**，直到 PASS。',
      '',
      '注意: 不要读本脚本源码——用 --help 就够了。',
    ].join('\n'));
    process.exit(0);
  }
  if (!file) {
    console.error('用法: node scripts/check_html.js <out.html>');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error('文件不存在: ' + file);
    process.exit(1);
  }
  const html = fs.readFileSync(file, 'utf8');

  // ---------- A. 结构 ----------
  if (!/^<!DOCTYPE html>/i.test(html.trimStart())) add(FAIL, 'A1 DOCTYPE', '缺少 <!DOCTYPE html>');
  else add(PASS, 'A1 DOCTYPE', '');
  if (!/<meta\s+charset="utf-8"/i.test(html)) add(FAIL, 'A2 charset', '缺少 <meta charset="utf-8">，中文会乱码');
  else add(PASS, 'A2 charset', '');
  if (!/<meta\s+name="viewport"/i.test(html)) add(FAIL, 'A3 viewport', '缺少 viewport');
  else add(PASS, 'A3 viewport', '');

  const secCount = (html.match(/<section class="sec"/g) || []).length;
  if (!/<div class="topnav"/.test(html)) add(FAIL, 'A4 结构', '缺少顶部导航');
  else if (!/<main class="wrap"/.test(html)) add(FAIL, 'A4 结构', '缺少 <main class="wrap">');
  else if (secCount < 1) add(FAIL, 'A4 结构', '没有任何章节（section.sec）');
  else add(PASS, 'A4 结构', `导航 + main + ${secCount} 个章节`);

  // A5 空占位 —— 字段缺失时 esc() 会把 undefined 吞成空串，所以只查「undefined」几乎抓不到；
  // 真正该查的是「只剩个序号/标签、后面什么都没有」这类空壳。
  const EMPTY = [
    [/<p>[①②③④⑤·]\s*<\/p>/g, '空的序号行（如「② 」）'],
    [/<td>\s*<\/td>/g, '空表格单元格'],
    [/<h[234]>\s*<\/h[234]>/g, '空标题'],
    [/<b>\s*<\/b>/g, '空数值'],
    [/<span class="[^"]*">\s*<\/span>/g, '空数据格'],
    [/<a class="btn"[^>]*>\s*<\/a>/g, '空链接文字'],
    [/<p class="(?:meta|src|note|sub|psub|hint|legmeta|bus|car)(?:\s[^"]*)?">\s*<\/p>/g, '空的元信息 / 提示 / 注脚'],
    [/<aside class="cost">\s*<h4>[^<]*<\/h4>\s*<\/aside>/g, '空的费用明细卡（只有标题没有费用行）'],
  ];
  const empties = [];
  for (const [re, label] of EMPTY) {
    const n = (html.match(re) || []).length;
    if (n) empties.push(`${label} ×${n}`);
  }
  const junk = ['undefined', 'NaN', '[object Object]'].filter(b => html.includes(b));
  if (empties.length || junk.length) {
    const detail = [empties.join(' / '), junk.length ? '未渲染占位符：' + junk.join(' / ') : '']
      .filter(Boolean).join('；');
    add(FAIL, 'A5 空占位', detail + '（多为数据字段缺失）');
  } else {
    add(PASS, 'A5 空占位', '无空序号 / 空单元格 / 空标题 / 空数值');
  }

  if (html.length < 4000) add(WARN, 'A6 体积', `仅 ${html.length} 字节，疑似渲染不完整`);
  else add(PASS, 'A6 体积', `${(html.length / 1024).toFixed(1)} KB`);

  // A7 页面不得出现技术 / 数据源信息（SKILL.md「输出格式要求」：数据来源只写在聊天回复里，不进网页）。
  // 与 travel 同口径：抽查几个**铁定属内部用语**的词；命中即说明内部信息漏进交付物。
  // ⚠ 不扫 URL（页面允许放景点官网链接）；`--spots` 模式下放行"评价来源行"的平台名。
  const TEXTLIKE = html.replace(/\b(?:href|src|action)\s*=\s*"[^"]*"/gi, '').replace(/\b(?:href|src|action)\s*=\s*'[^']*'/gi, '');
  const TECH = (() => {
    const t = [];
    t.push(...(TEXTLIKE.match(/12306/g) || []));
    t.push(...(TEXTLIKE.match(/OpenFlights/gi) || []));
    t.push(...(TEXTLIKE.match(/web_search/gi) || []));
    for (const m of TEXTLIKE.match(/\b(?:12306|flight|plan|itinerary|make_html|check_html|spots_check)\.js\b/gi) || []) t.push(m);
    for (const m of TEXTLIKE.match(/\{\{[^}]{0,40}\}\}/g) || []) t.push(m);
    if (!isSpots) for (const m of TEXTLIKE.match(/马蜂窝|去哪儿|大众点评|欣欣旅游/g) || []) t.push(m);
    return [...new Set(t)];
  })();
  if (TECH.length) {
    add(FAIL, 'A7 无技术信息',
      `页面出现内部技术 / 数据源用语：${TECH.join(' / ')} —— **数据来源只写在聊天回复里，不进网页**` +
      `${isSpots ? '（景点页只允许"评价来源行"，不含其他数据源名）' : ''}；请从数据里删掉这些词后重新生成`);
  } else {
    add(PASS, 'A7 无技术信息', `未出现数据源名 / 脚本名 / 未渲染标记${isSpots ? '（景点页评价来源行已放行）' : ''}`);
  }

  // A8 锚点唯一（**防「整页被渲染两遍」**）。
  // 生成器把章节放在模块级数组里且**不在 build* 里清空**，入口一旦误调两次 build*，
  // 每个章节会被 push 两遍：正文整段重复、导航重复，而 A4 只数 section 个数、
  // A5 只找空壳、A7 只看技术词——**全都抓不到**。重复 id 本身也是非法 HTML。
  const idCounts = new Map();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) idCounts.set(m[1], (idCounts.get(m[1]) || 0) + 1);
  const dupIds = [...idCounts.entries()].filter(([, n]) => n > 1);
  if (dupIds.length) {
    add(FAIL, 'A8 锚点唯一',
      `同一 id 出现多次：${dupIds.map(([k, n]) => `${k}×${n}`).join(' / ')} —— ` +
      `**页面被渲染了两遍**（生成器入口重复调用了 build*）；请修生成器，不要靠改数据绕过`);
  } else {
    add(PASS, 'A8 锚点唯一', `${idCounts.size} 个锚点均唯一`);
  }

  // ---------- B. 自包含 ----------
  const rules = [
    [/<link\b[^>]*rel=["']?stylesheet/gi, '外链样式表 <link rel=stylesheet>'],
    [/<link\b[^>]*href=/gi, '外链 <link href=…>'],
    [/<script\b[^>]*\bsrc=/gi, '外链脚本 <script src=>'],
    [/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, '内联 <script>（可能发起外部请求）'],
    [/<img\b/gi, '<img>（交付物必须单文件，不能带图片）'],
    [/<iframe\b/gi, '<iframe>'],
    [/<video\b|<audio\b|<source\b/gi, '内嵌媒体标签'],
    [/@import\b/gi, 'CSS @import'],
    [/url\(\s*["']?(?!data:)/gi, 'CSS url(…)（非 data: 内联）'],
  ];
  const external = rules.filter(([re]) => re.test(html)).map(([, label]) => label);
  if (external.length) add(FAIL, 'B1 自包含', '引用了外部资源：' + external.join(' / ') + '（交付物必须单文件）');
  else add(PASS, 'B1 自包含', '零外链、零依赖（允许的只有 <a href> 出站链接）');
  // ---------- C. 溢出（真实浏览器，三种视口） ----------
  const edge = EDGE_CANDIDATES.find(p => fs.existsSync(p));
  if (!edge) {
    add(SKIP, 'C 溢出检查', '未找到 Edge/Chrome，跳过浏览器量测（交付不受影响，但请人工过一眼）');
  } else {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-htmlcheck-'));

    // C1 / C2：屏幕媒体，限宽 = 视口宽
    measure(edge, tmpDir, html, {
      id: 'wide', label: 'C1 宽屏（窗口 1280）', windowW: 1280, windowH: 900,
      limit: 'document.documentElement.clientWidth', critical: false,
    });
    measure(edge, tmpDir, html, {
      id: 'narrow', label: 'C2 窄窗口（窗口 375）', windowW: 375, windowH: 900,
      limit: 'document.documentElement.clientWidth', critical: false,
    });

    // C3：把打印样式搬到屏幕、禁用窄屏断点、并把文档钉死成 A4 正文宽，量测打印版式
    let printHtml = html
      .replace('@media print{', '@media screen{')
      .replace('@media screen and (max-width:900px)', '@media screen and (max-width:50px)')
      .replace('</head>',
        `<style>html,body{width:${A4_CONTENT_PX}px;max-width:${A4_CONTENT_PX}px;margin:0;padding:0}</style></head>`);
    measure(edge, tmpDir, printHtml, {
      id: 'print', label: `C3 A4 打印版式 ${A4_CONTENT_PX}px（客户自行打印时）`,
      windowW: 900, windowH: 1200, limit: String(A4_CONTENT_PX), critical: true,
    });

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  // ---------- 报告 ----------
  const order = { FAIL: 0, WARN: 1, SKIP: 2, PASS: 3 };
  results.sort((a, b) => order[a.level] - order[b.level]);
  console.log('HTML 出品校验：' + path.basename(file));
  console.log('─'.repeat(74));
  for (const r of results) console.log(`[${r.level}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log('─'.repeat(74));
  const fails = results.filter(r => r.level === FAIL).length;
  const warns = results.filter(r => r.level === WARN).length;
  if (fails) {
    console.log(`结论：FAIL（${fails} 项不通过）`);
    process.exit(1);
  }
  console.log(`结论：PASS${warns ? `（${warns} 项提示，建议看一眼）` : ''}`);
  process.exit(0);
}

main();
