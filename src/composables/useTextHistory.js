import { computed, nextTick, ref, unref } from 'vue'

function editorSnapshot(value, editor) {
  return {
    value: value || '',
    selectionStart: editor?.selectionStart ?? 0,
    selectionEnd: editor?.selectionEnd ?? editor?.selectionStart ?? 0,
  }
}

/**
 * A model-driven undo/redo layer for textarea editors.
 *
 * Browser-native history is not reliable once Vue model updates and
 * programmatic replacements are mixed in. This composable records the value
 * before each input transaction and keeps separate stacks per context key
 * (draft id, prompt slot, response slot, and so on).
 */
export function useTextHistory(model, editor, {
  contextKey = 'default',
  maxEntries = 120,
} = {}) {
  const histories = new Map()
  const revision = ref(0)

  function key() {
    const value = unref(contextKey)
    return value == null || value === '' ? 'default' : String(value)
  }

  function state(forKey = key()) {
    if (!histories.has(forKey)) {
      histories.set(forKey, { undo: [], redo: [], pending: null })
    }
    return histories.get(forKey)
  }

  function touch() {
    revision.value += 1
  }

  function trim(stack) {
    if (stack.length > maxEntries) stack.splice(0, stack.length - maxEntries)
  }

  function push(stack, snapshot) {
    if (!snapshot || typeof snapshot.value !== 'string') return false
    const previous = stack[stack.length - 1]
    if (previous?.value === snapshot.value) {
      previous.selectionStart = snapshot.selectionStart
      previous.selectionEnd = snapshot.selectionEnd
      return false
    }
    stack.push({
      value: snapshot.value,
      selectionStart: snapshot.selectionStart ?? 0,
      selectionEnd: snapshot.selectionEnd ?? snapshot.selectionStart ?? 0,
    })
    trim(stack)
    return true
  }

  function currentSnapshot() {
    return editorSnapshot(unref(model), unref(editor))
  }

  function capture(snapshot = currentSnapshot()) {
    const currentState = state()
    const changed = push(currentState.undo, snapshot)
    currentState.redo.length = 0
    currentState.pending = null
    if (changed) touch()
  }

  function onBeforeInput(event) {
    const currentState = state()
    currentState.pending = editorSnapshot(unref(model), event.currentTarget)
  }

  function onInput(event) {
    const currentState = state()
    const before = currentState.pending
    currentState.pending = null
    if (!before || before.value === event.currentTarget.value) return
    const changed = push(currentState.undo, before)
    currentState.redo.length = 0
    if (changed) touch()
  }

  function restoreSelection(snapshot) {
    nextTick(() => {
      const element = unref(editor)
      if (!element?.setSelectionRange) return
      element.focus()
      const max = (unref(model) || '').length
      const start = Math.min(snapshot.selectionStart ?? 0, max)
      const end = Math.min(snapshot.selectionEnd ?? start, max)
      element.setSelectionRange(start, end)
    })
  }

  function undo() {
    const currentState = state()
    const target = currentState.undo.pop()
    if (!target) return false
    push(currentState.redo, currentSnapshot())
    model.value = target.value
    currentState.pending = null
    touch()
    restoreSelection(target)
    return true
  }

  function redo() {
    const currentState = state()
    const target = currentState.redo.pop()
    if (!target) return false
    push(currentState.undo, currentSnapshot())
    model.value = target.value
    currentState.pending = null
    touch()
    restoreSelection(target)
    return true
  }

  function onKeydown(event) {
    const modifier = event.ctrlKey || event.metaKey
    if (!modifier) return
    const keyName = event.key.toLowerCase()
    if (keyName === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    } else if (keyName === 'y') {
      event.preventDefault()
      redo()
    }
  }

  function clear(forKey = key()) {
    histories.delete(String(forKey || 'default'))
    touch()
  }

  function clearAll() {
    histories.clear()
    touch()
  }

  const canUndo = computed(() => {
    revision.value
    return state().undo.length > 0
  })

  const canRedo = computed(() => {
    revision.value
    return state().redo.length > 0
  })

  return {
    canUndo,
    canRedo,
    capture,
    onBeforeInput,
    onInput,
    onKeydown,
    undo,
    redo,
    clear,
    clearAll,
  }
}
