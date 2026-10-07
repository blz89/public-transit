#!/usr/bin/env node
/**
 * 12306 官方数据查询脚本（旅游规划 skill 用）
 * 数据源为 12306 官方接口（kyfw.12306.cn），免登录。
 *
 * 用法:
 *   node 12306.js stations <关键词>                # 搜索车站（支持中文名/拼音/简拼/三字码）
 *   node 12306.js tickets <出发> <到达> [日期]      # 余票+时刻+票价 合并输出（核心）
 *   node 12306.js transfer <出发> <到达> [日期]     # 官方中转换乘方案（一次换乘）
 *
 * 出发/到达 支持：三字码(如 BJP)、车站中文名(如 北京南)、城市名(如 北京，自动选主站)。
 * 日期格式 YYYY-MM-DD，缺省为明天。可用 --out <文件> 把 JSON 写入 UTF-8 文件。
 *
 * 效率选项（重要）：
 *   --brief   精简输出：tickets 每车次一行（车次/发到/历时/**全部席别的票价与余票**，普速含硬座硬卧、高铁含二等/一等/商务），
 *             大枢纽线路全量 JSON 可达数百 KB（如 广州南→虎门 444 车次 264KB），
 *             全量读回极烧 token——优先用 --brief 看概要，确需全量再加 --out 落盘后按需提取。
 *             示例: node 12306.js tickets 广州南 虎门 2026-09-06 --brief
 *   --from HH:MM --to HH:MM  仅与 --brief 搭配：按发车时间窗过滤（如 --from 08:00 --to 12:00），
 *             进一步把输出压到几 KB（配合技能「时间窗口规则」先筛再读）。
 *   --out <文件> 仍可搭配使用（--brief 时写精简文本而非 JSON）。
 *
 * 注意：必须用 node 运行（自带 OpenSSL），不要用 PowerShell 的 Invoke-WebRequest/curl
 * （Windows 沙箱下 schannel 会报 SEC_E_NO_CREDENTIALS）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// BASE 与缓存目录支持环境变量覆盖——**唯一目的是让回归测试能指向本地 mock**，
// 生产运行不设置这两个变量时行为与以前完全一致。
const BASE = process.env.RAIL_BASE || 'https://kyfw.12306.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HAS_BRIEF = process.argv.includes('--brief');
const hasOpt = (name) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null; };
const OUT_FILE = hasOpt('--out');
const TIME_FROM = hasOpt('--from'); // HH:MM，仅 --brief 生效
const TIME_TO = hasOpt('--to');

// 输出：默认 stdout；若命令行带 --out <文件> 则写 UTF-8 文件（Windows 重定向会变 UTF-16，需用此选项）
// ⚠ 目录不存在时**自动建**（实测踩过：`--out 中间数据/xxx.txt` 报 ENOENT，
//   执行者只能先建目录再重跑一遍——一次白跑的查询 + 一次往返）。
function ensureOutDir(file) {
  try { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); } catch { /* 写不进去会在 writeFileSync 报错 */ }
}
function emit(obj) {
  const json = JSON.stringify(obj, null, 2);
  if (OUT_FILE) {
    ensureOutDir(OUT_FILE);
    fs.writeFileSync(OUT_FILE, json, 'utf8');
    console.error('已写入: ' + OUT_FILE);
  } else {
    process.stdout.write(json + '\n');
  }
}

