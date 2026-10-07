#!/usr/bin/env node
/**
 * route/travel 共用 · 车次筛选与席别裁决（把"读全谱 + 逐条推规则"搬进代码）
 *
 * 用法: node scripts/plan.js <brief.txt> [选项]
 *   --at HH:MM     客户指定出发时间 T → 优先 T～T+1h，放宽 T～T+2h
 *   --from HH:MM   显式优先窗口起点（未给 --at 时默认 08:00）
 *   --to HH:MM     显式放宽窗口终点（默认 = 优先窗口末 + 1h）
 *   --pax N        出发人数（默认 1）
 *   --json         输出 JSON 而非文本
 *
 * 输入 = `12306.js tickets ... --brief` 的输出（每车次一行 + 两行 # 注释）。
 * 目的 = 让上层**不必读几百行车次原始数据**，只看本脚本给的短名单。
 * 裁决口径全部来自 SKILL.md「席别规则 / 人数与余票规则 / 无座票规则 / 时间窗口规则」。
 *
 * 退出码: 0 = 有可用车次；2 = 窗口内无可用（但仍打印结果）；1 = 用法/解析错误
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// 写文件前先建父目录：实测踩过——`--out 中间数据/candidates.json` 在目录不存在时直接崩（ENOENT），
// 执行者只能先建目录再重跑一遍命令（一次白跑的往返）。所有落盘点统一走这里。
function ensureDir(file) {
  try { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); } catch { /* 真写不进去会在 writeFileSync 报错 */ }
}

// ── 席别序（口径见 SKILL.md「席别规则」）───────────────────────────────
const EMU_TIERS = ['二等座', '一等座'];                       // G/C/D 封顶一等座，商务/特等座不列
const CONV_SHORT = ['硬座', '硬卧', '软卧'];                  // 普通普速：票价由低到高
const CONV_LONG = ['硬卧', '软卧', '硬座'];                   // 长途普速（跨天或历时≥12h）
const WZ = '无座';
const WZ_MAX_MIN = 45;                                        // 无座门槛

const isEmu = (code) => /^[GCD]/i.test(code);
const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim()); return m ? (+m[1]) * 60 + (+m[2]) : null; };
// 分钟差 → 可读文本。**负数必须显式带负号且不能出现 "h-18" 这种写法**：
// Math.floor(-18/60) = -1、(-18)%60 = -18，直接拼会得到 "-1h-18"，实测被读成"1 小时 18 分"。
const gapTxt = (g) => { const a = Math.abs(g); return `${g < 0 ? '-' : ''}${Math.floor(a / 60)}h${String(a % 60).padStart(2, '0')}`; };
const fmtPrice = (v) => (v === null || v === undefined || v === '-' ? null : Number(v));

// ── 参数 ──────────────────────────────────────────────────────────────
// ── 三段归位（最省钱 / 最快 / 额外）──────────────────────────────────
// 口径见 SKILL.md「方案生成」。给定各候选的（总费用, 总耗时），归位结果唯一。
// 票价：**有数字（含机票参考价）就照常参与"最省钱"比价**（2026-10-07 定）；只有 null（票价待定）才不参与，但**照常参与"最快"**。
// 到达日门槛（--arrive-by）：超出客户要求到达日的候选**不得进「最省钱 / 最快」**，
// 一律降级到额外方案并标注——否则"当日 14:09 发车、次日 15:49 到"的过夜普速车
// 会仅凭 ¥221.5 被封成「最省钱」，而客户是次日才起玩。
function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const hasT = m[4] !== undefined;
  const d = new Date(+m[1], +m[2] - 1, +m[3], hasT ? +m[4] : 23, hasT ? +m[5] : 59, hasT ? 0 : 59);
  return Number.isNaN(d.getTime()) ? null : d;
}
const fmtLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

