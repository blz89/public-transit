#!/usr/bin/env node
/**
 * 航班航线数据查询脚本（旅游规划 skill 用）
 *
 * 作用：判断「两地之间是否有直飞航线、哪些航司执飞」，并给出机场三字码——
 *       用于空中方案的基本可行性判断，避免凭空编造航班；时刻与价格仍需实时查询。
 * 数据源：OpenFlights 开源航线库（routes.dat + airports.dat），首次运行下载并缓存。
 *
 * 用法:
 *   node flight.js route <出发> <到达>      # 查航线：是否有直飞、承运航司、经停
 *   node flight.js airport <关键词>         # 查机场（中文城市名/英文/三字码）
 *   node flight.js cities                   # 列出内置中文城市→机场对照（常用）
 *
 * 出发/到达 支持：中文城市名（南宁/百色/广州…，内置常用对照）、英文城市名、IATA 三字码。
 *
 * 注意：OpenFlights 为社区静态数据（更新较慢），可判断"航线存在性/承运航司"，
 *       但**不含班期、时刻、票价与余票**——这些必须实时查询（web_search 购票平台或航司官网），
 *       查不到时如实说明，禁止编造航班号与时刻。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CACHE_DIR = path.join(__dirname, '.flight_cache');
const ROUTES_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat';
const AIRPORTS_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat';

// 常用中国城市 → 机场三字码（首选主机场；多机场城市在结果中一并列出）
const CN_CITY_AIRPORTS = {
  '北京': ['PEK', 'PKX'], '上海': ['SHA', 'PVG'], '广州': ['CAN'], '深圳': ['SZX'],
  '南宁': ['NNG'], '百色': ['AEB'], '桂林': ['KWL'], '柳州': ['LZH'], '北海': ['BHY'],
  '成都': ['CTU', 'TFU'], '重庆': ['CKG'], '昆明': ['KMG'], '贵阳': ['KWE'], '西安': ['XIY'],
  '杭州': ['HGH'], '南京': ['NKG'], '武汉': ['WUH'], '长沙': ['CSX'], '郑州': ['CGO'],
  '天津': ['TSN'], '青岛': ['TAO'], '厦门': ['XMN'], '福州': ['FOC'], '海口': ['HAK'],
  '三亚': ['SYX'], '南昌': ['KHN'], '合肥': ['HFE'], '济南': ['TNA'], '太原': ['TYN'],
  '沈阳': ['SHE'], '大连': ['DLC'], '哈尔滨': ['HRB'], '长春': ['CGQ'], '石家庄': ['SJW'],
  '宁波': ['NGB'], '温州': ['WNZ'], '无锡': ['WUX'], '珠海': ['ZUH'], '揭阳': ['SWA'],
  '湛江': ['ZHA'], '汕头': ['SWA'], '银川': ['INC'], '兰州': ['LHW'], '西宁': ['XNN'],
  '乌鲁木齐': ['URC'], '呼和浩特': ['HET'], '拉萨': ['LXA'], '丽江': ['LJG'], '大理': ['DLU'],
  '香港': ['HKG'], '澳门': ['MFM'], '台北': ['TPE', 'TSA'], '高雄': ['KHH'],
};

// 补充机场表：OpenFlights 的 airports.dat 对中国机场覆盖不全（实测缺 张掖 YZY、嘉峪关 JGN、
// 敦煌 DNH 等，一给三字码就报"无法识别"）。这里内置一份"城市 → 三字码"补充，并给出机场名。
// ⚠ 本表只用于**给出候选三字码**；是否存在该机场、有无航班，仍以实时查询为准。
const CN_AIRPORTS_EXTRA = {
  YZY: ['张掖', '张掖甘州机场'], JGN: ['嘉峪关', '嘉峪关机场'], DNH: ['敦煌', '敦煌莫高国际机场'],
  KHG: ['喀什', '喀什徕宁国际机场'], HTN: ['和田', '和田昆冈机场'], AKU: ['阿克苏', '阿克苏红旗坡机场'],
  KRL: ['库尔勒', '库尔勒梨城机场'], YIN: ['伊宁', '伊宁机场'], AAT: ['阿勒泰', '阿勒泰雪都机场'],
  KRY: ['克拉玛依', '克拉玛依机场'], HMI: ['哈密', '哈密伊州机场'],
  JHG: ['西双版纳', '西双版纳嘎洒国际机场'], DIG: ['香格里拉', '迪庆香格里拉机场'],
  TCZ: ['腾冲', '腾冲驼峰机场'], JZH: ['九寨沟', '九寨黄龙机场'], DCY: ['稻城', '稻城亚丁机场'],
  LZY: ['林芝', '林芝米林机场'], RKZ: ['日喀则', '日喀则和平机场'], YUS: ['玉树', '玉树巴塘机场'],
  GOQ: ['格尔木', '格尔木机场'], ENY: ['延安', '延安南泥湾机场'], UYN: ['榆林', '榆林榆阳机场'],
  HZG: ['汉中', '汉中城固机场'], DSN: ['鄂尔多斯', '鄂尔多斯伊金霍洛机场'], BAV: ['包头', '包头东河机场'],
  CIF: ['赤峰', '赤峰玉龙机场'], HLD: ['海拉尔', '呼伦贝尔海拉尔机场'], NZH: ['满洲里', '满洲里西郊机场'],
  OHE: ['漠河', '漠河古莲机场'], YNJ: ['延吉', '延吉朝阳川机场'], NBS: ['长白山', '长白山机场'],
  WEH: ['威海', '威海大水泊机场'], YNT: ['烟台', '烟台蓬莱国际机场'], LYI: ['临沂', '临沂启阳机场'],
  XUZ: ['徐州', '徐州观音国际机场'], CZX: ['常州', '常州奔牛国际机场'], NTG: ['南通', '南通兴东国际机场'],
  LYG: ['连云港', '连云港花果山机场'], HSN: ['舟山', '舟山普陀山机场'], YIW: ['义乌', '义乌机场'],
  TXN: ['黄山', '黄山屯溪国际机场'], KOW: ['赣州', '赣州黄金机场'], DYG: ['张家界', '张家界荷花国际机场'],
  TEN: ['铜仁', '铜仁凤凰机场'], ACX: ['兴义', '兴义万峰林机场'], AVA: ['安顺', '安顺黄果树机场'],
  BSD: ['保山', '保山云端机场'], LUM: ['芒市', '德宏芒市机场'], MIG: ['绵阳', '绵阳南郊机场'],
  LZO: ['泸州', '泸州云龙机场'], YBP: ['宜宾', '宜宾五粮液机场'], WXN: ['万州', '万州五桥机场'],
  ENH: ['恩施', '恩施许家坪机场'], YIH: ['宜昌', '宜昌三峡机场'], XFN: ['襄阳', '襄阳刘集机场'],
  NNY: ['南阳', '南阳姜营机场'], LYA: ['洛阳', '洛阳北郊机场'], YCU: ['运城', '运城张孝机场'],
  DAT: ['大同', '大同云冈机场'],
};
// 城市名 → 补充表里的三字码（供 resolveAirports 用）
const CN_EXTRA_BY_CITY = (() => {
  const m = {};
  for (const [code, [city]] of Object.entries(CN_AIRPORTS_EXTRA)) {
    if (!m[city]) m[city] = [];
    m[city].push(code);
  }
  return m;
})();

// 常用航司两字码 → 中文名（便于方案展示）
const AIRLINE_CN = {
  CA: '国航', CZ: '南航', MU: '东航', HU: '海航', ZH: '深航', MF: '厦航', '3U': '川航',
  SC: '山航', FM: '上航', GS: '天津航空', JD: '首都航空', HO: '吉祥航空', '9C': '春秋航空',
  KN: '中联航', PN: '西部航空', EU: '成都航空', GJ: '长龙航空', BK: '奥凯航空',
  NS: '河北航空', RY: '江西航空', GX: '北部湾航空', QW: '青岛航空', DR: '瑞丽航空',
  KY: '昆明航空', TV: '西藏航空', '8L': '祥鹏航空', CN: '大新华航空', OQ: '重庆航空',
  A6: '湖南航空', GT: '桂林航空', FU: '福州航空', HX: '香港航空', CX: '国泰航空',
  NX: '澳门航空', BR: '长荣航空', CI: '中华航空', IT: '台湾虎航', UO: '香港快运',
  HB: '大湾区航空',
};
function airlineLabel(code) { return AIRLINE_CN[code] ? `${code}(${AIRLINE_CN[code]})` : code; }

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  return await res.text();
}

function cachePath(name) { return path.join(CACHE_DIR, name); }

// 数据缓存 30 天（静态社区数据，无需频繁更新）
async function loadData(name, url) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const p = cachePath(name);
    if (fs.existsSync(p) && Date.now() - fs.statSync(p).mtimeMs < 30 * 864e5) {
      return fs.readFileSync(p, 'utf8');
    }
    const txt = await fetchText(url);
    fs.writeFileSync(p, txt, 'utf8');
    return txt;
  } catch (e) {
    // 下载失败时退回旧缓存（若有）
    const p = cachePath(name);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    throw e;
  }
}

function parseCsvLine(line) {
  // 简易 CSV 解析（支持引号包裹）
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

async function loadAirports() {
  const txt = await loadData('airports.json', AIRPORTS_URL);
  const map = new Map();      // IATA -> {code, name, city, country}
  const byCity = new Map();   // city(小写) -> [code...]
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    // AirportID,Name,City,Country,IATA,ICAO,...
    const iata = f[4];
    if (!iata || iata === '\\N' || !/^[A-Z]{3}$/.test(iata)) continue;
    const rec = { code: iata, name: f[1], city: f[2], country: f[3] };
    map.set(iata, rec);
    const ck = (f[2] || '').toLowerCase();
    if (ck) { if (!byCity.has(ck)) byCity.set(ck, []); byCity.get(ck).push(iata); }
  }
  return { map, byCity };
}

async function loadRoutes() {
  const txt = await loadData('routes.json', ROUTES_URL);
  const routes = [];  // {airline, from, to, stops}
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    // Airline,AirlineID,Source,SourceID,Dest,DestID,Codeshare,Stops,Equipment
    if (!f[2] || !f[4]) continue;
    routes.push({ airline: f[0], from: f[2], to: f[4], stops: f[7] });
  }
  return routes;
}

// 解析用户输入 → IATA 列表
function resolveAirports(input, airports) {
  const raw = input.trim();
  if (/^[A-Za-z]{3}$/.test(raw)) {
    // 三字码一律接受——**不能因为开源库没收录就报"无法识别"**（实测踩过：
    // 张掖 YZY、嘉峪关 JGN 等不在 airports.dat 里，导致误判成"这地方没机场"）。
    return [raw.toUpperCase()];
  }
  if (CN_CITY_AIRPORTS[raw]) return CN_CITY_AIRPORTS[raw];
  // 中文名去掉"市/机场"等后缀再试
  const cleaned = raw.replace(/[市机場场]/g, '');
  if (CN_CITY_AIRPORTS[cleaned]) return CN_CITY_AIRPORTS[cleaned];
  if (CN_EXTRA_BY_CITY[cleaned]) return CN_EXTRA_BY_CITY[cleaned];
  // 英文城市名
  const hits = airports.byCity.get(raw.toLowerCase()) || [];
  return hits;
}
// 该三字码是否在开源库里（用来区分"库里没收录"与"这方向确实没直飞记录"）
const knownToOpenFlights = (code, airports) => airports.map.has(code);

function airportLabel(code, airports) {
  const a = airports.map.get(code);
  if (a) return `${code}(${a.city}·${a.name})`;
  const e = CN_AIRPORTS_EXTRA[code];
  return e ? `${code}(${e[0]}·${e[1]}，开源库未收录)` : code;
}

(async () => {
  const args = process.argv.slice(2);
  const [cmd, ...rest] = args;
  if (cmd === '--help' || cmd === '-h') {
    console.log([
      'flight.js —— 用开源航线库判断"这两地之间历史上有没有直飞、哪家航司飞过"',
      '',
      '用法:',
      '  node scripts/flight.js route <出发> <到达>',
      '  node scripts/flight.js airport <关键词>',
      '  node scripts/flight.js cities',
      '',
      '  route     查航线：有无直飞、条数、承运航司（含中文名）',
      '  airport   查机场：中文城市名 / 英文 / 三字码',
      '  cities    列出内置的中文城市 → 机场对照表',
      '',
      '数据边界（必须遵守）:',
      '  · 本库是**社区历史快照**：不含班期、时刻、票价、余票，也**不代表该航线目前仍在执飞**。',
      '  · 只能用来**初步判断"该方向有没有直飞"**、避免凭空编造。',
      '  · **严禁**据它宣称"有航班 / 可以坐飞机过去"——是否在飞、班期与价格必须用 web_search 实时确认。',
      '  · 实时查询与本库冲突时**以实时结果为准**。',
      '  · 目的地**无机场**（如东莞）会明确报"无法识别机场"，此时改用最近机场并写明落地机场。',
      '',
      '缓存: 数据首次运行自动下载，缓存 30 天（scripts/.flight_cache/）。',
      '退出码: 0 = 成功；1 = 参数错误 / 无法识别机场。',
      '',
      '注意: 不要读本脚本源码——用 --help 就够了。',
    ].join('\n'));
    process.exit(0);
  }
  const airports = await loadAirports();

  if (cmd === 'cities') {
    const lines = Object.entries(CN_CITY_AIRPORTS).map(([city, codes]) => `${city}: ${codes.join(' / ')}`);
    console.log('内置中文城市 → 机场对照（共 ' + lines.length + ' 个城市）\n' + lines.join('\n'));
    const extraLines = Object.entries(CN_EXTRA_BY_CITY).map(([city, codes]) => `${city}: ${codes.join(' / ')}`);
    console.log('\n补充对照（开源航线库未收录，仅供取三字码；共 ' + extraLines.length + ' 个城市）\n' + extraLines.join('\n'));
    console.log('\n⚠ 三字码只用来发起实时查询；是否有航班 / 具体班次与票价一律以 web_search 与机场官网为准。');
    return;
  }

  if (cmd === 'airport') {
    const kw = rest[0];
    if (!kw) throw new Error('用法: node flight.js airport <关键词>');
    if (/^[A-Za-z]{3}$/.test(kw)) {
      const a = airports.map.get(kw.toUpperCase());
      console.log(a ? JSON.stringify(a, null, 2) : `未找到机场: ${kw}`);
      return;
    }
    // 中文城市名 → 内置映射
    const cn = CN_CITY_AIRPORTS[kw] || CN_CITY_AIRPORTS[kw.replace(/[市机場场]/g, '')];
    if (cn) { console.log(cn.map(c => airportLabel(c, airports)).join('\n')); return; }
    // 补充表（开源库未收录的中国机场）
    const extra = CN_EXTRA_BY_CITY[kw] || CN_EXTRA_BY_CITY[kw.replace(/[市机場场]/g, '')];
    if (extra) { console.log(extra.map(c => airportLabel(c, airports)).join('\n')); return; }
    const byCityHits = airports.byCity.get(kw.toLowerCase()) || [];
    const nameHits = [...airports.map.values()].filter(a => (a.name || '').toLowerCase().includes(kw.toLowerCase()) || (a.city || '').includes(kw)).slice(0, 15);
    const codes = [...new Set([...byCityHits, ...nameHits.map(a => a.code)])].slice(0, 15);
    if (!codes.length) { console.log(`未找到机场: ${kw}（中文城市请先用 node flight.js cities 查看内置对照）`); return; }
    console.log(codes.map(c => airportLabel(c, airports)).join('\n'));
    return;
  }

  if (cmd === 'route') {
    const [fromRaw, toRaw] = rest;
    if (!fromRaw || !toRaw) throw new Error('用法: node flight.js route <出发> <到达>');
    const fromCodes = resolveAirports(fromRaw, airports);
    const toCodes = resolveAirports(toRaw, airports);
    if (!fromCodes.length) { console.error(`无法识别出发地机场: ${fromRaw}（可用 IATA 三字码或 node flight.js cities 查看内置城市）`); process.exit(1); }
    if (!toCodes.length) { console.error(`无法识别目的地机场: ${toRaw}（可用 IATA 三字码或 node flight.js cities 查看内置城市）`); process.exit(1); }

    const routes = await loadRoutes();
    // 「本库对其覆盖不可用」的机场——分两种，必须分开说，不得混为一谈：
    //   ① 机场表未收录（连机场本身都没有，如成都天府 TFU）
    //   ② 机场表有、但**航线表里该机场零记录**（如北京大兴 PKX——2019 年启用，本库航线停在 2014 年）
    // 根源都是「本库覆盖不全」，**一律不等于"当地没有机场"**，也**不等于"没有直飞"**。
    // ⚠ 必须在循环之前快照：循环里每次 filter 返回新数组，事后比较等于白比。
    const noRoute = new Map();
    for (const c of [...new Set([...fromCodes, ...toCodes])]) {
      const n = routes.reduce((a, r) => a + (r.from === c || r.to === c ? 1 : 0), 0);
      if (!n) noRoute.set(c, n);
    }
    let found = 0;
    for (const fc of fromCodes) {
      for (const tc of toCodes) {
        const hits = routes.filter(r => r.from === fc && r.to === tc);
        if (!hits.length) continue;
        found += hits.length;
        const direct = hits.filter(h => h.stops === '0');
        const airlines = [...new Set(hits.map(h => h.airline))];
        const directAirlines = [...new Set(direct.map(h => h.airline))];
        console.log(`${airportLabel(fc, airports)} → ${airportLabel(tc, airports)}`);
        console.log(`  航线记录 ${hits.length} 条；直飞 ${direct.length} 条`);
        console.log(`  承运航司: ${airlines.map(airlineLabel).join(', ')}`);
        if (directAirlines.length !== airlines.length) console.log(`  其中直飞航司: ${directAirlines.map(airlineLabel).join(', ')}`);
      }
    }
    // 显式点名所有「本库覆盖不可用」的机场——不得让它们静默消失
    const uncovered = [...noRoute.keys()];
    if (uncovered.length && found) {
      // 已查到直飞 → 结果不受覆盖缺失影响：不再打整段覆盖告警，只留"本次只列有记录的机场对"
      console.log('⚠ 本次仅列出库中有直飞记录的机场对；多机场城市须逐个机场核（详见 SKILL.md「覆盖判据」）。');
    }
    if (!found) {
      // 显式点名所有「本库覆盖不可用」的机场——不得让它们静默消失
      const inAirportsTable = uncovered.filter(c => knownToOpenFlights(c, airports));
      const notInAirportsTable = uncovered.filter(c => !knownToOpenFlights(c, airports));
      console.log(`${fromRaw}(${fromCodes.join('/')}) → ${toRaw}(${toCodes.join('/')}) 在开源航线库中${uncovered.length ? `（其含 ${uncovered.length} 个未覆盖机场，**本结论不可用**）` : ''}未查到直飞记录。`);
      console.log('说明：可能是本就无直飞（需中转），或该航线为库里未收录/已停飞——请以实时购票平台查询为准。');
      if (uncovered.length) {
        console.log('');
        console.log('⚠ 覆盖不可用（**只说明"本库没覆盖"，不代表"当地没有机场"，也不代表"该方向没有直飞"**）：');
        if (inAirportsTable.length) {
          console.log(`  · 机场在库中、但**航线表里零记录**：${inAirportsTable.map(c => airportLabel(c, airports)).join('、')}`);
        }
        if (notInAirportsTable.length) {
          console.log(`  · **机场表未收录**（连机场本身都没有）：${notInAirportsTable.map(c => airportLabel(c, airports)).join('、')}`);
        }
        console.log('  → 必须用 web_search 查该方向实时航班（**含中转**），或用机场官网时刻表核对；');
        console.log('     多机场城市（北京 PEK/PKX、上海 SHA/PVG、成都 CTU/TFU）**要逐个机场核**，本库常只收录其中一个。');
      }
    } else {
      console.log('\n注意：以上为开源航线库的**历史快照**，仅说明该方向历史上存在直飞航线记录，');
      console.log('      **不代表目前仍在执飞**，也不含班期/时刻/票价/余票——是否在飞与具体班次须实时查询确认。');
    }
    return;
  }

  console.error('未知命令: ' + cmd + '\n用法:\n  node flight.js route <出发> <到达>\n  node flight.js airport <关键词>\n  node flight.js cities');
  process.exit(1);
})().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
