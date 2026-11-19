# Hikari’s Space

Hikari 的个人数字空间，站点地址为 <https://hikari-wz.github.io/>。Astro 在构建时生成独立 HTML，浏览器按页面加载主题与导航等少量脚本。日常写作使用 Markdown，项目页可以在 MDX 中嵌入独立组件。

## 在自己的电脑上运行

推荐 Node.js 24 LTS。安装后，在仓库根目录执行下面两条命令。

```sh
npm ci
npm run dev
```

终端会显示本地网址。修改文件并保存即可看到变化。提交前执行以下检查。静态和内容测试需要 Python 3.9+，浏览器测试复用本机安装的 Chrome。

```sh
npm run check
npm run build
python3 scripts/verify.py
npm run test:content
npm run test:browser
npm audit
npm run preview
```

`dev` 用于写作和开发，`preview` 查看上一次构建生成的 `dist/`。提交源码与 `package-lock.json` 即可。CI 会从锁文件安装依赖。项目使用 Astro 7、Vite 8 和现有的 remark/rehype 数学插件。锁文件固定了修复后的依赖；KaTeX 的 npm override 等上游数学插件跟进后可以移除。CI 对完整依赖树执行审计，高危及以上会中止部署。

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

## 写作与发布

新增 Markdown 或 MDX 文件即可生成独立页面。文件路径决定文章地址，例如 `src/content/journal/first-walk.md` 对应 `/journal/first-walk/`。同一栏目使用唯一文件名；已发布的路径尽量保持稳定。`/journal/category/` 留给分类页。页面地址发生冲突时构建会报错，请给新文件换一个名称。

| 内容状态 | 如何设置 | 本地开发 | 生产栏目和详情页 | 首页最近更新 |
| --- | --- | --- | --- | --- |
| 正式内容 | 省略两个开关 | 可见 | 可见，进入站点地图 | 按更新时间取最近四条 |
| 公开示例 | `demo: true` | 显示 Demo | 显示 Demo，地址可分享 | 隐藏 |
| 草稿 | `draft: true` | 显示草稿，可从栏目进入 | 排除，站点地图也排除 | 隐藏 |

两个开关同时开启时按草稿处理。没有正式条目时首页显示空状态。用 `npm run dev` 预览草稿；发布时删除 `draft: true` 或改为 `false`，构建后再用 `npm run preview` 查看公开版本。

**公开仓库里的草稿源码人人可读。** 私人草稿或私人照片请保留在仓库外，或仅保存在本机未跟踪的文件中。放在 `public/` 的资源会原样发布，不能用草稿字段保护。提交前检查 `git diff --staged`，避免把私人资料、密钥或包含定位信息的照片带入历史。

三个可复制的最小示例如下。实际写作时替换标题、日期与正文。

### 旅行游记 · `src/content/journal/first-walk.md`

```md
---
title: 一段步行路线
description: 这段路线的起点、终点和途中观察。
date: 2026-11-19
category: travel
tags: [步行, 旅行]
---

## 途中

在这里写下想记住的一个细节。
```

记录分类可选 `travel`、`photography`、`life`。三个集合都支持可选的 `updated: YYYY-MM-DD` 和 `cover`。封面可用自己的或获得授权的本地 JPG、PNG、WebP。把文件放在文章旁边，在上面的两个 `---` 之间追加以下字段，路径相对于该文章。替代文字请描述照片本身。

```yaml
cover:
  src: ./my-photo.jpg
  alt: 河岸步道旁的一排树
```

有封面时，详情页显示响应式图片，分享时另生成 1200 × 630 的 JPEG。省略封面时复用首页的公版版画作分享图。分享卡只在目标地址可由平台抓取后才会显示；各平台自行缓存。

### C++ 笔记 · `src/content/learn/cpp/stl/pair.md`

```md
---
title: pair 的两个成员
description: 记录 first 与 second 的访问方式。
date: 2026-11-19
topic: cpp
section: STL
order: 2
tags: [C++, STL]
---

## 成员访问

用 `p.first` 和 `p.second` 分别访问两个成员。
```