function rankMain(file, deadline, emitData, meta) {
  meta = meta || {};
  if (!file) { console.error('用法: node scripts/plan.js rank <candidates.json> [--arrive-by <日期>]（--help 看完整说明）'); process.exit(1); }
  if (!fs.existsSync(file)) { console.error('文件不存在: ' + file); process.exit(1); }
  let list;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error('JSON 解析失败: ' + e.message); process.exit(1); }
  if (!Array.isArray(list) || list.length < 1) { console.error('candidates 必须是非空数组'); process.exit(1); }

  const errs = [];
  list.forEach((c, i) => {
    const tag = c && c.name ? `「${c.name}」` : `第 ${i + 1} 项`;
    if (!c || typeof c !== 'object') { errs.push(`${tag} 不是对象`); return; }
    if (!c.name) errs.push(`${tag} 缺 name`);
    if (!Number.isFinite(c.durationMin)) errs.push(`${tag} 缺 durationMin（总耗时，分钟）`);
    if (c.cost !== null && c.cost !== undefined && !Number.isFinite(c.cost)) errs.push(`${tag} 的 cost 必须是数字或 null（未知票价用 null）`);
    if (deadline && !parseLocal(c.arriveAt)) errs.push(`${tag} 已给 --arrive-by，就必须给 arriveAt（到达时刻，如 "2026-10-02T15:49"）`);
  });
  if (errs.length) { console.error('数据有问题：'); errs.forEach(e => console.error('  ' + e)); process.exit(1); }

  // 不可行候选（换乘预留不达标 / 时刻倒挂）**一律排除**，不得进「最省钱 / 最快」——
  // 口径 = SKILL.md「换乘时间规则」：「换乘预留不足的方案排除，不得作为推荐」。
  // 从前只把这句话写在正文里、代码不执行：实测有候选时刻倒挂（上一段 08:47 到、下一段 08:29 发）
  // 却照样进 JSON，靠"更便宜的那个恰好可行"才没被选上——纯属运气。
  // 兜底：候选带了 legs 却没有 feasible 标记时**就地重算一遍**。
  // 为什么必须重算：rank 从前只信 candidates 写下的标记，于是 (a) 手写的 candidates.json、
  // (b) 跑完 candidates 之后又改了腿（"改了明细不重跑"那个老毛病）——都能整条绕过换乘校验。
  for (const c of list) {
    if (!c || c.feasible !== undefined || !Array.isArray(c.legs) || !c.legs.length) continue;
    // ⚠ 重算必须**把联程豁免一起带过去**：漏了它，合法的平台联程中转会被重算成
    // "未达 90 分钟（起飞前 1.5 小时到机场）门槛"而排除——candidates 说可行、rank 说不可行（实测踩过）。
    // 判据与 buildOption 一致：候选级或任一段级写了 throughCheckin。
    const through = !!c.throughCheckin || c.legs.some(l => !!(l && l.throughCheckin));
    const r = buildOption({ name: c.name, kind: c.kind, legs: c.legs, throughCheckin: through }, 0, new Map());
    if (r.bad.length) { c.feasible = false; c.infeasible = r.bad; }
  }

  const infeasible = list.filter(c => c && c.feasible === false);
  const usable = list.filter(c => !(c && c.feasible === false));
  const work = usable.length ? usable : list;
  const allInfeasible = !usable.length;

  const isLate = (c) => !!deadline && parseLocal(c.arriveAt).getTime() > deadline.getTime();
  const withCost = work.filter(c => Number.isFinite(c.cost));
  const lateCount = deadline ? work.filter(isLate).length : 0;
  // 到达日之内的候选（全超时则退回全体，否则无从下手）
  const okAll = deadline ? work.filter(c => !isLate(c)) : work;
  const pool = okAll.length ? okAll : work;
  // 最省钱：只在「到达日之内」的有价候选里取最低价（超出者一律不进）。
  // 兜底：若到达日内**一个已知票价的候选都没有**（含所有票价都未知），最省钱段也**不能空**——
  // 生成器要求 cheapest.plans 至少 1 个。此时指定「到达日内最早到达者」当兜底，并明确
  // 要求标注"票价为参考价/待定"。实测踩过：模型死守"票价未知不参与最省钱"，导致该段为空、
  // 只能自行判断怎么填（这正是我们要消灭的"AI 自行判断"）。
  const okCost = deadline ? withCost.filter(c => !isLate(c)) : withCost;
  const cheapestKnown = okCost.length ? okCost.reduce((a, b) => (b.cost < a.cost ? b : a)) : null;
  const cheapest = cheapestKnown || pool.reduce((a, b) => (b.durationMin < a.durationMin ? b : a));
  const cheapestIsFallback = !cheapestKnown;
  // 最快：同样只在到达日之内的候选里取；全超时仍给最快，但要告警
  const fastest = pool.reduce((a, b) => (b.durationMin < a.durationMin ? b : a));
  const extra = work.filter(c => c !== cheapest && c !== fastest);

  const h = (m) => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}`;
  const money = (v) => (Number.isFinite(v) ? '¥' + v : '票价未定');
  // kind 显示成中文术语（SKILL.md「术语规范」要求一律用中文称呼）：候选里写 rail/air
  // 或 铁路/空中 都能显示成「铁路 / 空中」，避免输出出现英文 kind。
  // 只在**显示**这一层转换，判定逻辑（`isAir`）仍认原值。
  const KIND_CN = { rail: '铁路', train: '铁路', 铁路: '铁路', 高铁: '铁路', 动车: '铁路',
                    air: '空中', flight: '空中', plane: '空中', 空中: '空中', 航空: '空中' };
  const kindCn = (k) => {
    if (!k) return k;
    const s = String(k).trim();
    const lower = s.toLowerCase();
    if (KIND_CN[lower]) return KIND_CN[lower];
    if (/空中|航空|航班/.test(s)) return '空中';
    if (/铁路|高铁|动车|火车/.test(s)) return '铁路';
    return s;
  };
  const line = (c, tag) => {
    const bits = [c.name, money(c.cost), h(c.durationMin)];
    if (c.windowHit) bits.push(c.windowHit);
    if (c.arriveAt) bits.push('到 ' + c.arriveAt);
    if (isLate(c)) bits.push('⚠ 超出到达日');
    if (c.kind) bits.push(kindCn(c.kind));
    if (c.note) bits.push(c.note);
    return `  ${tag}${bits.join('  ·  ')}`;
  };
  const delta = (c) => {
    const out = [];
    if (cheapest && c !== cheapest && Number.isFinite(c.cost) && Number.isFinite(cheapest.cost)) {
      const d = Math.round((c.cost - cheapest.cost) * 10) / 10;
      out.push(d >= 0 ? `比最省钱贵 ¥${d}` : `比最省钱省 ¥${-d}`);
    }
    if (c !== fastest) {
      const d = c.durationMin - fastest.durationMin;
      out.push(d >= 0 ? `比最快慢 ${h(d)}` : `比最快快 ${h(-d)}`);
    }
    return out.join(' / ');
  };

  const L = [];
  L.push(`# 三段归位（候选 ${list.length} 个${infeasible.length ? `，其中**不可行 ${infeasible.length} 个已排除**` : ''}；票价未知 ${work.length - withCost.length} 个）`);
  if (infeasible.length) {
    L.push('不可行候选（换乘预留不达标 / 时刻倒挂）**已被排除在归位之外**（换乘时间规则）：');
    infeasible.forEach(c => {
      L.push(`  ✗ ${c.name}${Number.isFinite(c.cost) ? '  ¥' + c.cost : ''}  ${h(c.durationMin)}`);
      (c.infeasible || []).forEach(x => L.push(`      ${x}`));
    });
    if (allInfeasible) L.push('  ⚠ **全部候选都不可行**：下面的排序只是兜底，交付前必须先把时刻 / 换乘修对，不得原样交付。');
  }
  // 可行候选太少 = "还没找到"的信号，不是"不可达"的证据。
  // 实测第四轮：A 的池子里 5 个候选有 4 个不可行、只剩 1 个可行，它据此宣布"唯一通道是经武汉"，
  // 把被判不可行的铁路方案抬成最省钱/最快——而 B 同轮找到了 10h35m 当日到达的空路与 ¥677.5 的铁路经西安。
  if (work.length <= 1) {
    L.push('');
    L.push(`⚠ **可行候选只有 ${work.length} 个**——这**不是"不可达"的证据，是"还没找到"的证据**。写页面之前必须再扩一轮：`);
    L.push('  ① **换枢纽**：至少再试 2 条链，尤其**出发地机场能飞哪些城市**与**相邻大枢纽**（别只在一条走廊里加深）；');
    L.push('  ② **换日期**看余票（次日有票往往能救回整条通道）；③ 把官方 `transfer` 的每组按门槛逐条复核。');
    L.push('  **不得**据此宣布"唯一通道 / 不可达"，也**不得**把判为不可行的候选抬成最省钱 / 最快（换乘时间规则）。');
  }
  if (deadline) {
    L.push(`到达日门槛：不晚于 ${fmtLocal(deadline)}——超出的候选**不进「最省钱 / 最快」**，一律降级到额外方案并标注。`);
    if (lateCount) L.push(`  ⚠ 超出门槛的候选 ${lateCount} 个（总耗时跨越了客户要求的到达日）。`);
  } else if (list.some(c => c.arriveAt)) {
    L.push('提示：候选带了 arriveAt，但本次**未给 --arrive-by，未做到达日校验**——客户指定了到达日时请补上。');
  }
  L.push('');
  L.push('## 1. 最省钱（只给 1 个）');
  L.push(line(cheapest, '★ '));
  if (cheapestIsFallback) {
    L.push('     ⚠ 到达日内**没有任何已知票价的候选** → 本段仍**必须照给这一个**（最省钱段不能空）。');
    L.push('        在 badge / footnotes 注明"票价为参考价或待定，非当日实价，以出票页为准"。');
    if (withCost.length) L.push(`        并说明：另有 ${withCost.length} 个已知票价的方案总价更低，但超出到达日，已降级到额外方案。`);
  } else {
    const rest = okCost.filter(c => c !== cheapest).sort((a, b) => a.cost - b.cost);
    if (rest.length) L.push(`     次省：${rest[0].name}  ${money(rest[0].cost)}（贵 ¥${Math.round((rest[0].cost - cheapest.cost) * 10) / 10}）`);
    else L.push('     没有其它有价候选可比较');
  }
  L.push('');
  L.push('## 2. 最快（只给 1 个）');
  L.push(line(fastest, '★ '));
  if (deadline && isLate(fastest)) L.push(`     ⚠ **最快方案也超出到达日**——没有任何候选能在 ${fmtLocal(deadline)} 前到达，必须在聊天回复里明确说明，并让客户改期或明示接受次日到达。`);
  if (!Number.isFinite(fastest.cost)) L.push(cheapestIsFallback
    ? '     （票价未定，但它是到达日内的候选 → 已按兜底规则占用"最省钱"段，见上）'
    : '     （票价未定 → 不参与"最省钱"归位，但照常参与"最快"比较）');
  L.push('');
  L.push(`## 3. 额外方案（${extra.length} 个，目标 ≥2）`);
  if (extra.length) extra.forEach(c => { L.push(line(c, '- ')); const d = delta(c); if (d) L.push('     ' + d); });
  else L.push('  （无）');
  if (extra.length < 2) {
    L.push('');
    L.push(`**给不满 2 个 → 必须在聊天回复与页面注脚里写明原因**（口径见 SKILL.md「方案生成 → 3. 额外方案」）。`);
    L.push('常见原因：票不够 / 班次太少 / 航班查不到代号 / 窗口内无班次。');
  }
  const sameBoth = cheapest && cheapest === fastest;
  if (sameBoth) { L.push(''); L.push(`注：「${cheapest.name}」同时是最省钱与最快，两段各列一次。`); }

  // ── --emit-data：顺手把 make_html 要的 data.json 骨架写出来 ─────────────
  // 为什么塞在这里而不是新开一个模式：**新开模式 = 多一次往返 = 约 11 万 token**（见「成本 ≈ 调用次数 × 上下文」）。
  // rank 手里已经有归位结果、价格、总耗时、到达时刻与逐段明细，生成骨架是纯机械活。
  // 从前这步由模型手写 13–14 KB 的 data.json，**两份成品都因此把总价写错**（明细改了、总价留着旧值）。
  if (emitData) {
    const p2 = (n) => String(n).padStart(2, '0');
    const hm = (m) => `${Math.floor(m / 60)} 小时 ${p2(m % 60)} 分`;
    const clock = (s) => String(s || '').replace(/^(\d{4})-/, '').replace('T', ' ').trim();
    const stepOf = (l) => ({
      time: `${clock(l.dep) || '—'} → ${clock(l.arr) || '—'}`,
      place: `${l.from || '?'} → ${l.to || '?'}`,
      desc: [`${l.code || ''}${l.seat ? ' · ' + l.seat : ''}`.trim(), Number.isFinite(l.cost) ? `¥${l.cost}` : null].filter(Boolean).join(' · ') || '（请补写本段说明）',
    });
    const rowsOf = (c) => {
      const legs = Array.isArray(c.legs) ? c.legs : [];
      // 首列写「车次/航班号 + 席别」，价格单列——正好满足 A2「价格必须标明票种」
      const rows = legs.filter(l => Number.isFinite(l.cost)).map(l => [`${l.code || ''}${l.seat ? ' ' + l.seat : ''}`.trim() || '接驳', `¥${l.cost}`]);
      const sum = legs.reduce((a, l) => a + (Number.isFinite(l.cost) ? l.cost : 0), 0);
      // 行里没有的差额（如 extraCost）单列一行，保证「合计 = 明细之和」这条校验永远成立
      if (Number.isFinite(c.cost) && Math.abs(c.cost - sum) > 0.05) rows.push(['接驳 / 附加', `¥${Math.round((c.cost - sum) * 10) / 10}`]);
      rows.push(['合计 / 人', Number.isFinite(c.cost) ? `¥${c.cost}` : '待定（以出票页为准）']);
      return rows;
    };
    // 票种（席别 / 舱位）：从各段取写了的席别，拼成"二等座"或"二等座 + 经济舱"。
    // ⚠ 兜底**必须**扫候选名 / 备注 / 段说明：实测（2026-09-26 上海→武汉 A/B）手写 options.json 的腿
    //   常常不写 `seat`，而票种其实写在候选名里（"高铁 G1523 直达（拼票：二等座 1 张 + 一等座 1 张）"）。
    //   旧实现取不到就回退 `'票价'` → 产出 `**票价 ¥611.5 / 人**` → **被自家 A2 门禁拒绝**，
    //   执行者只好回头改数据重生成（一次白跑的生成 + 数条 edit）。
    const SEAT_WORDS = /二等座|一等座|商务座|特等座|硬座|硬卧|软卧|高级软卧|软座|无座|经济舱|公务舱|头等舱|超经/g;
    const seatKindOf = (c) => {
      const legs = Array.isArray(c.legs) ? c.legs : [];
      const seats = [...new Set(legs.map(l => String(l.seat || '').trim()).filter(Boolean))];
      if (seats.length) return seats.join(' + ');
      const txt = [c.name, c.note, c.title, ...legs.map(l => (l && l.desc) || '')].filter(Boolean).join(' ');
      return [...new Set(txt.match(SEAT_WORDS) || [])].join(' + ');
    };
    // 过夜判定：某段跨天（到达日 > 出发日），或 note 里已写"过夜"
    const overnight = (c) => {
      const legs = Array.isArray(c.legs) ? c.legs : [];
      const cross = legs.some(l => String(l.arr || '').slice(0, 10) !== String(l.dep || '').slice(0, 10));
      return cross || /过夜/.test(String(c.note || ''));
    };
    const footnotesOf = (c) => [
      c.windowHit ? `窗口命中：${c.windowHit}` : null,
      /偏紧/.test(String(c.note || '')) ? '⚠ **换乘偏紧**：到站后余量不足 30 分钟，前段一旦晚点就赶不上，请自行留足时间。' : null,
      overnight(c) ? '本方案含**过夜**（跨天到达），请备好过夜用品与餐食。' : null,
      !Number.isFinite(c.cost) ? '**票价为参考价 / 待定，非当日实价**，以出票页为准。' : null,
      c.note || null,
    ].filter(Boolean);
    const planOf = (c) => ({
      title: c.name,
      subtitle: `${hm(c.durationMin)}${c.arriveAt ? ' · 到 ' + clock(c.arriveAt) : ''}`,
      // 价格带票种（席别/舱位）：技能硬性要求「价格必须标明票种」，A4/A2 门禁会拦
      price: Number.isFinite(c.cost)
        ? `**${seatKindOf(c) || '票价'} ¥${c.cost} / 人**`
        : '**票价待定，以出票页为准**',
      ...(c.note ? { badge: c.note } : {}),
      steps: (Array.isArray(c.legs) && c.legs.length)
        ? c.legs.map(stepOf)
        : [{ time: '—', place: '—', desc: '（该候选没有 legs，请按实际补写逐段信息）' }],
      costRows: rowsOf(c),
      footnotes: footnotesOf(c),
    });
    const seq = [];
    const push = (c, tag) => { if (c && !seq.some(x => x.c === c)) seq.push({ c, tag }); };
    push(cheapest, '最省钱'); push(fastest, '最快'); extra.forEach(c => push(c, '额外'));
    // 额外方案不足 2 个：技能要求「给不满必须在注脚里写明原因」。
    // ⚠ 这条**必须由代码写出来**：否则 --emit-data 的产物会被 A4 门禁拒绝生成，
    // 而执行者只看到一条"extra.plans 只有 N 个（要求 ≥2）"，还得自己猜该往哪写（实测踩过）。
    const extraShortNote = extra.length >= 2 ? null
      : `本次可给出的额外方案只有 ${extra.length} 个（技能目标 ≥2）——原因是**本次查询到的可行候选本身就只有这么多**：`
        + `无票 / 余票不足 / 班次太少 / 窗口内无可选班次，故不凑数（不编造方案）。`;
    const data = {
      coverTitle: `${meta.route || '路线'} 交通方案`,
      coverSubtitle: `出行日期 ${meta.date || '（补写）'}　出发时间窗口 ${meta.window || '不限'}　${meta.pax || 1} 人`,
      coverCards: [
        ['出发 / 到达', meta.route || '（补写）', '按「方案终点」口径算到到达站 / 落地机场'],
        ['出行日期', meta.date || '（补写）', '余票与票价为查询日数据，出行前请复核'],
        ['出行人数', `${meta.pax || 1} 人`, '各方案余票均已按此人数校验'],
        ['最省钱', Number.isFinite(cheapest.cost) ? `¥${cheapest.cost} / 人` : '票价待定', `${hm(cheapest.durationMin)}${cheapest.arriveAt ? '，到 ' + clock(cheapest.arriveAt) : ''}`],
        ['最快', `${hm(fastest.durationMin)}`, Number.isFinite(fastest.cost) ? `¥${fastest.cost} / 人` : '票价待定'],
      ],
      coverNote: `本页只提供交通路线，不含景点与游玩安排。共 ${seq.length} 个方案：最省钱 ${hm(cheapest.durationMin)}${Number.isFinite(cheapest.cost) ? '（¥' + cheapest.cost + '/人）' : ''}，最快 ${hm(fastest.durationMin)}${fastest.arriveAt ? '（' + clock(fastest.arriveAt) + ' 到）' : ''}${seq.some(({ c }) => overnight(c)) ? '；含过夜的方案已单独标注' : ''}。总耗时与总费用均含出发端接驳与换乘 / 候机时间；余票与票价为查询日数据，出行前请以购票页为准。`,
      overview: {
        title: '决策速览',
        subtitle: `${seq.length} 个方案横向对比`,
        rows: [
          ['方案', '总费用（人均）', '总耗时', '到达时刻与窗口命中'],
          ...seq.map(({ c, tag }) => [
            `${tag} · ${c.name}`,
            Number.isFinite(c.cost) ? `¥${c.cost}` : '票价待定',
            hm(c.durationMin),
            `${c.arriveAt ? clock(c.arriveAt) + ' 到' : '—'}${c.windowHit ? '（' + c.windowHit + '）' : ''}`,
          ]),
        ],
        footnotes: [
          '价格均为人民币元；铁路按席别标价，均为人均价。',
          '总耗时口径：从出发地出发（含去车站 / 去机场的接驳与起飞前候机缓冲）→ 候车候机 → 运行（含换乘与等待）→ 算到到达站 / 落地机场为止。',
          `余票为查询日（${meta.date || '查询日'}）数据，出行前请以购票页实时余票为准。`,
          ...(seq.some(({ c }) => !Number.isFinite(c.cost)) ? ['含机票的方案票价为**查询当日所见的参考价（已计入"最省钱"比价）**，含机建 + 燃油，以出票页为准；票价待定（无数字）者不参与比价。'] : []),
          ...(extraShortNote ? [extraShortNote] : []),
        ],
      },
      cheapest: { title: '最省钱方案', subtitle: `${hm(cheapest.durationMin)} · ${Number.isFinite(cheapest.cost) ? '¥' + cheapest.cost + ' / 人' : '票价待定'}`, plans: [planOf(cheapest)] },
      fastest: planOf(fastest),
      ...(extra.length ? { extra: { title: '额外方案', plans: extra.map(planOf) } } : {}),
    };
    try {
      ensureDir(emitData); fs.writeFileSync(emitData, JSON.stringify(data, null, 2), 'utf8');
      L.push('');
      L.push(`已写出 ${emitData}（make_html 的 data.json 骨架：价格、总耗时、逐段明细、总览表都是**代码算的**）。`);
      // ⚠ 票种缺失要在**写出的这一刻**点名（2026-09-26 A/B 实测）：否则产物到 make_html 才被 A2 拒，
      //   执行者只能回头改数据重生成。这里点名，改一条 leg 的 seat 即可，最便宜。
      const noSeat = seq.map(x => x.c).filter(c => !(Array.isArray(c.legs) && c.legs.length && c.legs.every(l => l && String(l.seat || '').trim())));
      if (noSeat.length) {
        L.push('');
        L.push(`⚠ **${noSeat.length} 个候选的 legs 没写全 \`seat\`（票种）**——上面的价格里会出现"{票种} 待补"或被 A2 门禁拒：`);
        noSeat.forEach(c => L.push(`  - ${c.name}  →  当前价：${planOf(c).price}`));
        L.push('  → **回 options.json 给每条腿补 `"seat"` 再跑一遍**（G/C/D 写 二等座/一等座；普速写 硬座/硬卧/软卧；航空写 经济舱）');
        L.push('  → 只把票种写在候选名里不够：**腿自身的 seat 才是价格明细的依据**。');
      }
      L.push('  → 你只需补 `coverNote` 与各处 `footnotes` 的文案，**不要改任何数字**；再跑：');
      L.push(`     node scripts/make_html.js plan ${emitData} <起点>到<终点>交通方案.html --check`);
    } catch (e) { console.error('写出 data.json 失败: ' + e.message); process.exit(1); }
  }

  process.stdout.write(L.join('\n') + '\n');
  process.exit(0);
}

