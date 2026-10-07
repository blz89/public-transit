#!/usr/bin/env node
/**
 * travel-planner 行程文档生成器（HTML 唯一出口，禁止手写生成脚本）
 *
 * 用法:
 *   node scripts/make_html.js plan  <data.json> <out.html>   # 流程一：交通方案
 *   node scripts/make_html.js spots <data.json> <out.html>   # 流程二：景点推荐
 *   node scripts/make_html.js itin  <data.json> <out.html>   # 流程二：行程方案
 *
 * 设计目标 = 屏幕（网页），不是 A4 纸面：
 *   - 单文件、零依赖、零外链：双击即用浏览器打开，无 CDN、无字体下载、无图片文件
 *   - 满宽布局（max-width 1180px）+ 放大字号（正文 17px / 时刻 20px / 章节 28px / 主标题 44px）
 *   - 用足横向空间：方案页「时间线 + 费用卡」两栏；景点页「好评/差评/我的点评」三栏；
 *     逐段页两列网格；方案对比三栏
 *   - 吸顶导航 + 锚点跳转（网页特有）
 *   - 容器查询做响应式：宽屏多栏、窄屏自动重排为单栏（手机可读）
 *
 * 交付形态 = 单文件 HTML：本技能**不产出 PDF**（客户要纸面时自行用浏览器打印，
 * 打印版面由 check_html.js 的「A4 纸宽实测」兜住）。
 * 生成后仍须过「HTML 出品校验」（scripts/check_html.js）。
 */

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// 写盘前先建父目录（实测：输出目录不存在时直接 ENOENT，执行者得先建目录再重跑一次）
function ensureDir(file) { try { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); } catch { /* 真写不进去会在 writeFileSync 报错 */ } }

// ---------- 口径（与 SKILL.md「方案生成」「席别规则」一致）----------
// 过夜 / 住宿 / **跨天到达**类信息命中即标红
// —— 「次日」「(+1天)」「翌日」也算：实测出现过"当日晚发、次日 15:49 才到"的方案，
//    它是跨天到达，红字提示的必要性与过夜完全相同。
const OVERNIGHT_RE = /过夜|住宿|住一晚|一晚|夜行|留宿|过宿|次日|翌日|\(\+1\s*天\)/;
// 需要红字强调的注脚（给不出更多方案的原因等）
const WARNFOOT_RE = /不推荐|余票不足|余票不够|票不够|无票|放弃/;
const isOvernight = t => OVERNIGHT_RE.test(String(t || ''));
const isWarnFootnote = t => WARNFOOT_RE.test(String(t || '')) || isOvernight(t);

