<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from '../i18n'
import { draftCreatedDateKey } from '../utils/dateKey'

const props = defineProps({
  drafts: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue'])
const { t, locale } = useI18n()
const visibleMonth = ref('')

const dateCounts = computed(() => {
  const counts = new Map()
  for (const draft of props.drafts) {
    const key = draftCreatedDateKey(draft)
    if (key) counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
})

const availableMonths = computed(() =>
  [...new Set([...dateCounts.value.keys()].map(key => key.slice(0, 7)))].sort()
)

watch(
  [availableMonths, () => props.modelValue],
  ([months, selected]) => {
    if (selected && !dateCounts.value.has(selected)) {
      emit('update:modelValue', '')
    }
    const selectedMonth = selected?.slice(0, 7)
    if (selectedMonth && months.includes(selectedMonth)) {
      visibleMonth.value = selectedMonth
    } else if (!months.includes(visibleMonth.value)) {
      visibleMonth.value = months.at(-1) || ''
    }
  },
  { immediate: true }
)

const monthIndex = computed(() => availableMonths.value.indexOf(visibleMonth.value))

const monthLabel = computed(() => {
  if (!visibleMonth.value) return ''
  const [year, month] = visibleMonth.value.split('-').map(Number)
  const lang = locale.value === 'en' ? 'en-US' : 'zh-CN'
  return new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long' })
    .format(new Date(year, month - 1, 1))
})

const weekdayLabels = computed(() => {
  const lang = locale.value === 'en' ? 'en-US' : 'zh-CN'
  const monday = new Date(2024, 0, 1)
  return Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(lang, { weekday: 'narrow' })
      .format(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index))
  )
})

const calendarCells = computed(() => {
  if (!visibleMonth.value) return []
  const [year, month] = visibleMonth.value.split('-').map(Number)
  const first = new Date(year, month - 1, 1)
  const leading = (first.getDay() + 6) % 7
  const days = new Date(year, month, 0).getDate()
  const cells = Array.from({ length: leading }, () => null)

  for (let day = 1; day <= days; day++) {
    const key = `${visibleMonth.value}-${String(day).padStart(2, '0')}`
    cells.push({ day, key, count: dateCounts.value.get(key) || 0 })
  }
  while (cells.length % 7) cells.push(null)
  return cells
})

const selectedCount = computed(() => dateCounts.value.get(props.modelValue) || 0)

function moveMonth(direction) {
  const next = monthIndex.value + direction
  if (next >= 0 && next < availableMonths.value.length) {
    visibleMonth.value = availableMonths.value[next]
  }
}

function selectDate(cell) {
  if (!cell?.count) return
  emit('update:modelValue', props.modelValue === cell.key ? '' : cell.key)
}
</script>

<template>
  <section class="dcf" aria-label="draft calendar filter">
    <header class="dcf-head">
      <button
        type="button"
        class="dcf-all"
        :class="{ active: !modelValue }"
        @click="emit('update:modelValue', '')"
      >{{ t('drafts.allDates') }}</button>
      <span class="dcf-title">{{ t('drafts.calendarTitle') }}</span>
    </header>

    <template v-if="availableMonths.length">
      <div class="dcf-month">
        <button
          type="button"
          :disabled="monthIndex <= 0"
          :title="t('drafts.previousActiveMonth')"
          @click="moveMonth(-1)"
        >‹</button>
        <strong>{{ monthLabel }}</strong>
        <button
          type="button"
          :disabled="monthIndex < 0 || monthIndex >= availableMonths.length - 1"
          :title="t('drafts.nextActiveMonth')"
          @click="moveMonth(1)"
        >›</button>
      </div>

      <div class="dcf-weekdays">
        <span v-for="label in weekdayLabels" :key="label">{{ label }}</span>
      </div>
      <div class="dcf-grid">
        <template v-for="(cell, index) in calendarCells" :key="cell?.key || `blank-${index}`">
          <span v-if="!cell" class="dcf-blank"></span>
          <button
            v-else
            type="button"
            class="dcf-day"
            :class="{ active: modelValue === cell.key, available: cell.count > 0 }"
            :disabled="cell.count === 0"
            :title="cell.count ? t('drafts.dateCount', { date: cell.key, count: cell.count }) : ''"
            @click="selectDate(cell)"
          >
            <span>{{ cell.day }}</span>
            <small v-if="cell.count > 1">{{ cell.count }}</small>
          </button>
        </template>
      </div>

      <p v-if="modelValue" class="dcf-selection">
        {{ t('drafts.dateCount', { date: modelValue, count: selectedCount }) }}
      </p>
    </template>
  </section>
</template>

<style scoped>
.dcf {
  padding: 10px 12px 12px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-card) 94%, var(--text) 6%);
}
.dcf-head,
.dcf-month {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.dcf-head { margin-bottom: 9px; }
.dcf-title {
  color: var(--text-muted);
  font-size: 10px;
  letter-spacing: .04em;
}
.dcf-all {
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
}
.dcf-all.active {
  border-color: var(--accent);
  color: var(--accent);
}
.dcf-month button {
  width: 28px;
  height: 26px;
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: 19px;
}
.dcf-month button:disabled { opacity: .2; cursor: not-allowed; }
.dcf-month strong { font-size: 12px; font-weight: 600; }
.dcf-weekdays,
.dcf-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
}
.dcf-weekdays { margin-top: 5px; }
.dcf-weekdays span {
  padding: 3px 0;
  color: var(--text-muted);
  font-size: 9px;
  text-align: center;
}
.dcf-day,
.dcf-blank {
  position: relative;
  height: 31px;
}
.dcf-day {
  border: 1px solid transparent;
  border-radius: 0;
  background: transparent;
  color: color-mix(in srgb, var(--text-muted) 45%, transparent);
  cursor: not-allowed;
  font-size: 11px;
}
.dcf-day.available {
  color: var(--text);
  cursor: pointer;
  font-weight: 600;
}
.dcf-day.available:hover { border-color: var(--accent); }
.dcf-day.active {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
.dcf-day small {
  position: absolute;
  right: 2px;
  bottom: 1px;
  font-size: 7px;
  font-weight: 500;
}
.dcf-selection {
  margin: 7px 0 0;
  color: var(--accent);
  font-size: 10px;
  text-align: center;
}
</style>
