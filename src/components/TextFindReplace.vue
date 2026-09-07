<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '../i18n'

const props = defineProps({
  modelValue: { type: String, default: '' },
  editor: { default: null },
  targetLabel: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['before-change', 'update:modelValue', 'replace'])
const { t } = useI18n()

const openState = ref(false)
const findText = ref('')
const replaceText = ref('')
const caseSensitive = ref(false)
const currentIndex = ref(0)
const findInput = ref(null)
const statusText = ref('')

function collectMatches(content, query, matchCase) {
  if (!query) return []
  const source = matchCase ? content : content.toLocaleLowerCase()
  const needle = matchCase ? query : query.toLocaleLowerCase()
  const ranges = []
  let cursor = 0

  while (cursor <= source.length - needle.length) {
    const start = source.indexOf(needle, cursor)
    if (start === -1) break
    ranges.push({ start, end: start + query.length })
    cursor = start + Math.max(query.length, 1)
  }
  return ranges
}

const matches = computed(() =>
  collectMatches(props.modelValue || '', findText.value, caseSensitive.value)
)

const matchLabel = computed(() => {
  if (!findText.value) return props.targetLabel || t('sr.title')
  if (!matches.value.length) return t('sr.noMatch')
  return `${currentIndex.value + 1}/${matches.value.length}`
})

watch([findText, caseSensitive], () => {
  currentIndex.value = 0
  statusText.value = ''
})

watch(() => props.modelValue, () => {
  if (!matches.value.length) currentIndex.value = 0
  else if (currentIndex.value >= matches.value.length) currentIndex.value = matches.value.length - 1
})

function open() {
  if (props.disabled) return
  openState.value = true
  nextTick(() => findInput.value?.focus())
}

function close() {
  openState.value = false
  statusText.value = ''
}

function toggle() {
  if (openState.value) close()
  else open()
}

function selectCurrent() {
  const range = matches.value[currentIndex.value]
  const editor = props.editor
  if (!range || !editor || typeof editor.setSelectionRange !== 'function') return
  editor.focus()
  editor.setSelectionRange(range.start, range.end)
}

function move(direction) {
  const count = matches.value.length
  if (!count) return
  currentIndex.value = (currentIndex.value + direction + count) % count
  nextTick(selectCurrent)
}

function onFindKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    move(event.shiftKey ? -1 : 1)
  }
}

function replaceCurrent() {
  const range = matches.value[currentIndex.value]
  if (!range) return
  emit('before-change', {
    value: props.modelValue,
    selectionStart: props.editor?.selectionStart ?? range.start,
    selectionEnd: props.editor?.selectionEnd ?? range.end,
  })
  const nextValue =
    props.modelValue.slice(0, range.start) +
    replaceText.value +
    props.modelValue.slice(range.end)

  emit('update:modelValue', nextValue)
  emit('replace', { count: 1, replacement: replaceText.value })
  statusText.value = t('sr.replaced', { count: 1 })

  nextTick(() => {
    if (matches.value.length) {
      currentIndex.value = Math.min(currentIndex.value, matches.value.length - 1)
      selectCurrent()
    } else {
      const editor = props.editor
      if (editor?.setSelectionRange) {
        const caret = range.start + replaceText.value.length
        editor.focus()
        editor.setSelectionRange(caret, caret)
      }
    }
  })
}

function replaceAll() {
  const ranges = matches.value
  if (!ranges.length) return

  emit('before-change', {
    value: props.modelValue,
    selectionStart: props.editor?.selectionStart ?? 0,
    selectionEnd: props.editor?.selectionEnd ?? 0,
  })

  let cursor = 0
  let nextValue = ''
  for (const range of ranges) {
    nextValue += props.modelValue.slice(cursor, range.start)
    nextValue += replaceText.value
    cursor = range.end
  }
  nextValue += props.modelValue.slice(cursor)

  const count = ranges.length
  emit('update:modelValue', nextValue)
  emit('replace', { count, replacement: replaceText.value })
  statusText.value = t('sr.replaced', { count })
  currentIndex.value = 0
  nextTick(() => props.editor?.focus?.())
}

defineExpose({ open, close })
</script>

