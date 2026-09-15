# Gemini / ChatGPT 中文阅读

两份可独立配置的 Stylus 样式。使用本机字体，不请求远程字体服务。新安装的默认正文字体为启动器下载的霞鹜文楷（`LXGW WenKai`），19px，1.8 倍行距，阅读宽度 820px；代码使用 Cascadia Mono / Consolas。已有样式的字体选择和其他参数保留。

## 一键安装与换机

Windows 下双击仓库根目录的 `start.bat`。启动器会自动准备 NovelWeb 的 `public/fonts` 网页字体、下面列出的 14 款本机字体及 OFL 许可证、固定版本的官方 Stylus 2.4.13，以及项目内的管理器和两站默认阅读样式。字体在 Chrome 启动前安装，避免旧字体列表影响 `local()` 加载。首次安装需要联网；文件完整且校验一致时，字体和 Stylus 缓存可离线复用，不重复下载。缺失、损坏或源码更新时会补齐，下载或校验失败会明确报错。

项目保存来源清单、下载和安装脚本、默认样式以及管理器源码。本机路径从当前用户的 `%LOCALAPPDATA%` 推导，不依赖原来的用户名或仓库位置。Chrome profile 中的个人主题、字体变量、启用选择和账号登录不会随仓库一起复制。换机后重新登录 Gemini / ChatGPT；个人样式与参数可在旧电脑的 Stylus 原生管理器中导出，在新电脑中导入。

已有阅读样式不会被默认安装覆盖。首次初始化按两个站点分别补齐默认样式，并记住完成状态；之后主动删除的默认样式不会在下次启动时复活。已运行的专用 Runner 只接受读取检查；组件需要更新时，启动器会提示先完整关闭专用 Runner，再运行 `start.bat`，不会自动关闭你的页面。

## 已安装 / 已启用样式管理

启动器准备的 Runner Chrome 提供两个管理入口：

- 在 ChatGPT / Gemini 页面右下侧点击 **「Aa 样式管理」**。
- 或点击 Stylus 扩展里的 **「已安装 / 已启用样式」** 按钮。

管理页始终显示当前网站及完整 URL，提供「本站可用」「已启用」「全部已安装」三种列表。**默认同一网站只选一份外观主题，阅读字体独立启用**；选择另一份主题会停用旧主题，保留字体。GPT 和 Gemini 分别保存主题和字体选择。选择「叠加模式」后，可逐个添加主题；切回单选保留组合中的第一个主题。下载新样式不会自动加入已有组合。

「ChatGPT · 中文阅读」和「Gemini · 中文阅读」标记为**独立字体**，用方形复选框控制；字体、字号、行距和阅读排版沿用原有设置。管理页显示「主题数量 · 阅读字体状态」，本站启用总数包含字体样式。主题单选时，1 个主题加 1 份阅读字体是正常状态。点击「字体设置」调整参数，取消字体勾选只关闭字体与阅读排版；「停用本站所有样式」同时关闭主题和字体。

字体独立管理使用 V2 设置，会自动迁移旧 V1 选择：保留主题与已保存字体参数，恢复之前因选择主题而被排除的已启用阅读字体，保留用户原有排除规则。迁移后主动关闭字体会被记住。原生 Stylus 的字体启用开关也会同步，单纯保存字体参数不会擅自启用已关闭的字体。

勾选表示本站已选择；「本站已启用」与计数取 Stylus 实际注入结果，包含原有网址排除、明暗主题、临时禁用和总开关的影响。可以一键停用本站所有样式。管理器通过 Stylus 的精确主机排除规则控制本站启用项，保留下载的样式和用户原有排除。需要配置字体等参数时，可打开该项「配置」或原生管理器。

2026-09-14 排查并修正了两类跨站问题：