// 精简输出：tickets 结果 → 每车次一行（可按发车时间窗过滤）
// 注意：必须输出全部席别票价+余票（普速无二等座，只有硬座/硬卧等），
// 否则「最省钱=普速硬座 vs 高铁二等座比价」无法成立——信息零丢失，靠时间窗过滤条数来省 token。
function emitBrief(header, trains) {
  let list = trains;
  if (TIME_FROM || TIME_TO) {
    list = trains.filter((t) => {
      const hm = t.start_time || '00:00';
      if (TIME_FROM && hm < TIME_FROM) return false;
      if (TIME_TO && hm > TIME_TO) return false;
      return true;
    });
  }
  const lines = [];
  lines.push(`# ${header.from.name} → ${header.to.name}  ${header.date}  窗口内 ${list.length}/${trains.length} 车次（--brief 精简，含全部席别票价/余票）`);
  lines.push('# 车次  发站→到站  发时→到时[(+1天)=跨天到达/车上过夜]  历时  席别票价/余票（价格单位元）');
  for (const t of list) {
    const p = t.prices || {};
    const s = t.seats || {};
    // 合并所有席别：优先按 SEAT_FIELDS 顺序展示价/余票
    const parts = [];
    for (const [, label] of SEAT_FIELDS) {
      const price = p[label];
      const seat = s[label];
      if (price === undefined && seat === undefined) continue;
      const pr = price !== undefined && price !== null ? price : '-';
      const st = seat !== undefined && seat !== '' ? seat : '-';
      parts.push(`${label}${pr}/${st}`);
    }
    // 跨天到达（到达时刻不晚于发车时刻）= 车上过夜 → 供「席别规则 → 普速席别顺序」的"长途普速"判据，以及「方案生成 → 过夜 / 住宿一律标红」确定性判定
    const nextDay = !!(t.start_time && t.arrive_time && t.arrive_time <= t.start_time);
    lines.push(`${t.train_code}  ${t.from_station}→${t.to_station}  ${t.start_time}→${t.arrive_time}${nextDay ? '(+1天)' : ''}  ${t.duration}  ${parts.join(' ')}`);
  }
  const text = lines.join('\n') + '\n';
  if (OUT_FILE) { ensureOutDir(OUT_FILE); fs.writeFileSync(OUT_FILE, text, 'utf8'); console.error('已写入(精简): ' + OUT_FILE); }
  else process.stdout.write(text);
}

// 站表缓存：station_name.js 每次下载约 137KB，缓存到脚本同目录 .stations_cache.json（7 天有效）
// 实测该表保鲜度很高（上游常 2 天内才更新一次），24h 太保守——放宽到 7 天可省掉大部分重复下载。
// 缓存目录可被环境变量覆盖（仅为测试隔离；生产不设置时即脚本同目录）
const CACHE_DIR = process.env.RAIL_CACHE_DIR || __dirname;
function stationCachePath() { return path.join(CACHE_DIR, '.stations_cache.json'); }
function loadStationCache() {
  try {
    const p = stationCachePath();
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > 7 * 24 * 3600 * 1000) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}
function saveStationCache(stations) {
  try {
    fs.writeFileSync(stationCachePath(), JSON.stringify([...stations.values()]), 'utf8');
  } catch { /* 缓存失败不影响主流程 */ }
}

function cookieJar() {
  const jar = new Map();
  return {
    absorb(res) {
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of sc) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
  };
}

// ---------- 错误分类（决定「该不该重试」）----------
// 原则：**只重试网络类瞬时故障**。风控/HTTP 语义错误**一律不重试**——
// 重试只会加深风控、并让上层误以为"再试一次就好"，白白多烧 LLM 往返。
function isRetryableNetworkError(e) {
  if (!e) return false;
  if (e instanceof RateLimitError || e instanceof HttpError || e instanceof WireChangedError) return false;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  const m = String(e.message || '');
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|terminated|other side closed/i.test(m);
}
class RateLimitError extends Error {}     // 12306 风控 / 403：命中即弃，不重试
class HttpError extends Error {}          // 其它非 200：不重试
class WireChangedError extends Error {}   // 端点轮换全部试完仍拿不到数据：协议可能变了

// 退避：**指数 + jitter**。多 agent 并发时，无 jitter 会同步重试造成二次风暴。
const backoffMs = (attempt) => 300 * 2 ** attempt + Math.floor(Math.random() * 200);