<template>
  <div class="tfr" :class="{ open: openState }">
    <button
      type="button"
      class="tfr-toggle"
      :class="{ active: openState }"
      :disabled="disabled"
      :title="t('sr.title')"
      @click="toggle"
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M8.5 3a5.5 5.5 0 1 0 3.42 9.81L16.1 17l.9-.9-4.19-4.18A5.5 5.5 0 0 0 8.5 3Zm0 1.4a4.1 4.1 0 1 1 0 8.2 4.1 4.1 0 0 1 0-8.2Z"/>
      </svg>
    </button>

    <div v-if="openState" class="tfr-panel" @keydown.esc.stop.prevent="close">
      <div class="tfr-row">
        <label class="tfr-field tfr-find">
          <span>{{ t('sr.find') }}</span>
          <input
            ref="findInput"
            v-model="findText"
            :placeholder="t('sr.findPlaceholder')"
            autocomplete="off"
            spellcheck="false"
            @keydown="onFindKeydown"
          />
        </label>
        <span class="tfr-count" :class="{ empty: findText && !matches.length }">{{ statusText || matchLabel }}</span>
        <button type="button" class="tfr-small" :disabled="!matches.length" :title="t('sr.previous')" @click="move(-1)">↑</button>
        <button type="button" class="tfr-small" :disabled="!matches.length" :title="t('sr.next')" @click="move(1)">↓</button>
        <button
          type="button"
          class="tfr-small tfr-case"
          :class="{ active: caseSensitive }"
          :title="t('sr.caseSensitive')"
          @click="caseSensitive = !caseSensitive"
        >Aa</button>
        <button type="button" class="tfr-close" :title="t('common.close')" @click="close">×</button>
      </div>

      <div class="tfr-row">
        <label class="tfr-field tfr-replace">
          <span>{{ t('sr.replace') }}</span>
          <input
            v-model="replaceText"
            :placeholder="t('sr.replacePlaceholder')"
            autocomplete="off"
            spellcheck="false"
            @keydown.enter.prevent="replaceCurrent"
          />
        </label>
        <button type="button" class="tfr-action" :disabled="!matches.length" @click="replaceCurrent">
          {{ t('sr.replaceCurrent') }}
        </button>
        <button type="button" class="tfr-action tfr-primary" :disabled="!matches.length" @click="replaceAll">
          {{ t('sr.replaceAll') }}
        </button>
      </div>

      <p class="tfr-hint">{{ t('sr.emptyDeletes') }}</p>
    </div>
  </div>
</template>

<style scoped>
.tfr {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.tfr.open { z-index: 120; }
.tfr-toggle {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.tfr-toggle:hover,
.tfr-toggle.active { background: color-mix(in srgb, var(--text) 7%, transparent); }
.tfr-toggle:disabled { opacity: .35; cursor: not-allowed; }
.tfr-toggle svg { width: 17px; height: 17px; fill: currentColor; }

.tfr-panel {
  position: absolute;
  top: calc(100% + 7px);
  right: 0;
  width: min(620px, calc(100vw - 72px));
  padding: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  box-shadow: 0 10px 28px rgba(0, 0, 0, .14);
  color: var(--text);
}
.tfr-row {
  display: flex;
  align-items: end;
  gap: 6px;
}
.tfr-row + .tfr-row { margin-top: 8px; }
.tfr-field {
  display: grid;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.tfr-field > span {
  color: var(--text-muted);
  font-size: 10px;
}
.tfr-field input {
  width: 100%;
  height: 30px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 0;
  outline: none;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 12px;
}
.tfr-field input:focus { border-color: var(--accent); }
.tfr-count {
  min-width: 62px;
  padding-bottom: 7px;
  color: var(--text-muted);
  font-size: 10px;
  text-align: center;
  white-space: nowrap;
}
.tfr-count.empty { color: #b34a42; }
.tfr-small,
.tfr-close,
.tfr-action {
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
}
.tfr-small { width: 30px; padding: 0; }
.tfr-case { width: 36px; font-size: 11px; }
.tfr-close { width: 28px; border-color: transparent; font-size: 18px; }
.tfr-action { padding: 0 10px; white-space: nowrap; }
.tfr-small:hover,
.tfr-action:hover { border-color: var(--accent); color: var(--accent); }
.tfr-small.active,
.tfr-primary { border-color: var(--accent); background: var(--accent); color: #fff; }
.tfr-small:disabled,
.tfr-action:disabled { opacity: .35; cursor: not-allowed; }
.tfr-hint {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 10px;
}

@media (max-width: 720px) {
  .tfr-panel { width: calc(100vw - 24px); right: -8px; }
  .tfr-row { flex-wrap: wrap; }
  .tfr-field { min-width: 180px; }
  .tfr-count { min-width: 48px; }
}
</style>