- 搜索 Gemini 时，原查找器会把结果扩大到 `google.com`，返回 Google 首页等主题；现在按 Gemini / ChatGPT 各自的应用名称及分类查找，不再扩大到父域全部主题。目录的标签可能不准确，样式安装后的可用范围仍由真实 CSS 和 Stylus 匹配器判断。
- 历史验收时，本机「Nadeshiko Style (Still in progress)」的实际 CSS 位于网址范围之外，已将允许范围限制到 `chatgpt.com` / `chat.openai.com`；「Demon Slayer google style」的 `google.com` 包含 Gemini 子域，已限制到 `www.google.com` / `google.com` 的准确主机。这里采用 Stylus 持久化的个人允许范围，不修改第三方 CSS 正文；这些第三方样式及个人设置不在默认安装包中，需要时通过 Stylus 导出 / 导入迁移。

管理器源码位于 `manager/`，针对官方解压版 **Stylus 2.4.13** 集成；版本、官方下载地址、大小和 SHA-256 固定在 `stylus-release.json`，升级时需要重新验证接入点。通常由 `start.bat` 自动准备。只读检查当前缓存与源码是否一致：

```powershell
node scripts/ensure-reading-style.mjs --check
```

开发或单独准备时，可在关闭专用 Runner 后运行 `node scripts/ensure-reading-style.mjs`；使用 `--root DIRECTORY` 可在隔离目录验证安装。原有 `node userstyles/ai-reading/install-manager.mjs [RUNTIME]` 命令仍可针对已有上游目录部署管理器，它不负责下载字体或启动 Chrome。

安装器只增加管理文件、两个网站的按钮及后台/搜索接入，不增加 Stylus 权限。原始上游文件保存在运行目录的 `novelweb-upstream/`；`novelweb-stylus-install.json` 记录全部上游及部署文件哈希，`novelweb-manager-install.json` 和 `manager/build-info.json` 记录管理器构建信息。源码哈希不包含本机绝对路径或时间。相同文件不重写；部署损坏时从已校验原包重新解压，不修改 Chrome profile 中的个人设置。

启动器同时核对后台两份实际执行代码中的构建标记。刚启动的新 Runner 若仍使用 Chrome 缓存的旧 Stylus 后台，会刷新一次扩展并重新核验；不会重启浏览器。已有 Runner 的检查不执行这项刷新。

## 切换字体

1. 打开 Gemini 或 ChatGPT，点击 **「Aa 样式管理」**，确认对应「中文阅读」的独立字体已勾选。
2. 点击该项 **「字体设置」**；也可以从 Stylus 弹窗的配置齿轮进入。
3. 在「中文 / 正文字体」选择字体；在「英文字体」单独选择花体或手写体。英文默认跟随正文，也能组合成「霞鹜文楷 + Dancing Script」「站酷快乐体 + Great Vibes」。也可选择「自定义字体」，在下一行填写 CSS 字体列表，例如 `'KaiTi', serif`。
4. 字号、行距、段落间距、阅读宽度和代码字体均可独立调整。开启「实时变更」可实时生效；否则点击「保存」。

「页面界面字体」默认保留网页原字体。选择「与正文使用同一字体」后，输入框、侧栏和菜单也会切换。正文和代码分开设置；数学和图标不强制替换字体。两网站各自保存选择。

要恢复主题原有的字体与排版，取消「中文阅读」的勾选即可；「停用本站所有样式」恢复网页原样。设置面板内的「重置」恢复阅读样式的默认值。

## 14 款新增字体

打开本目录的 `font-gallery.html`，可直接对照样张、组合中英文字体，或输入自己的文字预览。预览页中的选择只影响预览；应用到聊天网页时，在 Stylus 的配置中选择对应字体。

| 类型 | 字体 |
| --- | --- |
| 中文手写、毛笔 | 霞鹜文楷、马善政毛笔楷体、龙藏体、志莽行书、刘建毛草 |
| 中文萌趣、装饰 | 站酷快乐体、站酷庆科黄油体、站酷小薇体 |
| 英文花体、手写 | Great Vibes、Allura、Dancing Script、Pacifico、Caveat、Sacramento |

