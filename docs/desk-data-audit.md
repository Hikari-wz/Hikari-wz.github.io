# 当前实现核查（2026-11-27）

基线：远端 main `3ba7a01`，包含 PR #8 和 #9。实际抓取 `https://hikari.wang/desk/study/` 与 `/desk/academic/`；两者均返回正式页面，仍描述本地存储。实施前核查时未修改正式站或用户数据；随后在确认新 Supabase 项目没有用户业务表和 Auth 用户后，仅新增结构。具体结果见 desk-data-test-results.md。

## 模型及存储

- Study 的 `model.ts` 定义设置、课程/项目统一注册表 `subjects`、考试、按周计划及预算快照、学习记录、单个计时器和按周复盘。
- Academic 的 `model.ts` 在同一 DeskData 中增加学期（内嵌课程和阶段路线）、考核与任务、学习成果、资料、配置历史、权重调整、下次行动及别名。不另建学习记录表。课程外键一直为 `subjectId`。
- 两个 app 都调用 `study/storage.ts` 的 `openStudyRepository()`，数据库名都为 `hikari-study-dashboard`，版本 2，`state` store 的 `current` key 是同一个 v2 envelope。`BroadcastChannel('hikari-study-dashboard')`、窗口聚焦与页面恢复触发刷新。Academic 定时重新计算；Study 原来只在本地通知和页面恢复时读取。
- Study v1 → v2 迁移通过 `migrateStudy` 增补 Academic。旧 service worker readiness 检查先于旧库升级；旧 v1 页用数据库版本隔离。升级失败有只读 v1 导出与恢复路径。
- `localStorage` 仅发现主题设置 `hikari-theme`（布局及 ThemeControl），不属于学业数据；没有另一个 Academic 业务数据库或 sessionStorage 业务副本。Supabase SDK 新增 Auth session 本地持久化。
- 未完成计时 `timer` 保存稳定 id、学习日期、课程、startedAt、elapsedMs 和 runningSince，时间由时间戳计算；结算时使用同一个 id 创建 session 并清空 timer。不是每秒累加存储。
- v1/v2 JSON 导入经格式、日期、关联和预算完整性检查；UTF-8 大小上限 64 MiB。原恢复是确认后的整库替换，仅继续用于显式 local 模式；cloud 模式入口转向统一数据中心合并。

## 同域共享问题的证据边界

当前源码不存在 Study/Academic 各建一份记录的实现。在同 origin、同一浏览器存储分区、同一个当前版本下，使用的是同一主记录。现有回归测试验证此路径；无法仅凭用户现象认定同分区共享仍有代码错误。

不同浏览器、设备、主屏幕容器的隔离会造成不同库；旧缓存页面、不同 origin（http/https 或其他主机名）、不同浏览器配置及未更新页面也需要在用户实际环境核对。本次没有访问用户那些环境，也没有将推测报告为已复现根因。数据中心原始导出可以帮助核查每个来源；原始文件只由用户下载保存。

## 构建及现有测试

- Astro + TypeScript + Tailwind，静态 GitHub Pages；`scripts/study-pwa.mjs` 构建 Study 离线壳，worker 只缓存本站静态路径，不缓存 Supabase API。
- `.github/workflows/pages.yml` 对 PR 执行依赖审计、类型检查、构建、链接/内容测试及 Study、Academic、网站 Chrome 回归；只有 main push/workflow_dispatch 才部署。
- 现有单元测试覆盖阶段、三轨分配、时区/DST、预算历史、推荐、成果、权重调整和大备份。浏览器测试覆盖计时、补录、课程、考试/任务互转、历史、恢复、移动宽度和旧离线壳升级。
- 本次新增 `test:desk`：真实本地 PostgreSQL（PGlite）执行迁移与权限测试；两个隔离 Chrome context 使用本地 Auth/Data API 测试服务。该服务不等同于 Supabase 云端 Auth，也不等同于真实手机。
