import { defineStore } from 'pinia'
import { ref, watch, computed } from 'vue'

const STORAGE_KEY = 'novelweb-settings'

// Fonts for the reading area (novel content — always Chinese)
const FONTS = [
  // — Web fonts: 娟秀 / 手写 / 书法 —
  { id: 'lxgw', name: '霞鹜文楷', family: "'LXGW WenKai Screen', 'KaiTi', 'STKaiti', serif" },
  { id: 'zcool-xiaowei', name: '站酷小薇', family: "'ZCOOL XiaoWei', 'KaiTi', serif" },
  { id: 'mashanzheng', name: '马善政毛笔', family: "'Ma Shan Zheng', 'KaiTi', serif" },
  { id: 'longcang', name: '龙藏书法', family: "'Long Cang', 'KaiTi', serif" },
  { id: 'liujian-maocao', name: '柳建毛草', family: "'Liu Jian Mao Cao', 'KaiTi', serif" },
  { id: 'zhimangxing', name: '志莽行', family: "'Zhi Mang Xing', 'KaiTi', serif" },
  // — Web fonts: 现代 / 趣味 —
  { id: 'smileysans', name: '得意黑', family: "'Smiley Sans', 'Microsoft YaHei', sans-serif" },
  { id: 'zcool-kuaile', name: '站酷快乐体', family: "'ZCOOL KuaiLe', 'Microsoft YaHei', sans-serif" },
  { id: 'zcool-huangyou', name: '站酷黄油体', family: "'ZCOOL QingKe HuangYou', 'Microsoft YaHei', sans-serif" },
  // — System fonts (兜底) —
  { id: 'kaiti', name: '楷体', family: "'KaiTi', 'STKaiti', serif" },
  { id: 'songti', name: '宋体', family: "'SimSun', 'Songti SC', serif" },
  { id: 'fangsong', name: '仿宋', family: "'FangSong', 'STFangsong', serif" },
  { id: 'heiti', name: '黑体', family: "'SimHei', 'STHeiti', 'Microsoft YaHei', sans-serif" },
  { id: 'yuanti', name: '圆体', family: "'YouYuan', 'STYuanti', sans-serif" },
  { id: 'serif', name: 'Serif', family: "'Noto Serif SC', 'Source Han Serif SC', serif" },
  { id: 'sans', name: 'Sans', family: "'Microsoft YaHei', 'PingFang SC', sans-serif" },
]