// 从 302 响应里提取官方给的新端点名（这是「换址提示」，不是风控）
// 只认同域 + ^query[A-Z]$（**防开放重定向**；同域基准取 BASE，便于测试指向 mock）
const BASE_HOST = (() => { try { return new URL(BASE).hostname; } catch { return 'kyfw.12306.cn'; } })();
function extractQueryEndpoint({ body, location }) {
  let raw = null;
  try { raw = JSON.parse(body || '')?.c_url; } catch { /* body 非 JSON 属正常 */ }
  if (!raw && location) {
    const m = String(location).match(/leftTicket\/(query[A-Z])(?:$|[?#/])/);
    if (m) raw = m[1];
  }
  if (!raw) return null;
  const name = String(raw).split('/').pop();
  if (!/^query[A-Z]$/.test(name)) return null;
  try {
    if (new URL(`/otn/leftTicket/${name}`, BASE).hostname !== BASE_HOST) return null;
  } catch { return null; }
  return name;
}

function isErrorPage(res, text) {
  return res.status !== 200 || /error\.html|ntce/i.test((res.url || '')) || /网络可能存在问题/.test(String(text || '').slice(0, 500));
}

// ── 取数原语 ────────────────────────────────────────────────
// redirect:'manual' 是硬性要求：一旦 follow，官方用来告知新端点名的 c_url 就被丢掉了，
// 302 会静默落到 error.html 并被误判成"风控"，上层只好改用 web_search 兜底（纯烧 token）。
async function fetchOnce(url, { jar, referer = BASE + '/otn/leftTicket/init', timeout = 25000, followRedirect = false }) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Referer': referer,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      // 仅用于回归测试：把测试模式透传给本地 mock（生产不设置该变量则无此头）
      ...(process.env.RAIL_MOCK_MODE ? { 'X-Mock-Mode': process.env.RAIL_MOCK_MODE } : {}),
      ...(jar ? { 'Cookie': jar.header() } : {}),
    },
    redirect: followRedirect ? 'follow' : 'manual',
    signal: AbortSignal.timeout(timeout),
  });
  // 302 也要吸收 Set-Cookie（否则会丢会话）
  if (jar) jar.absorb(res);
  // 一律把 body 读出来：调用方需要文本；且避免「读了 headers 没读 body」造成连接悬挂。
  // （200 的 body 也必须读——曾因只给 302 读 body、200 返回空串，导致站表解析出空 Map。）
  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  return { res, text };
}

// 带「错误分流 + 指数退避 + 429 等待」的取数。返回 { res, text }（text 已读好，避免二次读流）
async function requestText(url, { jar, referer, timeout = 25000, retries = 2, followRedirect = false } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const { res, text } = await fetchOnce(url, { jar, referer, timeout, followRedirect });

      if (res.status === 200) {
        // 200 也可能是风控页（error.html / ntce）——归类为风控，不重试
        if (/error\.html|ntce/i.test(res.url || '') || /网络可能存在问题/.test(text.slice(0, 500))) {
          throw new RateLimitError('12306 返回风控页（error.html/ntce）');
        }
        return { res, text };
      }

      // 429：按 Retry-After 等待（最多 3s），只重试一次。
      // ⚠ 等待后必须 `continue` **跳过本轮的抛出**——否则同一轮里紧接着就抛错，重试等于没做。
      if (res.status === 429) {
        if (i < 1) {
          const ra = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 3000) : 1500;
          await sleep(wait);
          continue;
        }
        throw new RateLimitError('12306 限流（HTTP 429）');
      }

      // 302 及其它 3xx：**不重试**，把控制权交给端点轮换逻辑
      if (res.status >= 300 && res.status < 400) {
        return { res, text, redirect: true, location: res.headers.get('location') };
      }

      // 403/451 以及其它非 200：不重试
      if (res.status === 403 || res.status === 451) {
        throw new RateLimitError(`12306 拒绝访问（HTTP ${res.status}），疑似风控`);
      }
      throw new HttpError(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
      // 只对网络类瞬时故障重试；RateLimit/Http/WireChanged 直接抛出
      if (!isRetryableNetworkError(e)) throw e;
      if (i < retries) await sleep(backoffMs(i));
    }
  }
  throw lastErr;
}

async function get(url, opts = {}) {
  const { res, text } = await requestText(url, opts);
  return new ResponseLike(res, text);
}

