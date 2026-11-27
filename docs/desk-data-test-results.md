# 数据层交付与验证记录

日期：2026-11-27（Asia/Shanghai）。基线 main：`3ba7a01`。本次前端仅独立分支和 draft PR 交付，未部署到正式网站；个人旧数据尚未导入。

## 已完成

| 检查 | 结果及边界 |
| --- | --- |
| Astro 类型检查 | 0 errors / 0 warnings / 0 hints |
| 原有 + 新增单元/数据库测试 | 23 项全部通过（19 项原有、4 项 Desk；每项可包含多个断言） |
| 真实项目配置的 cloud 构建 | 成功；16 个页面，链接检查通过 |
| 显式 local 构建及链接检查 | 成功；16 个页面、632 个内部引用 |
| 原有内容测试 | 通过：draft、demo、空页面、发布、分类、封面和冲突路由 |
| 原有网站 Chrome 回归 | 通过：15 条已列路由、5 个宽度、键盘、主题和 404 |
| 原有 Study Chrome 回归 | 通过：学习阶段、预算、补录、编辑/删除、课程归档、计时、复盘、备份、离线与 worker 更新 |
| 原有 Academic Chrome 回归 | 通过：课程/考试/任务、成果、权重、周报、坏库恢复、大备份、历史周及离线结算 |
| 新增 cloud Chrome 回归 | 通过下列全部场景；使用本地 Auth/Data API 测试服务与真实本地 PostgreSQL，不是 Supabase Auth 云端验收 |
| 真实 Supabase 新结构 | 两份 migration 成功应用，文件版本与云端 migration history 对齐 |
| 真实匿名 Data API | Publishable Key 直接调用 snapshot/commit、业务表 select、收据表 select 均被 42501 拒绝 |
| 真实 PostgreSQL 用户隔离 | `supabase/tests/rls_rollback.sql` 通过：两个临时用户、authenticated 角色、实际 auth.uid() 声明下验证自己的读取、他人不可读取、直接改/删被拒、跨用户 RPC 被拒。全事务回滚，结束时两张业务表和 Auth 用户数仍为 0 |
| Supabase 安全扫描 | 权限加固后 findings 为空。公开 RPC 为 invoker，definer 实现位于非暴露 desk_private；收据有明确拒绝策略；平台 auto-RLS 事件触发函数的客户端 EXECUTE 已撤销 |
| 性能扫描 | 仅新建索引未使用 INFO；尚无真实数据，不删除索引 |
| 公开配置 | `.env.local` 已被 Git 忽略；两个 PUBLIC 配置已设置为 Repository Variables；没有 Secret、Service Role Key 或数据库密码进入代码 |

新增 cloud 浏览器场景：

- 同一账号两个独立浏览器 context：Study 增改删高数记录，Academic 正确重新读取同一数据。
- 离线接受补录、离线重开、队列持久化、联网后自动提交。
- 服务器已提交但响应丢失：重试保持 UUID，不重复学习记录。
- 已有缓存读取失败保留数据；新环境首次读取失败不初始化空数据库。
- 远端删除与旧设备离线修改冲突：云端墓碑和本地待同步修改均保留，重开后仍明确显示冲突。
- 导出队列后确认放弃、重新读取云端；多来源迁移预览、确认后的记录/分钟对账、重复导入幂等。
- 完整云端备份导出、SHA-256 校验、向另一账号恢复时明确选择配置冲突、删除墓碑保留。
- 旧 v2 库提升为 v3 后原 current 数据逐字段相同，旧 v2 打开请求被 VersionError 拒绝。
- 同一计时器 id 在另一环境可见、重开可恢复、暂停并保存仅产生一条学习记录。
- 退出后页面不再显示私人内容；切换账号只显示该账号恢复的数据；iPhone 模拟宽度无水平溢出。

## 未完成及验收条件

- 已在真实项目复查：公开注册已关闭、匿名登录关闭；1 个邮箱已确认的个人账号，核查时尚无登录记录。真实登录仍需用户在预览中亲自输入凭证。
- 真实 Supabase Auth 的两个已登录账号端到端 API 测试尚未执行；已提供 `scripts/test-desk-live.mjs`，不可用本地模拟 Auth 或数据库角色声明测试替代此项。
- 原有 Academic 脚本在本轮提示 `ACADEMIC_LEGACY_DIST` 未提供，因此未重跑实际旧 v1 离线壳构建对照；常规旧数据/坏库路径已通过。本次新增 cloud 测试验证实际 v2 数据栅栏。
- 用户各浏览器/PWA 的真实原始数据、来源对账和不确定冲突选择尚未由用户提供或确认。
- iPhone Safari、iPhone Chrome、主屏幕 App、实际 MacBook/Windows、真实磁盘耗尽和系统存储回收未做真机验收。
- 文件上限 64 MiB、单个聚合/事务大小、云端请求限制及队列备份恢复方式详见架构与操作指南；超限不会被报告为迁移成功。
- 不合并、不部署前端，不删除旧数据，直到完成上述必要验收。

参考：[Supabase API 权限说明](https://supabase.com/docs/guides/api/securing-your-api)、[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[安全扫描说明](https://supabase.com/docs/guides/database/database-linter)。
