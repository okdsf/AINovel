# 示例故事 / Demo Story

> 这个文件是 NovelWeb 公开版自带的演示资产，演示**双线叙事**架构在实践里到底是什么样。
> This file ships with the public release of NovelWeb to demonstrate the **dual-track narrative** architecture in practice.

---

## 中文

### 这是什么？

NovelWeb 不是一个"普通的写作工具"。它的核心创意是：**一部小说，应该有两条平行的叙事线**。

- **章节线**——你直接给读者看的正文
- **报道线**——在你那个世界里，不同媒体如何报道章节里发生的事

读者只看章节也能读完。但想深入世界的人会去翻 archive，看不同立场的媒体（CNN、Fox News、NYT、Daily Mail、Guardian、社交平台、官方声明……）用完全不同的语气节奏报道同一件事——拼凑出比小说本身更立体的"那个世界"。

### Demo 故事

公开版自带一个 demo 事件 `evt-murloc-whitehouse`（**白宫玫瑰园鱼人事件**）：

> **2026 年 5 月 25 日凌晨 3 点 14 分。**白宫玫瑰园的安保摄像头记录到一只身高 60 厘米的蓝色两栖生物——外形与电子游戏《魔兽世界》中的"鱼人宝宝"一致。Secret Service 试图按"未识别生物入侵"流程处理，但内部手册里**没有任何与该类型生物相关的条款**。

围绕这一事件，公开版自带**两篇报道**：

1. **CNN — Anderson Cooper 360° 实况转播**
2. **Fox News — 黄金时段评论员节目**

**它们的语气节奏完全不同**——但这是 demo 作者写的两种风格表演，**不构成对 CNN 或 Fox News 这两家媒体本身特质的判断**。任何真实媒体在不同时间、不同节目、不同记者手下都有大量内部差异，我们这里只是借两个名字演示"语气节奏的差异"是什么意思。

打开应用 → 点 rail 上的"志"（archive）→ 找到该事件 → 翻两篇报道，体验**同一件荒诞事在两种不同语气下如何被组装**。

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

这段文字**不在仓库里**——只是给你看的示例。你的故事完全不必走这个方向。

### 怎么删掉这个 demo 开始你自己的

```bash
rm data/archive/events/evt-murloc-whitehouse.json
rm -rf data/archive/pieces/piece-cnn-murloc-whitehouse
rm -rf data/archive/pieces/piece-fox-murloc-whitehouse
rm DEMO.md
```

然后在应用 UI 里创建你自己的第一本书，开始写。

---

## English

### What is this?

NovelWeb is not just a writing tool. Its core idea: **a novel should run on two parallel narrative tracks.**

- **The chapter line** — the prose you show readers directly
- **The reportage line** — how different outlets in your story-world cover what happens in the chapters

A reader can stick to the chapters and finish the story. But the curious reader can dig into the archive, see how different outlets (CNN, Fox News, NYT, Daily Mail, Guardian, social platforms, official statements…) cover the same event with different tonal cadences, and assemble a more dimensional "your world" than the novel alone provides.

### The demo content

The public release ships with one demo event: `evt-murloc-whitehouse` (the **"Murloc in the White House Rose Garden" incident**).

> **At 03:14 EDT on May 25, 2026,** White House Rose Garden security cameras recorded a 60 cm tall blue amphibious creature — visually identical to a "murloc baby" from World of Warcraft. The Secret Service tried to apply standard "unidentified-animal intrusion" protocols, but there was **no clause in the playbook covering fantasy-game creatures.**

Two pieces ship covering this same event:

1. **CNN — Anderson Cooper 360° live coverage**
2. **Fox News — primetime opinion segment**

**Their tonal cadences are very different** — but these are two stylistic performances written by the demo author, **not claims about the characteristics of CNN or Fox News as outlets**. Any real outlet contains an enormous range of voices across shows, reporters, and eras. We're just borrowing two well-known names to demonstrate what "different tonal cadence on the same event" means.

Launch the app → click the "志" (archive) glyph on the rail → open the event → read both pieces. You're experiencing the core mechanic: **the same absurd event, refracted through two different tonal frames.**

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

This text **is not in the repo** — just shown as a sketch. Your story does not have to go in this direction.

### How to delete this demo and start your own

```bash
rm data/archive/events/evt-murloc-whitehouse.json
rm -rf data/archive/pieces/piece-cnn-murloc-whitehouse
rm -rf data/archive/pieces/piece-fox-murloc-whitehouse
rm DEMO.md
```

Then create your first book through the app UI and start writing.
