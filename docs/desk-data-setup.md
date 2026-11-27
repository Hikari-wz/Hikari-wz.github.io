# 首次启用、迁移和恢复

hikari-desk 已连接并应用两份版本化结构迁移，安全扫描通过；前端尚未上线，也未迁移个人数据。PR 保持 draft，账号配置已复查通过；真实账号端到端测试和真机验收完成后再审阅部署。

## 用户创建免费项目

1. 登录 [Supabase Dashboard](https://supabase.com/dashboard)，创建 Free 项目。不要选择付费套餐。数据库密码仅由你在 Dashboard/安全密码管理器保管。
2. 在 Authentication → Providers / Sign In 配置关闭 **Allow new users to sign up** 和匿名登录；不要仅依赖隐藏注册按钮。通过 Dashboard → Authentication → Users 创建你自己的邮箱/密码账号。若需要邮箱确认，由你在邮箱内完成。
3. 新项目须按文件名顺序执行仓库内两份 migration，或在本机已授权 Supabase CLI 中 link 后执行 `supabase db push`。hikari-desk 已应用，勿重复手工执行。不要在聊天或公开 GitHub 中粘贴数据库密码、Secret / Service Role Key 或 Auth session。
4. 提供项目 URL 和 **Publishable Key** 即可接入前端。Publishable/旧 anon key 是公开配置，安全依赖 RLS 和 RPC 权限。
5. 构建环境设置 `.env.example` 所列三个 PUBLIC 变量。`PUBLIC_DESK_DATA_MODE=cloud` 缺少配置会构建失败；不会悄悄改用 local。GitHub Pages 的 build 阶段配置相同仓库变量。前端托管继续为 Pages，不需要新服务器。

参考：[官方 RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[Auth 配置](https://supabase.com/docs/guides/auth/general-configuration)、[公开客户端 Key](https://supabase.com/docs/guides/api/api-keys)。不要假设免费套餐提供项目所需的自动备份。

## 首次登录和多来源迁移

1. 在各原始浏览器、设备、PWA 分别导出旧 JSON。如果已可访问新版 `/desk/data/`，其中“导出当前浏览器原始旧数据”无需登录，可以保留 state store 的原始 current 和恢复副本。云端故障时该导出也可用。
2. 把每个文件按来源和日期命名，保存在 iCloud Drive 或你控制的文件夹，额外留一份离线副本。原始私人 JSON 不提交仓库。
3. 联网打开已正确配置的新版 `/desk/data/`，用预先创建的账号登录。每个浏览器需要分别登录。
4. 选择一个来源文件。检查新增、重复、未解决冲突、无法识别项和学习记录条数/分钟对账。无法识别格式或无效关联会拒绝整个文件，不部分写入。
5. 逐项确认课程设置、学期、预算、计时及历史配置冲突。不同 id 同内容的记录也必须由你判断两次学习还是重复。配置项的“使用来源”只对该业务聚合生效，可能替换其中嵌套配置，需阅读展开的两份内容。
6. 点击“确认合并到云端”。只有队列完成且云端重新读取成功，才显示云端确认。若离线、失败或冲突，原始文件与本地队列仍保留。
7. 逐份重复；相同稳定 id 和内容重复导入不新增记录。每份完成后核对条数、总时长、课程归属、历史预算和未完成计时。不要同时在多个来源运行同一个旧计时器。
8. 最后在数据中心导出完整云端备份，在另一登录环境验证 Study/Academic、计时、设置和成果。用户确认完成前不删除任一原始数据；本实现没有自动删除原库功能。

当旧版窗口阻止升级时关闭它再刷新。原库版本栅栏只在当前浏览器分区生效；无法自动保护尚未访问新版的其他浏览器，它们都要单独导出和升级。

## 日常备份及安全恢复

- 数据中心“导出完整云端备份”必须联网成功读取，文件包含删除墓碑、版本和校验和。建议完成一批迁移、重要修改和每周复盘后各保留一份。
- “导出缓存与待同步队列”可保留当前账号尚未同步的操作；恢复时选该文件进行预览。普通云端备份不包含尚未提交到服务器的队列。
- Study/Academic 原 JSON 导出继续可用，导出的是当前可见数据（可能包含待同步修改），不含云端墓碑。完整云端灾备优先使用数据中心。
- 普通导入始终合并并预览，不会先清空云端。不确定选择先保留云端和原文件；确认后可再次导入。
- 冲突队列：先导出，再确认放弃本设备队列，重新读取云端，把导出文件作为来源合并。若要恢复被删除记录，确认后以新记录 id 补录；原墓碑不删除。队列中被放弃的删除要在原业务界面重新确认。
- 如整个 Supabase 项目丢失：创建新的 Free 项目和账号，应用 migration，配置新 URL/Publishable Key，登录后导入完整备份。业务记录可合并恢复，旧账号 UUID、Auth session 和操作收据不会迁移；来源删除墓碑也会恢复，防止后续旧备份让已删除记录复活。遇到来源删除与云端现存记录冲突时，必须明确确认删除或保留云端。验证后保留原备份。
- 当前文件导入上限为 64 MiB；云端 API 对请求大小/执行时间还可能有更低限制。大文件安全失败不表示迁移成功，不能删除旧数据。当前没有分块上传工具。

## 上线前验收

自动化命令：`npm ci && npm run check && npm run build` 和 `npm run test:desk`。原有浏览器脚本验证显式 local 模式；本地已有 `.env.local` 时先用 `PUBLIC_DESK_DATA_MODE=local npm run build` 构建，再运行 `npm run test:study`、`npm run test:academic`、`npm run test:browser`、`python3 scripts/verify.py` 和 `PUBLIC_DESK_DATA_MODE=local npm run test:content`。上线构建必须重新使用 cloud 配置，CI 会在原有回归后重建。

`test:desk` 使用本地 PostgreSQL 和模拟 Auth/Data API；必须另在真实项目运行 `node scripts/test-desk-live.mjs`。该脚本读取本地环境变量 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`DESK_TEST_EMAIL_A` / `DESK_TEST_PASSWORD_A`、`DESK_TEST_EMAIL_B` / `DESK_TEST_PASSWORD_B`。用两个专用合成测试账号，在新建的无私人数据项目测试；不要把生产账号或真实记录用于写入测试。凭证只通过本机环境传入，不记录或提交。

真实 iPhone Safari、Chrome、主屏幕 App，MacBook 和 Windows 分别检查：登录、2 小时高数记录的增改删及 Academic 更新、关闭重开、后台恢复、离线计时/补录、恢复网络、队列冲突和退出隐私。模拟 iPhone 尺寸的 Chrome 结果不等于这些真机通过。

## 无需向助手提供密码的真实 API 权限验收

先在专用测试账号导入合成验收学期，用主账号在另一个 origin（如 localhost 对应原来的 127.0.0.1）亲自登录，保持会话分开。页面会显示当前账号。主账号须尚无业务数据。

验收使用 `scripts/prepare-live-probe.mjs` 读取外部临时配置 JSON（放在 `/tmp`，不提交仓库）。配置包含主账号 UUID、测试账号 UUID 和专用 `term-test` 学期的当前 kind/id/ordinal/version/payload。脚本只接受名称同时含“合成验收”和“测试专用”的学期，不接受密码、JWT 或高权限密钥。

在已完成正常 cloud 构建后运行 `node scripts/prepare-live-probe.mjs /tmp/hikari-live-probe-config.json`。从与主账号登录相同的 origin 打开 `/desk/acceptance/`。此页通过官方 SDK 验证当前账号，只有匹配预期主账号才允许运行；结果只显示检查名称、通过状态和错误码。会检查跨用户查询、直接修改/删除权限、伪造 RPC 行归属、收据读取和匿名请求。删除权限探测使用不存在的目标，不删除真实记录。更新探测使用测试学期原 payload，不变更业务内容。

该页仅生成在被忽略的本地 dist 目录中，正常 Astro build 会将其清除；正式 CI 不运行准备脚本，因此不会把验收页发布到 GitHub Pages。
