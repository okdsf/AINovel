# Gemini 网页自动化

NovelWeb 的自动化采用“本地持久队列 + 浏览器扩展执行器”。账号登录始终留在浏览器里；NovelWeb 不读取、复制或保存 Gemini Cookie。

## 它解决什么

- 把一组提示词按顺序送进同一段 Gemini 对话，形成真正的多轮链。
- 把每条提示词放进独立新对话，生成互不污染的平行样本。
- 绑定一条已有 Gemini 对话，连续点击最后一条回答的 `Redo / 重新生成`，把每次变体分别保存；不会重新发送提示词。
- 每轮发送前先保存提示词，回答完成后立即保存 Markdown、JSON 和 JSONL。
- 刷新页面、关闭 NovelWeb 或浏览器异常后，可以从磁盘状态继续。
- 校验页面当前显示的模式，例如 `Deep Think`；不匹配时暂停，而不是悄悄用错模型。

Google AI Ultra 是订阅档位，`Pro Extended`、`Deep Think` 等才是网页里需要校验的具体模式。网页额度不是无限的；扩展遇到登录失效、验证码或额度提示会停在“需要处理”，不会尝试绕过。

## 安装与配对

Windows 下在仓库目录运行一条命令即可：

```powershell
npm run gemini
```

启动器会优先复用这个仓库已经运行的 NovelWeb；若默认的前端 `5173` 或后端 `3001` 被其他程序占用，它会自动选择一组空闲端口并在终端打印实际的 `NovelWeb UI`、`NovelWeb API` 和 `Automation` 地址。选中的地址会保存供下次启动复用。随后它会下载并缓存官方 Chrome for Testing、建立一个与日常浏览器隔离的 Gemini 专用 profile，并加载两个扩展：

- `NovelWeb Gemini Runner`：执行持久队列；普通提示词与 `Redo` 都会在真正点击前默认预热 Gemini 同源连接。
- `Gemini Manual Prewarm`：只处理你亲自点击发送、按 Enter、点击精确 `Redo / 重做` 控件，以及编辑历史提示后重新提交的操作；它会先预热，再放行一次操作。它不读取、保存或上传提示词正文。

启动器随后完成本机配对，并打开自动化页面和 Gemini。配对令牌只通过一个短生命周期的本机文件交给 Runner；握手成功或失败后都会删除，不会出现在命令行、URL 或日志中。手动预热扩展不需要、也拿不到 NovelWeb 配对令牌。

Chrome 137 之后的正式版不再允许脚本通过 `--load-extension` 加载本地扩展，所以一键启动器使用 Google 官方 Chrome for Testing。它只用于这个 Gemini 自动化窗口，不会替换系统 Chrome，也不会读取或复制日常浏览器 profile。

首次运行后，在专用窗口完成账号登录和模式选择：

1. 在专用窗口登录 `gemini.google.com`，完成账号验证，并在网页中选择 `Pro Extended`、`Deep Think` 等实际模式。
2. 启动器配对成功后会启用 Runner，已点击“开始”的队列可以继续执行；可在扩展弹窗关闭执行器。新建任务先保存为草稿，检查后再点击“开始”。`Gemini Manual Prewarm` 默认启用，但只有你亲自发送或点击 Redo 时才工作，也可在它自己的弹窗中关闭。

之后创建任务，检查提示词和模式锁，再点击“开始”。以后再次打开专用窗口仍运行 `npm run gemini`；登录状态保存在这个独立 profile 中。

## Codex 真实浏览器诊断通道

Runner Chrome 启动时只在本机 `127.0.0.1:9223` 暴露 Chrome DevTools Protocol。这个端口对应自动化真正使用的专用浏览器和 profile，不是 Codex 内置浏览器，也不是用户的日常 Chrome。

```powershell
# 查看实际浏览器、标签页，以及工作区/运行时扩展是否一致
npm run gemini:browser -- -Action Status

# 列出可供精确选择的真实标签页
npm run gemini:browser -- -Action Tabs

# 在实际 Runner 浏览器中打开 Tabs 所列出的精确本地前端地址进行渲染验收
npm run gemini:browser -- -Action Open -TargetUrl 'http://127.0.0.1:<selected-web-port>/automation'

# 读取目标页渲染后的确切 DOM 元素、accessible name 和祖先链
npm run gemini:browser -- -Action Inspect `
  -TargetUrl 'https://gemini.google.com/app/<conversation-id>' `
  -Selector 'button[aria-label="Redo"]'

# 只在唯一可见精确匹配时点击；零个或多个匹配都会拒绝执行
npm run gemini:browser -- -Action Click `
  -TargetUrl 'https://gemini.google.com/app/<conversation-id>' `
  -Selector 'gem-menu[role="menu"] gem-menu-item[role="menuitem"]' `
  -ExactName 'Try again'
