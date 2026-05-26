# NovelWeb

**双线叙事写作平台**——给架空世界观小说作者的本地工具。

## 这是什么

一个 opinionated 的小说创作环境，核心是**两条平行的叙事线**：

- **章节线**：你写的小说正文
- **报道线**：在你那个世界里，不同立场的媒体（CNN/Guardian/Daily Mail/Fox News/NYT/...）如何报道你写的事件

两条线**独立存在但互相映照**。读者只看章节也能读完故事；想深入世界的人会去翻 archive 看 17 种媒体人格如何各自带偏见地拼凑同一件事——这正是真实世界里我们认识"现实"的方式。

> 引擎开源 · 内容私有 · 双线创作

## 不是什么

- 不是 Scrivener / Notion / Google Docs 的替代品（那些更通用）
- 不是 AI 自动写小说工具（AI 在这里只是辅助起草和迭代）
- 不是"导入文档就能用"的轻量工具（需要你接受它的结构）

## 技术

- Vue 3 + Pinia + Vite
- Express 本地后端（数据存文件系统，无数据库依赖）
- 中文字体系统：[scripts/fetch-fonts.mjs](scripts/fetch-fonts.mjs) 多 CDN 镜像探测 + 自动下载 9 种 web 字体
- 两套 chrome 主题：作家书桌（米黄+墨+错金）/ NYT 报头（米白+报头黑+NYT 红）
- thin rail + 召唤式抽屉 UI 架构

## 快速开始

```bash
git clone https://github.com/okdsf/AINovel.git
cd AINovel
npm install
npm run fonts          # 下载阅读字体到 public/fonts/（多镜像自动选最快）
npm run dev            # 同时启动前端 + 后端
```

打开 http://localhost:5173 创建第一本书。

## 项目结构

```
src/                  # Vue 前端
├── views/            # 路由页面（HomeView 是 NYT 风报头）
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
└── fetch-fonts.mjs   # 多镜像字体下载器
```

详细架构和写作规范见 [CLAUDE.md](CLAUDE.md)。

## 引擎 / 内容分仓哲学

公有仓里**没有任何小说内容**——只有引擎和示例骨架。这是设计选择：
- 写小说是私人活动，发表前不应该被 git push 意外曝光
- 引擎可以开源迭代，作者可以保留对内容的完全控制
- 想用这个工具的人，clone 之后是空架子，从零写自己的故事

如果你写到一半想备份内容到 GitHub，建议**另开一个 private repo** 专放 `data/` 内容，本地用 symlink/junction 接进引擎目录。

## 字体说明

9 种中文 web 字体不入仓（共 40MB），通过 `npm run fonts` 在你的机器上下载。脚本自带：
- jsdelivr / fastly / gcore / unpkg / github-raw 五种镜像的 HEAD 探测
- 自动选最快的源
- 幂等：已存在的文件跳过
- 在 npm install 后或换机后跑一次即可

字体均为 OFL / 免费商用：霞鹜文楷 / 站酷小薇 / 马善政毛笔 / 龙藏 / 柳建毛草 / 志莽行 / 站酷快乐体 / 站酷黄油体 / 得意黑。

## License

MIT — 见 [LICENSE](LICENSE)。
