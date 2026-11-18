# 重构进度

分支 `redesign/hikari-space` 从原站 `b6e1c46` 创建。第一个可恢复检查点是 `2cdb476`。本分支包含完整网站源码、锁文件、README 与 Pages 工作流。

## 已完成

- 构建六个主空间、三个记录分类、文章/笔记/项目详情模板和自定义 404。
- 迁入旧站的 vector 笔记和 STL 练习站链接。新增的三个样例均标记为 Demo。
- 内容集合覆盖 Markdown 和 MDX，独立项目可以在 MDX 嵌入自己的组件。首页读取最近四条的元数据。
- 验证 Astro 类型检查及静态构建，生成 15 个 HTML 页面。全站链接检查覆盖导航、锚点、图片候选、样式和站点地图。
- 实看桌面及 390 像素浏览器视口。验证手机菜单、学习区导航、折叠目录、导数公式、深色模式跨页保留、跟随系统，以及无效地址显示自定义 404。
- 解决 Astro 与 Tailwind 插件使用不同 Vite 主版本导致的构建失败。依赖与锁文件已同步。

## 继续工作

1. 检出本分支，使用 Node 24 运行 `npm ci`、`npm run check`、`npm run build` 和 `python3 scripts/verify.py`。
2. 在仓库 Pull requests 中查看本分支对 main 的 PR 和最新 CI 运行。若连接中断时提交尚未创建 PR，使用本分支重新打开即可。
3. 生产切换在所有者审核后单独进行，按 README 的 Pages 章节选择 GitHub Actions 并合并。现阶段无需修改生产设置。

查看、编写和扩展内容的具体方法见 [README.md](./README.md)。
