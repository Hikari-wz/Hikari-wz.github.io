# Desk 统一数据层

## 数据流

`Study / Academic → StudyRepository → Supabase Auth + desk_snapshot / desk_commit → PostgreSQL`

原业务计算函数保持原状。cloud 构建中两个模块走同一 repository 实现；从不因网络失败打开旧本地业务库。旧库只读导出。显式 local 构建仅供未启用云端的旧版回归，不是故障降级。

## 关系和版本

版本化迁移：`supabase/migrations/20261127031430_desk_unified_data_v1.sql`。部署通过 Supabase CLI `db push` 或 Dashboard SQL Editor 一次执行，随后由 migration history 管理，不重复执行建表脚本。

`desk_entities` 的复合主键为 `(user_id, kind, id)`，用户外键指向 auth.users。每行保存一个已有业务聚合的 JSONB payload、创建/更新时间、递增 version、ordinal 顺序和 deleted 墓碑。不是一个用户一行整个 Desk JSON。JSONB 保留业务已存在的嵌套结构，避免重写模型：

| kind | 标识及内容 |
| --- | --- |
| subjects | 统一课程/自主学习/项目注册表，以既有 id 标识 |
| sessions / exams | 学习记录 / 正式考试，各用既有 id |
| plans / reviews | 以周一日期标识的预算快照 / Study 复盘 |
| settings / timer | 单例 current，分别为个人设置和当前计时 |
| terms | 学期 id，内嵌当前课程配置及阶段路线 |
| assessments / results / materials | 任务考核 / 学习成果 / 资料，各用既有 id |
| academic | 单例 current：选定学期、其他课程 id、别名、下次行动 |
| versions | 已有有序配置历史列表（一个聚合）；同一时间点冲突须确认 |
| adjustments | 学期、周和确认时间组合标识，保存原始证据与权重调整历史 |

同属用户的课程、学期引用在提交事务结束前检查；Study → Academic 始终读取同一 sessions 和 subjects。旧算法、历史快照、时区、民用日期和权重常量未更改。派生统计与推荐不新增数据库表。现有大聚合（versions、单个 terms）仍可能发生聚合级冲突，明确提示，不自动覆盖。

## 权限

两张表启用 RLS。authenticated 仅获得自己 desk_entities 的 select policy。anon 无表权限；客户端无任何直接 insert/update/delete grant。desk_operations 无客户端表权限，并有明确的拒绝策略。公开 RPC 是 SECURITY INVOKER 包装器，调用非暴露 desk_private schema 内的 SECURITY DEFINER 实现；使用空 search_path、固定 schema 和 auth.uid()，忽略请求中的 user_id。公开角色无 RPC execute，authenticated 才可执行。

desk_commit 按用户事务锁，在一个事务内检查每个变更的 expected version、禁止墓碑复活、校验必要引用、记录操作收据，然后返回一致快照。相同 operation UUID + 相同内容重试幂等；UUID 被用于不同内容会拒绝。操作收据、墓碑当前不自动清理，避免旧设备重新上传。身份 UUID 防止同账户名称变化影响归属。

SQL 对归属、幂等、版本和关键引用实施服务端保护；完整的现有业务格式校验复用客户端 assertValid。即使自行构造 API 请求，也只能影响当前认证用户；不能据此绕过跨用户权限。将来若增加不可信第三方写入端，应扩充服务端业务格式约束。

## 缓存、离线与冲突

单独的 IndexedDB `hikari-desk-cloud-v1/accounts` 按用户 UUID 保存最后成功云端快照及持久化操作队列。它不是独立权威库。首次打开必须成功读取云端，失败不初始化空业务库。Web Locks 串行化同账号同分区的多个窗口；不支持该 API 的浏览器拒绝可靠性无法保证的写入。

写入先校验，再在一次 IDB 事务中保存整个新增队列状态，提交成功才视为已接受。网络重试使用原 UUID。每条变更按行 CAS；多设备修改同一业务聚合会进入 conflict，队列不会被丢弃，也不采用 last-write-wins。删除保留墓碑，旧缓存无法把同 id 记录重建。

自动重试发生在恢复网络、打开页面、聚焦/恢复前台、定期刷新和下一次操作。Study 30 秒检查，Academic 最迟约 60 秒重新读取；表单编辑期间推迟 UI 更新以保留输入。状态独立显示已同步、待同步、离线、失败或冲突，不把队列中的修改称为云端已确认。

冲突后先导出缓存/队列，再经用户确认放弃本设备待同步修改，读取云端；可把队列文件作为来源重新预览合并。旧删除会被保留，已在云端删除的记录不可用原 id 复活。放弃的待同步删除需用户在正常记录界面重新确认执行。导出的队列为人工恢复材料，不直接重放不可信 RPC。

退出登录立即清空当前页面显示并清除本地 Auth session；其他同分区窗口收到 Auth 事件也清空。后台历史页面恢复时重载。账号缓存仍以 UUID 隔离保留，以免退出导致未同步记录丢失；后续必须再次登录同账号才能从应用入口读取。使用者清理站点存储或设备回收会删除缓存和未同步队列，须先确认同步或导出。

## 旧数据保护和备份

首次登录 cloud 版会将存在的旧库版本提升到 3，原 stores / records 不修改，目的是关闭加载中的 v2 连接、阻止 v2 旧页继续写入。回滚到旧前端不能直接写这个库；先用原始 JSON 在显式 local 测试环境恢复，不能降级覆盖原库。旧浏览器和旧 PWA 须分别联网刷新至新版并导出各自原始数据。

迁移预览识别同 id 同内容的重复；同 id 不同内容、同内容不同学习记录 id、配置和墓碑冲突均需选择。不会只靠科目和时长去重。确认前无云端写入，提交时重新检查预览基线。学习记录前后条数、分钟数均显示。每次只处理一份来源，保留所有原始文件。大文件请求超过云端限制时会安全失败并保留来源/队列，当前不做分块迁移。

云端备份包含 schema/version、全部 entity（含墓碑）和 SHA-256；不是 Supabase Free 自动备份的替代承诺。SHA-256 发现意外损坏，不是签名。旧 v1/v2 备份照常验证并合并；带未来版本、无法识别类型或损坏关联的数据拒绝，保留原文件。普通恢复不覆盖整库，也不清空现有云端。