```

前端自动化的 selector 和完成条件必须来自这个真实页面。菜单项应在触发按钮打开菜单后再读取，并限定在新出现的菜单根内；不允许用扫描整页或相似文本匹配充当兜底。日志中的 `.click()`、`submitted` 或普通 DOM mutation 都不算成功，必须从实际页面观察完整状态转换。

扩展源码位于仓库，运行副本位于 `%LOCALAPPDATA%\NovelWeb\GeminiRunner\extension`。`Status` 的 `runtimeMatchesSource` 为 `false` 时，当前浏览器没有运行工作区版本；在安全重启/重载并再次确认一致之前，不得用这个浏览器验证新代码。

启动器还会通过 CDP 读取 Chrome 内存中实际载入的后台脚本，与仓库源码比较；扩展文件和版本号一致仍可能存在旧脚本缓存。冷启动先保持无 Gemini 页面，必要时重载扩展，确认源码一致后才打开页面。已有 Runner 检查出旧代码时会要求先关闭专用窗口再启动，避免打断执行中的任务。

如果不想使用一键启动器，也可以手动在浏览器扩展管理页启用开发者模式，分别选择“加载已解压的扩展”：

- `extensions/gemini-web-runner/`
- `extensions/gemini-manual-prewarm/`

然后只需在 Runner 设置页填写 NovelWeb 地址与配对令牌。手动预热扩展不需要配对。

两个扩展可以同时存在。手动预热扩展只拦截浏览器标记为真实用户输入的事件；Runner 的程序化点击不会被它再次拦截，因此不会双重发送。

执行器开启时，请把被它占用的 Gemini 标签页当作专用工作页，不要在同一页手动发送别的提示词。你仍可以在其他标签页正常使用 Gemini；扩展会用唯一标签页锁避免两个执行页同时领取任务。

配对令牌只允许扩展领取和回传任务。管理队列的接口还会检查请求来自本机 NovelWeb 页面，避免普通网页向队列注入提示词。

## 精确对话工作流（推荐）

在启动器打印的 `Automation` 地址（默认是 `http://127.0.0.1:5173/automation`）粘贴一条带具体 ID 的 Gemini 对话链接，例如：

```text
https://gemini.google.com/app/<conversation-id>
https://gemini.google.com/gem/<gem-id>/<conversation-id>
```

先点击“读取快照”。NovelWeb 会让专用 Runner 只读扫描当前对话，把每条可见用户输入记录为 `turnKey + ordinal + SHA-256 + 字符数`；链接变化后必须重新读取。随后可选择：

- **只 Redo**：不发送新文字，对快照锁定的最后一条用户输入执行 N 次 Redo。
- **发送 → Redo**：用 Windows 原生剪贴板粘贴新提示词，核对 Gemini 编辑器全文后发送一次，再对这次结果执行 N 次 Redo。
- **编辑历史轮次 → Redo**：从快照选择一条历史用户输入，按轮次与 SHA 精确打开其编辑框，替换并更新一次，再执行 N 次 Redo。

每个结果都单独保存正文、SHA、网页可见的 thinking 摘要和客户端时序。网页端无法读取 Google 的隐藏 CoT，也无法知道 Google 内部真正开始/结束计算的服务器时间；日志中的时间明确是“客户端点击、首次可见响应、客户端确认完成”和 NovelWeb 收到事件的时间，不会冒充隐藏数据。

“导入 Prompt 迭代”只导入源 Prompt 与各版回答；thinking、时序、预热和网络遥测只保留在本地运行日志中。

## 旧版队列模式

### 同一聊天多轮

每个重复组先新建一段对话，然后在该对话里依次发送全部提示词。第二条及之后的提示词可以利用前文回答。重复组之间彼此独立。

例如，提示词为“写初稿 / 批评初稿 / 根据批评重写”，重复组为 3，会得到三段独立的三轮对话。

### 每条独立新聊天

每条提示词发送前都新建对话，适合对同一请求做多个互不影响的采样。

提示词输入框使用单独一行 `---` 分隔，不会把正文里普通的三个横线误认为分隔符，除非它们独占一行。

### 重复生成已有回答