// UI fonts — one list per locale. Picked when the user switches language
// (unless they've explicitly chosen a different UI font themselves).
const UI_FONTS = {
  zh: [
    { id: 'system', name: '系统默认', family: "'Microsoft YaHei', 'PingFang SC', sans-serif" },
    { id: 'pingfang', name: '苹方', family: "'PingFang SC', 'Microsoft YaHei', sans-serif" },
    { id: 'yahei', name: '微软雅黑', family: "'Microsoft YaHei', sans-serif" },
    { id: 'noto-sc', name: 'Noto Sans SC', family: "'Noto Sans SC', 'PingFang SC', sans-serif" },
    { id: 'source-han', name: '思源黑体', family: "'Source Han Sans SC', 'Noto Sans SC', sans-serif" },
    { id: 'sans-serif', name: '系统无衬线', family: 'system-ui, sans-serif' },
  ],
  en: [
    { id: 'system', name: 'System default', family: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
    { id: 'inter', name: 'Inter', family: "'Inter', 'Segoe UI', sans-serif" },
    { id: 'source-sans', name: 'Source Sans', family: "'Source Sans 3', 'Source Sans Pro', sans-serif" },
    { id: 'ibm-plex-sans', name: 'IBM Plex Sans', family: "'IBM Plex Sans', sans-serif" },
    { id: 'georgia', name: 'Georgia', family: "Georgia, 'Times New Roman', serif" },
    { id: 'garamond', name: 'Garamond', family: "'EB Garamond', Garamond, serif" },
    { id: 'ibm-plex-serif', name: 'IBM Plex Serif', family: "'IBM Plex Serif', Georgia, serif" },
    { id: 'mono', name: 'Monospace', family: "'IBM Plex Mono', 'Consolas', monospace" },
  ],
}

const DEFAULT_UI_FONT = { zh: 'system', en: 'system' }

// 阅读主题预设 — 只影响阅读区域（ReaderView 正文 + ImmersiveReader 书页）
// 每个主题定义一组 CSS 变量，由 --rc-* 前缀（reading content）
const THEMES = [
  {
    id: 'paper',
    name: '古卷',
    desc: '羊皮纸米黄，默认经典',
    bg: '#f5f0e8',
    paper: '#fffdf5',
    text: '#2a2520',
    accent: '#8b6b3d',
    divider: 'rgba(0,0,0,0.06)',
    shadow: '0 2px 20px rgba(0,0,0,0.08)',
  },
  {
    id: 'xuanzhi',
    name: '宣纸',
    desc: '中国水墨 · 朱砂标题 · 楷体推荐',
    bg: '#ece4d3',
    paper: '#f7efdc',
    paperBgImage: 'radial-gradient(ellipse at top left, rgba(139,69,19,0.04) 0%, transparent 50%), radial-gradient(ellipse at bottom right, rgba(139,69,19,0.03) 0%, transparent 50%)',
    text: '#1c1c1c',
    accent: '#8b0000',
    divider: 'rgba(139,69,19,0.12)',
    shadow: '0 2px 30px rgba(60,40,20,0.12)',
    recommendedFont: 'kaiti',
  },
  {
    id: 'kindle',
    name: '净白',
    desc: 'Kindle 风格 · 纯粹阅读',
    bg: '#eaeaea',
    paper: '#ffffff',
    text: '#000000',
    accent: '#555555',
    divider: 'rgba(0,0,0,0.08)',
    shadow: '0 1px 8px rgba(0,0,0,0.06)',
    recommendedFont: 'serif',
  },
  {
    id: 'lemon',
    name: '柠檬',
    desc: '淡黄浅绿 · 轻松日常',
    bg: '#f2f4e0',
    paper: '#fbfce8',
    text: '#2a3a1a',
    accent: '#6a8a3a',
    divider: 'rgba(80,120,40,0.10)',
    shadow: '0 2px 16px rgba(80,120,40,0.10)',
    recommendedFont: 'yuanti',
  },
  {
    id: 'rose',
    name: '薄暮玫瑰',
    desc: '暖酒红暗调 · 意蕴绵长',
    bg: '#2b1a1f',
    paper: '#3a232a',
    paperBgImage: 'radial-gradient(ellipse at center, rgba(201,161,136,0.05) 0%, transparent 70%)',
    text: '#e8d8d0',
    accent: '#c9a188',
    divider: 'rgba(232,216,208,0.10)',
    shadow: '0 4px 40px rgba(0,0,0,0.4)',
    recommendedFont: 'songti',
  },
  {
    id: 'mistyink',
    name: '宿墨',
    desc: '深色水墨 · 温润沉静',
    bg: '#1a1a1a',
    paper: '#242220',
    text: '#d4c8a8',
    accent: '#c9a16a',
    divider: 'rgba(212,200,168,0.10)',
    shadow: '0 4px 40px rgba(0,0,0,0.5)',
    recommendedFont: 'kaiti',
  },
]

// darkMode 开启时使用的统一深色样式（覆盖任何 theme）
const DARK_OVERRIDE = {
  bg: '#1a1a1a',
  paper: '#222222',
  text: '#d4d0c8',
  accent: '#d4a574',
  divider: 'rgba(255,255,255,0.06)',
  shadow: '0 2px 20px rgba(0,0,0,0.3)',
}

export const useSettingsStore = defineStore('settings', () => {
  const fontId = ref('kaiti')
  const fontSize = ref(18)
  const lineHeight = ref(1.8)
  const darkMode = ref(false)
  const themeId = ref('paper')
  const locale = ref('zh')                 // 'zh' | 'en'
  const uiFontIds = ref({ zh: DEFAULT_UI_FONT.zh, en: DEFAULT_UI_FONT.en })
  const customTextColor = ref('')           // '' = use theme default
  const customBgColor = ref('')
  // Chrome (overall UI) aesthetic: 'writer' = warm cream + ink + gold,
  // 'nyt' = stark cream + black + NYT red. Affects sidebar/buttons/tabs/forms,
  // independent of the per-reading-area --rc-* theme.
  const chromeTheme = ref('writer')
  // ↑ stored per-locale so switching language doesn't blow away the other one's pick

  // Load from localStorage
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const data = JSON.parse(raw)
        if (data.fontId) fontId.value = data.fontId
        if (data.fontSize) fontSize.value = data.fontSize
        if (data.lineHeight) lineHeight.value = data.lineHeight
        if (data.darkMode !== undefined) darkMode.value = data.darkMode
        if (data.themeId && THEMES.find(t => t.id === data.themeId)) themeId.value = data.themeId
        if (data.locale === 'zh' || data.locale === 'en') locale.value = data.locale
        if (data.uiFontIds && typeof data.uiFontIds === 'object') {
          uiFontIds.value = { ...uiFontIds.value, ...data.uiFontIds }
        }
        if (data.customTextColor) customTextColor.value = data.customTextColor
        if (data.customBgColor) customBgColor.value = data.customBgColor
        if (data.chromeTheme === 'writer' || data.chromeTheme === 'nyt') {
          chromeTheme.value = data.chromeTheme
        }
      }
    } catch {}
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      fontId: fontId.value,
      fontSize: fontSize.value,
      lineHeight: lineHeight.value,
      darkMode: darkMode.value,
      themeId: themeId.value,
      locale: locale.value,
      uiFontIds: uiFontIds.value,
      customTextColor: customTextColor.value,
      customBgColor: customBgColor.value,
      chromeTheme: chromeTheme.value,
    }))
  }

  function applyTheme() {
    const root = document.documentElement
    if (darkMode.value) {
      root.setAttribute('data-theme', 'dark')
    } else {
      root.removeAttribute('data-theme')
    }
    // Chrome (sidebar/buttons/forms/tabs) aesthetic
    root.setAttribute('data-chrome', chromeTheme.value)
    // UI font follows the reading font selection so the sidebar (volume / chapter
    // titles, draft labels, buttons) renders in the same typeface as the preview.
    const reading = FONTS.find(f => f.id === fontId.value) || FONTS[0]
    if (reading) root.style.setProperty('--font-ui', reading.family)
    // Reflect locale on <html lang> so screen readers and the browser pick the right font hints.
    root.setAttribute('lang', locale.value === 'en' ? 'en' : 'zh-Hans')
  }

  // Watch and persist
  watch([fontId, fontSize, lineHeight, darkMode, themeId, locale, uiFontIds, customTextColor, customBgColor, chromeTheme], () => {
    save()
    applyTheme()
  }, { deep: true })

  // Init
  load()
  applyTheme()

  const currentFont = () => FONTS.find(f => f.id === fontId.value) || FONTS[0]
  const currentTheme = () => THEMES.find(t => t.id === themeId.value) || THEMES[0]

  // 活动主题：darkMode 开启时强制使用 DARK_OVERRIDE
  const activeTheme = computed(() => {
    if (darkMode.value) return { ...currentTheme(), ...DARK_OVERRIDE, id: currentTheme().id + '-dark' }
    return currentTheme()
  })

  // 生成 CSS 变量对象，用于绑定到阅读容器上
  const themeVars = computed(() => {
    const t = activeTheme.value
    const vars = {
      '--rc-bg': customBgColor.value || t.bg,
      '--rc-paper': customBgColor.value || t.paper,
      '--rc-text': customTextColor.value || t.text,
      '--rc-accent': t.accent,
      '--rc-divider': t.divider,
      '--rc-shadow': t.shadow,
    }
    if (t.paperBgImage && !customBgColor.value) vars['--rc-paper-image'] = t.paperBgImage
    return vars
  })

  function applyRecommendedFont() {
    const t = currentTheme()
    if (t.recommendedFont && FONTS.find(f => f.id === t.recommendedFont)) {
      fontId.value = t.recommendedFont
    }
  }

  // UI-font helpers
  const uiFontList = computed(() => UI_FONTS[locale.value] || UI_FONTS.zh)
  const currentUiFontId = computed({
    get: () => uiFontIds.value[locale.value],
    set: (v) => { uiFontIds.value = { ...uiFontIds.value, [locale.value]: v } }
  })

  function toggleChromeTheme() {
    chromeTheme.value = chromeTheme.value === 'writer' ? 'nyt' : 'writer'
  }

  return {
    fontId, fontSize, lineHeight, darkMode, themeId, locale,
    customTextColor, customBgColor,
    chromeTheme,
    fonts: FONTS,
    themes: THEMES,
    uiFontList,
    currentUiFontId,
    currentFont,
    currentTheme,
    activeTheme,
    themeVars,
    applyRecommendedFont,
    toggleChromeTheme,
  }
})
