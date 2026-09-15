# NovelWeb

**双线叙事写作平台 / Dual-Track Narrative Engine for Fiction**

> 中英双语 README · Bilingual zh / en

---

## 中文

### 这是什么

一个 opinionated 的小说创作环境，核心是**两条平行的叙事线**：

- **章节线**：你写的小说正文
- **报道线**：在你那个世界里，不同媒体（CNN、Fox News、NYT、Daily Mail、Guardian、社交平台、官方声明……）如何报道章节里发生的事

现实世界的媒体生态本来就是多样的——同一件事，会被不同媒体用不同的语气节奏报道。这套差异**不是 bug，是真相被组装出来的方式**。NovelWeb 把这套机制做进写作工具：你可以为同一个虚构事件写多篇报道，让你那个世界拥有真实世界级别的叙事层次。

> 项目本身**不评价任何具体媒体**——它只是承认现实里报道生态的丰富性，并提供一个把这种丰富性带进小说的脚手架。

- 读者只看章节也能读完
- 想深入世界的人会去翻 archive，从不同风格报道里拼出更立体的"那个世界"

> 引擎开源 · 内容私有 · 双线创作

### 不是什么

- 不是 Scrivener / Notion / Google Docs 的替代品（那些更通用）
- 不是 AI 自动写小说工具（AI 在这里只是辅助起草和迭代）
- 不是"导入文档就能用"的轻量工具（需要你接受它的结构）

### 技术栈

- Vue 3 + Pinia + Vite
- Express 本地后端（数据存文件系统，无数据库依赖）
- 中文 web 字体系统：[scripts/fetch-fonts.mjs](scripts/fetch-fonts.mjs) 按固定版本清单下载并校验每个文件
- Gemini / ChatGPT 阅读字体：[userstyles/ai-reading](userstyles/ai-reading/README.md) 随 Windows 启动器自动安装字体与 Stylus 样式管理器
- 两套 chrome 主题：**Writer**（作家书桌：米黄 + 墨 + 错金）/ **Editorial**（编辑室：米白 + 墨黑 + 强调红）
- thin rail + 召唤式抽屉 UI 架构

### 快速开始

最简单：双击 `start.bat`（Windows）或 `bash start.sh`（macOS / Linux）。脚本会自动检查 Node.js（20.19+ 或 22.12+，不支持 21.x），缺失会通过 winget / Homebrew / apt 等自动装。Windows 入口先准备阅读字体和 Stylus，再启动 dev 服务和隔离的 Gemini Runner Chrome；macOS / Linux 入口会准备 NovelWeb 网页字体、启动 dev 服务并打开浏览器。

手动方式：
```bash
git clone https://github.com/okdsf/AINovel.git
cd AINovel
npm ci                 # 按 package-lock.json 安装依赖
npm run fonts          # 单独校验、补齐网页字体；npm run dev 也会自动准备
npm run dev            # 同时启动前端 + 后端
```

打开 http://localhost:5173 创建第一本书。

换目录或换 Windows 电脑时，将同一仓库 clone 到可写目录，运行 `start.bat` 即可。启动不依赖相邻的 `AINovel` 文件夹，也不需要复制 `.env`、旧的 `node_modules` 或扩展配对文件。第一次需要联网安装依赖、专用 Chrome、NovelWeb 网页字体、14 款本机字体及许可证，以及固定版本 Stylus 2.4.13。字体在 Chrome 启动前安装；管理器首次载入会添加 Gemini / ChatGPT 两份默认阅读样式。完整字体与 Stylus 缓存通过校验后可离线复用，缺失或损坏的文件会重新补齐；准备失败时会明确报错，重新运行入口即可重试。

脚本、来源清单、默认样式和管理器源码都在项目内。本机下载、字体注册和 Chrome profile 的路径从当前用户的 `%LOCALAPPDATA%` 推导。个人主题、字体参数及登录保存在专用 Chrome profile；换机后重新登录 Gemini / ChatGPT，个人样式可用 Stylus 导出 / 导入迁移。已有样式和设置不会被默认安装覆盖。若专用 Runner 仍在运行且字体或扩展需要更新，启动器只做检查并提示完整关闭专用窗口后重开，不会自动关闭你的页面。配对令牌会在本机重新生成，详见 [GEMINI-AUTOMATION.md](GEMINI-AUTOMATION.md)。

也可以先看看自带的演示故事：进 archive → 找到「白宫玫瑰园鱼人事件」→ 翻两篇报道（CNN 实况 + Fox News 评论）。详见 [DEMO.md](DEMO.md)。

需要把一组写作提示交给 Gemini 网页逐轮执行，或对指定的已有对话连续点击 `Redo / 重新生成` 并逐版留底时，可使用内置的持久队列和本地浏览器扩展。新任务创建后处于草稿状态，点击“开始”后执行。扩展不读取登录 Cookie，并会在验证码、额度或模式不匹配时暂停。安装与恢复说明见 [GEMINI-AUTOMATION.md](GEMINI-AUTOMATION.md)。

