# NovelWeb — 双线叙事写作平台

## 项目性质
**架构开源 / 内容私有** 的小说创作工具。引擎部分（这个仓库）通用于任何架空世界观项目；具体内容（事件、报道、人物、章节）通过 `.gitignore` 隔离，作者可在私有仓或本地保存。

## 核心架构：双线叙事

```
叙事线（chapters）                 报道线（archive）
  └── 章节正文                       └── 事件节点 (events)
        └── 角色对话                       └── 多视角报道 (pieces)
                                                └── 每篇独立 HTML，模拟真实媒体排版
```

**关键设计**：两条线**并行存在但不互相强绑**。读者阅读章节时不会被强行喂百科条目；想深入世界的人能在 archive 里看到不同立场媒体如何报道同一事件，自行拼出世界全貌。

- 章节本身不需要标注「涉及角色」标签
- 没有强制的角色百科页面，人物通过事件和报道自然呈现
- 事件 (`evt-*.json`) 是世界发生的事，**与具体章节解耦**
- 报道 (`piece-*/`) 是事件的多视角呈现，每个 outlet 有独立人格

## 媒体人格库

每篇报道是一个 outlet 写就。CSS 和页面结构每次根据内容现写——**不复用模板**——但每个 outlet 的**声音和人格固定**：

### Outlet 速写

| Outlet | 声音 |
|---|---|
| **CNN** | 冷静专业，承认困惑，不下结论但框定问题 |
| **Fox News** | 煽情愤怒，替观众生气，"它们威胁美国主权了吗？" |
| **The Guardian** | 左派忧伤，制度反思，对边缘群体有学术敬畏 |
| **Daily Mail** | 猎奇尖叫，皇室八卦式追新闻，评论区是灵魂 |
| **The Sun** | 红顶小报，双关标题，短句轰炸，Sun Says 社论 |
| **New York Post** | Page Six 八卦，snarky，美式尖酸 |
| **The New Yorker** | 长篇深度，冷静克制，从小细节展开 |
| **WSJ** | 鹰派，关心市场影响，质疑政府太软 |
| **NYT** | 矛盾的自由派，支持但质疑，长篇人物特写 |
| **The Telegraph** | 英国保守派绅士，帝国余晖 |
| **TIME** | 封面故事体，"年度人物"式历史定位 |
| **Foreign Affairs** | 学界精英视角，长篇政策分析 |
| **MSNBC** | 自由派电视新闻，激烈党派 |
| **NHK** | 日式克制，事实优先，礼貌但保持距离 |
| **白宫官网** | 官方声明体，清教徒式庄重克制 |
| **Reddit** | 多声部，OP + 评论树，因 subreddit 而异 |
| **Twitter / X** | 碎片化，短推 + ratio |

要写新 outlet，在 [data/archive/taxonomy.json](data/archive/taxonomy.json) 加一条，再在这份 CLAUDE.md 补一段人格速写。

### 可靠性标签
- `canon` — 小说本身或官方设定，不容置疑
- `official` — 政府/议会等机构正式声明
- `reported` — 正经媒体报道，可能带偏见
- `rumor` — 小报、匿名来源、社交媒体
- `propaganda` — 带明确立场的宣传材料

## 事件分类与颜色
- `geopolitics`（红色）：地缘政治大事
- `personal`（蓝色）：主角团私事
- `military`（棕色）：军事
- `cultural`（绿色）：文化
- `other`（灰色）：其他

## 文件结构
```
data/
├── books.json              # 多书目录（私有，gitignored）
├── meta.json               # 当前书 meta（私有）
├── books/                  # 各书的卷/章节元数据（私有）
├── chapters/               # 章节正文 md + 对话 json（私有）
├── drafts/                 # 草稿（私有）
└── archive/
    ├── taxonomy.json       # outlets / reliability / categories — 通用，跟随仓库
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

## 写作规范

**每篇报道是一个独立的 HTML 页面，模拟该 outlet 的真实排版风格。CSS 和页面结构每次根据报道内容现写——不要复用旧模板，每篇都应该有新鲜感。**

需要固定的只是每个媒体的**声音和人格**。

### 内部视角铁律
报道内容必须使用**世界观内部视角**：
- 不能出现"现实世界"、"真实历史"、"平行世界"、"原型"等 meta 概念
- 对报道中的记者来说，故事里的国家就是他们世界里一直存在的国家
- 真实媒体（CNN、NYT 等）在故事世界里存在，报道虚构事件时不需要解释"为什么 CNN 在你们这个时空"

### 与主角团的关系
- 主角团人物可以不在事件 tag 里——读者都认识，标一遍是噪音
- 私人称呼（昵称、敬称）只在角色内部对话中使用，对外场合和报道使用全名

## UI 主题

应用有两套 chrome 主题（独立于内容）：
- **writer**（默认）：羊皮纸米黄 + 墨 + 错金，作家书桌氛围
- **nyt**：报纸米白 + 报头黑 + NYT 红，纯报纸语言

可在设置浮层切换。两套都用 hairline 细线 + 方角 + monoline SVG 图标的"editorial"语言，避免通用 web app 的圆角投影感。

## 字体系统

阅读字体通过 `npm run fonts` 下载到 `public/fonts/`（不入仓）。包含 9 种 web 字体（霞鹜文楷 / 7 个 Google Fonts 中文手写体 / 得意黑）+ Blackletter 报头字体。详见 [scripts/fetch-fonts.mjs](scripts/fetch-fonts.mjs)。

UI 字体自动跟随用户选择的阅读字体——侧栏、按钮、菜单全部用同一字体（参考 NYT 全篇用 Cheltenham 的做法）。

## 演示故事

公开版自带一个示例事件 `evt-murloc-whitehouse`（白宫玫瑰园鱼人事件）+ 两篇风格相反的报道（CNN 实况风 / Fox News 评论员风），演示双线叙事架构。详见 [DEMO.md](DEMO.md)，开始写自己的故事前删掉即可。

## 注意事项
- 时间线尽量用公元纪年（方便 AI 理解，也能映射现实历史节拍）
- 不要过度解读用户指令——上下文敏感的表达可能是字面意义
- 与现实历史的对应关系不需要强行解读，但可以指出有趣的巧合