// 数据里若混进 markdown 粗体标记（**），页面会把它原样印出来——因为渲染走的是 esc()，
// 不做 markdown 解析。实测：技能示例把 price 写成 "**二等座 ¥250.0 / 人**"，照抄就会在
// 页面上印出四个星号，逼执行者重出一遍 HTML。这里是所有数据文本的唯一出口，统一剥掉。
const esc = s => String(s == null ? '' : s)
  .replace(/\*\*/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- 文案防重复（数据里误带渲染标签时自动剥离）----------
// 除了精确匹配当前 label，还剥掉常见变体（如「打车备选」）——否则模型把标签写进内容里，
// 渲染时会变成「打车约 打车备选 9 km」这种重复字。
const LEAD_LABELS = /^(?:全程打车备选|全程打车|打车备选|打车约|公交\+打车|车程|行车路线|备选路线|打车)(?=[\s：:，,]|$)[\s：:，,]*/;
function stripLead(v, label) {
  let t = String(v == null ? '' : v).trim();
  if (label && t.startsWith(label)) t = t.slice(label.length).replace(/^[：:\s]+/, '').trim();
  for (let i = 0; i < 3 && LEAD_LABELS.test(t); i++) t = t.replace(LEAD_LABELS, '').trim();
  return t;
}
function legNo(n, fallback) {
  const t = String(n == null ? '' : n).replace(/^第\s*/, '').replace(/\s*段\s*$/, '').trim();
  return t || String(fallback);
}
// coverCards 容错：["标签","值","说明"] 数组与 {label,value,desc} 对象都接受。
// 实测中两组都踩过——SKILL.md 只说"每张 3 项"，模型按字面写成对象就被拒；
// 生成器自己兜住，别让它靠报错重试（重试放大的代价远高于这里多几行）。
function card3(c) {
  if (Array.isArray(c)) return c;
  if (c && typeof c === 'object') {
    const pick = (...keys) => { for (const k of keys) if (c[k] !== undefined) return c[k]; return undefined; };
    return [pick('label', 'name', 0), pick('value', 'val', 1), pick('desc', 'note', 'text', 'sub', 2)];
  }
  return null;
}
// legs[].km 容错：给数字就按 km 处理（实测给数字会被拒）
const kmText = v => (Number.isFinite(v) ? `${v} km` : v);

// ---------- 文档骨架 ----------
const secs = [];
const blocks = [];
function sec(id, title, sub, inner) {
  secs.push({ id, label: title });
  blocks.push(`<section class="sec" id="${id}"><h2>${esc(title)}</h2>` +
    (sub ? `<p class="sub">${esc(sub)}</p>` : '') + inner + `</section>`);
}

function timeline(steps) {
  return '<ol class="tl">' + (steps || []).map(st => {
    const warn = st.warn === true || isOvernight(`${st.time}${st.place}${st.desc}`);
    return `<li${warn ? ' class="warn"' : ''}>` +
      `<span class="t">${esc(st.time)}</span>` +
      `<span class="p">${esc(st.place)}</span>` +
      `<span class="d">${esc(st.desc)}</span></li>`;
  }).join('') + '</ol>';
}

function costCard(p) {
  const rows = p.costRows || [];
  const body = rows.map((r, i) => {
    const total = i >= rows.length - 2;
    return `<div class="crow${total ? ' total' : ''}"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`;
  }).join('');
  const fns = (p.footnotes || []).map((fn, i) => {
    const warn = isWarnFootnote(fn);
    return `<p class="fn${warn ? ' warn' : (i === 0 ? '' : ' deep')}">${esc(fn)}</p>`;
  }).join('');
  return `<aside class="cost"><h4>${esc(p.costTitle || '费用明细（人均）')}</h4>` +
    body + (fns ? `<div class="fns">${fns}</div>` : '') + `</aside>`;
}

function ovTable(ov, opts = {}) {
  const rows = ov.rows || [];
  const cw = ov.colWidths || [];
  const sum = cw.reduce((a, b) => a + b, 0) || 1;
  const cols = cw.map(w => `<col style="width:${(w / sum * 100).toFixed(3)}%">`).join('');
  const body = rows.map((r, i) => {
    if (i === 0) return `<tr class="th">${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`;
    const tds = r.map((cell, j) => {
      const hot = opts.hotLastCol && j === r.length - 1 && cell === '热门';
      const cls = [isOvernight(cell) ? 'warn' : '', hot ? 'hot' : '',
        opts.boldCols && opts.boldCols.includes(j) ? 'b' : ''].filter(Boolean).join(' ');
      return `<td${cls ? ` class="${cls}"` : ''}>${esc(cell)}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  return `<div class="tblwrap"><table class="ov"><colgroup>${cols}</colgroup><tbody>${body}</tbody></table></div>`;
}

// 注脚三种写法通用：footnotes / note / noteBox
// 「余票不足 / 无票 / 过夜」这类原因注脚一律标红——与方案块的 footnotes 同口径（总览表注脚也适用）。
const notes = (raw, cls = '') => {
  const arr = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  return arr.map(t => {
    const klass = [cls, isWarnFootnote(t) ? 'warn' : ''].filter(Boolean).join(' ');
    // 没有附加类时不留尾空格：class="note " 会让校验器的空壳正则匹配不到
    return `<p class="note${klass ? ' ' + klass : ''}">${esc(t)}</p>`;
  }).join('');
};

function planCard(p, fallbackTitle, fallbackSub) {
  const title = p.title || fallbackTitle || '';
  const sub = p.subtitle || fallbackSub || '';
  const strip = [p.price, p.badge].filter(Boolean).join('　·　');
  const head = (title || sub)
    ? `<header class="pchead">${title ? `<h3>${esc(title)}</h3>` : ''}${sub ? `<p>${esc(sub)}</p>` : ''}</header>`
    : '';
  return `<article class="plancard">
    ${head}
    <div class="planbody">${timeline(p.steps)}${costCard(p)}</div>
    ${strip ? `<div class="strip">${esc(strip)}</div>` : ''}
  </article>`;
}

function hero(d) {
  const cards = (d.coverCards || []).map(c => {
    const t = card3(c) || [];
    const warn = isOvernight(`${t[0] || ''}${t[2] || ''}`);
    return `<div class="stat"><span class="${warn ? 'warn' : ''}">${esc(t[0])}</span>` +
      `<b>${esc(t[1])}</b><span class="${warn ? 'warn' : ''}">${esc(t[2])}</span></div>`;
  }).join('');
  return `<section class="hero"><h1>${esc(d.coverTitle || d.title || '')}</h1>` +
    `<p class="lede">${esc(d.coverSubtitle || d.subtitle || '')}</p>` +
    `<div class="stats">${cards}</div>` +
    (d.coverNote ? `<p class="banner">${esc(d.coverNote)}</p>` : '') + `</section>`;
}

// ---------- 流程一：城际交通方案 ----------
function buildPlan(d) {
  blocks.push(hero(d));
  if (d.overview) {
    sec('overview', d.overview.title || '决策速览', d.overview.subtitle,
      ovTable(d.overview, { boldCols: [3] }) +
      notes(d.overview.footnotes || d.overview.note || d.overview.noteBox));
  }
  if (d.cheapest && d.cheapest.plans) {
    sec('cheapest', d.cheapest.title || '最省钱方案', d.cheapest.subtitle,
      d.cheapest.plans.map(p => planCard(p)).join(''));
  }
  if (d.fastest) {
    sec('fastest', d.fastest.title || '最快方案', d.fastest.subtitle,
      planCard({ title: '', subtitle: '', steps: d.fastest.steps, price: d.fastest.price,
        badge: d.fastest.badge, costTitle: d.fastest.costTitle,
        costRows: d.fastest.costRows, footnotes: d.fastest.footnotes }));
  }
  const extra = d.extra;
  if (extra && extra.plans) {
    sec('extra', extra.title || '额外方案', extra.subtitle,
      extra.plans.map(p => planCard(p)).join(''));
  }
  return;
}

// 只渲染非空项：字段缺项时不留「② 」这种空序号（esc() 会把 undefined 吞成空串，光靠它守不住）
const numList = arr => (arr || [])
  .filter(x => String(x == null ? '' : x).trim() !== '')
  .map((t, i) => `<p>${'①②③④⑤'[i] || '·'} ${esc(t)}</p>`).join('');
const dotList = arr => (arr || [])
  .filter(x => String(x == null ? '' : x).trim() !== '')
  .map(t => `<p>· ${esc(t)}</p>`).join('');

// ---------- 流程二：目的地景点分析 ----------
function buildSpots(d) {
  blocks.push(hero(d));
  if (d.overview) {
    sec('overview', d.overview.title || '景点总览', d.overview.subtitle,
      ovTable(d.overview, { hotLastCol: true }) +
      notes(d.overview.note || d.overview.footnotes || d.overview.noteBox));
  }
  const cards = (d.spots || []).map(sp => {
    // 好评 / 差评最多 2 条，公开评论极少时可能只有 1 条甚至 0 条 —— 空的那一栏整栏不渲染
    const g = numList(sp.good), b = numList(sp.bad), m = dotList(sp.mine);
    const cols = [];
    if (g) cols.push(`<div class="col"><h4 class="gh">景区好评</h4>${g}</div>`);
    if (b) cols.push(`<div class="col"><h4 class="bh">景区差评</h4>${b}</div>`);
    if (m) cols.push(`<div class="col mine"><h4 class="mh">我的点评</h4>${m}</div>`);
    // 按钮自动带外链箭头 + 一行「点击可在新窗口打开」提示（数据里不用写，避免各景点写法不一）
    const siteLabel = String(sp.urlLabel == null ? '' : sp.urlLabel).replace(/\s*↗\s*$/, '');
    return `<article class="spotcard">
    <header class="schead">
      <div><h3>${esc(sp.name)}</h3><p class="meta">${esc(sp.meta)}</p></div>
      <div class="sitebox">
        <a class="btn" href="${esc(sp.url)}" target="_blank" rel="noopener">${esc(siteLabel)} ↗</a>
        <p class="hint">点击按钮，在新窗口打开该景点页面</p>
      </div>
    </header>
    <div class="grid3 n${cols.length}">
      ${cols.join('')}
    </div>
    ${sp.source ? `<p class="src">${esc(sp.source)}</p>` : ''}
  </article>`;
  }).join('');
  sec('spots', '景点详情', '每个景点：官方网址直达 · 好评差评 · 我的点评（含来源标注）', cards);
  return;
}

// ---------- 流程二：行程方案 ----------
function buildItin(d) {
  blocks.push(hero(d));
  // 口径可切换：公共交通（默认）「公交+打车 / 打车约 / 全程打车备选」；
  // 自驾把 legLabel 设为「行车路线」、taxiLabel 设为「车程」、carLabel 设为「备选路线」。
  const legLabel = d.legLabel === undefined ? '公交+打车' : d.legLabel;
  const taxiLabel = d.taxiLabel === undefined ? '打车约' : d.taxiLabel;
  const carLabel = d.carLabel === undefined ? '全程打车备选' : d.carLabel;

  if (d.overview) {
    sec('overview', d.overview.title || '行程总览 · 串线', d.overview.subtitle,
      ovTable(d.overview, { boldCols: [4] }) +
      notes(d.overview.footnotes || d.overview.note || d.overview.noteBox, 'deep'));
  }

  const legs = (d.legs || []).map((leg, i) => {
    const bus = stripLead(stripLead(leg.bus, legLabel), '公交+打车');
    const taxi = stripLead(stripLead(leg.taxi, taxiLabel), '打车约');
    const car = stripLead(stripLead(leg.car, carLabel), '全程打车备选');
    // 里程 / 说明用非空部分拼接，避免某一段为空时留下悬空的「 · 」
    const meta = [kmText(leg.km), leg.note]
      .filter(x => String(x == null ? '' : x).trim() !== '').map(x => esc(x)).join(' · ');
    return `<article class="legcard">
      <header class="leghead"><h3><span class="no">第 ${esc(legNo(leg.n, i + 1))} 段</span>
        ${esc(leg.from)} <span class="arrow">→</span> ${esc(leg.to)}</h3>
        ${taxi ? `<b class="taxi">${taxiLabel ? esc(taxiLabel) + ' ' : ''}${esc(taxi)}</b>` : ''}</header>
      ${bus ? `<p class="bus">${legLabel ? `<i>${esc(legLabel)}</i>：` : ''}${esc(bus)}</p>` : ''}
      ${meta ? `<p class="legmeta">${meta}</p>` : ''}
      ${car ? `<p class="car">${carLabel ? esc(carLabel) + '：' : ''}${esc(car)}</p>` : ''}
    </article>`;
  }).join('');
  sec('legs', d.legsTitle || '逐段换乘明细',
    d.legsSubtitle || '每段：从哪上车 → 坐哪路 → 到哪站 → 接驳 → 费用',
    `<div class="leggrid">${legs}</div>` +
    (d.legsFootnote ? `<p class="note">${esc(d.legsFootnote)}</p>` : ''));

  if (d.plans) {
    const pc = Array.isArray(d.plans) ? { cards: d.plans } : d.plans;
    const cards = (pc.cards || []).map(c => `<article class="cmpcard${c.hot ? ' hot' : ''}">
      <header><h3>${esc(c.title)}</h3>${c.hot ? `<span class="pill">${esc(c.hotLabel || '推荐')}</span>` : ''}</header>
      <p class="cmpPrice">${esc(c.price)}</p>
      ${c.note ? `<p class="cmpnote">${esc(c.note)}</p>` : ''}
      ${c.tag ? `<div class="ctag">${esc(c.tag)}</div>` : ''}
      <div class="cmprows">${(c.rows || []).map(r =>
        `<div class="crow"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('')}</div>
      ${c.badge ? `<div class="cbadge">${esc(c.badge)}</div>` : ''}
    </article>`).join('');
    sec('cmp', pc.title || '移动方案对比', pc.subtitle, `<div class="cmpgrid">${cards}</div>` +
      (pc.note ? `<p class="note">${esc(pc.note)}</p>` : ''));
  }
  return;
}

// ---------- 样式：屏幕优先 + 轻量打印 ----------
const CSS = `
:root{--deep:#065A82;--ink:#16202B;--gray:#5A6675;--line:#DCE3EC;--soft:#F1F6FA;
      --dot:#1C7293;--warn:#C0392B;--green:#2E7D32;--tagbg:#FBF3E8;--tagline:#D9C39A;
      --shadow:0 1px 2px rgba(16,36,56,.05),0 8px 24px rgba(16,36,56,.07)}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:"Microsoft YaHei","微软雅黑","PingFang SC",system-ui,sans-serif;
     color:var(--ink);font-size:17px;line-height:1.72;background:#F7F9FC;
     -webkit-print-color-adjust:exact;print-color-adjust:exact}
h1,h2,h3,h4{margin:0;font-weight:700;line-height:1.3}
a{color:#0A5FBF}
.warn{color:var(--warn)}
.hot{color:var(--warn);font-weight:700}
.b{font-weight:700}
.wrap{max-width:1180px;margin:0 auto;padding:0 28px}

/* 吸顶导航 */
.topnav{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.9);
        backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.topnav .wrap{display:flex;align-items:center;gap:22px;height:58px;padding:0 28px}
.topnav b{font-size:15px;color:var(--deep);white-space:normal}
.topnav a{font-size:14.5px;color:var(--gray);text-decoration:none;white-space:normal}
.topnav a:hover{color:var(--deep)}

/* 首屏 */
.hero{padding:56px 0 8px}
.hero h1{font-size:44px;color:var(--deep);letter-spacing:-.5px}
.lede{margin:10px 0 0;font-size:20px;color:var(--gray)}
.stats{display:flex;gap:18px;margin-top:32px;flex-wrap:wrap}
.stat{flex:1 1 220px;background:#fff;border:1px solid var(--line);border-radius:14px;
      padding:18px 20px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:4px}
.stat span{font-size:14px;color:var(--gray)}
.stat b{font-size:30px;color:var(--ink)}
.banner{margin-top:26px;background:var(--tagbg);border:1px solid var(--tagline);border-radius:12px;
        padding:13px 18px;color:var(--warn);font-weight:700;font-size:16px;text-align:center}

/* 章节 */
.sec{padding:38px 0 4px;scroll-margin-top:74px}
.sec h2{font-size:28px;color:var(--deep)}
.sec>.sub{margin:6px 0 20px;font-size:16px;color:var(--gray)}

/* 表格 */
.tblwrap{background:#fff;border:1px solid var(--line);border-radius:14px;
         box-shadow:var(--shadow);overflow:hidden}
.ov{width:100%;border-collapse:collapse;font-size:16px}
.ov td{padding:15px 18px;border-bottom:1px solid #EDF1F6;vertical-align:top}
.ov tbody tr:last-child td{border-bottom:none}
.ov tr.th td{background:var(--soft);color:var(--deep);font-weight:700;font-size:15px}
.note{margin:12px 0 0;font-size:14.5px;color:var(--gray)}
.note.deep{color:var(--deep)}

/* 方案卡：时间线 + 费用卡 */
.plancard{background:#fff;border:1px solid var(--line);border-radius:14px;
          box-shadow:var(--shadow);padding:24px;margin-bottom:22px}
.pchead{margin-bottom:18px}
.pchead h3{font-size:22px;color:var(--deep)}
.pchead p{margin:5px 0 0;font-size:15px;color:var(--gray)}
.planbody{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,1fr);gap:26px}
.tl{list-style:none;margin:0;padding:0}
.tl li{position:relative;display:grid;grid-template-columns:max-content 150px minmax(0,1fr);
       gap:14px;padding:0 0 22px 26px}
.tl li::before{content:"";position:absolute;left:0;top:9px;width:11px;height:11px;border-radius:50%;
       background:var(--dot);box-shadow:0 0 0 3px #fff}
.tl li:last-child::before{background:var(--deep)}
.tl li::after{content:"";position:absolute;left:5px;top:24px;bottom:2px;
       border-left:2px dashed var(--dot)}
.tl li:last-child::after{display:none}
.tl li.warn::before{background:var(--warn)}
.tl li.warn::after{border-left-color:var(--warn)}
.tl .t{font-size:20px;font-weight:700;color:var(--deep)}
.tl .p{font-weight:700}
.tl li.warn .t,.tl li.warn .p,.tl li.warn .d{color:var(--warn)}
.cost{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:20px;align-self:start}
.cost h4{font-size:16px;color:var(--deep);margin-bottom:12px}
.crow{display:flex;justify-content:space-between;gap:14px;padding:5px 0;font-size:16px}
.crow.total{font-weight:700;font-size:17px}
.fns{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px}
.fn{margin:0 0 6px;font-size:14px;color:var(--ink)}
.fn.deep{color:var(--deep);font-weight:700}
.fn.warn{color:var(--warn);font-weight:700}
.strip{margin-top:18px;background:var(--tagbg);border:1px solid var(--tagline);border-radius:10px;
       padding:12px;text-align:center;color:var(--warn);font-weight:700;font-size:17px}

/* 景点卡：横向三栏 */
.spotcard{background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);
          padding:24px;margin-bottom:22px}
.schead{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;
        border-bottom:1px solid #EDF1F6;padding-bottom:16px;margin-bottom:18px}
.schead h3{font-size:23px;color:var(--deep)}
.meta{margin:5px 0 0;font-size:15px;color:var(--gray)}
/* 景点网址按钮 + 可点击提示（提示语由生成器统一加，数据里不用写）
   —— 溢出安全：urlLabel 是数据驱动文本，长度不可控。A4 703px 下最易爆，
      所以按钮可换行、站点块可收缩（flex:0 1 auto + min-width:0），不再 flex:none。 */
.btn{flex:0 1 auto;min-width:0;max-width:100%;display:inline-block;
     white-space:normal;overflow-wrap:anywhere;
     background:var(--deep);color:#fff !important;text-decoration:none;
     border-radius:10px;padding:11px 20px;font-size:15px;font-weight:700}
.btn:hover{background:#04496A}
.sitebox{flex:0 1 auto;min-width:0;max-width:56%;text-align:right}
.hint{margin:7px 0 0;font-size:13px;color:var(--gray);overflow-wrap:anywhere}
.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}
.grid3.n2{grid-template-columns:repeat(2,minmax(0,1fr))}
.grid3.n1{grid-template-columns:minmax(0,1fr)}
.grid3 .col{border-left:3px solid var(--line);padding-left:16px}
.grid3 .col.mine{border-left-color:var(--deep);background:#FAFCFE;border-radius:0 10px 10px 0;
                 padding:12px 16px}
.grid3 h4{font-size:16px;margin-bottom:8px}
.gh{color:var(--green)}
.bh{color:#B3261E}
.mh{color:var(--deep)}
.grid3 p{margin:0 0 8px;font-size:16px}
.src{margin:18px 0 0;font-size:13.5px;color:var(--gray)}

/* 逐段卡：两列网格 */
.leggrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.legcard{background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);
         padding:20px;display:flex;flex-direction:column;gap:9px}
.leghead{display:flex;justify-content:space-between;align-items:baseline;gap:14px}
.leghead h3{font-size:18px}
.leghead .no{color:var(--deep)}
.arrow{color:var(--gray)}
.taxi{color:var(--deep);font-size:17px;white-space:normal;overflow-wrap:anywhere;min-width:0;text-align:right}
.bus{margin:0;font-size:16px}
.bus i{font-style:normal;color:var(--deep);font-weight:700}
.legmeta{margin:0;font-size:15px;color:var(--gray)}
.car{margin:0;font-size:14px;color:var(--gray);border-top:1px dashed var(--line);padding-top:9px}

/* 方案对比：三栏 */
.cmpgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
.cmpcard{background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);
         padding:22px;display:flex;flex-direction:column;gap:10px}
.cmpcard.hot{border-color:var(--deep);border-width:2px}
.cmpcard header{display:flex;align-items:center;justify-content:space-between;gap:10px}
.cmpcard h3{font-size:19px}
.pill{background:var(--deep);color:#fff;font-size:12.5px;font-weight:700;border-radius:8px;padding:3px 10px}
.cmpPrice{font-size:28px;font-weight:700;margin:0}
.cmpnote{margin:0;font-size:14.5px;color:var(--gray)}
.ctag{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:7px;
      text-align:center;font-size:14.5px;font-weight:700;color:var(--deep)}
.cmprows{margin-top:6px}
.cbadge{margin-top:auto;background:var(--soft);border:1px solid var(--line);border-radius:10px;
        padding:11px;text-align:center;font-size:14.5px;font-weight:700;color:var(--deep)}

footer{margin-top:56px;border-top:1px solid var(--line);background:#fff}
footer .wrap{padding:26px 28px;font-size:14px;color:var(--gray)}

/* 窄窗口自适应：仅在「屏幕」媒体下生效。
   注意必须限定 screen —— 打印时媒体查询会按页面宽度求值（A4 正文宽约 703px），
   不加限定就会被这个断点误命中，打印版式变成"意外"决定的。 */
@media screen and (max-width:900px){
  .hero h1{font-size:30px}
  .lede{font-size:17px}
  .sec h2{font-size:23px}
  .stat b{font-size:24px}
  .planbody{grid-template-columns:minmax(0,1fr);gap:20px}
  .grid3,.grid3.n1,.grid3.n2{grid-template-columns:minmax(0,1fr);gap:16px}
  .grid3 .col{border-left:3px solid var(--line);padding:10px 14px;background:#FAFCFE;
              border-radius:0 10px 10px 0}
  .leggrid{grid-template-columns:minmax(0,1fr)}
  .cmpgrid{grid-template-columns:minmax(0,1fr)}
  .schead{flex-direction:column}
  .btn{align-self:flex-start}
  .sitebox{align-self:flex-start;text-align:left}
  .tl li{grid-template-columns:max-content minmax(0,1fr);grid-template-rows:auto auto}
  .tl li .d{grid-column:2}
  .topnav .wrap{height:auto;padding:10px 20px;flex-wrap:wrap;gap:12px}
  .wrap{padding:0 20px}
  .ov{font-size:14px}
  .ov td{padding:10px 10px}
  .ov tr.th td{font-size:13px}
  .tl .t{font-size:17px}
  .cmpPrice{font-size:24px}
}

/* 打印（客户自行用浏览器打印）：A4 纵向，隐藏导航，卡片不跨页断开。
   版式在这里「显式指定」，不依赖屏幕断点。 */
@page{size:A4;margin:12mm}
@media print{
  body{background:#fff;font-size:11pt;line-height:1.6}
  .topnav{display:none}
  .wrap{max-width:none;padding:0}
  .hero{padding:0 0 6px}
  .hero h1{font-size:24pt}
  .lede{font-size:12pt}
  .stats{gap:10px;margin-top:14px}
  .stat{padding:12px 14px;box-shadow:none;flex:1 1 30%}
  .stat b{font-size:18pt}
  .banner{margin-top:14px;font-size:11pt;padding:9px 12px}
  .sec{padding:16px 0 0}
  .sec h2{font-size:16pt}
  .sec>.sub{margin:4px 0 12px;font-size:10.5pt}
  .planbody{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:16px}
  .grid3,.grid3.n1,.grid3.n2{grid-template-columns:minmax(0,1fr);gap:8px}
  .grid3 .col{border-left:3px solid var(--line);padding:6px 12px;background:#FAFCFE;
              border-radius:0 8px 8px 0}
  .leggrid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .cmpgrid{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .schead{flex-direction:row}
  .hint{font-size:9.5pt}
  .plancard,.spotcard,.legcard,.cmpcard,.tblwrap,.stat,.banner{break-inside:avoid;box-shadow:none}
  .plancard,.spotcard,.legcard,.cmpcard{padding:14px;margin-bottom:12px}
  .grid3 p,.bus,.ov{font-size:10pt}
  .ov td{padding:8px 10px}
  .tl li{padding-bottom:14px}
  .cmpPrice{font-size:18pt}
  footer{margin-top:20px}
  footer .wrap{padding:12px 0;font-size:9.5pt}
}
`;

function shell(title, subtitle) {
  const nav = secs.map(s => `<a href="#${s.id}">${esc(s.label)}</a>`).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
<style>${CSS}</style></head>
<body>
<div class="topnav"><div class="wrap"><b>${esc(title)}</b>${nav}</div></div>
<main class="wrap">${blocks.join('\n')}</main>
<footer><div class="wrap">${esc(subtitle || title)} ｜ 本文件为单文件网页，无外部依赖，双击即可用浏览器打开；转发给他人直接转这一个文件即可</div></footer>
</body></html>
`;
}

// ---------- 景点网址的「形状闸门」----------
// 只能保证「这是一张稳定的景点直达页」，**不能**证明「这真的是那个景点」——语义正确性仍靠执行者。
// 依据：真实跑出来的错例（把政务网稿页/信息公开页/频道首页当景点网址）几乎都是形状出卖的。
const URL_SHAPE_RULES = [
  ['短链 / 跳转站', u => /^https?:\/\/(bit\.ly|t\.cn|dwz\.cn|url\.cn|suo\.im|sourl\.cn)\//i.test(u)],
  ['纯 IP 地址', u => /^https?:\/\/\d{1,3}(\.\d{1,3}){3}/.test(u)],
  ['反爬 / 验证特征', u => /verify|security|robot|captcha|antibot/i.test(u)],
  ['携程系（trip.com / ctrip.com）', u => /(^|\.)(trip\.com|ctrip\.com)/i.test(u)],
  ['政府 CMS 日期稿件页（如 /t20220421_5692516.shtml）', u => /\/t\d{8}_\d+\.s?html?$/i.test(u)],
  ['政府信息公开 / 政务目录页', u => /\/(xxgk|bmxxgkmlx?|xxgkml|zwgk|zwxx|gkml|zfxxgk)\w*\//i.test(u)],
  ['频道 / 栏目首页', u => /\/(cindex|index|list|channel|column)\.?\w*$/i.test(u)],
];
const urlShapeFail = u => {
  for (const [name, f] of URL_SHAPE_RULES) if (f(u)) return name;
  return null;
};

// ---------- 数据校验（先校验再渲染：缺字段就报可读错误，不产出半成品、不抛堆栈）----------

// 费用明细自校验：明细（非合计行）逐项相加 **必须等于**「合计 / 人」行。
// 为什么必须由代码管：**总价是客户唯一真正看的数字，却长期是唯一没人校验的数字**——
// plan.js 只忠实汇总喂进去的 cost（喂错就照错算），check_html.js 只查结构与排版。
// 实测（公共交通路线规划 第二轮 A/B，新旧技能各一份成品）两边都交付了算错的总价：
//   旧技能 明细 ¥623.0 标成 ¥723.5；新技能 明细 ¥654.5 标成 ¥946.0（把硬卧价 587 留在了页面上，席别已改硬座 290.5）。
// 只认第一个**不含"2 人/两人"**的合计行（页面末尾常另有一行「2 人合计」，那不是人均值）。
function costMismatch(rows) {
  const num = (s) => { const m = /(-?\d+(?:\.\d+)?)/.exec(String(s == null ? '' : s).replace(/,/g, '')); return m ? parseFloat(m[1]) : null; };
  let sum = 0, total = null;
  const items = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const label = String(r[0] == null ? '' : r[0]);
    const val = num(r[1]);
    if (!Number.isFinite(val)) continue;
    if (/合计|总计|小计/.test(label)) {
      // "合计 / 人（2 人合计 ¥1447.0）" 这类把两人合计写进**标签**的写法也要认出人均行，
      // 否则会被误当成两人合计行跳过、最要命的那个总价反而漏检（实测旧技能就是这种写法）。
      const perPax = /合计[\s/｜|]*人|人均|每人/.test(label);
      const twoPax = /(2|两|二)\s*人/.test(label) && !perPax;
      if (total === null && !twoPax) total = val;
    }
    else { sum += val; items.push('¥' + val); }
  }
  if (total === null) return null;                       // 没有合计行就不判（不强制每个页面都写）
  if (Math.abs(sum - total) < 0.05) return null;         // 一致
  return { sum, total, items: items.join(' + ') };
}

function validateData(d, mode) {
  const errs = [];
  const isStr = v => typeof v === 'string' && v.trim() !== '';
  const arr = v => (Array.isArray(v) ? v : null);
  const nonEmpty = v => (arr(v) || []).filter(isStr);

  if (!isStr(d.coverTitle) && !isStr(d.title)) errs.push('缺少 coverTitle（封面主标题）');
  const cc = arr(d.coverCards);
  if (!cc || !cc.length) errs.push('coverCards 缺失或为空（封面至少 1 张数据卡）');
  else cc.forEach((c, i) => {
    const t = card3(c);
    if (!t || t.length < 3) errs.push(`coverCards[${i}] 需要 3 项：标签 / 值 / 说明（写 ["标签","值","说明"] 数组，或 {label,value,desc} 对象都行）`);
    else if (t.slice(0, 3).some(v => String(v == null ? '' : v).trim() === '')) {
      errs.push(`coverCards[${i}] 有空白项（标签 / 值 / 说明 都要写）`);
    }
  });

  if (!d.overview || !nonEmpty((d.overview.rows || []).flat()).length) {
    errs.push('overview.rows 缺失或为空（总览表必给）');
  }
  // colWidths：**数字权重**（如 [24,14,30,32]），不是百分比字符串——
  // 写成 ['24%',…] 或 ['24',…] 会静默算出 NaN% / 0.000%（列宽意图丢失且不报错），所以在这里拦死。
  if (d.overview && d.overview.colWidths !== undefined && d.overview.colWidths !== null) {
    const cw = arr(d.overview.colWidths);
    if (!cw) errs.push('overview.colWidths 必须是数组（数字权重，如 [24,14,30,32]）');
    else {
      const badIdx = cw.map((w, i) => [w, i]).filter(([w]) => typeof w !== 'number' || !isFinite(w) || w <= 0);
      if (badIdx.length) {
        errs.push(`overview.colWidths 只能是**正数**（数字权重，如 [24,14,30,32]）：` +
          badIdx.map(([w, i]) => `第 ${i + 1} 项=${JSON.stringify(w)}`).join('、') +
          ` —— 不要写百分比字符串（'24%'）或数字字符串（'24'），那会静默产出 NaN% / 0.000% 的列宽`);
      }
      const cols = arr((d.overview.rows || [])[0]);
      if (cols && cw.length !== cols.length) {
        errs.push(`overview.colWidths 有 ${cw.length} 项，但总览表是 ${cols.length} 列（必须一一对应）`);
      }
    }
  }

  if (mode === 'plan') {
    // ── A2 价格必须标明票种（与 travel 的 lib/validate.js 同口径）──
    // 每个价格都要带席别/舱位，否则客户判断不出"这是哪个票种的价"。豁免：不含数字的说明文案。
    const SEAT_KIND_RE = /二等座|一等座|商务座|特等座|硬座|硬卧|软卧|高级软卧|软座|无座|经济舱|公务舱|头等舱|超经|机票/;
    // ⑤ **方案块内已写明票种**也豁免（2026-09-26 A/B 实测新增，与 travel 同口径）：
    //    拼票方案的人均价天然是"二等座 + 一等座"的混合价，写不进单一票种；技能允许把票种写在
    //    **方案标题**里（"高铁 G1523 直达（拼票：二等座 1 张 + 一等座 1 张）"）。旧规则只认价格字段本身，
    //    于是把这种合规写法判成"未标票种"，逼执行者回头改数据再重生成——一次白跑的生成 + 若干次 edit。
    const blockSeatKind = (p) => {
      if (!p) return false;
      const parts = [p.title, p.subtitle, p.badge];
      for (const s of arr(p.steps) || []) if (s) parts.push(s.desc, s.place, s.time);
      for (const r of arr(p.costRows) || []) {
        if (Array.isArray(r)) parts.push(...r);
        else if (r) parts.push(r.label ?? r.name, r.value ?? r.val);
      }
      return SEAT_KIND_RE.test(parts.filter(isStr).join(' '));
    };
    const checkPriceKind = (txt, tag, blockHasKind = false) => {
      if (!isStr(txt)) return;
      if (!/\d/.test(txt)) return;
      if (SEAT_KIND_RE.test(txt)) return;
      if (blockHasKind) return;                          // ⑤ 同块内已写明票种
      errs.push(`${tag} 报价未标明票种：「${txt}」——每个价格都要写清席别（二等座/硬卧…）或舱位（经济舱）；票种由「席别规则」定，不需要客户自己比价`);
    };
    const checkPlans = (node, label) => {
      if (!node) return;
      const ps = arr(node.plans);
      if (!ps || !ps.length) { errs.push(`${label}.plans 缺失或为空`); return; }
      ps.forEach((p, i) => {
        const tag = `${label}.plans[${i}]`;
        const blockHasKind = blockSeatKind(p);
        if (!isStr(p.title)) errs.push(`${tag}.title 缺失`);
        checkPriceKind(p.price, `${tag}.price`, blockHasKind);
        if (!arr(p.steps) || !p.steps.length) errs.push(`${tag}.steps 缺失或为空`);
        else p.steps.forEach((s, j) => {
          if (!isStr(s.time) || !isStr(s.place) || !isStr(s.desc)) {
            errs.push(`${tag}.steps[${j}] 需要 time / place / desc 三项`);
          }
        });
        if (!arr(p.costRows) || !p.costRows.length) errs.push(`${tag}.costRows 缺失或为空`);
        else {
          const bad = costMismatch(p.costRows);
          if (bad) errs.push(`${tag} 费用明细**算错了**：${bad.items} = ¥${bad.sum.toFixed(1)}，但合计行写的是 ¥${bad.total.toFixed(1)}（差 ¥${(bad.total - bad.sum).toFixed(1)}）。总价必须与明细逐项相加一致——**改过任一段的席别或票价后要重跑 plan.js，不得手改数字**。`);
          // costRows 的票种判定看**标签+值两列**：["G2911 二等座","¥250"] 票种在标签里；
          // ["合计","¥800"]、["接驳","¥5"]、["人均","¥615.5"] 本就不带票种，必须豁免。
          p.costRows.forEach((row, j) => {
            const labelTxt = String((Array.isArray(row) ? row[0] : row && (row.label ?? row.name)) ?? '');
            const valTxt = String((Array.isArray(row) ? row[1] : row && (row.value ?? row.val)) ?? '');
            const AGG = /合计|小计|总计|总共|接驳|打车|地铁|公交|步行|机场建设费|机建|燃油|附加费|服务费|住宿|餐|人均/;
            if (SEAT_KIND_RE.test(labelTxt) || AGG.test(labelTxt)) return;
            // ⑤ 的"块级豁免"只给**综合行**（无班次号）；带班次号的行是"某一段自己的价"，必须自己标票种
            // —— 否则某一段漏标会被整卡别处的票种说明掩盖（与 travel 的 lib/validate.js 同口径）。
            const rowIsLeg = /\b(?:[GDCZTK]\d{1,4}|[A-Z]{2}\d{3,4})\b/.test(labelTxt);
            checkPriceKind(valTxt, `${tag}.costRows[${j}]`, blockHasKind && !rowIsLeg);
          });
        }
      });
    };
    checkPlans(d.cheapest, 'cheapest');
    checkPlans(d.extra, 'extra');
    if (d.fastest && (!arr(d.fastest.steps) || !d.fastest.steps.length)) {
      errs.push('fastest.steps 缺失或为空');
    }
    // fastest 也要 costRows：缺了会渲染出「只有标题、没有一行费用」的空费用卡（且旧版校验器与空壳检查都抓不到）
    if (d.fastest && (!arr(d.fastest.costRows) || !d.fastest.costRows.length)) {
      errs.push('fastest.costRows 缺失或为空（会渲染出只有标题的空「费用明细」卡）');
    } else if (d.fastest) {
      const bad = costMismatch(d.fastest.costRows);
      if (bad) errs.push(`fastest 费用明细**算错了**：${bad.items} = ¥${bad.sum.toFixed(1)}，但合计行写的是 ¥${bad.total.toFixed(1)}（差 ¥${(bad.total - bad.sum).toFixed(1)}）。`);
      checkPriceKind(d.fastest.price, 'fastest.price', blockSeatKind(d.fastest));
    }

    // ── A4 三段数量（硬性）：最省钱 1 个 + 最快 1 个 + 额外 ≥2 个 ──
    if (d.cheapest) {
      const cps = arr(d.cheapest.plans) || [];
      if (cps.length > 1) {
        errs.push(`cheapest.plans 有 ${cps.length} 个 —— 「最省钱」**只放 1 个**；比它贵但仍有价值的方案放「额外方案」（硬性：1 + 1 + ≥2）`);
      }
    }
    const exs = d.extra ? (arr(d.extra.plans) || []) : [];
    if (exs.length < 2) {
      const notesTxt = [
        ...(arr(d.overview && d.overview.footnotes) || []),
        ...(d.overview && isStr(d.overview.note) ? [d.overview.note] : []),
        ...((d.extra && arr(d.extra.footnotes)) || []),
      ].join(' ');
      const explained = /余票不足|余票不够|票不够|无票|班次太少|查不到代号|航班号|窗口内无|无法给出|只有这些|不凑数/.test(notesTxt);
      if (!explained) {
        errs.push(`extra.plans 只有 ${exs.length} 个（要求 ≥2）——**给不满必须在注脚里写明原因**` +
          `（余票不足 / 无票 / 班次太少 / 航班查不到代号 / 窗口内无班次），否则客户会以为没查全`);
      }
    }
  }

  if (mode === 'spots') {
    const sp = arr(d.spots);
    if (!sp || !sp.length) errs.push('spots 缺失或为空');
    else sp.forEach((s, i) => {
      const tag = `spots[${i}]${isStr(s.name) ? '（' + s.name + '）' : ''}`;
      if (!isStr(s.name)) errs.push(`${tag}.name 缺失`);
      if (!isStr(s.meta)) errs.push(`${tag}.meta 缺失`);
      if (!isStr(s.urlLabel)) errs.push(`${tag}.urlLabel 缺失`);
      if (!isStr(s.url)) errs.push(`${tag}.url 缺失`);
      else if (!/^https?:\/\//.test(s.url)) errs.push(`${tag}.url 不是 http(s) 网址：${s.url}`);
      else {
        const bad = urlShapeFail(s.url);
        if (bad) {
          errs.push(`${tag}.url 是「${bad}」，不能作为景点网址：${s.url}` +
            ` —— 景点网址只能是**该景点的官网**，或旅游平台（马蜂窝/去哪儿/欣欣）上**该景点的详情页**；` +
            `官网首页请直接写站点根地址（如 https://www.example.com/）；没有官网就如实写"未找到官网"再用详情页，` +
            `不得拿政务页 / 信息公开页 / 新闻稿 / 栏目首页充数`);
        }
      }
      // 好评 / 差评：最多 2 条；公开评论确实很少时允许 1 条甚至 0 条（如实呈现，不得编造）
      for (const k of ['good', 'bad']) {
        if (nonEmpty(s[k]).length > 2) errs.push(`${tag}.${k} 最多 2 条（当前 ${nonEmpty(s[k]).length} 条）`);
      }
      if (nonEmpty(s.mine).length < 1) errs.push(`${tag}.mine 至少 1 条`);
      if (!isStr(s.source)) errs.push(`${tag}.source 缺失（评价来源标注是硬性要求，见「流程二」步骤 4）`);
    });
    // 数量与配比：技能硬性要求（5～10 个 / ≥2 热门 / 保底 2 不热门）。
    // 从前只靠子代理自己数、自己写进自检结论，生成器不拦——**枚举就该由代码做**。
    if (sp) {
      if (sp.length < 5 || sp.length > 10) {
        errs.push(`spots 有 ${sp.length} 个，技能要求 **5～10 个**——凑不齐就按「流程二」步骤 1 的就近原则扩到同城/周边，超额就删到 10 个以内`);
      }
      const isHot = s => /热门/.test(String(s.meta || '')) && !/不热门/.test(String(s.meta || ''));
      const hot = sp.filter(isHot).length;
      const cold = sp.filter(s => /不热门/.test(String(s.meta || ''))).length;
      if (hot < 2) errs.push(`热门景点只有 ${hot} 个，技能要求**至少 2 个热门**（在对应景点的 meta 里写明"热门"）`);
      if (cold < 2) errs.push(`不热门景点只有 ${cold} 个，技能要求**保底 2 个不热门**（在对应景点的 meta 里写明"不热门"）`);
    }
  }

  if (mode === 'itin') {
    const lg = arr(d.legs);
    if (!lg || !lg.length) errs.push('legs 缺失或为空');
    else lg.forEach((l, i) => {
      if (!isStr(l.from) || !isStr(l.to)) errs.push(`legs[${i}] 缺少 from / to`);
      if (!isStr(l.km) && !Number.isFinite(l.km)) errs.push(`legs[${i}] 缺少 km（每段都要写清里程；写数字 15.3 或 "15.3 km" 都行）`);
      // note 可选：渲染器按「非空部分拼接」处理，留空不会留下悬空的「 · 」
    });
    if (d.plans) {
      const cards = Array.isArray(d.plans) ? d.plans : (arr(d.plans.cards) || []);
      if (!cards.length) errs.push('plans 给了但没有卡片');
      cards.forEach((c, i) => {
        if (!isStr(c.title)) errs.push(`plans.cards[${i}].title 缺失`);
        if (!isStr(c.price)) errs.push(`plans.cards[${i}].price 缺失`);
      });
    }
  }
  return errs;
}