// ── 候选装配（把 rank 的输入交给代码算）────────────────────────────────
// 为什么要有：SKILL.md 要求把候选整理成带 cost / durationMin / arriveAt 的 JSON 再交给
// rank，但从前**没有工具生成它**。实测执行者只能现写一个 gen_candidates.js，反复改 4 遍——
// 临时代码的源码全留在上下文里，比让它思考还贵。
// 本模式只做机械活：按 legs 求和票价、按首段发车到末段到达算总耗时、推到达时刻，
// 并顺带校验相邻两段的衔接预留（口径见「换乘时间规则」：一律看到站后余量；异站须给 transferMin）。
function parseDateTime(s) {
  const t = String(s == null ? '' : s).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(t);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, min: (+m[4]) * 60 + (+m[5]), hasDate: true };
  m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m) return { date: null, min: (+m[1]) * 60 + (+m[2]), hasDate: false };
  return null;
}
// 日期 → 天序号。**必须是相对最早日期的真实天差**（不能按"出现顺序"编号）：
// 实测踩过——10-01 出发、10-03 到达的组合一度被算成 35h40（少 24h），因为 10-03 只是"第 2 个出现的日期"。
const dateIdx = (map, d) => {
  if (!map.has(d)) {
    const first = map.size ? [...map.keys()][0] : d;
    const off = Math.round((new Date(d + 'T00:00:00') - new Date(first + 'T00:00:00')) / 86400000);
    map.set(d, off);
  }
  return map.get(d);
};

function candidatesMain(file, outFile) {
  if (!file) { console.error('用法: node scripts/plan.js candidates <options.json> [--out <candidates.json>]（--help 看完整说明）'); process.exit(1); }
  if (!fs.existsSync(file)) { console.error('文件不存在: ' + file); process.exit(1); }
  let opts;
  try { opts = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error('JSON 解析失败: ' + e.message); process.exit(1); }
  if (!Array.isArray(opts) || !opts.length) { console.error('options 必须是非空数组'); process.exit(1); }

  const dayMap = new Map();
  const out = [], warn = [];
  opts.forEach((o, oi) => { const r = buildOption(o, oi, dayMap); out.push(r.rec); warn.push(...r.warns); });
  emitCandidates(out, warn, outFile);
}