// 兼容原有 `res.text()` / `res.status` / `res.url` / `res.headers` 的用法
class ResponseLike {
  constructor(res, text) { this._res = res; this._text = text; }
  get status() { return this._res.status; }
  get url() { return this._res.url; }
  get headers() { return this._res.headers; }
  async text() { return this._text; }
}

// 端点轮换取数：把「端点名轮换 → 报错 → 上层 web_search 兜底」变成「自动换端点自愈」。
// 起点队列含全部已知端点；每次 302 都把官方解析出的端点 unshift 到队首优先重试。
async function requestWithRotation(buildUrl, { jar, referer, timeout, endpoints = ['queryG', 'queryO', 'queryZ', 'queryA'] } = {}) {
  const queue = [...endpoints];
  const tried = new Set();
  let lastDiag = '未知原因';
  while (queue.length) {
    const ep = queue.shift();
    if (tried.has(ep)) continue;
    tried.add(ep);
    const { res, text, redirect, location } = await requestText(buildUrl(ep), { jar, referer, timeout });
    if (redirect) {
      const rotated = extractQueryEndpoint({ body: text, location });
      if (rotated) { queue.unshift(rotated); lastDiag = `端点 ${ep} 返回 302，官方提示改用 ${rotated}`; continue; }
      // 302 但解析不出合法端点 → 真风控（通常是 error.html）
      throw new RateLimitError(`端点 ${ep} 返回 302 且未给出可用端点（疑似风控）`);
    }
    return { endpoint: ep, res, text };
  }
  throw new WireChangedError(`已尝试端点 ${[...tried].join('/')}，均未取得数据（${lastDiag}）——12306 接口名可能已更换`);
}

// ---------- 负缓存（OD + 日期 → 确定性空结果）----------
// 目的：避免 agent 对同一 OD + 同一日期**反复重试**同一个查询（实测这是最大的无效往返来源之一）。
// 硬性边界：**只缓存「确定性空结果」**（接口正常返回、但当天该 OD 一班车都没有）。
//           **风控 / 网络失败 / 解析失败一律不写缓存**——否则会把临时故障记成"没车"，
//           那是比多花几次查询严重得多的错误（会让整条方案凭空消失）。
const NEG_TTL_MS = 20 * 60 * 1000;   // 20 分钟
const NEG_MAX = 300;                 // 上限，防止文件无限增长
function negCachePath() { return path.join(CACHE_DIR, '.neg_cache.json'); }
function negKey(kind, fromCode, toCode, date) { return `${kind}|${fromCode}|${toCode}|${date}`; }
function loadNegCache() {
  try { return JSON.parse(fs.readFileSync(negCachePath(), 'utf8')) || {}; } catch { return {}; }
}
function readNegCache(key) {
  const c = loadNegCache();
  const hit = c[key];
  if (!hit) return null;
  if (Date.now() - hit.at > NEG_TTL_MS) return null;
  return hit;
}
function writeNegCache(key, info) {
  try {
    const c = loadNegCache();
    c[key] = { at: Date.now(), ...info };
    // 清过期 + 限长（按时间保留最近的 NEG_MAX 条）
    const alive = Object.entries(c).filter(([, v]) => Date.now() - v.at <= NEG_TTL_MS).slice(-NEG_MAX);
    fs.writeFileSync(negCachePath(), JSON.stringify(Object.fromEntries(alive)), 'utf8');
  } catch { /* 缓存失败不影响主流程 */ }
}

async function bootstrapSession() {
  const jar = cookieJar();
  // init 允许跟随重定向：这里只为拿 cookie，不涉及端点轮换
  await get(BASE + '/otn/leftTicket/init', { jar, followRedirect: true });
  return jar;
}