### 项目结构

```
src/                  # Vue 前端
├── views/            # 路由页面（HomeView 是首页报头）
├── components/       # 共享组件（ImmersiveReader / SidebarTree / ...）
├── stores/           # Pinia state (novel + settings)
└── assets/main.css   # 全局 chrome 样式

server/
└── index.js          # Express 数据 API

data/                 # 小说内容（私有 NovelWeb 备份；公开 AINovel 仅含示例）
└── archive/
    ├── taxonomy.json # outlet / reliability / category 定义
    ├── events/_example.json
    ├── pieces/_example/
    └── entities/_example.json

scripts/
├── fetch-fonts.mjs       # 固定清单字体校验与下载
├── ensure-reading-style.mjs # Stylus 下载、修复与管理器部署
└── demo-content/         # 公开版自带的演示故事
```

详细架构和写作规范见 [CLAUDE.md](CLAUDE.md)。

### 引擎 / 内容分仓哲学

私有 **NovelWeb** 仓库用于完整备份：小说、草稿、Prompt 迭代和已保存的 Gemini 运行结果随代码一起提交到私有远端。恢复时 clone 私有仓库即可取回这些已提交文件。`.env`、Git 凭据、本机配对令牌、执行器注册信息、活动队列和浏览器登录状态不入仓；新环境重新登录、重新配对后再开始任务。

私有仓库的具体恢复命令和独立目录实测结果见 [备份验证记录](BACKUP-VERIFICATION.md)。

公有仓里**没有任何小说内容**——只有引擎和演示骨架。这是设计选择：
- 写小说是私人活动，发表前不应该被 git push 意外曝光
- 引擎可以开源迭代，作者保留对内容的完全控制
- clone 之后是空架子（+一个演示故事），从零写自己的故事

如果使用公开的 AINovel 创建自己的小说，建议另建私有仓库备份内容。`npm run publish` 是导出到公开 AINovel 的独立操作；同步私有 NovelWeb 使用正常的 Git commit / push。

### 字体说明

NovelWeb 网页使用的 9 种中文字体和 Blackletter 报头字体下载到 `public/fonts/`，不入仓。`npm run dev` 会自动准备；也可单独运行 `npm run fonts`。版本、文件清单、下载地址和 SHA-256 位于 [scripts/web-fonts.json](scripts/web-fonts.json)，包括 CSS 引用的全部字体分片。已存在的文件仍会校验，缺失或损坏才下载；完整缓存不会再探测 CDN，也不需要网络。

Windows 的 `start.bat` 还会安装供 Gemini / ChatGPT 使用的 14 款中文手写、萌趣字体及英文花体，连同 OFL 许可证一起校验。首次安装的两站阅读样式使用已下载的霞鹜文楷（`LXGW WenKai`），原有样式的字体选择保留。详细清单、路径和管理方式见 [阅读字体说明](userstyles/ai-reading/README.md)。

### License

MIT — 见 [LICENSE](LICENSE)。

---

## English

### What this is

An opinionated novel-writing environment built around **two parallel narrative tracks**:

- **The chapter track** — the prose you give your readers
- **The reportage track** — how different outlets (CNN, Fox News, NYT, Daily Mail, Guardian, social platforms, official statements…) in your story-world cover events from the chapters

Real-world media is inherently diverse — for any given event, different outlets use different tonal cadences to report it. This polyphony **isn't noise — it's how reality gets assembled.** NovelWeb wires that mechanism into a writing tool: you can write multiple pieces of fictional reportage covering the same fictional event, giving your story-world the same dimensional layering a real one has.

> The project itself **makes no claims about any specific outlet's characteristics** — it just acknowledges the diversity of the real reportage ecosystem and gives you a scaffold to bring that diversity into fiction.

- A reader can finish the story on chapters alone
- The curious reader digs into `archive/`, assembling a richer "your world" from the different styles

> Open-source engine · Private content · Dual-track writing

### What this is not

- Not a Scrivener / Notion / Google Docs replacement (those are more general)
- Not an "AI writes the novel" tool (AI helps with drafting and iteration, not authorship)
- Not "import a doc and go" lightweight (you have to accept its structure)

### Stack

- Vue 3 + Pinia + Vite
- Express local backend (file-system storage, no database)
- Chinese web fonts: [scripts/fetch-fonts.mjs](scripts/fetch-fonts.mjs) downloads a pinned manifest and verifies every file
- Gemini / ChatGPT reading fonts: [userstyles/ai-reading](userstyles/ai-reading/README.md), installed with Stylus by the Windows launcher
- Two chrome themes: **Writer** (cream + ink + gold) / **Editorial** (paper + ink + emphasis red)
- Thin rail + summon-on-demand drawer UI

### Quick start

