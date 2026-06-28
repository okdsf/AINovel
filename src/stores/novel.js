import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const API = '/api'

export const useNovelStore = defineStore('novel', () => {
  // --- Multi-book state ---
  const books = ref([])
  const currentBookId = ref(localStorage.getItem('currentBookId') || '')
  const meta = ref(null)
  const loading = ref(false)

  // --- Novel tree: selected reading path ---
  const treePath = ref([])
  const treeNodes = ref({})
  const treeData = ref(null)

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
      fetchTreePath()
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

  async function deleteVolume(volId, mode) {
    const qs = mode === 'dissolve' ? '?mode=dissolve' : ''
    await fetch(`${bookApi.value}/volumes/${volId}${qs}`, { method: 'DELETE' })
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

  // --- Novel Tree ---
  async function getTree() {
    const res = await fetch(`${bookApi.value}/tree`)
    return await res.json()
  }

  async function saveTree(tree) {
    await fetch(`${bookApi.value}/tree`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tree),
    })
    await fetchTreePath()
  }

  async function fetchTreePath() {
    if (!currentBookId.value) return
    try {
      const data = await getTree()
      treeData.value = data
      treePath.value = data.selectedPath || []
      treeNodes.value = data.nodes || {}
    } catch {
      treeData.value = null
      treePath.value = []
      treeNodes.value = {}
    }
  }

  function getPathNeighbors(chId) {
    const path = treePath.value
    if (!path.length) return { prev: null, next: null }
    const idx = path.indexOf(chId)
    if (idx === -1) return { prev: null, next: null }
    return {
      prev: idx > 0 ? path[idx - 1] : null,
      next: idx < path.length - 1 ? path[idx + 1] : null,
    }
  }

  // Compute the sidebar view: path grouped by volume, with chapter numbering
  const pathView = computed(() => {
    const path = treePath.value
    const nodes = treeNodes.value
    if (!path.length || !Object.keys(nodes).length) return []

    const volumes = []
    let currentVol = null
    let globalChNum = 0

    for (const chId of path) {
      const node = nodes[chId]
      if (!node) continue
      globalChNum++
      const volName = node.volume || ''

      if (!currentVol || currentVol.name !== volName) {
        currentVol = { name: volName, volNum: volumes.length + 1, chapters: [] }
        volumes.push(currentVol)
      }
      currentVol.chapters.push({ id: chId, title: node.title || chId, chNum: globalChNum })
    }
    return volumes
  })

  // --- Tree node operations ---
  async function renameTreeNode(nodeId, title) {
    await fetch(`${bookApi.value}/tree/node/${nodeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    await fetchTreePath()
  }

  async function deleteTreeNode(nodeId) {
    await fetch(`${bookApi.value}/tree/node/${nodeId}`, { method: 'DELETE' })
    await fetchTreePath()
  }

  async function swapTreeNodes(indexA, indexB) {
    await fetch(`${bookApi.value}/tree/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pathArray: treePath.value, indexA, indexB }),
    })
    await fetchTreePath()
  }

  async function renameTreeVolume(oldName, newName) {
    await fetch(`${bookApi.value}/tree/volume-rename`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldName, newName }),
    })
    await fetchTreePath()
  }

  // --- Writes (version library) ---
  async function getWrites(chId) {
    const res = await fetch(`${bookApi.value}/chapters/${chId}/writes`)
    return await res.json()
  }

  async function addWrite(chId, content, provenance) {
    const res = await fetch(`${bookApi.value}/chapters/${chId}/writes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, provenance }),
    })
    return await res.json()
  }

  async function deleteWrite(chId, writeId) {
    await fetch(`${bookApi.value}/chapters/${chId}/writes/${writeId}`, { method: 'DELETE' })
  }

  async function applyWrite(chId, writeId) {
    await fetch(`${bookApi.value}/chapters/${chId}/writes/${writeId}/apply`, { method: 'POST' })
  }

  return {
    books, currentBookId, currentBook, meta, loading,
    treePath, treeNodes, treeData, pathView,
    fetchBooks, selectBook, createBook, deleteBook, updateBook,
    fetchMeta, addVolume, addChapter, deleteVolume, deleteChapter,
    getChapterContent, saveChapterContent,
    getConversation, saveConversation, addConversationTurn,
    renameChapter, renameVolume, splitChapter, mergeChapter, moveChapter,
    getStats,
    getTree, saveTree, fetchTreePath, getPathNeighbors,
    renameTreeNode, deleteTreeNode, swapTreeNodes, renameTreeVolume,
    getWrites, addWrite, deleteWrite, applyWrite,
  }
})