// ---------- 车站 ----------
async function loadStations() {
  // 优先本地缓存（7 天），避免每次下载全站表
  const cached = loadStationCache();
  if (cached && Array.isArray(cached) && cached.length > 1000) {
    const out = new Map();
    for (const s of cached) out.set(s.code, s);
    return out;
  }
  const res = await get(BASE + '/otn/resources/js/framework/station_name.js', { timeout: 30000 });
  const text = await res.text();
  const out = new Map(); // code -> {name, pinyin, short}
  for (const raw of text.split('@')) {
    if (!raw) continue;
    const f = raw.split('|');
    // 格式: 短码|站名|三字码|拼音|简拼|...
    if (f.length < 5) continue;
    const code = f[2], name = f[1], pinyin = f[3], short = f[4];
    if (/^[A-Z]{3}$/.test(code)) out.set(code, { code, name, pinyin, short });
  }
  saveStationCache(out);
  return out;
}

function searchStations(stations, kw) {
  kw = kw.trim();
  const up = kw.toUpperCase();
  const hits = [];
  const seen = new Set();
  const push = (s) => { if (!seen.has(s.code)) { seen.add(s.code); hits.push(s); } };
  // 精确匹配
  for (const s of stations.values()) {
    if (s.code === up || s.name === kw || s.pinyin === kw.toLowerCase() || s.short === kw.toLowerCase()) push(s);
  }
  // 模糊匹配：名称包含、拼音前缀、简拼前缀
  const kl = kw.toLowerCase();
  for (const s of stations.values()) {
    if (s.name.includes(kw) || s.pinyin.startsWith(kl) || s.short.startsWith(kl)) push(s);
  }
  return hits.slice(0, 20);
}

async function resolveStation(stations, input) {
  if (/^[A-Z]{3}$/.test(input)) {
    const s = stations.get(input);
    if (s) return s;
    throw new Error(`未知车站代码: ${input}`);
  }
  const hits = searchStations(stations, input);
  if (hits.length === 0) throw new Error(`未找到车站: ${input}`);
  // 精确名优先
  const exact = hits.find((h) => h.name === input);
  if (exact) return exact;
  // 城市名 → 主站（名字最短者优先：北京→北京站，上海→上海站）
  const sorted = [...hits].sort((a, b) => a.name.length - b.name.length);
  return sorted[0];
}

// ---------- 数据获取 ----------
const TICKET_IDX = {
  train_no: 2, station_train_code: 3, start_station_telecode: 4, end_station_telecode: 5,
  from_station_telecode: 6, to_station_telecode: 7, start_time: 8, arrive_time: 9, lishi: 10,
  canWebBuy: 11, start_train_date: 13, from_station_no: 16, to_station_no: 17, controlled_train_flag: 19,
};

const SEAT_FIELDS = [
  ['swz_num', '商务座'], ['tz_num', '特等座'], ['zy_num', '一等座'], ['ze_num', '二等座'],
  ['gr_num', '高级软卧'], ['rw_num', '软卧'], ['rz_num', '软座'], ['yw_num', '硬卧'],
  ['yz_num', '硬座'], ['wz_num', '无座'], ['yb_num', '动卧'], ['gg_num', '一等卧'],
];

// queryG 行字段: 20 gg_num 21 gr_num 22 qt_num 23 rw_num 24 rz_num 25 tz_num 26 wz_num 27 yb_num 28 yw_num 29 yz_num 30 ze_num 31 zy_num 32 swz_num
const SEAT_INDEX = { gg_num: 20, gr_num: 21, rw_num: 23, rz_num: 24, tz_num: 25, wz_num: 26, yb_num: 27, yw_num: 28, yz_num: 29, ze_num: 30, zy_num: 31, swz_num: 32 };

const PRICE_FIELDS = [
  ['swz_price', '商务座'], ['tz_price', '特等座'], ['zy_price', '一等座'], ['ze_price', '二等座'],
  ['gr_price', '高级软卧'], ['rw_price', '软卧'], ['rz_price', '软座'], ['yw_price', '硬卧'],
  ['yz_price', '硬座'], ['wz_price', '无座'], ['dw_price', '动卧'],
];

function fmtPrice(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw);
  if (!/^\d+$/.test(s)) return null;
  return (parseInt(s, 10) / 10).toFixed(1); // 角 → 元
}