// 把一个候选的各段事实算成 rank 需要的 {cost, durationMin, arriveAt}
// （candidates 模式与 compose 模式共用；口径 = SKILL.md「总耗时口径」「换乘时间规则」）
function buildOption(o, oi, dayMap) {
  const warn = [];
  const bad = [];
  const crossNotes = [];
  const tight = [];                                     // 余量 20–29 分：可行但必须标红警告客户
  const tag = o && o.name ? `「${o.name}」` : `第 ${oi + 1} 项`;
  const legs = Array.isArray(o && o.legs) ? o.legs : [];
  if (!legs.length) { console.error(`${tag} 缺 legs（至少一段：{from,dep,to,arr,cost}）`); process.exit(1); }
  // 联程判据（候选级或任一段级写了 throughCheckin 即算）——既要用于本次校验，也要落到记录上给 rank 用。
  const throughCheckinAny = !!o.throughCheckin || legs.some(l => !!(l && l.throughCheckin));
  let cost = 0, costKnown = true, firstAbs = null, lastAbs = null, curDay = null, curMin = -1;
    legs.forEach((leg, li) => {
      const dep = parseDateTime(leg.dep), arr = parseDateTime(leg.arr);
      if (!dep || !arr) { console.error(`${tag} 第 ${li + 1} 段的时刻读不出：dep=${JSON.stringify(leg.dep)} arr=${JSON.stringify(leg.arr)}（用 "HH:MM" 或 "YYYY-MM-DD HH:MM"）`); process.exit(1); }
      const dDay = dep.hasDate ? dateIdx(dayMap, dep.date) : (curDay === null ? 0 : curDay + (dep.min < curMin ? 1 : 0));
      const aDay = arr.hasDate ? dateIdx(dayMap, arr.date) : dDay + (arr.min < dep.min ? 1 : 0);
      const depAbs = dDay * 1440 + dep.min, arrAbs = aDay * 1440 + arr.min;
      if (firstAbs === null) firstAbs = depAbs;
      lastAbs = arrAbs; curDay = aDay; curMin = arr.min;
      if (Number.isFinite(leg.cost)) cost += leg.cost; else costKnown = false;
      // 顺带校衔接预留：铁路走「换乘时间规则」，空中走 air-fallback 的「中转时间校验」
      const nx = legs[li + 1];
      // kind 取值与上面 kindCn 同源：空中 / 航空 / 航班 / air / flight / plane 都算空中
      const isAir = /空中|航空|航班|air|flight|plane/i.test(String(o.kind || ''));
      if (nx) {
        const nDep = parseDateTime(nx.dep);
        const nDay = nDep && nDep.hasDate ? dateIdx(dayMap, nDep.date) : aDay + (nDep && nDep.min < arr.min ? 1 : 0);
        const gap = (nDay * 1440 + (nDep ? nDep.min : 0)) - arrAbs;
        const same = String(leg.to || '').trim() === String(nx.from || '').trim();
        // 空中段有**自己**的门槛（references/air-fallback.md「中转时间校验」，2026-10-07 收束为一条）：
        // ① 平台给出的联程 / 中转组合 → 衔接由航司安排并担保，**不做任何时间校验**（写 throughCheckin 即放行）；
        // ② 其余航空衔接（非同机场转场等）→ **必须在下一段起飞前 1.5 小时（90 分）到达下一段所在机场**，
        //    即「到站后余量（扣掉机场间转场）≥ 90 分」；不足即排除。
        // 从前这里整段跳过（`if (nx && !isAir)`，理由是"空中不适用铁路门槛"）——理由对、做法错：
        // 空中另有一套门槛，跳过等于**谁都不管**。实测第三轮 A/B：A 把"武汉跨航司只留 65 分"的方案
        // 封成了最省钱+最快（它自己在正文里标了风险，但归位照旧）。
        const isFlight = (c) => /^[A-Z0-9]{2}\d{2,4}$/i.test(String(c || '').trim());
        // **只有两段都是航班**才算"航空中转"：`机场快线 → 航班` 是地面接驳，套跨航司门槛会误杀
        // （实测：机场快线 09:00 到、航班 09:30 起飞，被误判成"跨航司仅 0h30"）。
        const bothFlights = isFlight(leg.code) && isFlight(nx.code);
        // 空中衔接：**判据只有一个声明位**（不再按航班号前缀猜航司）。
        //   · 平台组合（同机场 / 一次出票 / 行李直挂）→ **不做任何时间校验**：
        //     衔接是航司安排并担保的，赶不上由航司改签（飞猪/携程给的中转组合即属此类）。
        //   · **非同机场转机是唯一例外**（用户 2026-10-07 定）：旅客要自己转场，**即使标了联程
        //     也照样按 90 分判**（= 下一段起飞前 1.5 小时到达下一段机场，含机场间转场耗时）。
        const through = throughCheckinAny;
        const airWhere = same ? '同机场' : '不同机场';
        const airRule = isAir && bothFlights && !same;                  // 极罕见：非同机场（须自己转场）→ 恒按 90 分
        const airSameNoFlag = isAir && bothFlights && same && !through; // 同机场未标联程 → 只提示，不拦
        const groundToAir = !isFlight(leg.code) && isFlight(nx.code);   // 地面腿 → 航班：要留 1.5h 缓冲
        // 地面衔接门槛一律 30 分钟（**与站是否同一个无关**，新口径 2026-09-26）：
        // 从前写成 `same ? 30 : 120`，于是异站衔接的提示语会印出"未达 120 分钟门槛"，
        // 与实际判定（<20 不可行 / 20–29 偏紧 / ≥30 合格）自相矛盾。
        const need = (airRule || groundToAir) ? 90 : 30;              // 90 分 = 起飞前 1.5 小时到达该机场
        // 新口径（2026-09-26 定）：**不再按"异站 ≥2 小时"**，一律看"**到站后**离发车还有多久"。
        // 到站时刻 = 上一段到达 + 接驳耗时（接驳耗时由执行者估算；打车允许，但费用要计入总价）。
        // 余量 ≥30 分合格；20–29 分**可行但必须标红警告客户**；<20 分不可行。
        let transferMin = 0, transferUnknown = false;
        if (!same) {
          // `transferMin` = 「从上一段到站 → 本段发车」所需的接驳分钟数。
          // ⚠ 它**写在"后一段"上**（也就是本段 nx）；但实测（第二轮 A/B）执行者常挂到"前一段"上，
          //   而旧报错只说"在该段写"，没说哪一段 → 白跑一轮 candidates。现在**两边都认**（前一段优先读后一段），
          //   从根上消掉这个歧义；文档与报错文案同时写明"规范写法是写在后一段"。
          const pick = [nx.transferMin, leg.transferMin].find(Number.isFinite);
          if (Number.isFinite(pick)) transferMin = pick;
          else transferUnknown = true;                    // 异站 / 异机场却没给接驳 → 数据不全，不许拿"2 小时"糊过去
        }
        const slack = gap - transferMin;                   // 到站之后的余量
        if (gap < 0) {
          // 实测踩过：负余量曾被格式化成 "-1h-18"（Math.floor(-18/60) = -1、-18%60 = -18），
          // 执行者读成"1 小时 18 分"，误判成"脚本跨天算错"，还据此改掉了本来可行的方案。
          // **时刻倒挂 = 数据写错**，必须与"换乘太紧"分开说，且要给出可执行的补救指令。
          bad.push(`第 ${li + 1}→${li + 2} 段**时刻倒挂**：上一段 ${leg.to || '?'} 到达 ${leg.arr} 之后，下一段却写 ${nx.dep} 发车（早 ${-gap} 分钟）——**这是时刻写错，不是换乘太紧**；请先把两段时刻改成自洽的再交回来。`);
        } else if (transferUnknown) {
          bad.push(airRule
            ? `第 ${li + 1}→${li + 2} 段：${airWhere}转机（到 ${leg.to || '?'}、下一段从 ${nx.from || '?'} 起飞）**没给机场间转场耗时**——请在第 ${li + 2} 段写 \`transferMin\` = 机场间转场分钟数（含出站 / 转场 / 再进站）；**非同机场转机必须给**。`
            : `第 ${li + 1}→${li + 2} 段：上一段到 ${leg.to || '?'}、下一段从 ${nx.from || '?'} 发车，**两者不同站却没给接驳**——请补一段接驳腿（地铁 / 城际 / 公交 / 打车，含耗时与费用），或写 \`transferMin\`（= 从上一段到站到本段发车所需的接驳分钟数，**规范写法：写在后一段上**，即第 ${li + 2} 段）；**不许按"同城异站就算够 2 小时"直接放行**。`);
        } else if (airRule && slack < need) {
          bad.push(`第 ${li + 1}→${li + 2} 段：${airWhere}中转到站后余量仅 ${gapTxt(slack)}（时间差 ${gapTxt(gap)}${transferMin ? `，机场间转场 ${transferMin} 分` : ''}），未达 **90 分**门槛 = **起飞前 1.5 小时到达下一段机场**——**非同机场转机必须满足这条**（极罕见情形：先尽量换平台给的同机场方案），该组合应排除：换更晚的下一段，或改走同机场衔接。`);
        } else if (airSameNoFlag) {
          // 同机场两段航班 = 平台组合（平台给的转机基本必然同机场）→ **不做时间校验**，只留一条提示
          crossNotes.push(`同机场转机 ${leg.code || ''}→${nx.code || ''} 衔接 ${gapTxt(gap)}——**按平台组合处理、不做时间校验**；若这是自行拼的两段票，按「不自行拼段」不要采用（平台组合建议标 \`throughCheckin: true\` 留痕）`);
        } else if (groundToAir && slack < need) {
          bad.push(`第 ${li + 1}→${li + 2} 段：到机场后余量仅 ${gapTxt(slack)}${transferMin ? `（时间差 ${gapTxt(gap)}，接驳 ${transferMin} 分）` : ''}，**未达 90 分** = **起飞前 1.5 小时到达机场**（值机 / 安检缓冲）——该衔接不可行：把前一段提前，或换更晚的航班。`);
        } else if (through && bothFlights) {
          // 联程：不做时间校验，但要把这件事写出来（客户与页面都该知道"衔接由航司担保"）
          crossNotes.push(`联程中转 ${leg.code || ''}→${nx.code || ''}（平台组合、一次出票、行李直挂）衔接 ${gapTxt(gap)}——**航司已安排，不做时间校验**`);
        } else if (slack < 20) {
          // 负余量**不要**印成 "-0h13"（第 1 轮曾印 "-1h-18"，被读成"1 小时 18 分"）——直接说人话
          const why = slack < 0
            ? `**接驳耗时都补不回来**：两段时间差只有 ${gapTxt(gap)}，而接驳本身要 ${transferMin} 分钟（**晚 ${-slack} 分钟**）`
            : `到站后只剩 ${gapTxt(slack)}`;
          bad.push(`第 ${li + 1}→${li + 2} 段：${why}，**低于 20 分钟底限**，不可行（换乘时间规则）`);
        } else if (slack < 30) {
          // 20–29 分：可行但偏紧 → 必须在页面与聊天标红警告客户
          tight.push(`第 ${li + 1}→${li + 2} 段：到站后仅剩 ${gapTxt(slack)}（≥20 分但不足 30 分）——**偏紧，必须在页面与聊天标红警告客户**：前段一旦晚点就赶不上`);
        } else if (!same) {
          // 异站衔接**通过了也要写出来**：从前只有"不达标"才打印，于是"上一段到广州南、下一段从深圳东发"
          // 这种**跨城断链**（中间根本没腿）会静默通过——代码分不清"同城异站"与"不同城"（站表没有城市字段，
          // 拼音前缀也不行：武汉=wuhan / 武昌=wuchang 是同城却是不同前缀）。所以只陈述事实，由执行者判断。
          crossNotes.push(airRule
            ? `空中衔接 ${leg.to} → ${nx.from} 是**不同机场**（已按"起飞前 1.5 小时到机场"即 ${need} 分门槛校验，转场 ${transferMin} 分，余 ${gapTxt(slack)}）`
            : `异站衔接 ${leg.to} → ${nx.from}（按到站后余量 ${need} 分钟校验，接驳 ${transferMin} 分，余 ${gapTxt(slack)}）`);
        }
      }
    });
    if (Number.isFinite(o.extraCost)) cost += o.extraCost;
    const lastLeg = legs[legs.length - 1];
    const lastArr = parseDateTime(lastLeg.arr);
    const startDate = [...dayMap.keys()][0] || null;
    const lastDayIdx = Math.max(...dayMap.values());
    let arriveAt = lastArr ? (lastArr.hasDate ? `${lastArr.date}T${String(Math.floor(lastArr.min / 60)).padStart(2, '0')}:${String(lastArr.min % 60).padStart(2, '0')}` : null) : null;
    if (!arriveAt && startDate && lastArr) {
      // 用首段日期 + 天偏移推出到达日期
      const d = new Date(`${startDate}T00:00:00`);
      d.setDate(d.getDate() + lastDayIdx);
      arriveAt = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(Math.floor(lastArr.min / 60)).padStart(2, '0')}:${String(lastArr.min % 60).padStart(2, '0')}`;
    }
    return {
      rec: {
        name: o.name || `方案${oi + 1}`,
        cost: costKnown ? Math.round(cost * 10) / 10 : null,
        durationMin: lastAbs - firstAbs,
        ...(arriveAt ? { arriveAt } : {}),
        ...(o.windowHit ? { windowHit: o.windowHit } : {}),
        ...(o.kind ? { kind: o.kind } : {}),
        // 异站衔接与"余量偏紧"都写进 note：rank 原样打印，页面也照抄，客户与执行者都看得到
        ...(() => { const n = [String(o.note || '').replace(/[。；;]\s*$/, ''), crossNotes.join('；'), tight.map(t => '⚠ ' + t).join('；')].filter(Boolean).join('；'); return n ? { note: n } : {}; })(),
        // 逐段明细留给 rank：`--emit-data` 要靠它生成页面里的 steps / costRows（省掉"手抄一遍"）
        ...(Array.isArray(o.legs) ? { legs: o.legs } : {}),
        ...(tight.length ? { tight } : {}),
        // ⚠ 联程豁免**必须落到记录上**：buildOption 已经按 `throughCheckin` 判过一次（平台联程不做时间校验），
        // 但 rank 会**从 legs 再校验一遍**——若这里不把豁免状态传出，rank 就会把合法的联程中转判成
        // "未达 90 分钟门槛"而**排除掉**，于是 candidates 说可行、rank 说不可行（实测踩过）。
        // 判据同 buildOption：候选级或任一段级写了 throughCheckin 即为联程。
        ...((throughCheckinAny) ? { throughCheckin: true } : {}),
        // 不可行信号**必须进 JSON**：否则 rank 无从判断，会把时刻倒挂的方案封成"最省钱"
        ...(bad.length ? { feasible: false, infeasible: bad } : {}),
      },
      warns: warn,
      bad,
    };
}

// 打印 +（可选）落盘候选，作为 rank 的输入；quiet = 调用方已经自己打印过列表（compose 用）
function emitCandidates(out, warn, outFile, quiet) {
  const noDate = out.filter(c => !c.arriveAt);
  const L = [];
  if (!quiet) {
    L.push(`# 候选装配（${out.length} 个）`);
    out.forEach(c => L.push(`  ${c.name}  ${Number.isFinite(c.cost) ? '¥' + c.cost : '票价未定'}  ${Math.floor(c.durationMin / 60)}h${String(c.durationMin % 60).padStart(2, '0')}  ${c.arriveAt ? '到 ' + c.arriveAt : '**到达时刻缺日期**'}`));
  }
  if (warn.length) { L.push(''); L.push('⚠ 换乘预留不达标（按「换乘时间规则」这些组合不可行）：'); warn.forEach(w => L.push('  - ' + w)); }
  const tightOnes = out.filter(c => Array.isArray(c.tight) && c.tight.length);
  if (tightOnes.length) {
    L.push('');
    L.push(`⚠ ${tightOnes.length} 个候选换乘**偏紧（到站后 20–29 分）**——可行，但**必须在页面与聊天里标红警告客户**：`);
    tightOnes.forEach(c => { L.push(`  - ${c.name}`); c.tight.forEach(x => L.push(`      ${x}`)); });
  }
  const bad = out.filter(c => c.feasible === false);
  if (bad.length) {
    L.push('');
    L.push(`⚠ **${bad.length} 个候选不可行**——已写进 JSON 的 \`feasible:false\`，**rank 会排除它们、不会拿去当最省钱/最快**：`);
    bad.forEach(c => { L.push(`  - ${c.name}`); (c.infeasible || []).forEach(x => L.push(`      ${x}`)); });
  }
  if (noDate.length) { L.push(''); L.push(`⚠ ${noDate.length} 个候选推不出带日期的到达时刻——跨天行程请把时刻写全（"YYYY-MM-DD HH:MM"），否则 rank --arrive-by 会拒收。`); }
  // ⚠ 票种缺失**必须在这里就说**（2026-09-26 A/B 实测）：手写 options.json 的腿不写 `seat` 时，
  //   `rank --emit-data` 会产出 `**票价 ¥430 / 人**` 与裸金额明细行 → 直到 `make_html.js` 才被 A2 门禁拒，
  //   那时执行者只能回头改数据重生成（一次白跑的生成 + 若干 edit）。在这里点名，改 leg 就行，最便宜。
  const noSeat = out.filter(c => !(Array.isArray(c.legs) && c.legs.length && c.legs.every(l => l && String(l.seat || '').trim())));
  if (noSeat.length) {
    L.push('');
    L.push(`⚠ **${noSeat.length} 个候选的 legs 没写全 \`seat\`（票种）**——\`rank --emit-data\` 会给不出票种的价格，` +
      `然后被 A2 门禁拒（"报价未标明票种"）：`);
    noSeat.forEach(c => L.push(`  - ${c.name}`));
    L.push('  → **改 options.json：给每条腿补 `"seat"`**（G/C/D 写 二等座/一等座；普速写 硬座/硬卧/软卧；航空写 经济舱；接驳写 打车/地铁时不写也可）');
    L.push('  → 票种只写在候选名里不够（如"拼票：二等座 1 张 + 一等座 1 张"），**腿自身的 seat 才是价格明细的依据**。');
  }
  if (!quiet) L.push('');
  L.push(outFile ? `已写出 ${outFile} → 下一步：node scripts/plan.js rank ${outFile} --arrive-by <客户要求的到达日>` : '（加 --out <文件> 可直接落盘，交给 rank）');
  process.stdout.write(L.join('\n') + '\n');
  if (outFile) { try { ensureDir(outFile); fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8'); } catch (e) { console.error('写出失败: ' + e.message); process.exit(1); } }
  process.exit(0);
}

// ── 时间窗口（口径 = SKILL.md「时间窗口规则」；screen 与 compose 共用）────
//   指定 T  → 优先 T～T+1h，放宽 T～T+2h
//   未指定  → 单一窗口 08:00–10:00（可用 --from/--to 覆盖）
function makeWindow(opt) {
  let priFrom, priTo, wideTo, singleWindow = false;
  if (opt.at) {
    const t = toMin(opt.at);
    if (t === null) { console.error('--at 需为 HH:MM'); process.exit(1); }
    priFrom = t; priTo = Math.min(24 * 60 - 1, t + 60); wideTo = Math.min(24 * 60 - 1, t + 120);
  } else {
    priFrom = toMin(opt.from || '08:00');
    priTo = opt.to ? toMin(opt.to) : toMin('10:00');
    wideTo = priTo;
    singleWindow = true;
    if (priFrom === null || priTo === null) { console.error('--from/--to 需为 HH:MM'); process.exit(1); }
  }
  const hit = (m) => {
    if (m === null) return '窗口外';
    if (m < priFrom) return '窗口外';
    if (m <= priTo) return singleWindow ? '窗口内' : '优先';
    return m <= wideTo ? '放宽' : '窗口外';
  };
  const txt = singleWindow ? `窗口 ${fmt(priFrom)}–${fmt(priTo)}` : `优先 ${fmt(priFrom)}–${fmt(priTo)}，放宽至 ${fmt(wideTo)}`;
  return { hit, txt, priFrom, priTo, wideTo, singleWindow };
}

// ── 拼链（把"逐腿查完自己拼组合"交给代码）──────────────────────────────
// 为什么要有：SKILL.md 要求"自己枚举枢纽逐腿拼"，但实测执行者会**枚举出一堆腿却拼不出组合**
// （真实踩过：试了 深圳北→深圳东 换乘 4 分钟就整条放弃，从没试过"地铁衔接 + 异站 2 小时"那条）。
// 输入 = 每条腿一个 brief 格式文件（`12306.js tickets --brief` 的输出；非铁路腿可手写同格式）；
// 输出 = 可行组合（含成本 / 总耗时 / 到达时刻 / 换乘余量）写成 candidates.json，交给 rank 归位。
function composeMain(files, opt) {
  if (!files.length) { console.error('用法: node scripts/plan.js compose <腿1.txt> <腿2.txt> [...] [--pax N] [--at HH:MM] [--arrive-by <日期>] [--max N] [--out <candidates.json>]（--help 看完整说明）'); process.exit(1); }
  const pax = opt.pax;
  const briefs = files.map(f => {
    if (!fs.existsSync(f)) { console.error('文件不存在: ' + f); process.exit(1); }
    return { file: f, ...parseBrief(f) };
  });
  if (!briefs[0].date) { console.error(`第 1 条腿（${briefs[0].file}）的头行读不出日期：\n  ${briefs[0].head || '(没有 # 开头的头行)'}\n需要形如「# 汕头 → 深圳北  2026-10-01」的头行。`); process.exit(1); }
  const base = new Date(`${briefs[0].date}T00:00:00`);
  if (Number.isNaN(base.getTime())) { console.error(`第 1 条腿的日期读不出：${briefs[0].date}`); process.exit(1); }
  const dayDiff = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); if (!m) return null; const d = new Date(+m[1], +m[2] - 1, +m[3]); return Number.isNaN(d.getTime()) ? null : Math.round((d - base) / 86400000); };
  const pad = (n) => String(n).padStart(2, '0');
  const absToDT = (abs) => {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() + Math.floor(abs / 1440));
    const mm = ((abs % 1440) + 1440) % 1440;
    d.setHours(Math.floor(mm / 60), mm % 60, 0, 0);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(Math.floor(mm / 60))}:${pad(mm % 60)}`;
  };
  const hh = (m) => `${Math.floor(m / 60)}h${pad(Math.round(m % 60))}`;

  // 逐腿：只留"人数够 + 有票"的车次（席别裁决口径 = decide()），并把时刻换算成绝对分钟（第 1 腿日期 = 第 0 天）
  const legs = [], chainWarn = [], stat = [];
  briefs.forEach((b, i) => {
    if (!b.trains.length) { console.error(`第 ${i + 1} 条腿（${b.file}）没解析出任何车次；前几行：\n` + b.raw.slice(0, 3).join('\n')); process.exit(1); }
    const off = dayDiff(b.date);
    if (off === null) { console.error(`第 ${i + 1} 条腿（${b.file}）的头行缺日期，推不出到达日：\n  ${b.head || '(没有 # 开头的头行)'}`); process.exit(1); }
    if (off < 0) { console.error(`第 ${i + 1} 条腿（${b.file}）的日期 ${b.date} 早于第 1 条腿的 ${briefs[0].date}——腿必须按时间先后排列。`); process.exit(1); }
    const items = [];
    for (const t of b.trains) {
      if (t.startMin === null || t.endMin === null) continue;
      const d = decide(t, pax);
      if (!d.ok) continue;
      items.push({ t, code: t.code, from: t.from || b.from, to: t.to || b.to, depAbs: off * 1440 + t.startMin, arrAbs: off * 1440 + t.endMin, price: d.price, seat: d.seat, tickets: d.tickets });
    }
    items.sort((a, b2) => a.depAbs - b2.depAbs || a.arrAbs - b2.arrAbs);
    legs.push(items.filter((x, k) => k === 0 || x.depAbs !== items[k - 1].depAbs || x.code !== items[k - 1].code));
    stat.push(`第${i + 1}腿 ${b.from || '?'}→${b.to || '?'} 可用 ${items.length}/${b.trains.length}`);
    if (i) { const p = briefs[i - 1]; if (String(p.to || '').trim() !== String(b.from || '').trim()) chainWarn.push(`第 ${i}→${i + 1} 腿：${p.to || '?'} → ${b.from || '?'} 不是同一站（按异站衔接处理——须给接驳耗时 transferMin，或补一段接驳腿）`); }
  });
  const emptyLeg = legs.findIndex(l => !l.length);
  if (emptyLeg >= 0) {
    console.error(`拼不出组合：第 ${emptyLeg + 1} 条腿（${briefs[emptyLeg].file}）里没有"人数够且有票"的车次。`);
    console.error('  ' + stat.join('\n  '));
    console.error(`  → 换枢纽重查这一腿，或改用别的枢纽（改日期也可能有票）。`);
    process.exit(2);
  }

  // 组合枚举：按**到站后余量**剪枝（底限 20 分；细致判定交给 buildOption）；超出到达日 1 天以上的直接剪掉
  const win = makeWindow(opt);
  const deadline = opt.arriveBy ? parseLocal(opt.arriveBy) : null;
  if (opt.arriveBy && !deadline) { console.error('--arrive-by 需为 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM'); process.exit(1); }
  const deadlineMin = deadline ? Math.round((deadline - base) / 60000) : null;
  const lateLimit = deadlineMin === null ? null : deadlineMin + 1440;
  // 乐观下界：从第 i 腿起（含）最少还要多久才到（各腿最短历时 + 每次换乘 30 分），用于剪枝
  const minRest = new Array(legs.length + 1).fill(0);
  for (let i = legs.length - 1; i >= 0; i--) {
    const md = Math.min(...legs[i].map(x => x.t.durMin === null ? 0 : x.t.durMin));
    minRest[i] = minRest[i + 1] + md + (i < legs.length - 1 ? 30 : 0);
  }
  const MAXNODES = 400000, MAXRES = 20000;
  const res = [];
  let nodes = 0, truncated = false;
  const walk = (i, chosen, firstDep, prevArr, prevTo, cost) => {
    if (res.length >= MAXRES || nodes > MAXNODES) { truncated = true; return; }
    if (i === legs.length) { res.push({ chain: chosen.slice(), cost, dur: prevArr - firstDep, arrAbs: prevArr, firstStart: ((firstDep % 1440) + 1440) % 1440 }); return; }
    for (const it of legs[i]) {
      nodes++;
      if (i === 0) {
        if (lateLimit !== null && it.arrAbs + minRest[1] > lateLimit) continue;
      } else {
        // 枚举阶段的**宽松下界**：不能按"异站 ≥2 小时"硬剪——
        // 新口径（2026-09-26）下异站只要给了接驳耗时、到站后余量 ≥30 分就合格。
        // 这里按 20 分钟底限剪枝（真正余量 <20 分才不可行），细致判定交给 buildOption。
        // 若在此处按 120 分钟剪，会把"跨市地铁接驳 + 余量 40 分"这类完全可行的组合直接剪没。
        if (it.depAbs - prevArr < 20) continue;
        if (lateLimit !== null && it.arrAbs + minRest[i + 1] > lateLimit) continue;
      }
      chosen.push(it);
      walk(i + 1, chosen, i === 0 ? it.depAbs : firstDep, it.arrAbs, it.to, cost + (Number.isFinite(it.price) ? it.price : 0));
      chosen.pop();
    }
  };
  walk(0, [], 0, 0, null, 0);

  const inWin = res.filter(r => win.hit(r.firstStart) !== '窗口外');
  // 同价同到点的组合只留一个：留**换乘余量最大**的那个（更抗晚点）。
  // 实测踩过：23 个组合里 6 个是"只差深圳北坐哪班地铁"的同价同时刻组合，白白占掉展示位。
  const minSlack = (r) => { let m = Infinity; for (let k = 1; k < r.chain.length; k++) m = Math.min(m, r.chain[k].depAbs - r.chain[k - 1].arrAbs); return m; };
  const dedupe = (list) => {
    const best = new Map();
    for (const r of list) {
      const k = `${r.cost}|${r.dur}|${r.arrAbs}`;
      const s = minSlack(r);
      if (!best.has(k) || best.get(k).slack < s) best.set(k, { r, slack: s });
    }
    return [...best.values()].map(x => x.r);
  };
  const pool = dedupe(inWin.length ? inWin : res);
  const isLate = (r) => deadlineMin !== null && r.arrAbs > deadlineMin;
  const onTime = pool.filter(r => !isLate(r));
  const late = pool.filter(isLate);
  const max = Number.isFinite(opt.max) && opt.max > 0 ? opt.max : 6;
  const picked = [], seen = new Set(), perCost = new Map();
  const keyOf = (r) => r.chain.map(x => x.code + '@' + x.depAbs).join('|');
  // 同一票价的组合最多给 2 个：中国高铁同线二等座常是**一价到底**，不设上限时 6 个展示位会被
  // 6 个几乎一样的组合占满（实测踩过：宁德→东莞 借道链 6 个组合全是 ¥392）。
  const add = (r) => {
    if (picked.length >= max) return;
    const k = keyOf(r);
    if (seen.has(k)) return;
    const c = perCost.get(r.cost) || 0;
    if (c >= 2) return;
    seen.add(k);
    perCost.set(r.cost, c + 1);
    picked.push(r);
  };
  const byPrice = (a, b) => (a.cost - b.cost) || (a.dur - b.dur);
  const byDur = (a, b) => (a.dur - b.dur) || (a.cost - b.cost);
  onTime.slice().sort(byPrice).slice(0, 3).forEach(add);
  onTime.slice().sort(byDur).slice(0, 3).forEach(add);
  onTime.slice().sort(byPrice).forEach(add);
  late.slice().sort(byPrice).forEach(add);          // 超到达日的只作补位，rank 会给它标 ⚠

  const dayMap = new Map();
  const opts2 = picked.map((r, idx) => {
    const stops = r.chain.slice(0, -1).map(x => x.to).filter(Boolean);
    const gaps = [];
    for (let k = 1; k < r.chain.length; k++) {
      const a = r.chain[k - 1], b2 = r.chain[k];
      const g = b2.depAbs - a.arrAbs;
      gaps.push(`换乘 ${a.to} ${String(a.to || '').trim() === String(b2.from || '').trim() ? '同站' : '异站'} ${hh(g)}`);
    }
    const note = [gaps.join('；'), isLate(r) ? `⚠ 超出到达日（${absToDT(r.arrAbs)} 才到）` : ''].filter(Boolean).join('；');
    return {
      name: `${stops.length ? '经' + stops.join('/') + ' ' : ''}${r.chain.map(x => x.code).join('+')}`,
      kind: '铁路',
      windowHit: win.hit(r.firstStart),
      gapsTxt: gaps.join(' / '),
      ...(note ? { note } : {}),
      // ⚠ 必须带上 `seat`：席别在逐腿筛选时已经由 `decide()` 定好了（见上面的 items.push），
      // 这里若不传下去，`--emit-data` 就无法给价格标票种 → 页面价格变成裸价 "¥795"，
      // 被 A2 门禁判为"报价未标明票种"而拒绝生成（实测踩过）。
      legs: r.chain.map(x => ({ code: x.code, from: x.from, dep: absToDT(x.depAbs), to: x.to, arr: absToDT(x.arrAbs), cost: x.price, ...(x.seat ? { seat: x.seat } : {}) })),
    };
  });
  const recs = opts2.map((o, i) => ({ ...buildOption(o, i, dayMap).rec, legs: o.legs }));

  const L = [];
  L.push(`# 拼链 ${briefs[0].from || '?'} → ${briefs[briefs.length - 1].to || '?'}  ${briefs[0].date} 起  人数 ${pax}  ${win.txt}`);
  L.push(`# ${stat.join(' · ')}`);
  if (chainWarn.length) { L.push('⚠ 腿间接不上（已按「异站衔接」处理——缺接驳耗时即为数据不全）：'); chainWarn.forEach(w => L.push('  - ' + w)); }
  if (!res.length) {
    L.push('');
    L.push('⚠ **一条组合都拼不出来**——三个常见原因，按序排查：');
    L.push('  1) 换乘门槛：一律按"到站后余量"——铁路同站/异站同一标准，都是 ≥30 分（20–29 分标红、<20 分不可行）；同机场转机（平台组合，基本必然同机场）不做时间校验；非同机场转机 / 地面腿→航班都要 ≥90 分（= 起飞前 1.5 小时到达机场）；');
    L.push('  2) 某腿无票：上面 stat 里"可用 0/x"的那条腿就是断点，加车次或换枢纽重查；');
    L.push('  3) 到达日太紧：--arrive-by 只容忍晚 1 天，再晚的组合已被剪掉。');
    if (deadlineMin !== null) L.push(`     → **去掉 --arrive-by 再跑一次**就能看到更晚的组合（rank 会照 --arrive-by 把它们降级成额外方案并标 ⚠）；要不就换更快的枢纽链 / 考虑空中。`);
    process.stdout.write(L.join('\n') + '\n');
    process.exit(2);
  }
  if (!inWin.length) L.push('⚠ 窗口内一个组合都没有；下面给的是窗口外组合（可当"窗口外最近班次"用）。');
  if (truncated) L.push(`⚠ 组合太多（节点 ${nodes}），枚举已截断——要更全请缩小窗口或减少腿数。`);
  L.push('');
  L.push(`== 可行组合 ${res.length} 个${pool.length !== res.length ? `，同价同到点合并后 ${pool.length} 个` : ''}${picked.length < pool.length ? '，同一票价最多给 2 个' : ''}（枚举按"到站后余量 ≥20 分"剪枝；<30 分标红警告），给出 ${recs.length} 个 ==`);
  recs.forEach((c, i) => {
    L.push(`${i + 1}. ${c.name}  ${Number.isFinite(c.cost) ? '¥' + c.cost : '票价未定'}  ${hh(c.durationMin)}  到 ${absToDT(picked[i].arrAbs)}  [${c.windowHit}]${isLate(picked[i]) ? '  ⚠超到达日' : ''}${opts2[i].gapsTxt ? '  ' + opts2[i].gapsTxt : ''}`);
    picked[i].chain.forEach(x => L.push(`     ${x.code}  ${x.from} ${x.t.start}→${x.to} ${x.t.arrive}${x.t.nextDay ? '(+1天)' : ''}  ${x.t.dur}  ${x.seat} ¥${x.price} ${x.tickets}`));
  });
  process.stdout.write(L.join('\n') + '\n');
  emitCandidates(recs, [], opt.out || null, true);
}

