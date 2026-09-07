# Gemini Manual Prewarm

这是一个独立的 Chrome MV3 扩展。它只在 `https://gemini.google.com/` 生效，并且默认启用。

当你在 Gemini 编辑器中：

- 手动点击“发送”；或
- 按下不带 Shift / Alt / Ctrl / Meta 的 Enter（排除输入法组合状态与长按重复）；或
- 手动点击最后一条回答上精确命名为 `Redo / 重做 / 重新生成` 的控件
- 编辑一条历史用户提示后，点击精确的更新/提交控件，或在 `Edit prompt / 编辑提示词` 输入框按 Enter

扩展会在捕获阶段暂时拦住这次操作，先发出同源请求：

```text
HEAD https://gemini.google.com/app
credentials: same-origin
cache: no-store
timeout: 3500 ms
```

请求结束后，扩展只点击一次当前“发送”控件。预热超时、HTTP 异常或网络失败时仍会放行发送；结果会保存在扩展自己的 `chrome.storage.local` 中，并显示在弹窗里。

## 安装

1. Chrome 地址栏打开 `chrome://extensions/`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录：`extensions/gemini-manual-prewarm/`。
5. 刷新已经打开的 Gemini 标签页。

工具栏图标显示 `ON` 时已启用。点击图标可以停用，并查看最近一次预热的结果、耗时以及发送动作。

## 安全边界

- 只匹配 `gemini.google.com`，不访问 NovelWeb 或其他站点。
- 不读取、不复制、不记录、不上传提示文本。
- 编辑后按 Enter 的路径会在预热完成后向同一个编辑框重放一次不受本扩展再次拦截的 Enter；不会误点页面底部的普通发送按钮。
- 不拦截 Shift+Enter、多修饰键 Enter、输入法合成 Enter 或按键自动重复。
- 若 Gemini 正在生成（存在 Stop 控件），不会启动新的预热或发送。
- 预热期间的重复点击/Enter 会被吞掉，避免一条消息重复发送。
- 只拦截浏览器标记为真实用户操作的事件；NovelWeb Runner 或其他扩展发出的程序化发送/Redo 点击会原样放行。
- 页面在预热期间导航到另一条对话时不会发送；同一页面重绘并导致发送控件消失时，也不会猜测到其他页面重放。

## 测试

在仓库根目录运行：

```powershell
node --test extensions/gemini-manual-prewarm/tests/*.test.cjs
```

测试覆盖 Enter 判定、Send/Stop 控件判定、单飞门闩，以及预热成功、HTTP 异常、网络失败、超时。测试不需要打开浏览器。