粘贴一条具体的 Gemini 对话地址（形如 `https://gemini.google.com/app/<对话ID>`），再填写重复次数。执行器会打开并严格核对这条对话，只点击最后一条 Gemini 回答下方的 `Redo / 重新生成`，不改写输入框，也不重新发送原提示词。

`Redo 方式` 是任务的持久化参数，可选 `Try again`、`Longer` 或 `Shorter`。主 Redo 按钮打开菜单后，扩展只在新出现的 `gem-menu[role="menu"]` 内点击对应 exact accessible name 的 `gem-menu-item[role="menuitem"]`。三个选项不使用相似文本、整页扫描或位置索引。若某条回答第一次点击 Redo 就直接开始生成，Gemini 本身没有展示选择菜单；所选方式从该对话实际出现菜单的轮次起生效。

每次重新生成都是一个独立、可恢复的任务，结果分别保存到自己的 `response.md`，并按顺序写入 `transcript.jsonl`。即使新回答的文字恰好和上一版完全相同，只要执行器确实观察到本次重新生成的生成周期，也会把它作为一次新结果保存。

为了避免改错对话，必须使用带对话 ID 的具体链接；`https://gemini.google.com/app` 这种空白首页地址不会被接受。当前模式也必须符合任务里的模式锁，例如 `Pro Extended`。

## 保存位置

默认保存到：

```text
data/drafts/ai-runs/
├── worker-token
├── workers.json
├── queue-state.json
└── runs/
    └── <run-id>/
        ├── manifest.json
        ├── transcript.jsonl
        └── tasks/
            └── <task-id>/
                ├── prompt.md
                ├── response.md
                ├── response.html   # 可选：网页原始回答片段
                ├── turn.json
                ├── recovery.md     # 可选：尚未确认完成的可见回答
                ├── recovery.html   # 可选：恢复快照的网页片段
                └── recovery.json   # 恢复快照校验与来源信息
```

私人 NovelWeb 仓库会备份运行记录、提示词、生成正文和会话快照；`worker-token`、`workers.json`、`queue-state.json` 属于本机配对和调度状态，不提交。公开 AINovel 导出仍排除整个草稿目录。可用环境变量 `NOVELWEB_AUTOMATION_DIR` 改到另一个本地目录；使用仓库外目录时，需要另行备份那里的内容。

## 防重复与断点恢复

网页点击不存在跨浏览器和服务端的绝对“恰好一次”事务。NovelWeb 采用保守策略：

1. 领取任务前，提示词已经原子写入磁盘。
2. 点击“发送”或“Redo”前，扩展先写入 `dispatching` 栅栏。
3. 栅栏之后若浏览器消失，任务变成 `uncertain`，由作者确认后再重试，不会盲目再次发送。
4. 回答抽取后，扩展先写进自己的本地 outbox；服务端确认落盘后才删除。
5. 所有回传带稳定事件 ID，网络重传不会重复追加同一轮。
6. 如果回答已经出现在页面上、但“停止生成”控件无法识别或任务中断，扩展会把可见文本同时写入扩展恢复区和任务目录的 `recovery.*`。它会被标为“未确认”，不会冒充已完成回答。

因此系统倾向于“停下来让你看一眼”，而不是偷偷多扣一次额度或生成重复内容。

## VPN 节点实验

打开 `http://127.0.0.1:5173/vpn-test`，先固定一条精确 Gemini 对话，再按节点依次记录 `redo_only` 工作流。NovelWeb 不自动切换 VPN；你切好节点后再开始该节点的 trial。任意节点仍在运行时，所有实验都会锁定下一次记录，且同一个 run 不能重复归入两个实验，避免切线途中污染统计。

页面按节点汇总成功率、点击到首次可见回答、总生成耗时和预热耗时。它比较的是一次完整 Gemini Web Redo 的实际表现，不把简单 ping 当成生成质量或服务器推理时间。

## 安全边界

- 默认单并发，请求间隔可设为 5 秒到 1 小时，同一运行的间隔跨重启保留；不同运行独立调度。编辑历史提示并紧接 Redo 的连续步骤不会插入普通轮次间隔。
- 最多 20 个重复组、每次运行最多 100 条提示词、自动重试最多 3 次。
- 不导出 Cookie，不自动填写账号密码，不切换账号。
- 不绕过验证码、限额提示或页面风控。
- 页面结构或模型标签无法确认时暂停。
- 浏览器网页结构改变后，可能需要更新选择器；先用小任务验证，再运行长队列。
