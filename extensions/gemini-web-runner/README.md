# NovelWeb Gemini Runner

一个**无需构建**的 Chrome / Edge Manifest V3 扩展。它只在你已登录的 `gemini.google.com` 标签页中工作，串行领取 NovelWeb 的本地持久队列任务，把每轮回答立即写回本地。

## 安装与配对

Windows 推荐在仓库根目录运行：

```powershell
npm run gemini
```

启动器会启动 NovelWeb，按需从 Google 官方地址下载并校验 Chrome for Testing，在 `%LOCALAPPDATA%\NovelWeb\GeminiRunner` 建立独立运行时与 profile，复制当前扩展、完成本机配对，然后打开自动化页面和 Gemini。Chrome 137 之后的正式版会忽略命令行 `--load-extension`，因此不能用系统 Chrome 代替这个专用运行时。

配对 bootstrap 是临时文件：令牌不进入浏览器参数、URL、网页 DOM 或仓库；扩展确认本机 heartbeat 后启动器立即删除它。启动器配对后会设置 `enabled: true`，使已开始的队列可以继续执行。

首次运行后，由你本人登录 [Gemini](https://gemini.google.com/app)，在页面选择任务要求的 `Pro Extended`、`Deep Think` 等模式。扩展只验证模式，不会自行切换；执行器可在弹窗或设置页关闭。以后重新打开仍使用 `npm run gemini`，登录状态留在独立 profile 中。

手动安装仍然可用：在支持加载本地扩展的浏览器中打开扩展管理页、开启开发者模式、加载本目录，再在配对设置中填写 NovelWeb 地址和 Worker 配对令牌。连接测试使用 `/ping`，不会领取任务。

扩展更新后，如果既有 Gemini 标签页没有显示连接状态，请刷新一次该标签页。

## 运行方式

- Gemini content script 检查页面、登录、安全验证、当前模式、会话地址和输入框。
- 网络预热默认开启：普通提示词和 Redo 都会先完成目标会话、模式、输入内容或精确 Redo 控件校验，然后在 `dispatching` fence 之前检查最近 15 秒的同源网络活动；连接并非已热时，才用同源凭据向 `/app` 发出一次 `HEAD`（`cache: no-store`，3 秒超时）。预热失败只写入 telemetry，不会阻止发送；可在扩展设置页关闭。预热不会在空闲轮询或尚未确认目标时运行。
- 同时打开多个 Gemini 标签页时，background worker 只授予一个标签页执行权；其他标签页保持 standby。发送前后都会复核所有权，旧 owner 绝不会继续点击。
- 所有本地 HTTP 请求都由 MV3 background service worker 发起。这样不会让 HTTPS 页面直接请求 HTTP，也避免混合内容 / CORS / Private Network Access 的兼容问题。
- `continue` 任务必须带有安全的 Gemini 会话 URL，或命中扩展为该 run 保存的会话映射；否则会阻止发送。支持普通 `/app/<conversation-id>` 与自定义 Gem 的 `/gem/<gem-id>/<conversation-id>`；URL 不同时只会导航到任务精确指定的规范地址。
- `new` 任务会点击“发起新对话 / New chat”，并确认输入框为空后才继续。提示词任务也可以显式指定已有对话，此时第一轮就是 `continue`，不会新建聊天。
- `redo` 任务必须携带精确的普通对话或自定义 Gem 对话 URL、`prompt: null`、重复序号和 `redoOption`。`redoOption` 只能是 `try_again`、`longer` 或 `shorter`，分别映射真实菜单 accessible name `Try again`、`Longer`、`Shorter`。NovelWeb 会把每次重复展开成独立队列任务；扩展只导航到该会话，在**最后一条可见模型回答内部**寻找 accessible name 精确为 `Redo`（或安全的本地化“重做/重新生成”）的唯一按钮，绝不填写或发送提示词。第一次点击该按钮可能直接开始生成；后续点击会打开真实 `gem-menu[role="menu"]`，扩展只在这个新菜单内点击任务指定的 `gem-menu-item[role="menuitem"]`。每次重复沿用同一会话 URL，并各自写入一个独立 `completed` 结果。
- Redo 同样在点击前写入带精确会话 URL 的 `dispatching` fence，并在服务端确认后复核标签页所有权、总开关、URL、模式、最后回答和按钮身份。扩展必须先观察到目标 Redo 控件真实离开可用状态或出现停止生成控件，才能确认 Gemini 接受了操作；随后同一轮的精确 Redo 控件重新可用即构成完整 action cycle。即使新回答文字与旧回答完全相同也可保存；单独一次 DOM mutation、代码调用了 `.click()` 或服务端记录了 `submitted` 都不算生成成功。
- 点击后只有同时观察到“不同于旧线程的新 `/app/<id>`、当前可见的停止生成按钮、页面最后一条用户消息与本次 prompt 完整匹配”，才会把 URL 和发送时模式固化进 active 状态。每次读取回答、生成恢复快照或回传完成前，都必须证明当前 DOM 来自这个确切线程；误入另一个会话时只会导航回原线程，无法证明来源时宁可阻断也不会把别处回答归错任务。
- 提示词完整填入且再次校验后，扩展在点击发送的紧邻前一刻写入 `dispatching` fence。只有服务端确认后才点击。进入这个 fence 后如果状态不确定，扩展**绝不自动重发**。
- 点击前会重新读取总开关。若你在 fence 前关闭，任务安全退回且不发送；若在 fence 确认后关闭，则不点击并转人工核对。已经开始生成的回答仍会继续监视并保存。
- 点击后写入 `submitted`。完成必须同时满足：曾观察到“停止生成”按钮、按钮随后消失、最后一条模型回答稳定至少约 4 秒。
- 长生成期间若 NovelWeb 重启或原 lease 变成 `404/409/410`，扩展会持久化“租约失效”状态，停止后续服务端 heartbeat 和任何新提示发送，但仍保持标签页唯一所有权、只读观察当前生成；最终回答仍尝试作为同 lease 的 late `completed` 保存，冲突时完整事件留在待发箱。
- `dispatching`、`submitted`、`blocked`、`failed` 与 `completed` 都会尽量携带当前预热 telemetry；`completed` 还包含点击至完成的耗时和有限数量的同源 Resource Timing 摘要。完成结果包含纯文本、HTML、会话 URL 与模式标签。若回传失败，完整事件先进入 `chrome.storage.local` 待发箱；恢复连接前不会领取下一任务。相同 `eventId` 可幂等重试。
- 若回答文本已经可见，但停止按钮、页面状态或 lease 无法继续确认，扩展会先把当前文本、HTML、会话地址和来源 lease 写进独立恢复区，并以 `responsePartial` 回传 NovelWeb。它仍然是“未确认快照”，不会被当作 `completed`。
- 如果发送后只能看到部分/疑似完整回答，却因停止信号缺失、超时或页面异常而无法安全确认完成，扩展会先把文本、有限大小的 HTML、会话 URL、模式和原因写入独立“本地恢复区”，再上报 `blocked/failed`。它不会把这类快照冒充 `completed`；只有同一 lease 的 `completed` 被 NovelWeb 确认后才清除对应恢复项。

## 安全边界

扩展：

- 不读取、不导出、不上传 Cookie 或浏览器登录凭据；
- 不自动登录，不要求你把 Google 密码交给任何程序；
- 不绕过验证码、安全验证、账号限制或请求配额；
- 不自动切换 Gemini 模式；模式不符即 `blocked`；
- 只允许把 API 请求发送到本机 `http://127.0.0.1` / `http://localhost`，并只代理 `/api/automation/` 路径；
- 启动器配对后启用执行器；新建任务保存为草稿，点击“开始”后才进入可领取队列。

网页自动化依赖 Gemini 当前 DOM，Google 更新页面后可能需要维护 selector。先用短提示的小队列验收，再运行长篇任务。使用频率、账号政策和订阅配额仍由你负责；扩展不会让网页端限制消失。

不要在尚有“待回传”或“可恢复”记录时卸载扩展或清除扩展数据，否则这些本地结果也会被删除。遇到 `409`、lease owner mismatch 或状态冲突时，待发箱会保留原始结果，等待人工处理，不会把冲突当作已保存。

## 权限说明

- `storage` / `unlimitedStorage`：保存设置、断点状态和可能较长的回答待发箱。
- `activeTab`：弹窗读取当前 Gemini 标签页的执行状态。
- `https://gemini.google.com/*`：仅在 Gemini 网页中执行队列。
- `http://127.0.0.1/*` 与 `http://localhost/*`：background worker 连接本地 NovelWeb。

## 开发自检

本目录没有打包步骤。修改后可在仓库根目录运行：

```powershell
Get-ChildItem extensions/gemini-web-runner/*.js | ForEach-Object { node --check $_.FullName }
node -e "JSON.parse(require('fs').readFileSync('extensions/gemini-web-runner/manifest.json','utf8')); console.log('manifest ok')"
node --test extensions/gemini-web-runner/tests/*.test.cjs
```

单元测试之后还必须检查实际 Runner Chrome；工作区文件和已加载运行副本是两个位置：

```powershell
npm run gemini:browser -- -Action Status
npm run gemini:browser -- -Action Tabs
npm run gemini:browser -- -Action Inspect -TargetUrl 'https://gemini.google.com/app/<conversation-id>' -Selector 'button[aria-label="Redo"]'
```

只有 `runtimeMatchesSource: true` 且真实页面的渲染 DOM 与生产 selector 一致，才说明当前浏览器确实在验证新代码。详细规则见 [`.codex/skills/novelweb-real-browser/SKILL.md`](../../.codex/skills/novelweb-real-browser/SKILL.md)。
