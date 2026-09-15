import {mkdir, readFile, writeFile} from 'node:fs/promises';

const {fonts} = JSON.parse(await readFile(new URL('fonts.json', import.meta.url), 'utf8'));
const fontOptions = (group) => fonts.filter(font => font.group === group).map(font =>
  `  ${JSON.stringify(`${font.id.replaceAll('-', '_')}:${font.style} · ${font.label}${font.id === 'lxgw-wenkai' ? '*' : ''}`)}: ${JSON.stringify(`'${font.family}'${group === 'zh' ? ", 'Noto Serif SC', 'Microsoft YaHei', serif" : ''}`)}`
).join(',\n');

// Use full face and PostScript names for installed Windows fonts. Chrome may
// need a fresh window or restart after installation to refresh its font list.
// Local sources only: no font files or chat content are sent to a remote service.
const localFontFaces = fonts.map(font => {
  const weight = font.variableAxes.find(axis => axis.tag === 'wght');
  return `  @font-face {
    font-family: '${font.family}';
    src: local('${font.fullName}'), local('${font.postScriptName}'), local('${font.family}');
    font-weight: ${weight ? `${weight.min} ${weight.max}` : '400'};
    font-style: normal;
    font-display: swap;
  }`;
}).join('\n');

// The two files have separate identities so Stylus remembers each site's choices.
const header = (site) => `/* ==UserStyle==
@name         ${site} · 中文阅读
@namespace    novelweb-ai-reading
@version      1.2.1
@description  本机字体、字号、行距和阅读宽度；保留公式与图标
@license      MIT
@preprocessor default

@var select nr-font "中文 / 正文字体" {
  "serif:思源宋体 · Noto Serif SC": "'Noto Serif SC', 'Source Han Serif SC', 'Microsoft YaHei', serif",
  "sans:思源黑体 · Noto Sans SC": "'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei', sans-serif",
  "yahei:微软雅黑": "'Microsoft YaHei', sans-serif",
  "kaiti:楷体": "'KaiTi', 'Noto Serif SC', serif",
${fontOptions('zh')},
  "custom:自定义字体": "var(--nr-custom-font)"
}
@var text nr-custom-font "自定义字体（上方选择自定义后生效）" "'Noto Serif SC', serif"
@var select nr-latin-font "英文字体（可与中文搭配）" {
  "follow:跟随正文字体*": "var(--nr-font)",
${fontOptions('latin')}
}
@var range nr-size "正文字号" [19, 16, 26, 1, "px"]
@var range nr-line-height "正文行距" [1.8, 1.4, 2.2, 0.05]
@var range nr-width "阅读宽度（窄屏自动收缩）" [820, 640, 1100, 20, "px"]
@var range nr-paragraph-gap "段落间距" [0.8, 0.4, 1.6, 0.1, "em"]
@var select nr-code-font "代码字体" {
  "cascadia:Cascadia Mono*": "'Cascadia Mono', Consolas, monospace",
  "consolas:Consolas": "Consolas, monospace",
  "system:系统等宽": "monospace"
}
@var range nr-code-size "代码字号" [16, 12, 22, 1, "px"]
@var select nr-ui-font "页面界面字体" {
  "keep:保留网页原字体*": "revert-layer",
  "match:与正文使用同一字体": "var(--nr-latin-font), var(--nr-font)"
}
==/UserStyle== */
`;

// These exclusions protect semantic code/math, observed KaTeX and Gemini icons.
// No script scans or rewrites the page; CSS also covers newly streamed content.
const protectedElements = 'pre, pre *, code, code *, kbd, kbd *, samp, samp *, math, math *, .katex, .katex *, [data-assistant-math-rendered], [data-assistant-math-rendered] *, svg, svg *, mat-icon, mat-icon *, gem-icon, gem-icon *, [role="img"], [role="img"] *';
const proseElements = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, strong, b, em, i, a, span, table, thead, tbody, tr, th, td';

function typography(root) {
  return `
  ${root} {
    font-family: var(--nr-latin-font), var(--nr-font) !important;
    font-size: var(--nr-size) !important;
    line-height: var(--nr-line-height) !important;
    overflow-wrap: break-word;
  }

  ${root} :is(${proseElements}):not(:where(${protectedElements}, button, button *)) {
    font-family: var(--nr-latin-font), var(--nr-font) !important;
  }

  ${root} :is(p, li, blockquote, th, td):not(:where(${protectedElements})) {
    font-size: var(--nr-size) !important;
    line-height: var(--nr-line-height) !important;
  }

  ${root} :is(p, blockquote) {
    margin-block: var(--nr-paragraph-gap) !important;
  }

  ${root} > :first-child { margin-block-start: 0 !important; }
  ${root} > :last-child { margin-block-end: 0 !important; }

  ${root} :is(h1, h2, h3, h4, h5, h6) {
    line-height: 1.45 !important;
    margin-block: 1.2em 0.55em !important;
  }
  ${root} h1 { font-size: calc(var(--nr-size) * 1.5) !important; }
  ${root} h2 { font-size: calc(var(--nr-size) * 1.25) !important; }
  ${root} h3 { font-size: calc(var(--nr-size) * 1.12) !important; }
  ${root} :is(h4, h5, h6) { font-size: var(--nr-size) !important; }

  ${root} :is(code, code *, kbd, samp) {
    font-family: var(--nr-code-font) !important;
    font-size: var(--nr-code-size) !important;
    letter-spacing: normal !important;
  }
  ${root} pre {
    max-inline-size: 100%;
    overflow-x: auto !important;
  }
  ${root} pre code {
    line-height: 1.6 !important;
    white-space: pre !important;
    overflow-wrap: normal !important;
    word-break: normal !important;
  }

  /* A separate cascade layer lets revert-layer preserve the original UI. */
  @layer novelweb-reading-interface {
    body :not(:where(${protectedElements}, ${root}, ${root} *)) {
      font-family: var(--nr-ui-font, revert-layer) !important;
    }
  }
`;
}

// Guest and signed-in markup were each observed in the actual Runner browser.
const chatRoot = ':is([data-conversation-transcript] [data-message-role="assistant"] [data-assistant-markdown], #thread [data-message-author-role="assistant"] .markdown)';
const geminiRoot = '#chat-history [data-test-id="chat-history-container"] model-response model-response-content message-content > .markdown';
const sites = [
  {
    file: 'chatgpt-reading.user.css', name: 'ChatGPT', domain: 'chatgpt.com', root: chatRoot,
    layout: `
  /* Observed ChatGPT conversation padding is 64px on each side at desktop. */
  @media (min-width: 900px) {
    [data-web-mobile-conversation] {
      max-width: calc(var(--nr-width) + 128px) !important;
    }
  }
  [data-conversation-transcript] {
    max-inline-size: var(--nr-width) !important;
    margin-inline: auto !important;
    inline-size: 100%;
  }
  #thread [data-conversation-screenshot-content] {
    --thread-content-max-width: var(--nr-width) !important;
  }
`,
  },
  {
    file: 'gemini-reading.user.css', name: 'Gemini', domain: 'gemini.google.com', root: geminiRoot,
    layout: `
  #chat-history [data-test-id="chat-history-container"] > .conversation-container {
    max-width: var(--nr-width) !important;
  }
`,
  },
];

await mkdir(new URL('./', import.meta.url), {recursive: true});
for (const site of sites) {
  const css = header(site.name) + `\n@-moz-document domain("${site.domain}") {\n` + localFontFaces + '\n' + typography(site.root) + site.layout + '}\n';
  await writeFile(new URL(site.file, import.meta.url), css, 'utf8');
  console.log(`Built ${site.file}`);
}
