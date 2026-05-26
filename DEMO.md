# 示例资产 / Demo Bundle

> 这个文件说明 NovelWeb 公开版自带的演示资产——**一本完整的小书 + 两篇媒体报道**。
> This file describes the demo bundle shipped with the public release — **a small complete book + two media pieces**.

---

## 中文

### 这是什么？

NovelWeb 的核心创意：**一部小说有两条平行的叙事线**——

- **章节线**（小说正文）
- **报道线**（在你那个世界里，不同媒体如何报道章节里发生的事）

为了让你**一打开就能看到这两条线长什么样**，公开版自带一份完整的演示资产。**全部都是 demo，整本删掉即可清空**：

#### 1. 一本完整的小书：《示例：时空之门》

5 章，主角第一人称，讲一个本科生半夜借实验室触发了一扇时空门、误把电子游戏《魔兽世界》里的一只鱼人放到了现实里、然后**死活不敢承认是他干的**——尤其当 CNN 和 Fox News 把这事炒上了全美第一热度的时候。

包含章节：
- 第一章 · 我把那本书烧了
- 第二章 · 鱼人不见了
- 第三章 · 妈妈在楼上喊吃晚饭
- 第四章 · Anderson Cooper 不会放弃
- 第五章 · 如果有人问起

打开应用 → 点 rail 上的 **卷** (📖) → 选《示例：时空之门》→ 一章一章读。

#### 2. 配套的事件 + 两篇媒体报道

- **事件**：`evt-murloc-whitehouse` 「白宫玫瑰园鱼人事件」
- **CNN — Anderson Cooper 360° 实况转播**
- **Fox News — 黄金时段评论员节目**

打开 rail 上的 **志** (📜 archive) 即可看到该事件 + 两篇报道，体验**同一件荒诞事**在两种不同语气下如何被组装。

> ⚠️ 关于真实媒体名字：本 demo 是 demo 作者写的两种风格表演，**不构成对 CNN 或 Fox News 这两家真实媒体特质的判断**。NovelWeb 不对任何具体媒体的报道特质做评价——它只是承认现实里报道生态的丰富性。

### 这套 demo 的设计意图

整个项目是**分形**的：

> 引擎里装着一本书 ←→ 这本书在演示"引擎可以装一本书"

如果你不想看这个 demo，**整本删掉就好**——下面有命令。然后从 UI 里创建自己的第一本书，开始写。

### 怎么删掉 demo

```bash
# 删整本 demo 书（包括所有章节）
rm -rf data/books/book-murloc-demo
# 从书目里移除 demo 条目（编辑这个文件，删除 book-murloc-demo 那一项）
nano data/books.json

# 删事件 + 两篇报道
rm data/archive/events/evt-murloc-whitehouse.json
rm -rf data/archive/pieces/piece-cnn-murloc-whitehouse
rm -rf data/archive/pieces/piece-fox-murloc-whitehouse

# 删这份说明
rm DEMO.md
```

---

## English

### What is this?

NovelWeb's core idea: **a novel runs on two parallel narrative tracks** —

- **The chapter track** (the prose)
- **The reportage track** (how different outlets in your story-world cover the events from the chapters)

To let you **see what both tracks look like the moment you open it**, the public release ships a complete demo bundle. **It is all demo content; delete the whole thing to start fresh**:

#### 1. A complete small book: *"Portal of Time" (示例：时空之门)*

5 chapters, first-person, about an undergraduate who triggers a portal in a borrowed lab one night, accidentally lets a murloc from *World of Warcraft* into the real world, and then **refuses to admit responsibility** — especially after CNN and Fox News turn the incident into the top US story.

Chapters included:
- Ch. 1 · I burned the book
- Ch. 2 · The murloc is gone
- Ch. 3 · Mom is calling for dinner upstairs
- Ch. 4 · Anderson Cooper will not give up
- Ch. 5 · If anyone asks

Open the app → click **卷** (📖) on the rail → select *Portal of Time* → read chapter by chapter.

#### 2. Companion event + two media pieces

- **Event**: `evt-murloc-whitehouse` — the "Murloc in the White House Rose Garden" incident
- **CNN — Anderson Cooper 360° live coverage**
- **Fox News — primetime opinion segment**

Click **志** (📜 archive) on the rail to see the event + both pieces side by side. Experience **the same absurd event** refracted through two different tonal frames.

> ⚠️ About the real outlet names: these two pieces are stylistic performances written by the demo author. They are **not claims about the characteristics of CNN or Fox News as real outlets**. NovelWeb makes no claims about the characteristics of any specific outlet — it just acknowledges the diversity of the real reportage ecosystem.

### Why this demo is shaped this way

The whole project is **fractal**:

> The engine contains a book ←→ this book demonstrates "the engine can contain a book"

If you don't want this demo, **delete the whole thing** — commands below. Then create your own first book from the UI.

### How to remove the demo

```bash
# Remove the demo book (includes all chapters)
rm -rf data/books/book-murloc-demo
# Remove its entry from the book registry (edit and delete the book-murloc-demo entry)
nano data/books.json

# Remove the event + both media pieces
rm data/archive/events/evt-murloc-whitehouse.json
rm -rf data/archive/pieces/piece-cnn-murloc-whitehouse
rm -rf data/archive/pieces/piece-fox-murloc-whitehouse

# Remove this document
rm DEMO.md
```