function parseTickets(result, stationNameMap) {
  const trains = [];
  for (const row of result) {
    const f = row.split('|');
    if (f.length < 35 || !f[TICKET_IDX.train_no]) continue;
    const seats = {};
    for (const [field, label] of SEAT_FIELDS) {
      const v = f[SEAT_INDEX[field]];
      if (v !== undefined && v !== '' && v !== '--') seats[label] = v;
    }
    trains.push({
      train_no: f[TICKET_IDX.train_no],
      train_code: f[TICKET_IDX.station_train_code],
      from_station: stationNameMap[f[TICKET_IDX.from_station_telecode]] || f[TICKET_IDX.from_station_telecode],
      from_station_code: f[TICKET_IDX.from_station_telecode],
      to_station: stationNameMap[f[TICKET_IDX.to_station_telecode]] || f[TICKET_IDX.to_station_telecode],
      to_station_code: f[TICKET_IDX.to_station_telecode],
      start_time: f[TICKET_IDX.start_time],
      arrive_time: f[TICKET_IDX.arrive_time],
      duration: f[TICKET_IDX.lishi],
      // 12306 只给钟点不给日期：到达时刻不晚于发车时刻即为跨天到达（车上过夜）
      arrives_next_day: !!(f[TICKET_IDX.start_time] && f[TICKET_IDX.arrive_time] && f[TICKET_IDX.arrive_time] <= f[TICKET_IDX.start_time]),
      can_web_buy: f[TICKET_IDX.canWebBuy] === 'Y',
      train_date: f[TICKET_IDX.start_train_date],
      seats,
    });
  }
  return trains;
}

function parsePrices(data) {
  const map = new Map();
  for (const item of data || []) {
    const dto = item.queryLeftNewDTO || {};
    if (!dto.train_no) continue;
    const prices = {};
    for (const [field, label] of PRICE_FIELDS) {
      const v = fmtPrice(dto[field]);
      if (v !== null) prices[label] = v;
    }
    const key = `${dto.train_no}|${dto.from_station_telecode}|${dto.to_station_telecode}`;
    map.set(key, {
      train_no: dto.train_no,
      train_code: dto.station_train_code,
      from_station: dto.from_station_name,
      to_station: dto.to_station_name,
      train_class_name: dto.train_class_name,
      day_difference: dto.day_difference,
      prices,
    });
  }
  return map;
}

// ---------- 主命令 ----------
async function cmdStations(stations, kw) {
  const hits = searchStations(stations, kw);
  emit({ count: hits.length, stations: hits });
}

