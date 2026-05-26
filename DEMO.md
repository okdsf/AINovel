# 示例故事 / Demo Story

> 这个文件是 NovelWeb 公开版自带的演示资产，演示**双线叙事**架构在实践里到底是什么样。
> This file ships with the public release of NovelWeb to demonstrate the **dual-track narrative** architecture in practice.

---

## 中文

### 这是什么？

NovelWeb 不是一个"普通的写作工具"。它的核心创意是：**一部小说，应该有两条平行的叙事线**。

- **章节线**——你直接给读者看的正文
- **报道线**——在你那个世界里，新闻媒体如何报道章节里发生的事

读者只看章节也能读完。但想深入世界的人会去翻 archive，看 CNN 和 Fox News 用完全不同的立场报道同一件事——拼凑出比小说本身更立体的"那个世界"。

### Demo 故事内容

公开版自带一个 demo 事件 `evt-murloc-whitehouse`：

> **2026 年 5 月 25 日凌晨 3 点 14 分。**白宫玫瑰园的安保摄像头记录到一只身高 60 厘米的蓝色两栖生物——外形与电子游戏《魔兽世界》中的低级怪物"鱼人宝宝"完全一致。Secret Service 试图按"未识别生物入侵"流程处理，但内部手册里**没有任何与该类型生物相关的条款**。

围绕这一事件，公开版自带两篇风格完全不同的报道：

1. **CNN — Anderson Cooper 360° 实况风** — 冷静、谨慎、"officials decline to comment"。强调 Secret Service 的"无可奉告"和新闻发言人的"我们正在核实"。
2. **Fox News — 黄金时段评论员风** — 激烈、追问、强调"美国人民应得的答案"。把同一个鸡腿事件讲成"一根鸡腿就能搞定的国安级响应"。

打开应用 → 点 rail 上的"志"（archive）→ 找到「白宫玫瑰园鱼人事件」→ 翻两篇报道，体验**同一件荒诞事在不同叙事框架下如何被组装**。

### 配套章节开头（示例）

如果你要把这件事写进小说，主线视角可以这么开篇——

```text
第一章 · 别提我的名字

我刚把那本破书烧了。地下室还有焦味。

门确实被打开过。不到三秒，关上了。但那三秒里，
有东西从那边过来了。

不止鱼人。但只有鱼人被电视拍到了——电视上播：
白宫玫瑰园里，有只 60 厘米高的蓝色东西，
正发出 mrrgglglglgl 的叫声。

我现在还能听到楼上电视机的声音。Anderson Cooper
正在问 Sarah Lin 一些 Sarah Lin 不会回答的问题。

妈妈在楼上喊吃晚饭。

我决定先吃完饭。
```

这段文字**不在仓库里**——它是给你看的示例，演示当你看到 archive 里那个鱼人事件
之后，作者视角的开篇大概可以是什么样。**你的故事不必走这个方向。** 你可以把那个
鱼人事件当成偶然事件、当成主线、当成 worldbuilding、当成完全无关的彩蛋——
完全由你决定。

### 怎么删掉这个 demo 开始你自己的

```bash
# 删事件
rm data/archive/events/evt-murloc-whitehouse.json

# 删两篇报道
rm -rf data/archive/pieces/piece-cnn-murloc-whitehouse
rm -rf data/archive/pieces/piece-fox-murloc-whitehouse

# 删这份说明
rm DEMO.md
```

然后在应用 UI 里创建你自己的第一本书，开始写。

---

## English

### What is this?

NovelWeb is not just a writing tool. Its core idea: **a novel should run on two parallel narrative tracks.**

- **The chapter line** — the prose you show readers directly
- **The reportage line** — how news outlets in your story-world cover what happens in the chapters

A reader can stick to the chapters and finish the story. But the curious reader can dig into the archive, see how CNN and Fox News cover the same event with opposite framings, and assemble a more dimensional "your world" than the novel alone provides.

### The demo content

The public release ships with one demo event: `evt-murloc-whitehouse`.

> **At 03:14 EDT on May 25, 2026,** White House Rose Garden security cameras recorded a 60 cm tall blue amphibious creature — visually identical to a "murloc baby," a low-level monster from World of Warcraft. The Secret Service tried to apply standard "unidentified-animal intrusion" protocols, but there was **no clause in the playbook covering fantasy-game creatures.**

The release ships two pieces covering this same event, with deliberately opposed editorial voices:

1. **CNN — Anderson Cooper 360°** — cool, cautious, "officials decline to comment." Foregrounds Secret Service's stonewalling and the press secretary's "we're verifying."
2. **Fox News — primetime opinion** — outraged, leading questions, "what the American people deserve." Reframes the same chicken-leg solution as "this administration's idea of a national-security response."

Launch the app → click the "志" (archive) glyph on the rail → open the murloc event → read both pieces. You're experiencing the core mechanic: **the same absurd event, refracted through two different framing apparatuses.**

### Sample chapter opening (for inspiration)

If you wanted to write this event into a novel, the main-thread perspective could open something like:

```text
Chapter One — Don't say my name

I just burned the book. The basement still smells like smoke.

The door did open. For less than three seconds, then it closed.
But in those three seconds, something came through.

More than just the murloc. But only the murloc was caught on TV.
TV says: White House Rose Garden, 60 cm tall, blue,
making a sound like mrrgglglglgl.

I can still hear the TV upstairs. Anderson Cooper is asking
Sarah Lin questions Sarah Lin won't answer.

Mom is calling me up for dinner.

I decide to eat first.
```

This text **is not in the repo**. It's just shown here as a sketch of what an author POV might look like once the reader has seen the archive event. **Your story does not need to go this direction.** You can treat that murloc event as a one-off, a main thread, worldbuilding flavor, or an unrelated easter egg — entirely your call.

### How to delete this demo and start your own

```bash
# Remove the event
rm data/archive/events/evt-murloc-whitehouse.json

# Remove the two pieces
rm -rf data/archive/pieces/piece-cnn-murloc-whitehouse
rm -rf data/archive/pieces/piece-fox-murloc-whitehouse

# Remove this doc
rm DEMO.md
```

Then create your first book through the app UI and start writing.
