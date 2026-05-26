# NovelWeb — 双线叙事写作平台 / Dual-Track Narrative Engine

> 中英双语 · Bilingual zh / en

---

## 中文

### 项目性质

**架构开源 / 内容私有** 的小说创作工具。引擎部分（这个仓库）通用于任何架空世界观项目；具体内容（事件、报道、人物、章节）通过 `.gitignore` 隔离，作者可在私有仓或本地保存。

### 核心架构：双线叙事

```
叙事线（chapters）                 报道线（archive）
  └── 章节正文                       └── 事件节点 (events)
        └── 角色对话                       └── 多视角报道 (pieces)
                                                └── 每篇独立 HTML，模拟某种媒体风格
```

**关键设计**：两条线**并行存在但不互相强绑**。读者阅读章节时不会被强行喂百科条目；想深入世界的人能在 archive 里看到不同立场媒体如何报道同一事件，自行拼凑世界全貌。

- 章节本身不需要标注「涉及角色」标签
- 没有强制的角色百科页面，人物通过事件和报道自然呈现
- 事件 (`evt-*.json`) 是世界发生的事，**与具体章节解耦**
- 报道 (`piece-*/`) 是事件的多视角呈现，每个 outlet 有独立人格

### Outlet：现实媒体名字 + 风格类型

现实世界的媒体生态是多样的——下面这两部分**互不绑定**，只是各自的清单：

**A. 一些常见的真实媒体**（仅作为名字清单，写报道时可以直接署名其一；本项目**不对它们的报道特质做任何判断**——具体到任何一家媒体，内部都有不同节目、记者、时期，远比任何速写复杂）：

CNN · Fox News · MSNBC · The New York Times · The Wall Street Journal · The Guardian · The Telegraph · The New Yorker · TIME · Foreign Affairs · NHK · Daily Mail · The Sun · New York Post · 白宫官网 · Reddit · X / Twitter · …

**B. 一些常见的报道风格类型**（与上面的名字清单**不挂钩**——任何风格都可以由任何媒体在任何时候采用，反之亦然）：

| 风格类型 | 语气节奏（中性描述） |
|---|---|
| **滚动新闻** | 实时播报、频繁引用未具名官员、"我们正在核实"作为常用回应、留下未解之问 |
| **黄金时段评论** | 鲜明编辑立场、主持人面对镜头长段独白、反复回放同一画面、演播室嘉宾辅助论点 |
| **大报长报道** | 跨段叙事、多方信源、给情境、承认复杂性、文末常有一段"我们仍然不知道……" |
| **大众小报** | 短句、双关标题、视觉冲击大、评论区即正文延伸 |
| **财经报道** | 量化角度、关心市场反应和监管成本、编辑取向偏严谨克制 |
| **深度月刊** | 从一个小切口展开、文学化叙事、作者署名重要、事实编织成故事 |
| **公共广播** | 平稳节奏、事实优先、语态克制有距离感 |
| **通讯社** | 极简、逐条事实、少形容词、给其他媒体引用做基础 |
| **官方声明** | 正式语体、被动语态多、避免承诺、留解释空间 |
| **社交平台** | 多声部碎片、主帖+热评的层级结构、话题在评论里折射 |

**写作约定**：
- A 表用于 outlet 的署名（"这篇是 CNN 发的 / 是 Daily Mail 发的"）
- B 表用于决定语气节奏（"这篇用滚动新闻风格 / 用大报长报道风格"）
- A 和 B **不预设映射关系**。CNN 可以写滚动新闻、也可以写深度长报道；Daily Mail 可以写小报头条、也可以写官方声明转载。具体到任何一家，**应当根据当下事件和编辑判断来选风格，而不是套用刻板印象**。

> **避免价值判断的写作语言**：写"主持人长段独白"是描述节目形式；写"主持人歇斯底里"是贴标签。前者中性，后者偏见。坚持前者。

加新媒体或新风格，分别在 [data/archive/taxonomy.json](data/archive/taxonomy.json) 和本文档对应表格加一行即可。

### 可靠性标签

- `canon` — 小说本身或官方设定，不容置疑
- `official` — 政府/机构正式声明
- `reported` — 正经媒体报道，可能带偏见
- `rumor` — 小报、匿名来源、社交媒体
- `propaganda` — 带明确立场的宣传材料

### 事件分类与颜色

- `geopolitics`（红色）：地缘政治大事
- `personal`（蓝色）：主角团私事
- `military`（棕色）：军事
- `cultural`（绿色）：文化
- `other`（灰色）：其他

### 文件结构