Easiest: double-click `start.bat` on Windows, or run `bash start.sh` on macOS / Linux. The script auto-checks Node.js (20.19+ or 22.12+; Node 21.x is unsupported), auto-installs it via winget / Homebrew / apt if missing, and installs dependencies. Windows prepares reading fonts and Stylus before starting the dev services and isolated Gemini Runner Chrome. On macOS / Linux it prepares NovelWeb web fonts, starts the dev server, and opens a browser.

Manual:
```bash
git clone https://github.com/okdsf/AINovel.git
cd AINovel
npm ci                 # installs the dependencies pinned in package-lock.json
npm run fonts          # verifies and repairs web fonts; npm run dev also prepares them
npm run dev            # starts both frontend and backend
```

Open http://localhost:5173 and create your first book.

To move to another folder or Windows computer, clone the same repository into a writable directory and run `start.bat`. Startup does not depend on a sibling `AINovel` folder or copied `.env`, `node_modules`, or pairing files. The first run needs a network connection to install dependencies, dedicated Chrome, NovelWeb web fonts, 14 local fonts with their licenses, and pinned Stylus 2.4.13. Fonts are installed before Chrome starts. The manager adds the two default Gemini / ChatGPT reading styles on first initialization. Complete verified font and Stylus caches work offline; missing or damaged files are repaired. If preparation fails, the launcher reports the error and can be run again.

Source code, download manifests, default styles, and the manager live in this repository. Local downloads, font registration, and Chrome profile paths derive from the current user's `%LOCALAPPDATA%`. Personal themes, font settings, and login sessions belong to the dedicated profile. Sign in to Gemini / ChatGPT again on a new machine; use Stylus export / import to transfer personal styles. Default installation preserves existing styles and settings. If an open Runner needs font or extension changes, the launcher checks without modifying it and asks you to fully close the dedicated windows before restarting; it does not close your pages automatically. Pairing credentials are generated locally; see [GEMINI-AUTOMATION.md](GEMINI-AUTOMATION.md).

Or browse the shipped demo first: open archive → find the "Otherworldly Creature in the Presidential Garden" incident → read both fictional-outlet pieces. See [DEMO.md](DEMO.md).

NovelWeb also includes a durable queue and local browser extension for sending a writing workflow through the Gemini web app, or repeatedly clicking `Redo` on a specific existing conversation, while checkpointing every result. New runs remain drafts until you click Start. A second independent extension prewarms ordinary manual Send, edited-prompt resubmission, and Redo actions without requiring NovelWeb. The runner never exports login cookies and pauses on CAPTCHA, quota, or model mismatches. See [GEMINI-AUTOMATION.md](GEMINI-AUTOMATION.md).

### Project layout

```
src/                  # Vue frontend
├── views/            # route pages (HomeView is the masthead)
├── components/       # shared components
├── stores/           # Pinia state (novel + settings)
└── assets/main.css   # global chrome

server/
└── index.js          # Express data API

data/                 # content (backed up in private NovelWeb; demos only in public AINovel)
└── archive/
    ├── taxonomy.json
    ├── events/_example.json
    ├── pieces/_example/
    └── entities/_example.json

scripts/
├── fetch-fonts.mjs       # pinned font verification and download
├── ensure-reading-style.mjs # Stylus download, repair, and manager deployment
└── demo-content/         # shipped demo story
```

Full architecture in [CLAUDE.md](CLAUDE.md).

### Engine / content separation philosophy

The private **NovelWeb** repository backs up the code together with novels, drafts, Prompt iterations, and saved Gemini run results. Clone the private repository to restore committed files. `.env`, Git credentials, local pairing tokens, worker registrations, the active queue, and browser login sessions are excluded; sign in and pair the new environment before starting tasks.

The public repo contains **no novel content** — only the engine and a demo scaffold. This is deliberate:
- Writing fiction is a private activity; it shouldn't be one git-push away from accidental exposure
- The engine evolves openly; authors keep full control over their content
- A fresh clone is an empty scaffold (+ one demo), ready to host your own story

If you use public AINovel for your own novel, create a private repository for content backups. `npm run publish` separately exports the engine to public AINovel; use ordinary Git commit / push to sync private NovelWeb.

### Fonts

NovelWeb's nine Chinese web fonts and Blackletter masthead font are downloaded to `public/fonts/` and excluded from Git. `npm run dev` prepares them automatically; `npm run fonts` can also verify and repair them separately. [scripts/web-fonts.json](scripts/web-fonts.json) pins versions, URLs, and SHA-256 hashes, including every subset referenced by the CSS. Existing files are verified; only missing or damaged files are downloaded. A complete cache makes no CDN probes or network requests.

Windows `start.bat` also installs 14 Chinese handwriting and decorative fonts and Latin script fonts for Gemini / ChatGPT, with verified OFL licenses. Newly installed reading styles use the downloaded `LXGW WenKai`; existing font choices are preserved. See the [reading font guide](userstyles/ai-reading/README.md) for the font list, locations, and controls.

### License

MIT — see [LICENSE](LICENSE).