// ---------- 入口 ----------
(function main() {
  // `--check`：生成后**同一条命令**接着跑校验。
  // 与 travel 侧同一口径（2026-09-26 A/B 实测：分开跑是「make_html ×5 + check_html ×5」
  // = 10 次往返，每一步都要重放整个上下文；合成后是 3 次，并消灭"忘了校验就交付"）。
  const RAW = process.argv.slice(2);
  const DO_CHECK = RAW.includes('--check');
  // 交付形态只有 HTML：`--pdf` 已移除，见到就直接拒绝（不静默放过，免得执行者以为转出了文件）。
  if (RAW.includes('--pdf')) {
    console.error('PDF 生成已移除 —— 本技能只交付单文件 HTML。请去掉 --pdf，改用：');
    console.error('  node scripts/make_html.js plan <data.json> <out.html> --check');
    process.exit(1);
  }
  const [mode, dataFile, outArg] = RAW.filter(a => a !== '--check');
  if (mode === '--help' || mode === '-h') {
    console.log([
      'make_html.js —— HTML 生成统一入口（禁止手写生成脚本）',
      '',
      '用法:',
      '  node scripts/make_html.js plan  <data.json> <out.html>    # 城际交通方案页',
      '  node scripts/make_html.js spots <data.json> <out.html>    # 景点推荐页',
      '  node scripts/make_html.js itin  <data.json> <out.html>    # 行程方案页',
      '',
      '  ★ 推荐一条命令到底（省往返，也免得忘记校验）：',
      '  node scripts/make_html.js plan <data.json> <out.html> --check',
      '    --check  生成后立刻跑 check_html.js（景点页自动带 --spots），FAIL 则以退出码 1 结束',
      '  加了 --check 后**不要再单独跑** check_html.js。',
      '  交付形态只有 HTML（不产出 PDF）；客户要纸面请自行用浏览器打印。',
      '',
      '为什么用它: 生成器已固化全部布局 / 字号 / 样式规范。执行时**只需写一个小数据 JSON**，',
      '            不必手写几百行 JS，也不必反复试错调布局。**不要另写生成脚本。**',
      '',
      '它会先校验数据: **缺必需字段就打印可读错误并拒绝生成**，不产出半成品。',
      '  · 封面四件套 coverTitle / coverSubtitle / coverCards / coverNote（cards 每张 3 项：数组 ["标签","值","说明"] 或对象 {label,value,desc} 都接受）',
      '      填好的例子：coverCards: [["推荐景点","5 个","含 3 个热门、2 个不热门"], ["开放时间核对","2026 年 9 月","已按最近公告核对"]]',
      '      —— 三项都要有内容；只写两项会被拒（"有空白项"），这是最常见的退件原因',
      '  · 各方案的 steps / costRows',
      '  · 行程页 legs[]：from / to / km 必需（km 写数字 15.3 或 "15.3 km" 都行）',
      '  · overview.colWidths 必须是**正数数组**（数字权重，个数 = 列数）——写成百分比字符串会静默产出 NaN%',
      '  · 景点页的 url 走**形状闸门**（政务页 / 频道首页 / 携程系 / 短链 / 纯 IP 一律拒绝）',
      '  · 块级字段（plans / extra / fastest）没给就不出那一块',
      '',
      '产出: 「屏幕优先的单文件网页」，零外链零依赖，双击即用浏览器打开。',
      '      不要往里加外链资源——那会让交付物不再是单文件。',
      '      生成后**仍须**过 check_html.js（必须 PASS）。',
      '',
      '**完整字段规范见 SKILL.md「流程一」；本脚本的校验错误会告诉你缺什么。**',
      '退出码: 0 = 生成成功；1 = 用法错误 / 数据校验不通过。',
      '',
      '注意: 不要读本脚本源码——用 --help 就够了。',
    ].join('\n'));
    process.exit(0);
  }
  if (!mode || !dataFile || !outArg) {
    console.error('用法:\n  node scripts/make_html.js plan  <data.json> <out.html>\n' +
      '  node scripts/make_html.js spots <data.json> <out.html>\n' +
      '  node scripts/make_html.js itin  <data.json> <out.html>');
    process.exit(1);
  }
  // 容忍 UTF-8 BOM（PowerShell 写出的 JSON 常带 BOM，否则 JSON.parse 会报错）
  const d = JSON.parse(fs.readFileSync(dataFile, 'utf8').replace(/^\uFEFF/, ''));

  const errs = validateData(d, mode);
  if (errs.length) {
    console.error(`数据校验未通过（${errs.length} 项）——未生成任何文件：`);
    errs.forEach(e => console.error('  · ' + e));
    console.error('请修正数据后重新生成；字段规范见 SKILL.md 对应流程章节。');
    process.exit(1);
  }

  if (mode === 'plan') buildPlan(d);
  else if (mode === 'spots') buildSpots(d);
  else if (mode === 'itin') buildItin(d);
  else { console.error('未知模式: ' + mode); process.exit(1); }

  ensureDir(outArg);
  fs.writeFileSync(outArg, shell(d.coverTitle || d.title || mode, d.coverSubtitle), 'utf8');
  console.log(`WROTE: ${outArg}  (章节 ${secs.length} 个)`);

  // ── --check：生成后立刻校验（景点页自动带 --spots）──
  if (DO_CHECK) {
    const checkArgs = [path.join(__dirname, 'check_html.js'), outArg];
    if (mode === 'spots') checkArgs.push('--spots');
    const r = spawnSync(process.execPath, checkArgs, { encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stderr.write(r.stderr);
    console.log(r.status === 0
      ? '\n[make_html --check] 校验 PASS —— 这一页可以直接交付（不要再单独跑 check_html.js）。'
      : '\n[make_html --check] 校验 **FAIL** —— 按上面每一条修数据后重跑本命令，不要反复试。');
    if (r.status !== 0) {
      // 校验没过 → 删掉刚生成的 HTML：本脚本对不合格数据的承诺是"不产出半成品"，
      // 这条承诺在 --check 路径上也要成立（与 travel 同口径）。
      try { fs.unlinkSync(outArg); console.log(`[make_html --check] 已删除未通过校验的 ${outArg}（不留半成品）。`); } catch { /* 删不掉就算了 */ }
      process.exit(1);
    }
  }
})();