`topic` 可选 `cpp`、`math`、`languages`、`computing`。侧栏按学科和章节汇总，同章节按 `order` 排序。二、三级标题自动进入本页目录。代码围栏写语言名即可高亮。`$…$` 和 `$$…$$` 分别表示行内和块级公式，构建时生成 MathML。搜索入口已预留在 `LearnNav.astro` 的 `search` 插槽。

### 项目介绍 · `src/content/lab/my-tool.md`

```md
---
title: 我的第一个小工具
description: 说明它帮助使用者解决什么问题。
date: 2026-11-19
tags: [工具]
---

## 使用方法

在这里写输入、操作和结果。
```

有外部地址时添加 HTTPS `projectUrl` 即可显示“打开项目”。站内工具可参考 `palette.mdx`：将组件放到 `src/features/项目名/`，从 MDX 导入即可。项目使用实验空间分类，标签可按需要填写。

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

### 失败排查

打开 Actions 中对应提交的运行，先看第一个失败步骤。类型错误通常会指出内容文件和字段；图片错误先核对文件名、大小写、相对路径和格式。站点地图或站内锚点错误会打印来源页和目标地址。依赖审计失败先读公告，再更新兼容版本和锁文件，重跑公式、MDX 和图片测试。PR 中部署显示 `skipped` 是预期行为。

构建成功但 `deploy` 失败时，核对运行的分支、Pages 来源、`github-pages` 环境规则与部署作业权限。推送新修复后查看新提交的运行；临时网络失败可重跑原作业。首次成功发布后，从正式域名直接打开首页、笔记、项目和不存在的路径，再试一次手机分享。真实平台的缓存和渲染需要在这一步核对。

### 回滚

- **后续普通更新**：从最新 `main` 开恢复分支，对有问题的提交执行 `git revert <提交号>`，通过 PR 运行检查再合并。若要撤回一个真正的合并提交，先核对其父提交，再使用 `git revert -m 1 <合并提交号>`。这会新增一条恢复记录。
- **首次切换后急需旧主页**：历史提交 `b6e1c46` 含完整旧版 `index.html`、`style.css`、README。可从它建专用恢复分支（例如 `git branch legacy-pages b6e1c46`、`git push origin legacy-pages`）。由所有者在 Pages 来源选择 **Deploy from a branch → legacy-pages → / (root)**，等对应部署成功并打开正式域名核对。恢复 Astro 版时再选择 **GitHub Actions**，从已修复的 `main` 手动运行工作流。整个过程保留 `main` 的历史。

### 验收范围

`scripts/verify.py` 遍历生成的 HTML、站内资源、锚点和站点地图，同时校验分享图、规范地址、语言、替代文字、主标题和主内容区。`test:content` 在临时目录分别构建仅含草稿和示例的站点、加入三类正式内容的站点，并测试自定义封面及路由冲突。两个测试站均独立于生产产物。

`test:browser` 使用本地生产预览，在 375、390、430、768、1280 像素下检查页面宽度和图片。它还检查键盘跳转、菜单开合、跨页主题、系统配色、长代码和块级数学公式，以及 HTTP 404。Linux 可通过 `CHROME_BIN=/usr/bin/chromium npm run test:browser` 指定可执行文件。上线前可再用 iPhone Safari 或 VoiceOver 实查导航朗读、公式与标签含义。

## 工作台的隐私边界

`/desk/` 目前只公开四个布局模块，不读写个人记录。GitHub Pages 会公开发布的 HTML、脚本和构建产物。前端密码、难猜的 URL 与 robots.txt 均不能给私人数据提供访问控制。未来可把工作台接到独立的私有服务，由服务端完成身份验证、逐用户授权与存储，仅向登录用户返回自己的数据。密钥保留在服务端，勿放入公开仓库、客户端变量或静态构建内容。

## 交接

当前分支的验证进度和恢复步骤见 [PROGRESS.md](./PROGRESS.md)。
