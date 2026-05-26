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
- 中文 web 字体系统：[scripts/fetch-fonts.mjs](scripts/fetch-fonts.mjs) 多 CDN 镜像探测 + 自动下载
- 两套 chrome 主题：**Writer**（作家书桌：米黄 + 墨 + 错金）/ **Editorial**（编辑室：米白 + 墨黑 + 强调红）
- thin rail + 召唤式抽屉 UI 架构

### 快速开始

```bash
git clone https://github.com/okdsf/AINovel.git
cd AINovel
npm install
npm run fonts          # 下载阅读字体到 public/fonts/（多镜像自动选最快）
npm run dev            # 同时启动前端 + 后端
```

打开 http://localhost:5173 创建第一本书。

也可以先看看自带的演示故事：进 archive → 找到「白宫玫瑰园鱼人事件」→ 翻两篇报道（CNN 实况 + Fox News 评论）。详见 [DEMO.md](DEMO.md)。

### 项目结构

```
src/                  # Vue 前端
├── views/            # 路由页面（HomeView 是首页报头）
├── components/       # 共享组件（ImmersiveReader / SidebarTree / ...）
├── stores/           # Pinia state (novel + settings)
└── assets/main.css   # 全局 chrome 样式

server/
└── index.js          # Express 数据 API

data/                 # 内容（除示例外全部 .gitignored）
└── archive/
    ├── taxonomy.json # outlet / reliability / category 定义
    ├── events/_example.json
    ├── pieces/_example/
    └── entities/_example.json

scripts/
├── fetch-fonts.mjs       # 多镜像字体下载器
└── demo-content/         # 公开版自带的演示故事
```

详细架构和写作规范见 [CLAUDE.md](CLAUDE.md)。

### 引擎 / 内容分仓哲学

公有仓里**没有任何小说内容**——只有引擎和演示骨架。这是设计选择：
- 写小说是私人活动，发表前不应该被 git push 意外曝光
- 引擎可以开源迭代，作者保留对内容的完全控制
- clone 之后是空架子（+一个演示故事），从零写自己的故事

如果你写到一半想备份内容到 GitHub，建议**另开一个 private repo** 专放 `data/` 内容，本地用 symlink/junction 接进引擎目录。

### 字体说明

9 种中文 web 字体不入仓（共约 40MB），通过 `npm run fonts` 在你机器上下载。脚本自带：
- jsdelivr / fastly / gcore / unpkg / github-raw 五种镜像的 HEAD 探测
- 自动选最快的源
- 幂等：已存在的文件跳过
- npm install 后或换机后跑一次即可

字体均为 OFL / 免费商用。

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
- Chinese web font system: [scripts/fetch-fonts.mjs](scripts/fetch-fonts.mjs) with multi-CDN mirror probing
- Two chrome themes: **Writer** (cream + ink + gold) / **Editorial** (paper + ink + emphasis red)
- Thin rail + summon-on-demand drawer UI

### Quick start

```bash
git clone https://github.com/okdsf/AINovel.git
cd AINovel
npm install
npm run fonts          # downloads reading fonts to public/fonts/ via fastest mirror
npm run dev            # starts both frontend and backend
```

Open http://localhost:5173 and create your first book.

Or browse the shipped demo first: open archive → find the "Otherworldly Creature in the Presidential Garden" incident → read both fictional-outlet pieces. See [DEMO.md](DEMO.md).

### Project layout

```
src/                  # Vue frontend
├── views/            # route pages (HomeView is the masthead)
├── components/       # shared components
├── stores/           # Pinia state (novel + settings)
└── assets/main.css   # global chrome

server/
└── index.js          # Express data API

data/                 # content (gitignored except seed files)
└── archive/
    ├── taxonomy.json
    ├── events/_example.json
    ├── pieces/_example/
    └── entities/_example.json

scripts/
├── fetch-fonts.mjs       # multi-mirror font fetcher
└── demo-content/         # shipped demo story
```

Full architecture in [CLAUDE.md](CLAUDE.md).

### Engine / content separation philosophy

The public repo contains **no novel content** — only the engine and a demo scaffold. This is deliberate:
- Writing fiction is a private activity; it shouldn't be one git-push away from accidental exposure
- The engine evolves openly; authors keep full control over their content
- A fresh clone is an empty scaffold (+ one demo), ready to host your own story

If mid-draft you want to back up content to GitHub, open a **separate private repo** just for `data/`, and symlink (or junction on Windows) it into your engine checkout.

### Fonts

Nine Chinese web fonts are not committed (~40 MB total) and are downloaded by `npm run fonts` onto your machine. The script:
- Probes five CDN mirrors (jsdelivr / fastly / gcore / unpkg / github-raw) with HEAD requests
- Picks the fastest
- Is idempotent — files already on disk are skipped
- Should be run once after `npm install`, and once per new machine

All fonts are OFL / free for commercial use.

### License

MIT — see [LICENSE](LICENSE).
