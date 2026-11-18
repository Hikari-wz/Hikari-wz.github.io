# Hikari’s Space

Hikari 的个人数字空间，站点地址为 <https://hikari-wz.github.io/>。Astro 在构建时生成独立 HTML，浏览器只为主题选择和移动导航加载少量脚本。日常写作使用 Markdown，项目页可以在 MDX 中嵌入独立组件。

## 在自己的电脑上运行

推荐 Node.js 24 LTS。安装后，在仓库根目录执行下面两条命令。

```sh
npm ci
npm run dev
```

终端会显示本地网址。修改文件并保存即可看到变化。提交前执行以下检查，最后一行需要 Python 3.9 或更高版本。

```sh
npm run check
npm run build
python3 scripts/verify.py
npm run preview
```

`dev` 用于写作和开发，`preview` 查看上一次构建生成的 `dist/`。提交源码与 `package-lock.json` 即可。CI 会从锁文件安装依赖。Astro 6 与 Tailwind 的 Vite 插件共用 Vite 7，升级开发依赖时一起验证这三者。

## 找代码

| 路径 | 负责的内容 |
| --- | --- |
| `src/pages/` | 文件路由。六个主页面、记录分类、三类详情页与 404 |
| `src/layouts/Site.astro` | 文档骨架、SEO、首屏主题 |
| `src/components/` | 导航、页脚、内容列表、文章排版、学习目录 |
| `src/data/site.ts` | 站名、介绍、导航、首页入口、分类和学科 |
| `src/content/{journal,learn,lab}/` | 可发布的 Markdown / MDX |
| `src/content.config.ts`、`src/lib/entries.ts` | 校验内容字段，生成链接、排序更新时间 |
| `src/features/` | 独立项目的界面和逻辑，例如 `palette/Palette.astro` |
| `src/styles/` | `tokens.css` 控制配色、字体和间距，其余样式按页面职责拆分 |
| `src/assets/`、`public/` | 参与优化的图片，以及原样发布的图标、robots.txt |
| `.github/workflows/pages.yml`、`scripts/verify.py` | CI、部署、构建产物链接校验 |

## 发布一篇记录

在 `src/content/journal/` 创建 `first-walk.md`，如下所示。文件名会成为永久链接 `/journal/first-walk/`。子目录也会成为路径的一部分，发布后尽量保留文件名。分类页使用 `/journal/category/` 前缀，文章文件避开这一目录名。

```md
---
title: 文章标题
description: 一句话介绍这篇文章。
date: 2026-11-19
category: travel
tags: [散步, 摄影]
demo: true
---

## 一个瞬间

在这里写正文。
```

`category` 可选 `travel`、`photography`、`life`。正式内容省略 `demo` 字段。需要调整显示的更新时间时，添加 `updated: YYYY-MM-DD`。文章、分类页及最近更新都在构建时生成，首页只输出最新四条的标题与链接。公开仓库中的草稿也可被别人读取，私人草稿请放到自己的电脑上。

## 添加学习笔记

复制 `src/content/learn/math/derivative.md`，或参考旧站迁入的 `src/content/learn/cpp/stl/vector.md`。学习笔记使用相同的标题、简介、日期和标签字段，并提供以下字段。

```yaml
topic: cpp
section: STL
order: 2
```

`topic` 可选 `cpp`、`math`、`languages`、`computing`。侧栏按学科和章节汇总，同章节按 `order` 排序。二、三级 Markdown 标题自动进入本页目录。使用带语言名称的代码围栏高亮代码，`$…$` 和 `$$…$$` 表示行内和块级公式。数学内容在构建时生成 MathML。将来需要搜索时，可在构建后索引 `dist/`，再给 `LearnNav.astro` 的 `search` 插槽接入搜索控件，按需加载索引。

## 添加项目

- **外部项目**　在 `src/content/lab/` 复制 `stl-practice.md`，更改内容和 HTTPS `projectUrl`，详情页会生成“打开项目”入口。
- **站内项目**　参考 `palette.mdx`，在 `src/features/项目名/` 放置组件，在 MDX 正文中导入并使用它。新增内容文件就会生成独立地址和目录入口。
- **交互工具**　把工具的脚本写在其 Astro 组件的 `<script>` 内。若确实需要 React，再安装相应集成，仅在工具页按需激活组件。首页始终只读取项目元数据。

## 导航、图片与外观

`src/data/site.ts` 的 `nav` 同时供应桌面和手机导航。`spaces` 控制首页四个入口。旅行和生活分别指向 Journal 的两个分类，可以共用同一套发布方式。记录和学习分类的合法值也从此文件生成。

全站默认为系统主题，右上角可选择浅色、深色或跟随系统，偏好保存在当前浏览器。全站字体使用本地候选字体与中日文字体回退。设计令牌与 Tailwind 的主题变量共享。动效尊重系统的减少动态效果设置。

照片放进 `src/assets/` 或与 Markdown 同目录，使用相对路径和有意义的替代文字。组件中可参考首页的 Astro `Image`，设置显示宽度和候选尺寸。只有首页首幅画优先加载，正文图片可按需加载。首页画作是葛饰北斋《相州梅泽庄》，大都会艺术博物馆公版藏品 JP20。图片随仓库提供。[原作与公版说明](https://www.metmuseum.org/art/collection/search/36501)

## GitHub Pages 首次切换与日常部署

1. 在独立分支提交改动，对 `main` 打开 PR。工作流会安装依赖、检查类型、构建并遍历内部链接。PR 不上传正式 Pages 构建包。
2. **确定要切换正式站时**，由仓库所有者把 **Settings → Pages → Build and deployment → Source** 调整为 **GitHub Actions**，再合并已通过检查的 PR。旧站曾使用 GitHub 自动生成的 Pages 构建记录。
3. 合并触发 `main` 的工作流，将 `dist/` 上传并部署。若已先合并，可在修改 Source 后于 Actions 中对 `main` 手动运行 **Check and deploy Pages**。查看 deploy 作业的环境链接。
4. 本仓库是用户主页，根路径为 `/`，`astro.config.mjs` 的 `site` 是正式域名。子路由生成各自的 `index.html`，`404.html` 提供自定义错误页面。将来若迁往子目录，需要同步调整站点配置和根路径链接。

部署无需填写个人访问令牌。只有部署作业申请 Pages 写权限和 OIDC 权限。原站的三个文件可从提交 `b6e1c46` 读取，原 vector 笔记和 STL 链接已迁入新站。

## 工作台的隐私边界

`/desk/` 目前只公开四个布局模块，不读写个人记录。GitHub Pages 会公开发布的 HTML、脚本和构建产物。前端密码、难猜的 URL 与 robots.txt 均不能给私人数据提供访问控制。未来可把工作台接到独立的私有服务，由服务端完成身份验证、逐用户授权与存储，仅向登录用户返回自己的数据。密钥保留在服务端，勿放入公开仓库、客户端变量或静态构建内容。

## 交接

当前分支的验证进度和恢复步骤见 [PROGRESS.md](./PROGRESS.md)。