```
data/
├── books.json              # 多书目录（私有，gitignored）
├── meta.json               # 当前书 meta（私有）
├── books/                  # 各书的卷/章节元数据（私有）
├── chapters/               # 章节正文 md + 对话 json（私有）
├── drafts/                 # 草稿（私有）
└── archive/
    ├── taxonomy.json       # outlets / reliability / categories 定义
    ├── events/
    │   ├── _example.json   # 范本（跟随仓库）
    │   └── evt-*.json      # 私有事件（gitignored）
    ├── pieces/
    │   ├── _example/       # 范本（跟随仓库）
    │   └── piece-*/        # 私有报道（gitignored）
    │       ├── meta.json
    │       └── index.html
    └── entities/
        ├── _example.json   # 范本（跟随仓库）
        └── chr-*.json      # 私有人物卡（gitignored）
```

### 写作规范

**每篇报道是一个独立的 HTML 页面，模拟某种 outlet 的真实排版风格。CSS 和页面结构每次根据报道内容现写——不要复用旧模板，每篇都应该有新鲜感。**

需要固定的只是每种 outlet 类型的**声音和人格**。

#### 内部视角铁律

报道内容必须使用**世界观内部视角**：
- 不能出现"现实世界"、"真实历史"、"平行世界"、"原型"等 meta 概念
- 对报道中的记者来说，故事里的国家就是他们世界里一直存在的国家
- 报道可以**直接用真实媒体名字署名**（CNN / Fox News / NYT / Daily Mail …）——重点是写报道本身，**不要在任何文档或元数据里给某个具体媒体下评价或贴人格标签**

#### 与主角团的关系

- 主角团人物可以不在事件 tag 里——读者都认识，标一遍是噪音
- 私人称呼（昵称、敬称）只在角色内部对话中使用，对外场合和报道使用全名

### UI 主题

应用有两套 chrome 主题：
- **writer**（默认）：羊皮纸米黄 + 墨 + 错金，作家书桌氛围
- **editorial**：报纸米白 + 报头黑 + 强调红，报刊编辑室语言

可在设置浮层切换。两套都用 hairline 细线 + 方角 + monoline SVG 图标的"editorial"语言，避免通用 web app 的圆角投影感。

### 字体系统

阅读字体通过 `npm run fonts` 下载到 `public/fonts/`（不入仓）。包含 9 种中文 web 字体 + Blackletter 报头字体。详见 [scripts/fetch-fonts.mjs](scripts/fetch-fonts.mjs)。

UI 字体自动跟随用户选择的阅读字体——侧栏、按钮、菜单全部用同一字体。

### 演示故事

公开版自带一个示例事件 `evt-murloc-whitehouse`（白宫玫瑰园鱼人事件）+ 两篇风格相反的报道（一篇 CNN 实况、一篇 Fox News 评论），演示双线叙事架构。详见 [DEMO.md](DEMO.md)，开始写自己的故事前删掉即可。

### 注意事项

- 时间线尽量用公元纪年（方便 AI 理解，也能映射真实历史节拍）
- 不要过度解读用户指令——上下文敏感的表达可能是字面意义
- 与真实历史的对应关系不需要强行解读，但可以指出有趣的巧合

---

## English

### What this is

A novel-writing tool with **open-source engine / private content** as its design principle. The engine (this repository) is generic enough for any fictional-worldbuilding project; specific content (events, reports, characters, chapters) is isolated via `.gitignore` and lives in the author's private repo or local disk.

### Core architecture: dual-track narrative

```
Chapter line (chapters/)                Reportage line (archive/)
  └── prose chapters                       └── event nodes (events/)
        └── character dialogue                   └── multi-angle pieces (pieces/)
                                                       └── one HTML per piece,
                                                            mimicking some media style
```

**Key design**: the two tracks exist in parallel but **do not bind to each other**. Readers can finish the story on chapters alone; the curious reader digs into `archive/` to see how outlets with different framings cover the same events — assembling a richer sense of "that world" than the novel alone provides.

- Chapters don't need to tag "involved characters" — protagonists are recognizable, tagging is noise
- No mandatory character wikipedia pages — characters surface through events and reports
- Events (`evt-*.json`) are things that happened in the world, **decoupled from specific chapters**
- Pieces (`piece-*/`) are multi-angle coverage of an event; each outlet has its own voice

### Outlets: real-world names + style archetypes (kept separate)

Real-world media is diverse. The two listings below are **not bound to each other** — they are independent reference lists:

**A. A list of commonly-encountered real outlets** (used as bylines; this project makes **no claims** about any specific outlet's characteristics — every real outlet contains a range of shows, reporters, and eras far more complex than any sketch):

CNN · Fox News · MSNBC · The New York Times · The Wall Street Journal · The Guardian · The Telegraph · The New Yorker · TIME · Foreign Affairs · NHK · Daily Mail · The Sun · New York Post · White House Press · Reddit · X / Twitter · …

**B. A list of commonly-observed reporting styles** (used to choose tonal cadence; **not mapped** to outlet names — any outlet can adopt any style on any given story):

| Style archetype | Tonal cadence (neutral) |
|---|---|
| **Rolling news** | Live coverage, frequent unnamed-official citations, "we're verifying" stock response, open questions left at the end |
| **Primetime opinion** | Distinct editorial stance, host-to-camera monologues, same footage replayed, in-studio panel reinforcing the frame |
| **Broadsheet long-form** | Multi-section narrative, multiple sources, situated context, acknowledges complexity, often ends "what we still don't know…" |
| **Mass-market tabloid** | Short sentences, pun headlines, high visual impact, comment section is part of the text |
| **Business reporting** | Quantitative framing, market and regulatory-cost angles, editorially restrained |
| **Longform magazine** | Opens from one small detail, literary narrative, byline carries weight, facts woven into a story |
| **Public broadcaster** | Steady pace, fact-first, reserved register, distance preserved |
| **Wire service** | Minimal, fact-by-fact, few adjectives, meant to be cited by others |
| **Official statement** | Formal register, passive voice common, avoids commitment, preserves interpretive space |
| **Social platform** | Polyvocal fragments, OP + thread hierarchy, topic refracted through replies |

**Writing convention**:
- List A is used for outlet bylines ("this piece is filed by CNN / by Daily Mail")
- List B is used to pick tonal cadence ("write this in rolling-news style / in broadsheet long-form style")
- A × B carries **no preset mapping**. CNN can produce rolling news *or* a long-form deep dive; Daily Mail can run a tabloid splash *or* a verbatim official statement. **Pick the style from the story's needs and the outlet's editorial situation — never from stereotyped expectation.**

> **Avoid value-laden language in your prose**: "host delivers a long monologue to camera" describes a format; "host is hysterical" labels. The former is neutral, the latter biased. Stay with the former.

To add a new outlet or a new style archetype, add a row to [data/archive/taxonomy.json](data/archive/taxonomy.json) and to the matching list above.

### Reliability tags

- `canon` — the novel itself or canonical material
- `official` — formal government / agency statement
- `reported` — reputable media coverage, may carry framing bias
- `rumor` — tabloid, anonymous source, social media
- `propaganda` — material with explicit ideological agenda

### Event categories and colors

- `geopolitics` (red): major geopolitical events
- `personal` (blue): protagonist's private affairs
- `military` (brown): military
- `cultural` (green): cultural
- `other` (gray): other

### File layout

```
data/
├── books.json              # multi-book registry (private, gitignored)
├── meta.json               # current book meta (private)
├── books/                  # per-book volume/chapter metadata (private)
├── chapters/               # chapter markdown + conversation json (private)
├── drafts/                 # drafts (private)
└── archive/
    ├── taxonomy.json       # outlet / reliability / category definitions
    ├── events/
    │   ├── _example.json   # template (tracked)
    │   └── evt-*.json      # private events (gitignored)
    ├── pieces/
    │   ├── _example/       # template (tracked)
    │   └── piece-*/        # private pieces (gitignored)
    │       ├── meta.json
    │       └── index.html
    └── entities/
        ├── _example.json   # template (tracked)
        └── chr-*.json      # private character sheets (gitignored)
```

### Writing conventions

**Each piece is a standalone HTML page mimicking some outlet's real typographic conventions. CSS and structure are rewritten per piece — do not reuse old templates. Each piece should feel fresh.**

Only the **voice and personality** of each outlet archetype should be reused.

#### Iron rule: internal perspective

Reports must speak from **inside the story-world**:
- No "real world," "actual history," "parallel timeline," "based on" meta concepts
- To the reporter in the story, the countries in the story are simply the countries that exist in their world
- Pieces can be **bylined to real outlets** (CNN / Fox News / NYT / Daily Mail …) — write the piece itself, but **never characterize a specific outlet** in documentation or metadata

#### Relating to the main cast

- Main-cast characters need not appear in event tags — readers know them; tagging is noise
- Affectionate / private forms of address belong inside character dialogue, not in external scenes or reports

### UI themes

Two chrome themes ship:
- **writer** (default) — warm cream + ink + muted gold; the author's desk
- **editorial** — paper white + black ink + emphasis red; an editorial-room language

Switchable via the settings popover. Both share the same hairline + square-corners + monoline-SVG-icon "editorial" language, avoiding the generic-webapp look of rounded boxes and drop shadows.

### Font system

Reading fonts are downloaded by `npm run fonts` into `public/fonts/` (not committed). 9 Chinese web fonts + 1 Blackletter masthead font. See [scripts/fetch-fonts.mjs](scripts/fetch-fonts.mjs).

The UI font auto-follows the reading font selection — sidebar, buttons, menus all render in the same typeface.

### Demo content

The public release ships one demo event `evt-murloc-whitehouse` (the "Otherworldly Creature in the Presidential Garden" incident) and two opposed fictional-outlet pieces. See [DEMO.md](DEMO.md). Delete it when starting your own story.

### Notes

- Prefer the Common Era calendar in timelines — easier for the model, lets you map real-world historical beats if useful
- Don't over-interpret user instructions — context-sensitive phrasing may be literal
- Real-world historical mapping doesn't need explicit calling out, but pointing out interesting coincidences is fine