async function cmdTickets(stations, from, to, date) {
  const sFrom = await resolveStation(stations, from);
  const sTo = await resolveStation(stations, to);
  const nameMap = {};
  for (const s of stations.values()) nameMap[s.code] = s.name;

  // 0) 负缓存：命中直接返回，省一次网络往返 + 省一次 agent 往返
  const nkey = negKey('tickets', sFrom.code, sTo.code, date);
  const neg = readNegCache(nkey);
  if (neg) {
    const header = { from: { code: sFrom.code, name: sFrom.name }, to: { code: sTo.code, name: sTo.name }, date };
    console.error(`[负缓存] ${sFrom.name}→${sTo.name} ${date} ${Math.round((Date.now() - neg.at) / 60000)} 分钟前已确认无车，直接返回（不重查）`);
    if (HAS_BRIEF) { emitBrief(header, []); return; }
    emit({ ...header, count: 0, trains: [], note: '负缓存命中：该 OD 当日已确认无车次，未重复查询' });
    return;
  }

  const jar = await bootstrapSession();

  // 1) 余票/时刻（端点轮换：302 时按官方提示自动换端点，不再误判成风控）
  const { endpoint, res, text } = await requestWithRotation(
    (ep) => `${BASE}/otn/leftTicket/${ep}?leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=${sFrom.code}&leftTicketDTO.to_station=${sTo.code}&purpose_codes=ADULT`,
    { jar },
  );
  if (!text) throw new Error('12306 余票查询无数据');
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`12306 余票查询返回非 JSON（端点 ${endpoint}）`); }
  if (!j.data || !j.data.result) throw new Error(`12306 余票查询无数据（端点 ${endpoint}）`);
  const trains = parseTickets(j.data.result, nameMap);

  // 确定性空结果才写负缓存（能走到这里说明接口本身是正常的）
  if (!trains.length) writeNegCache(nkey, { note: `${sFrom.name}→${sTo.name} 当日无车次` });

  // 2) 票价（官方公开票价接口）
  let priceMap = new Map();
  const purl = `${BASE}/otn/leftTicketPrice/queryAllPublicPrice?leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=${sFrom.code}&leftTicketDTO.to_station=${sTo.code}&purpose_codes=ADULT`;
  try {
    const pres = await get(purl, { jar });
    const ptext = await pres.text();
    if (!isErrorPage(pres, ptext)) {
      const pj = JSON.parse(ptext);
      priceMap = parsePrices(pj.data);
    }
  } catch (e) {
    priceMap = new Map();
  }

  const merged = trains.map((t) => {
    // 优先用车次实际乘降站匹配，其次用查询站匹配
    const p = priceMap.get(`${t.train_no}|${t.from_station_code}|${t.to_station_code}`)
      || priceMap.get(`${t.train_no}|${sFrom.code}|${sTo.code}`)
      || {};
    return {
      ...t,
      train_class: p.train_class_name || guessClass(t.train_code),
      prices: p.prices || {},
    };
  });

  const header = { from: { code: sFrom.code, name: sFrom.name }, to: { code: sTo.code, name: sTo.name }, date };
  if (HAS_BRIEF) {
    emitBrief(header, merged);
    return;
  }
  emit({ ...header, count: merged.length, trains: merged });
}

function guessClass(code) {
  if (/^(G|C)/.test(code)) return '高速动车';
  if (/^D/.test(code)) return '动车';
  if (/^Z/.test(code)) return '直达特快';
  if (/^T/.test(code)) return '特快';
  if (/^K/.test(code)) return '快速';
  if (/^[0-9]/.test(code)) return '普快/普客';
  return '其他';
}

async function cmdTransfer(stations, from, to, date) {
  const jar = await bootstrapSession();
  const sFrom = await resolveStation(stations, from);
  const sTo = await resolveStation(stations, to);
  // 端点轮换：lcquery 与 leftTicket 一样是可轮换的单字母后缀
  const { text } = await requestWithRotation(
    (ep) => `${BASE}/lcquery/${ep}?train_date=${date}&from_station_telecode=${sFrom.code}&to_station_telecode=${sTo.code}&middle_station=&result_index=0&can_query=Y&isShowWZ=Y&purpose_codes=00&channel=E`,
    { jar, referer: BASE + '/otn/leftTicket/init' },
  );
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('中转换乘查询返回非 JSON'); }
  const list = (j.data && j.data.middleList) || [];
  const plans = list.map((p) => {
    const full = p.fullList || [];
    return {
      middle_station: p.middle_station_name,
      wait_time: p.wait_time,
      total_duration: p.all_lishi,
      total_duration_minutes: p.all_lishi_minutes,
      segments: full.map((seg) => ({
        train_code: seg.station_train_code,
        from_station: seg.from_station_name,
        to_station: seg.to_station_name,
        start_time: seg.start_time,
        arrive_time: seg.arrive_time,
        duration: seg.lishi,
        seats: seg.wz_num || '',
      })),
    };
  });
  emit({ from: sFrom.name, to: sTo.name, date, count: plans.length, plans });
}