// ── explore：一次调用走完"逐腿查 → 拼链 → 归位 → 出 data.json" ──────────
// 为什么要有：实测一次运行 80+ 次调用，其中大多数是模型在**打字指挥**——
// 一条条 `tickets`、给腿文件起名、再 compose/candidates/rank/emit-data。
// 这些指挥逻辑是固定的，写进代码即可；**"哪些枢纽值得试"仍由模型给**（判断不代码化：
// R4 的教训是枢纽判断错会全盘皆输，写死进代码就会变成第二个被固化的错规则）。
// 失败一律如实点名（对应正文「不得拿没搜到当不可达」），绝不静默。
function exploreMain(opt) {
  const { execFileSync } = require('node:child_process');
  const chains = (opt.chains || []).map(s => String(s).split(/[,，>→]+/).map(x => x.trim()).filter(Boolean)).filter(c => c.length >= 2);
  if (!chains.length) { console.error('用法: node scripts/plan.js explore --chain "汕头,深圳北,兰州西,张掖西" [--chain "..."] --date 2026-10-01 [--pax 2] [--from 07:00 --to 08:00] [--arrive-by 2026-10-02] [--route "汕头→张掖"] [--out-dir <目录>] [--tickets <12306.js 路径>]'); process.exit(1); }
  const dir = opt.outDir || '.';
  fs.mkdirSync(dir, { recursive: true });
  const tickets = opt.tickets || path.join(__dirname, '12306.js');
  const safe = (s) => String(s).replace(/[\\/:*?"<>|\s]/g, '_');
  const run = (args) => { try { return { ok: true, out: execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message) }; } };

  const L = [];
  L.push(`# explore：${chains.length} 条枢纽链 · ${opt.date || '（未给日期）'}`);
  // ── 代码替模型跑掉两类候选，顺带把"跑过哪几类"记下来 ──────────────────
  // 为什么：正文要求"说不可达前必须逐类给证据（直达/官方 transfer/自拼枢纽/空中/借道）"，
  // 那是**要求模型多想**——而推理按 ¥4/百万计价。把前两类交给代码，模型只看结果。
  const origin = chains[0][0], dest = chains[0][chains[0].length - 1];
  const coverage = { 直达: '未查', 官方中转: '未查', 自拼枢纽: `${chains.length} 条链`, 空中: '**需你查**（平台/航司时刻，代码取不到）', 借道: '按需' };
  try {
    const directFile = path.join(dir, '_direct.txt');
    const rd = run([tickets, 'tickets', origin, dest, opt.date, '--brief', '--out', directFile]);
    const directLines = (rd.ok && fs.existsSync(directFile)) ? fs.readFileSync(directFile, 'utf8').split('\n').filter(x => x.trim() && !x.startsWith('#')).length : 0;
    coverage.直达 = directLines ? `${directLines} 个车次（${directFile}）` : '**0 车次**';
    L.push(`  · 直达 ${origin}→${dest}：${coverage.直达}`);
  } catch (e) { coverage.直达 = '查询失败'; L.push(`  · 直达 ${origin}→${dest}：查询失败（${String(e.message).slice(0, 60)}）`); }
  try {
    const trFile = path.join(dir, '_transfer.json');
    const rt = run([tickets, 'transfer', origin, dest, opt.date, '--out', trFile]);
    let n = 0;
    if (rt.ok && fs.existsSync(trFile)) { try { const j = JSON.parse(fs.readFileSync(trFile, 'utf8')); n = Array.isArray(j) ? j.length : ((j && j.plans) || []).length; } catch { n = 0; } }
    coverage.官方中转 = n ? `${n} 组（${trFile}，**逐组按换乘门槛复核**）` : '**0 组**';
    L.push(`  · 官方 transfer：${coverage.官方中转}`);
  } catch (e) { coverage.官方中转 = '查询失败'; L.push(`  · 官方 transfer：查询失败`); }
  L.push('');
  const chainFiles = [];
  chains.forEach((stops, ci) => {
    const legs = [];
    let broke = null;
    for (let i = 0; i + 1 < stops.length; i++) {
      const f = path.join(dir, `leg_c${ci + 1}_${i + 1}_${safe(stops[i])}_${safe(stops[i + 1])}.txt`);
      const r = run([tickets, 'tickets', stops[i], stops[i + 1], opt.date, '--brief', '--out', f]);
      if (!r.ok || !fs.existsSync(f)) { broke = `第 ${i + 1} 腿 ${stops[i]}→${stops[i + 1]} **查询失败**（${(r.err || '').split('\n')[0].slice(0, 80)}）——该链未查到，请换枢纽或换日期重试，**不得据此判"不可达"**`; break; }
      legs.push(f);
    }
    if (broke) { L.push(`  ✗ 链${ci + 1} ${stops.join('→')}：${broke}`); return; }
    const out = path.join(dir, `chain${ci + 1}_candidates.json`);
    const args = [__filename, 'compose', ...legs, '--pax', String(opt.pax || 1), '--out', out];
    if (opt.from) args.push('--from', opt.from);
    if (opt.to) args.push('--to', opt.to);
    if (opt.arriveBy) args.push('--arrive-by', opt.arriveBy);
    const r2 = run(args);
    if (!r2.ok || !fs.existsSync(out)) {
      const why = (r2.out || r2.err || '').split('\n').filter(x => /拼不出|可用 0|不可行|⚠/.test(x)).slice(0, 2).join(' ') || '拼不出组合';
      L.push(`  ✗ 链${ci + 1} ${stops.join('→')}：${why.trim().slice(0, 140)}`);
      return;
    }
    chainFiles.push(out);
    const n = (JSON.parse(fs.readFileSync(out, 'utf8')) || []).length;
    L.push(`  ✓ 链${ci + 1} ${stops.join('→')}：${n} 个候选`);
  });
  if (!chainFiles.length) { L.push(''); L.push('⚠ **所有链都没拼出候选**——按正文：换枢纽（至少再试 2 条链，尤其出发地机场能飞哪些城市）/ 换日期，**不得判"不可达"**。'); process.stdout.write(L.join('\n') + '\n'); process.exit(2); }

  const merged = [];
  const seen = new Set();
  for (const f of chainFiles) for (const c of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    const k = `${c.name}|${c.cost}|${c.durationMin}`;
    if (!seen.has(k)) { seen.add(k); merged.push(c); }
  }
  const mergedFile = path.join(dir, 'candidates.json');
  ensureDir(mergedFile); fs.writeFileSync(mergedFile, JSON.stringify(merged, null, 1), 'utf8');
  L.push(`  → 合并去重后 ${merged.length} 个候选 → ${mergedFile}`);
  L.push('');
  L.push('  候选类别覆盖（**说"不可达 / 唯一通道"之前必须逐类有据**，前两类已由代码跑完）：');
  for (const [k, v] of Object.entries(coverage)) L.push(`    · ${k}：${v}`);
  L.push('');
  process.stdout.write(L.join('\n') + '\n');

  const rArgs = [__filename, 'rank', mergedFile, '--pax', String(opt.pax || 1), '--emit-data', opt.emitData || path.join(dir, 'data.json')];
  if (opt.arriveBy) rArgs.push('--arrive-by', opt.arriveBy);
  if (opt.route) rArgs.push('--route', opt.route);
  if (opt.date) rArgs.push('--date', opt.date);
  if (opt.from) rArgs.push('--window', opt.to ? `${opt.from}–${opt.to}` : `${opt.from} 起`);
  const r3 = run(rArgs);
  process.stdout.write(r3.out || '');
  if (!r3.ok) { console.error(r3.err || '归位失败'); process.exit(1); }
  process.exit(0);
}

const argv = process.argv.slice(2);

// --help：脚本自带的用法说明（SKILL.md 只留最常用的一条，其余看这里）
const HELP = [
  'plan.js —— 车次筛选与席别裁决（把"读全谱 + 逐条套规则"交给代码）',
  '',
  '用法:',
  '  node scripts/plan.js <brief.txt> [选项]',
  '  node scripts/plan.js screen <brief.txt> [选项]   # 筛选模式（默认；省略 screen 亦可）',
  '  node scripts/plan.js rank   <candidates.json> [--arrive-by <日期>]   # 三段归位模式',
  '  node scripts/plan.js candidates <options.json> [--out <candidates.json>]   # 装配候选模式',
  '  node scripts/plan.js compose <腿1.txt> <腿2.txt> [...] [选项]        # 逐腿拼链模式',
  '  node scripts/plan.js explore --chain "起点,枢纽…,终点" --date <日期>  # 一趟跑完拼链→归位→出 data.json',
  '',
  '参数:',
  '  <brief.txt>   12306.js tickets ... --brief 的输出文件（也接受未落盘时的临时文件）',
  '',
  '选项:',
  '  --at HH:MM        客户端指定出发时间 T → 优先窗口 T～T+1h，放宽至 T+2h',
  '  --from HH:MM      显式窗口起点（未给 --at 时默认 08:00）',
  '  --to HH:MM        显式窗口终点（未给 --at 时：默认起点 08:00、终点 10:00，给了 --to 就是单一窗口；',
  '                    给了 --at 时本项无效——那时放宽窗口终点固定为 T+2h）',
  '  --pax N           出发人数（默认 1）；影响余票校验与拼票判定',
  '  --arrive-by <日期> rank 模式：客户要求的到达日（YYYY-MM-DD，或 YYYY-MM-DDTHH:MM 精确到时刻）；',
  '                     超出该日的候选**不进「最省钱 / 最快」**，降级到额外方案并标注',
  '  --json            输出结构化 JSON（默认输出人行可读文本）',
  '  --help, -h        显示本说明',
  '',
  'rank 模式的输入 JSON（数组）:',
  "  [{ \"name\": \"经福州南 动车\", \"cost\": 385, \"durationMin\": 485, \"arriveAt\": \"2026-10-01T18:05\", \"windowHit\": \"窗口内\", \"kind\": \"铁路\" }]",
  '  · name 必填；durationMin 必填（总耗时，分钟）',
  '  · cost 给数字（**机票写参考价 = 票面 + 机建 + 燃油，它会照常参与"最省钱"比价**），或 null 表示票价待定（待定者不参与最省钱，但照常参与最快）',
  '  · arriveAt = 到达时刻（如 "2026-10-02T15:49"）；**用了 --arrive-by 就必填**',
  '  · windowHit / kind / note 可选，仅用于展示',
  '',
  'candidates 模式（**先用它，再跑 rank**）:',
  '  node scripts/plan.js candidates <options.json> [--out <candidates.json>]',
  '  输入 = 你查到的方案清单，每项按「段」写，**只写事实、不用自己算**：',
  '  [{ "name": "经西宁 Z508+Z21", "kind": "铁路", "windowHit": "窗口外", "note": "…", "extraCost": 0,',
  '     "legs": [ { "code": "Z508", "from": "成都", "dep": "2026-10-01 12:00", "to": "西宁", "arr": "2026-10-02 05:30", "cost": 232.5 },',
  '               { "code": "Z21",  "from": "西宁", "dep": "2026-10-02 08:00", "to": "拉萨", "arr": "2026-10-02 11:46", "cost": 155 } ] }]',
  '  · 它替你算：cost（各段相加 + extraCost；某段缺票价则整体记 null）、durationMin（首段发车→末段到达）、arriveAt；',
  '  · 跨天必须把时刻写全（"YYYY-MM-DD HH:MM"），只写 "HH:MM" 推不出到达日、rank --arrive-by 会拒收；',
  '  · 顺带校验相邻两段衔接预留（一律看到站后余量）：铁路 ≥30 分合格 / 20–29 分标红 / <20 分不可行；异站须给 transferMin。',
  '    · 空中：平台给的转机**基本必然同机场** → **不做时间校验**（写 throughCheckin:true 留痕即可，漏标也不拦）；**非同机场转机极罕见**，真遇到先换平台方案，否则须 ≥90 分（= 起飞前 1.5 小时到下一段机场）并写 transferMin；**地面腿 → 航班要 ≥90 分**。',
  '  · **空中段的 dep 写「离开出发地的时刻」**（= 航班起飞 − 起飞前 1.5h 缓冲 − 去机场接驳耗时），',
  '    不是航班起飞时刻——这样算出的总耗时才和铁路同一口径（见 SKILL.md「总耗时口径」）。',
  '    ⚠ **已把出发端接驳单列为一段 leg 时，航班段 dep 写真实起飞时刻**，否则两条腿时刻重叠、会被判"时刻倒挂"。',
  '  · 加 --out 落盘后直接喂给 rank：`plan.js rank <candidates.json> --arrive-by <到达日>`。',
  '',
  'compose 模式（**含非铁路腿 / 要手工控制 legs 时用它**；纯铁路枚举请用 explore，别自己脑内组合）:',
  '  node scripts/plan.js compose <腿1.txt> <腿2.txt> [...] [--pax N] [--at HH:MM] [--arrive-by <日期>] [--max N] [--out <candidates.json>]',
  '  输入 = **每条腿一个 brief 格式文件，按时间先后排列**（自动取头行的 发站→到站 与日期）：',
  '    · 铁路腿：直接给 `12306.js tickets <A> <B> <日期> --brief --out 腿N.txt` 的输出文件；',
  '    · 非铁路腿（跨市地铁 / 城际公交 / 大巴）**按同一格式手写**，例：',
  '        # 深圳北 → 深圳东  2026-10-01',
  '        地铁5号线  深圳北→深圳东  07:40→08:12  00:32  硬座5/有',
  '      席别名要用规则里的名字（普速腿写 硬座/硬卧/软卧，G/C/D 腿写 二等座/一等座），',
  '      否则席别裁决认不出、这一腿会被当成"无票"；历时字段是 HH:MM（32 分钟写 00:32）。',
  '  它做什么：**对每条腿筛出"人数够 + 有票"的车次，再把各腿交叉组合**，按「换乘时间规则」',
  '    （一律看到站后余量）过滤，套时间窗口，并剪掉超出 --arrive-by 一天以上的组合。',
  '    腿与腿之间站名不一致（如 深圳北 → 深圳 换乘）会自动按**异站**处理并在输出里点名。',
  '  输出：**腿库 + 每个可行组合的成本 / 总耗时 / 到达时刻 / 换乘余量**，并落盘成 candidates.json',
  '    （其中 legs 带完整时刻，写 HTML 方案时可直接照抄）→ 下一步 `plan.js rank <candidates.json> --arrive-by <到达日>`。',
  '  --max N   最多给几个组合（默认 6）。它先取最便宜 3 个 + 最快 3 个，再按票价补齐。',
  '  退出码：0 = 有可行组合；2 = 一条都拼不出来（会打印每条腿"可用 x/y"与三个排查方向）；1 = 用法/数据错误。',
  '',
  'explore 模式（**自己枚举枢纽时用它，一趟跑完，不要一条条打 tickets**）:',
  '  node scripts/plan.js explore --chain "起点,枢纽1,枢纽2,…,终点" [--chain "…"] --date <日期> [选项]',
  '  你只给**枢纽链**（可给多条），代码替你完成：逐腿 tickets 查询 → 拼链 → 合并去重 → 三段归位',
  '  → 写出 data.json；最后只打印短名单。',
  '  选项: --pax N / --from HH:MM --to HH:MM / --arrive-by <日期> / --route "<起点→终点>"',
  '        / --out-dir <目录>（腿文件与 data.json 的落点，默认当前目录）',
  '        / --tickets <12306.js 路径>（默认同目录的 12306.js）',
  '  · 顺带把「直达」与「官方 transfer」也跑一遍并在输出里点名，省掉你手工记"跑过哪几类"。',
  '  · 查询失败的链会**如实点名**（不得据此判"不可达"）；全部失败时退出码 2 并提示换枢纽 / 换日期。',
  '  · 枢纽链**一次只试一条**（先跑最可能成功的那条）；明显绕远、或首段在期望窗口内本就无票的链不要试。',
  '',
  'rank 模式做什么: 按「方案生成」的三段定义归位——最省钱 1 + 最快 1 + 额外（其余全部），',
  '  并给出每个额外方案与两个基准的增量对比；额外不足 2 个时提示必须写明原因。',
  '  给了 --arrive-by 时另做**到达日门槛**：超出客户要求到达日的候选不进「最省钱 / 最快」，',
  '  降级到额外方案并标 ⚠——防止"次日才到"的过夜车仅凭低价被封成最省钱。',
  '',
  '它做什么（全部口径见 SKILL.md「时间窗口规则 / 人数与余票规则 / 席别规则 / 无座票规则」）:',
  '  1. 时间窗口判定：优先 / 放宽 / 窗口外',
  '  2. 人数与余票校验',
  '  3. 主选席别裁决：G/C/D 走 二等座→一等座；普速按票价由低到高（长途普速改排硬卧→软卧→硬座）',
  '  4. 拼票：主选席别不够 X 人时用更高档补，给出各买几张与人均价',
  '  5. 无座 45 分钟门槛（含"全无票但短途只有无座"的优先裁决）',
  '  6. 输出体量上限（可用车次最多列 20 个）',
  '',
  '输出:',
  '  表头 + 「可用」（按票价升序，含窗口命中 / 主选席别 / 票价 / 各买几张）+「无票 / 不列」及原因',
  '',
  '退出码:',
  '  0 = 窗口内有可用车次',
  '  2 = 窗口内无可用（仍会打印窗口外候选，可当"窗口外最近班次"用）',
  '  1 = 用法错误 / 文件不存在 / 解析不出车次',
  '',
  '注意:',
  '  · 脚本与正文口径同源；两者冲突时以脚本为准，并把冲突回报给用户。',
  '  · 不要读本脚本源码——它可能很大，会污染上下文。用 --help 就够了。',
].join('\n') + '\n';
if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); process.exit(0); }
const opt = { pax: 1, at: null, from: null, to: null, json: false, file: null, files: [], arriveBy: null, max: null, emitData: null, route: null, date: null, window: null, chains: [], outDir: null, tickets: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--pax') opt.pax = parseInt(argv[++i], 10);
  else if (a === '--at') opt.at = argv[++i];
  else if (a === '--from') opt.from = argv[++i];
  else if (a === '--to') opt.to = argv[++i];
  else if (a === '--arrive-by') opt.arriveBy = argv[++i];
  else if (a === '--out') opt.out = argv[++i];
  else if (a === '--max') opt.max = parseInt(argv[++i], 10);
  else if (a === '--emit-data') opt.emitData = argv[++i];
  else if (a === '--route') opt.route = argv[++i];
  else if (a === '--date') opt.date = argv[++i];
  else if (a === '--window') opt.window = argv[++i];
  else if (a === '--chain') opt.chains.push(argv[++i]);
  else if (a === '--out-dir') opt.outDir = argv[++i];
  else if (a === '--tickets') opt.tickets = argv[++i];
  else if (a === 'explore') opt.mode = 'explore';
  else if (a === '--json') opt.json = true;
  else if (a === 'rank') opt.mode = 'rank';
  else if (a === 'candidates') opt.mode = 'candidates';
  else if (a === 'compose') opt.mode = 'compose';
  else if (a === 'screen') opt.mode = 'screen';
  else if (!a.startsWith('--')) { opt.files.push(a); opt.file = a; }
}
let deadline = null;
if (opt.arriveBy) {
  deadline = parseLocal(opt.arriveBy);
  if (!deadline) { console.error('--arrive-by 需为 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM'); process.exit(1); }
}
if (opt.mode === 'rank') rankMain(opt.file, deadline, opt.emitData || null, { route: opt.route, date: opt.date, window: opt.window, pax: opt.pax });
if (opt.mode === 'candidates') candidatesMain(opt.file, opt.out || null);
if (opt.mode === 'compose') composeMain(opt.files, opt);
if (opt.mode === 'explore') exploreMain(opt);
if (!opt.file) { console.error('用法: node scripts/plan.js <brief.txt> [--at HH:MM] [--from HH:MM] [--to HH:MM] [--pax N] [--json]\n      或: node scripts/plan.js rank <candidates.json>（--help 看完整说明）'); process.exit(1); }
if (!fs.existsSync(opt.file)) { console.error('文件不存在: ' + opt.file); process.exit(1); }
if (!Number.isFinite(opt.pax) || opt.pax < 1) { console.error('--pax 必须是 ≥1 的整数'); process.exit(1); }

