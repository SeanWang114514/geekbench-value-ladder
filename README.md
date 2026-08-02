# GPU / CPU Geekbench 性能与性价比天梯图

单文件 HTML 网页，展示显卡和 CPU 的 Geekbench 性能排行与性价比排行（跑分 ÷ 人民币价格），页面风格参考 cpuranklist。

## 功能

- 显卡 / CPU 切换，性能榜 / 性价比榜切换
- 品牌筛选、搜索、加载更多
- 性能榜展示全部跑分型号；性价比榜只展示已匹配到 ZOL 价格的桌面型号
- 价格取 ZOL 电商最低报价（无电商报价时取参考价），本地服务模式下打开页面自动更新价格，每日一次
- 跑分默认使用内置数据，可在页面右上角“设置”中手动重新抓取

## 数据来源

- Geekbench 跑分：[cpuranklist GPU](https://cpuranklist.com/gpu-geekbench.php)、[cpuranklist CPU](https://cpuranklist.com/cpu-geekbench.php)
- 人民币价格：[ZOL 显卡](https://detail.zol.com.cn/vga/)、[ZOL CPU](https://detail.zol.com.cn/cpu/)

数据抓取时间见 `data.json` 中的 `fetchedAt` 字段。

## 使用

- 直接打开 `index.html` 即可查看静态快照（GitHub Pages 同款模式）
- 本地自动更新价格：`node server.mjs`，然后打开 http://127.0.0.1:8765
- 更新数据：`node scrape.mjs`（自动抓取并匹配型号，结果写入 `data.json`）
- 重新生成页面：`node build.mjs`（把 `data.json` 内嵌进 `index.html`）

## 在线访问

GitHub Pages（静态快照）：https://SeanWang114514.github.io/geekbench-value-ladder/

GitHub Pages 是纯静态托管，无法运行自动抓取，展示的是最后一次内嵌的数据快照；价格每日自动更新需要本地运行 `node server.mjs`。

## 文件说明

- `scrape.mjs`：抓取跑分与价格、型号匹配
- `server.mjs`：本地服务，提供每日价格更新与手动刷新跑分接口
- `data.json`：抓取结果（跑分、价格、价格来源）
- `index.template.html` + `build.mjs`：生成最终页面
- `index.html`：最终交付的单文件网页