// ---------- 入口 ----------
const HELP = [
  '12306.js —— 铁路数据查询（12306 官网数据）',
  '',
  '用法:',
  '  node scripts/12306.js stations <关键词>',
  '  node scripts/12306.js tickets <出发> <到达> [日期] [--brief] [--out <文件>]',
  '  node scripts/12306.js transfer <出发> <到达> [日期]',
  '',
  '  stations   搜车站。支持中文 / 拼音 / 简拼 / 三字码。输出很小，可直接读。',
  '  tickets    查某日某 OD 的全部车次（核心命令）。',
  '  transfer   官方中转换乘方案（一次换乘）。**只取第一页**，返回 0 条不代表中转不可行——',
  '             必须自己枚举沿途枢纽逐腿拼（见 SKILL.md「12306.js 用法」）。',
  '',
  '选项:',
  '  --brief          精简输出：每车次一行（车次 / 发站→到站 / 发时→到时 / 跨天标记 (+1天) /',
  '                   历时 / 全部席别的票价与余票）。**日常查询一律加这个。**',
  '  --out <文件>     结果写入文件（脚本自己用 utf8 写；不要用 PowerShell 的 > 重定向，会变 UTF-16）',
  '  --from HH:MM     按发车时间过滤（**首次全谱查询不要带**，见 SKILL.md「读取效率」）',
  '  --to HH:MM       同上',
  '  --help, -h       显示本说明',
  '',
  '输出:',
  '  默认全量 JSON（大枢纽可达数百 KB，**严禁整文件读回**）；--brief 为每车次一行。',
  '  seat 字段取值：数字 = 剩余张数；"有" = 充足；"无" = 无票；空 / 缺 = 该席别不售。',
  '',
  '退出码: 0 = 成功；1 = 参数错误或查询失败（如被限流）。',
  '',
  '注意:',
  '  · 必须用 node 运行（不要用 PowerShell 的 Invoke-WebRequest / curl）。',
  '  · 同一线路只查一次；短时间多次查询会触发 12306 按 IP 限流。',
  '  · 站表已做 7 天本地缓存，无需担心重复下载。',
  '  · 不要读本脚本源码——它可能很大，会污染上下文。用 --help 就够了。',
].join('\n') + '\n';
if (process.argv.includes('--help') || process.argv.includes('-h')) { process.stdout.write(HELP); process.exit(0); }
const USAGE = [
  '用法:',
  '  node scripts/12306.js stations <关键词>                 # 搜车站（中文/拼音/简拼/三字码）',
  '  node scripts/12306.js tickets <出发> <到达> [日期] [--brief] [--from HH:MM] [--to HH:MM]',
  '  node scripts/12306.js transfer <出发> <到达> [日期]      # 官方中转换乘方案',
  '日期格式 YYYY-MM-DD，缺省为明天；日常查询一律加 --brief（每车次一行）。',
].join('\n');
(async () => {
  // 剔除选项（--out <文件> / --brief / --from <t> / --to <t>）后得到位置参数
  const rawArgs = process.argv.slice(2);
  const OPT_WITH_VALUE = new Set(['--out', '--from', '--to']);
  const OPT_FLAG = new Set(['--brief']);
  const positional = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (OPT_WITH_VALUE.has(rawArgs[i])) { i++; continue; }
    if (OPT_FLAG.has(rawArgs[i])) continue;
    positional.push(rawArgs[i]);
  }
  const [cmd, ...args] = positional;
  const stations = await loadStations();

  const today = new Date();
  const tomorrow = new Date(today.getTime() + 864e5);
  const defaultDate = tomorrow.toISOString().slice(0, 10);

  switch (cmd) {
    case 'stations': {
      if (!args[0]) throw new Error('用法: node 12306.js stations <关键词>');
      await cmdStations(stations, args[0]);
      break;
    }
    case 'tickets': {
      if (args.length < 2) throw new Error('用法: node 12306.js tickets <出发> <到达> [YYYY-MM-DD]');
      const date = args[2] || defaultDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');
      await cmdTickets(stations, args[0], args[1], date);
      break;
    }
    case 'transfer': {
      if (args.length < 2) throw new Error('用法: node 12306.js transfer <出发> <到达> [YYYY-MM-DD]');
      const date = args[2] || defaultDate;
      await cmdTransfer(stations, args[0], args[1], date);
      break;
    }
    default:
      console.error(cmd ? `未知命令: ${cmd}` : '缺少命令');
      console.error(USAGE);
      process.exit(1);
  }
})().catch((e) => {
  console.error('ERROR: ' + e.message);
  process.exit(1);
});