// 窗口（口径见 SKILL.md「时间窗口规则」；实现集中在 makeWindow，screen 与 compose 共用）
const win = makeWindow(opt);
const { priFrom, priTo, wideTo, singleWindow } = win;
const hit = win.hit;

// ── 解析 brief（screen 与 compose 共用同一份解析，保证口径同源）──────────
// 车次行格式：车次  发站→到站  发时→到时[(+1天)]  历时  席别价格/余票 ...
// 头行格式：  # 发站 → 到站  YYYY-MM-DD  其余说明
function parseBrief(file) {
  const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const head = raw.find(l => l.startsWith('#')) || '';
  const meta = /(\S+)\s*→\s*(\S+)\s+(\d{4}-\d{2}-\d{2})/.exec(head) || [];
  const trains = [];
  const badLines = [];
  for (const line of raw) {
    if (line.startsWith('#')) continue;
    const f = line.split(/\s{2,}/);                       // 前 4 字段以 2+ 空格分隔
    if (f.length < 4) { badLines.push(line); continue; }
    const [code, od, times, dur, seatsRaw = ''] = f;
    const tm = /^(\d{1,2}:\d{2})→(\d{1,2}:\d{2})(\(\+1天\))?$/.exec(times);
    if (!tm) { badLines.push(line); continue; }
    const odm = /^(.*?)→(.*)$/.exec(od) || [];
    const seats = {};
    for (const tok of seatsRaw.split(' ').filter(Boolean)) {
      const sm = /^([^0-9-]+?)([\d.]+|-)\/(.+)$/.exec(tok);
      if (!sm) continue;
      seats[sm[1]] = { price: fmtPrice(sm[2]), avail: sm[3] };
    }
    const durMin = toMin(dur);
    const startMin = toMin(tm[1]);
    trains.push({
      code, from: odm[1] || '', to: odm[2] || '',
      start: tm[1], arrive: tm[2], nextDay: !!tm[3], dur, durMin,
      nextDayFlag: !!tm[3],
      overnight: !!tm[3] || (durMin !== null && durMin >= 12 * 60),
      seats,
      startMin,
      // 到达分钟（含跨天）：历时优先，历时读不出才用钟点差兜底
      endMin: durMin !== null ? (startMin === null ? null : startMin + durMin)
        : (startMin === null || toMin(tm[2]) === null ? null : toMin(tm[2]) + (tm[3] ? 1440 : (toMin(tm[2]) < startMin ? 1440 : 0))),
    });
  }
  return { raw, head, meta, trains, badLines, from: meta[1] || null, to: meta[2] || null, date: meta[3] || null };
}
const brief = parseBrief(opt.file);
const { raw, head, meta, trains, badLines } = brief;
if (!trains.length) { console.error('没解析出任何车次；前几行：\n' + raw.slice(0, 3).join('\n')); process.exit(1); }

