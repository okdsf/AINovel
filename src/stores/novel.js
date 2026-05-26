import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const API = '/api'

export const useNovelStore = defineStore('novel', () => {
  // --- Multi-book state ---
  const books = ref([])
  const currentBookId = ref(localStorage.getItem('currentBookId') || '')
  const meta = ref(null)
  const loading = ref(false)

  const currentBook = computed(() => books.value.find(b => b.id === currentBookId.value))
  const bookApi = computed(() => `${API}/books/${currentBookId.value}`)

  // --- Books ---
  async function fetchBooks() {
    const res = await fetch(`${API}/books`)
    books.value = await res.json()
    // Auto-select first book if none selected
    if (!currentBookId.value && books.value.length > 0) {
      selectBook(books.value[0].id)
    }
    // If current book still valid, fetch its meta
    if (currentBookId.value) {
      await fetchMeta()
    }
  }

  function selectBook(bookId) {
    currentBookId.value = bookId
    localStorage.setItem('currentBookId', bookId)
    meta.value = null
    fetchMeta()
  }

  async function createBook(title, description) {
    const res = await fetch(`${API}/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description })
    })
    const data = await res.json()
    await fetchBooks()
    selectBook(data.id)
    return data.id
  }

  async function deleteBook(bookId) {
    await fetch(`${API}/books/${bookId}`, { method: 'DELETE' })
    if (currentBookId.value === bookId) {
      currentBookId.value = ''
      localStorage.removeItem('currentBookId')
      meta.value = null
    }
    await fetchBooks()
  }

  async function updateBook(bookId, title, description) {
    await fetch(`${API}/books/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description })
    })
    await fetchBooks()
  }

  // --- Meta ---
  async function fetchMeta() {
    if (!currentBookId.value) return
    loading.value = true
    try {
      const res = await fetch(`${bookApi.value}/meta`)
      meta.value = await res.json()
    } finally {
      loading.value = false
    }
  }

  // --- Volumes ---
  async function addVolume(title) {
    const res = await fetch(`${bookApi.value}/volumes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    })
    const data = await res.json()
    await fetchMeta()
    return data.id
  }

  async function renameVolume(volId, title) {
    await fetch(`${bookApi.value}/volumes/${volId}/title`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    })
    await fetchMeta()
  }

  async function deleteVolume(volId) {
    await fetch(`${bookApi.value}/volumes/${volId}`, { method: 'DELETE' })
    await fetchMeta()
  }

  // --- Chapters ---
  async function addChapter(volId, title) {
    const res = await fetch(`${bookApi.value}/volumes/${volId}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    })
    const data = await res.json()
    await fetchMeta()
    return data.id
  }

  async function deleteChapter(volId, chId) {
    await fetch(`${bookApi.value}/volumes/${volId}/chapters/${chId}`, { method: 'DELETE' })
    await fetchMeta()
  }

  async function getChapterContent(chId) {
    const res = await fetch(`${bookApi.value}/chapters/${chId}/content`)
    const data = await res.json()
    return data.content
  }

  async function saveChapterContent(chId, content) {
    await fetch(`${bookApi.value}/chapters/${chId}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })
  }

  async function getConversation(chId) {
    const res = await fetch(`${bookApi.value}/chapters/${chId}/conversation`)
    return await res.json()
  }

  async function saveConversation(chId, turns) {
    await fetch(`${bookApi.value}/chapters/${chId}/conversation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(turns)
    })
  }

  async function addConversationTurn(chId, userMessage, assistantMessage) {
    await fetch(`${bookApi.value}/chapters/${chId}/conversation/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessage, assistantMessage })
    })
  }

  async function renameChapter(chId, title) {
    await fetch(`${bookApi.value}/chapters/${chId}/title`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    })
    await fetchMeta()
  }

  async function splitChapter(chId, splitIndex, newTitle) {
    const res = await fetch(`${bookApi.value}/chapters/${chId}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ splitIndex, newTitle })
    })
    const data = await res.json()
    await fetchMeta()
    return data.newChapterId
  }

  async function mergeChapter(chId) {
    const res = await fetch(`${bookApi.value}/chapters/${chId}/merge`, { method: 'POST' })
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    await fetchMeta()
  }

  async function moveChapter(chId, targetVolId, targetIndex) {
    const res = await fetch(`${bookApi.value}/chapters/${chId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetVolId, targetIndex })
    })
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    await fetchMeta()
  }

  async function getStats() {
    const res = await fetch(`${bookApi.value}/stats`)
    return await res.json()
  }

  return {
    books, currentBookId, currentBook, meta, loading,
    fetchBooks, selectBook, createBook, deleteBook, updateBook,
    fetchMeta, addVolume, addChapter, deleteVolume, deleteChapter,
    getChapterContent, saveChapterContent,
    getConversation, saveConversation, addConversationTurn,
    renameChapter, renameVolume, splitChapter, mergeChapter, moveChapter,
    getStats
  }
})