字体约 60.48 MiB，下载时同时获取原版字体及 OFL 许可证。来源固定到 [霞鹜文楷 v1.522](https://github.com/lxgw/LxgwWenKai/releases/tag/v1.522) 和 [Google Fonts 仓库版本](https://github.com/google/fonts/tree/809e4d8b8d7e9364a914909bb777679606c178b8)，详见 `fonts.json` 的来源、内部字体名、字符覆盖及 SHA-256。中文字体缺少的生僻字会回退到本机可用的后备字体。英文花体优先用于西文，中文继续使用所选中文字体。

`start.bat` 会自动执行下载与注册。需要单独维护时，在关闭专用 Runner 后从仓库根目录运行（Node.js 要求与项目一致）：

```powershell
node userstyles/ai-reading/download-fonts.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File userstyles/ai-reading/install-fonts.ps1
```

下载与许可证存放在 `%LOCALAPPDATA%\NovelWeb\ReadingStyle\fonts`；字体注册到当前 Windows 用户，实际安装副本位于 `%LOCALAPPDATA%\Microsoft\Windows\Fonts\NovelWeb-Reading-*`。样式只从本机加载字体，无远程字体请求。`@font-face` 使用本机完整字体名称。

**安装或重新激活字体后，先在 Chrome 新窗口检查；旧窗口仍回退时，完全退出并重启 Chrome / Runner 浏览器。** 仅刷新网页或扩展可能仍使用旧字体集合，导致 `local()` 加载失败并回退到默认字体。当前 Chrome 的 Windows 字体代理会持有初始化时的 DirectWrite 集合，见 [Chromium 字体代理源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/renderer_host/dwrite_font_proxy_impl_win.cc)。重启前先确认草稿已保存、聊天未在生成。

## 安装到其他浏览器

1. 从 [Stylus 官方仓库的下载入口](https://github.com/openstyles/stylus#releases) 安装 Stylus，支持 Chrome、Edge 和 Firefox。
2. 打开 Stylus「管理」→「导入」，选择本目录的 `ai-reading.stylus.json`，一次导入两份样式。
3. 刷新 Gemini / ChatGPT。

也可以在 Stylus 管理器里新建 **UserCSS** 样式，粘贴对应 `.user.css` 文件的完整内容并保存。

字体需要在相应电脑上安装。找不到指定字体时，浏览器会使用字体列表里的下一项。字体名称为字体家族名，不是 `.ttf` 文件名。

## 文件

- `gemini-reading.user.css`：仅作用于 `gemini.google.com`。
- `chatgpt-reading.user.css`：仅作用于 `chatgpt.com`。
- `ai-reading.stylus.json`：经 Stylus 实际编译后导出的便携安装包。
- `fonts.json`、`download-fonts.mjs`、`install-fonts.ps1`：字体来源与可复用的下载、安装脚本。
- `font-gallery.html`：无外部资源依赖的独立字体预览页。
- `manager/`、`install-manager.mjs`：本站样式管理及 Stylus 集成部署脚本；管理页需要在扩展内打开。
- `stylus-release.json`：固定版本的官方 Stylus 安装包及校验信息。
- `../../scripts/ensure-reading-style.mjs`、`../../scripts/expand-reading-style.ps1`：自动下载、只读检查、安全解压和完整部署校验。
- `../../scripts/web-fonts.json`：NovelWeb 网页字体的固定来源与完整文件哈希；网页字体下载不再依赖启动时的 CDN 探测。
- `build.mjs`：两份样式的共同源码，运行 `node userstyles/ai-reading/build.mjs` 重新生成 CSS。修改后需在 Stylus 中更新样式。
- `export-defaults.mjs`：通过 Runner 的 Stylus 编译器生成不含个人参数的默认 JSON 包，仅维护样式源码时运行。命令为 `node --experimental-websocket userstyles/ai-reading/export-defaults.mjs --runtime "$env:LOCALAPPDATA\NovelWeb\ReadingStyle\stylus-v2.4.13"`；日常启动直接使用已编译包。
- `../../scripts/verify-reading-style.mjs`：启动时检查浏览器实际运行的管理器构建与默认样式初始化状态，只关闭自己创建的检查页。

## 适配范围与验收

2026-09-14，使用本机 NovelWeb Runner Chrome（CDP 9223）和 Stylus 2.4.13 检查真实页面。

- 样式管理：7 份已安装样式准确列出；在真实 GPT / Gemini 页面验证单选切换、叠加 2 份、切回单选，以及两站互不影响。页面按钮使用来源标签页的实时 URL，验证过 Gemini 切换对话后的入口。
- 查找样式：真实 Stylus 弹窗中 Gemini 返回 Gemini 专用结果，GPT 返回 ChatGPT 结果；不再由 Gemini 自动扩大到 Google 首页主题。360px 管理页无横向溢出。
- 安装兼容性：真实安装一份临时验证 UserCSS，已安装数增加但单选仍只应用原来的 1 份；删除验证样式后恢复 7 份。自有管理页接入 Stylus 原生编译 worker 通信，支持后续 UserCSS 安装。扩展重载后选择与站点限制保留。
- Gemini 的现有已完成回答：实测 `model-response-content message-content > .markdown` 正文、段落及标题。
- ChatGPT 的未登录聊天页：实测 `[data-conversation-transcript] [data-message-role="assistant"] [data-assistant-markdown]`，包含中文、中英混排、加粗、列表、行内代码、代码块和 MathML 公式。
- ChatGPT 登录版：实测 `#thread [data-message-author-role="assistant"] .markdown`，用单独新建的字体测试对话验证标题、中文、英文、中英混排、加粗、列表、行内代码、代码块和 KaTeX 公式；不向用户的已有对话发送测试内容。
- 14 款新增字体逐一在登录版 GPT 的样本段落验证，浏览器实际渲染字体报告确认全部生效；组合字体时，中文由站酷快乐体渲染，英文由 Great Vibes 渲染，代码保持 Cascadia Mono 16px，公式保持 KaTeX_Math。
- 实测设置面板中的中文和英文选择，以及刷新后的设置与回答保留。界面跟随时输入框切换字体；540px 窄屏没有新增页面横向溢出。测试后恢复用户先前的字体选择。
- Gemini 的实际可见段落确认霞鹜文楷与 Caveat 混排，图标仍由 `Luminous Symbols` 渲染。
- Gemini 经「禁用 → 启用 → 刷新」验证，字体与设置保留；窄屏没有新增页面横向溢出，图标继续使用 `Luminous Symbols`。
- 字体独立管理修复：原有 GPT / Gemini 主题保留，单独关闭字体、重新开启、切换主题均在真实管理页通过验证。新窗口可加载全部 14 款字体；两站分别切换霞鹜文楷 + Caveat、站酷快乐体 + Great Vibes，实际文字渲染字体报告确认生效，刷新后状态保留，最后恢复原有字体参数。400px 管理页无横向溢出。
- ChatGPT 的样式在刷新后仍加载；此次访客对话刷新会回到首页，因此不把它算作聊天记录持久性验证。
- 不同账号或后续页面改版可能需要追加经真实页面确认的规则。界面字体选项使用按域名限定的通用 CSS。

样式不修改聊天内容，不自动发消息，也不注册页面观察器。新生成的文本由 CSS 自动匹配。

启动器使用的 Stylus 来自固定的官方发布包，运行副本位于 `%LOCALAPPDATA%\NovelWeb\ReadingStyle\stylus-v2.4.13`，完整性由启动器检查和修复，不使用浏览器商店自动更新。个人样式、设置和登录位于独立的 `%LOCALAPPDATA%\NovelWeb\GeminiRunner\chrome-profile`；它们与可重新生成的扩展运行文件分开保存。

本机验收记录和效果图保存在 `%LOCALAPPDATA%\NovelWeb\ReadingStyle\verification`。安装包只包含样式，不包含聊天内容。

参考：[UserCSS 配置格式](https://github.com/openstyles/stylus/wiki/Writing-UserCSS)。