// ── 余票裁决 ──────────────────────────────────────────────────────────
function readSeat(t, seatName) {
  const s = t.seats[seatName];
  if (!s) return { state: 'nosale', n: 0 };
  const a = String(s.avail).trim();
  if (a === '有') return { state: 'ok', n: Infinity };
  if (a === '无' || a === '' || a === '-') return { state: 'none', n: 0 };
  const n = parseInt(a, 10);
  if (!Number.isFinite(n)) return { state: 'none', n: 0 };
  return { state: n > 0 ? 'some' : 'none', n };
}
function priceOf(t, seatName) { return t.seats[seatName] ? t.seats[seatName].price : null; }

// ── 定主选席别（口径 = SKILL.md「席别规则」）──────────────────────────
function decide(t, pax) {
  const tiers = isEmu(t.code) ? EMU_TIERS : (t.overnight ? CONV_LONG : CONV_SHORT);
  const notes = [];

  for (let i = 0; i < tiers.length; i++) {
    const name = tiers[i];
    const r = readSeat(t, name);
    if (r.state === 'ok' || (r.state === 'some' && r.n >= pax)) {
      return { ok: true, seat: name, price: priceOf(t, name), tickets: `${pax} 张`, notes };
    }
    if (r.state === 'some' && r.n > 0 && r.n < pax) {
      // 拼票：差额用更高档补（含 ≤45 分钟可用无座补）
      let need = pax - r.n;
      const parts = [{ seat: name, n: r.n, price: priceOf(t, name) }];
      let sum = r.n * (priceOf(t, name) || 0);
      let filled = false;
      for (let j = i + 1; j < tiers.length && need > 0; j++) {
        const hr = readSeat(t, tiers[j]);
        if (hr.state === 'none' || hr.state === 'nosale') continue;
        const take = Math.min(need, hr.n === Infinity ? need : hr.n);
        if (take <= 0) continue;
        parts.push({ seat: tiers[j], n: take, price: priceOf(t, tiers[j]) });
        sum += take * (priceOf(t, tiers[j]) || 0);
        need -= take;
      }
      if (need > 0 && t.durMin !== null && t.durMin <= WZ_MAX_MIN) {
        const wr = readSeat(t, WZ);
        if (wr.state === 'ok' || wr.n >= need) {
          const wzPrice = priceOf(t, WZ) ?? priceOf(t, name) ?? 0;
          parts.push({ seat: WZ, n: need, price: wzPrice });
          sum += need * (wzPrice || 0);
          need = 0;
          notes.push('短途用无座补差额（≤45 分钟）');
        }
      }
      if (need === 0) {
        return { ok: true, seat: name, price: Math.round(sum / pax * 10) / 10, tickets: parts.map(p => `${p.n} 张 ${p.seat}`).join(' + '), split: parts, notes: notes.concat('拼票，价格为人均价') };
      }
      notes.push(`${name} 仅 ${r.n} 张且补不齐`);
    }
  }

  // 全无票时：≤45 分钟且只有无座有票 → 用无座作主选（优先于买长乘短/补票）
  const allTiersNone = tiers.every(x => ['none', 'nosale'].includes(readSeat(t, x).state));
  if (allTiersNone && t.durMin !== null && t.durMin <= WZ_MAX_MIN) {
    const wr = readSeat(t, WZ);
    if (wr.state === 'ok' || wr.n >= pax) {
      const base = isEmu(t.code) ? '二等座' : '硬座';
      return { ok: true, seat: WZ, price: priceOf(t, WZ) ?? priceOf(t, base), tickets: `${pax} 张`, notes: ['短途无座（≤45 分钟），票面按同车次' + base + '价'] };
    }
  }
  return { ok: false, seat: null, price: null, notes: notes.concat('各档均无票 / 不售') };
}

