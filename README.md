# GPU / CPU Geekbench 性能与性价比天梯图

一个展示显卡（GPU）和 CPU 的 Geekbench 跑分排行与性价比排行的单文件网页。性价比 = Geekbench 跑分 ÷ 人民币价格，页面风格参考 cpuranklist，支持桌面型号的筛选、搜索和来源可追溯的价格标签。

## 功能

- 显卡 / CPU 切换，性能榜 / 性价比榜切换
- 按品牌筛选（NVIDIA 绿色、AMD 红色、Intel 蓝色、Apple 黑色）、搜索型号、加载更多
- 价格标签显示来源（ZOL 电商价 / 参考价、苏宁估价等），点击可直接跳转到对应详情页或电商搜索页
- 本地服务模式下打开页面自动抓取当日价格（每日一次）；隐藏参考价时自动为仅有参考价的型号抓取电商估价（先 ZOL 详情页，再苏宁无头浏览器兜底），并显示成功 / 失败数量，失败型号从性价比榜移除
- 跑分默认使用内置数据，可在页面右上角“设置”中手动重新抓取

## 数据来源

- Geekbench 跑分：[cpuranklist GPU](https://cpuranklist.com/gpu-geekbench.php)、[cpuranklist CPU](https://cpuranklist.com/cpu-geekbench.php)
- 人民币价格：[ZOL 显卡](https://detail.zol.com.cn/vga/)、[ZOL CPU](https://detail.zol.com.cn/cpu/)，电商估价兜底为[苏宁易购](https://www.suning.com/)搜索

数据抓取时间见 `data.json` 中的 `fetchedAt` 字段。

## 使用

- 直接打开 `index.html` 即可查看静态快照（GitHub Pages 同款模式）
- 本地自动更新价格：`node server.mjs`，然后打开 http://127.0.0.1:8765
- 刷新跑分 / 重新抓取：页面右上角“设置”中操作；底层数据由 `server.mjs` 写入 `data.json`
- 重新生成页面：`node build.mjs`（把 `data.json` 内嵌进 `index.html`）

## 在线访问

GitHub Pages（静态快照）：https://SeanWang114514.github.io/geekbench-value-ladder/

GitHub Pages 是纯静态托管，无法运行自动抓取，展示的是最后一次内嵌的数据快照；每日价格更新和电商估价需要本地运行 `node server.mjs`。

## 文件说明

- `scrape.mjs`：抓取跑分与价格、电商估价、型号匹配
- `server.mjs`：本地服务，提供每日价格更新、电商估价与手动刷新跑分接口
- `data.json`：抓取结果（跑分、价格、来源、ZOL ID）
- `index.template.html` + `build.mjs`：生成最终页面
- `index.html`：最终交付的单文件网页
