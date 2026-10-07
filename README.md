# public-transit（公共交通）

DSH 技能：**公共交通路线规划** —— 只做「出发地 → 目的地」的**公共交通**路线（**铁路 + 空中**），**不**做自驾等城际道路交通，也**不含**景点与游玩安排。定位是「为达目的地不择手段」：**直达 / 官方中转 / 自拼枢纽 / 空中（含转机）/ 借道邻近城市** 五类候选并列计算，穷尽之前不得说「不可达」。

- **交付物**：单文件 HTML（零外链零依赖，双击即用浏览器打开）；**不产出 PDF**。
- **硬口径**：三段输出（最省钱 1 + 最快 1 + 额外 ≥2）、价格必标票种、换乘余量门槛、`flight.js` 覆盖判据等，**一律以 `SKILL.md` 为准**。
- 本技能是 `travel` 拆出的「公共交通」部分（景点与行程在 `travel`）。

## 目录结构

```
SKILL.md                 技能正文（流程、门禁与硬性口径）
references/              按需加载的参考手册
  air-fallback.md          空中兜底 / 转机 / 取数降级
  borrow-city.md           借道邻近城市（正常候选，非兜底）
  seat-and-window-rules.md 席别与时间窗口规则
  no-ticket-fallback.md    无票兜底（买长乘短 / 补票）
scripts/                 可复用脚本
  12306.js  plan.js  flight.js  make_html.js  check_html.js
```

## 使用

把本目录放进 DSH 技能目录（例如 `~/.dsh/skills/public-transit/`），或让 DSH 从本仓库加载；技能入口是 `SKILL.md`。

## 版本

**V1.0.0** —— 首个发布版本（对应 tag `v1.0.0`）。

## 说明

- 运行时会自动生成缓存（`.flight_cache/`、`.stations_cache.json` 等），已在 `.gitignore` 中排除，首次运行自动下载。
- 脚本依赖本机 Node.js 与 Microsoft Edge（用于 HTML 出品校验）。
- 数据底线：不编造班次与价格；数据来源只写在聊天回复里，不进网页。