// ── 逐车次裁决 ────────────────────────────────────────────────────────
const out = trains.map(t => {
  const d = decide(t, opt.pax);
  return { ...t, hit: hit(t.startMin), decide: d };
});
const usable = out.filter(x => x.decide.ok);
const inWindow = usable.filter(x => x.hit !== '窗口外');
const dead = out.filter(x => !x.decide.ok);

// ── 输出 ──────────────────────────────────────────────────────────────
if (opt.json) {
  process.stdout.write(JSON.stringify({
    from: meta[1] || null, to: meta[2] || null, date: meta[3] || null,
    pax: opt.pax,
    window: { priFrom: fmt(priFrom), priTo: fmt(priTo), wideTo: fmt(wideTo) },
    totals: { trains: out.length, usable: usable.length, usableInWindow: inWindow.length, dead: dead.length },
    usable: usable.map(pick), dead: dead.map(x => ({ code: x.code, start: x.start, hit: x.hit, reason: x.decide.notes.join('；') })),
    parseWarnings: badLines,
  }, null, 1) + '\n');
} else {
  const L = [];
  const winTxt = singleWindow ? `窗口 ${fmt(priFrom)}-${fmt(priTo)}` : `优先窗口 ${fmt(priFrom)}-${fmt(priTo)}  放宽至 ${fmt(wideTo)}`;
  L.push(`# ${meta[1] || '?'} → ${meta[2] || '?'}  ${meta[3] || '?'}  人数 ${opt.pax}  ${winTxt}`);
  L.push(`# 共 ${out.length} 车次：可用 ${usable.length}（其中窗口内 ${inWindow.length}）· 无票 ${dead.length}`);
  L.push('');
  L.push(usable.length ? '== 可用（按票价升序）==' : '== 可用（无）==');
  for (const x of usable.slice().sort((a, b) => (a.decide.price ?? 9e9) - (b.decide.price ?? 9e9)).slice(0, 20)) {
    L.push(`${x.code}  ${x.from}→${x.to}  ${x.start}→${x.arrive}${x.nextDay ? '(+1天)' : ''}  ${x.dur}  ${x.hit}  ${x.decide.seat} ¥${x.decide.price}  ${x.decide.tickets}${x.decide.split ? '  [' + x.decide.split.map(p => `${p.seat}${p.n}`).join('+') + ']' : ''}`);
  }
  if (usable.length > 20) L.push(`… 另有 ${usable.length - 20} 个可用车次未列出（输出体量上限）`);
  L.push('');
  L.push(`== 无票 / 不列（${dead.length}）==`);
  for (const x of dead.slice(0, 10)) L.push(`${x.code}  ${x.from}→${x.to}  ${x.start}  ${x.hit}  ${x.decide.notes.join('；')}`);
  if (dead.length > 10) L.push(`… 另有 ${dead.length - 10} 个未列出`);
  process.stdout.write(L.join('\n') + '\n');
}
function pick(x) { return { code: x.code, start: x.start, arrive: x.arrive, dur: x.dur, hit: x.hit, seat: x.decide.seat, price: x.decide.price, tickets: x.decide.tickets, nextDay: x.nextDay, notes: x.decide.notes }; }
function fmt(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }

process.exit(inWindow.length ? 0 : 2);
