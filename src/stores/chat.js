import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const API = '/api'

export const useChatStore = defineStore('chat', () => {
  const conversations = ref([])
  const currentConv = ref(null)
  const loading = ref(false)
  const streaming = ref(false)
  const streamContent = ref('')

  async function fetchConversations() {
    const res = await fetch(`${API}/conversations`)
    conversations.value = await res.json()
  }

  async function loadConversation(id) {
    loading.value = true
    try {
      const res = await fetch(`${API}/conversations/${id}`)
      currentConv.value = await res.json()
    } finally {
      loading.value = false
    }
  }

  async function createConversation({ title, model, bookId, contextChapters, systemPrompt }) {
    const res = await fetch(`${API}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, model, bookId, contextChapters, systemPrompt }),
    })
    const conv = await res.json()
    currentConv.value = conv
    await fetchConversations()
    return conv
  }

  async function deleteConversation(id) {
    await fetch(`${API}/conversations/${id}`, { method: 'DELETE' })
    if (currentConv.value?.id === id) currentConv.value = null
    await fetchConversations()
  }

  async function renameConversation(id, title) {
    await fetch(`${API}/conversations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    if (currentConv.value?.id === id) currentConv.value.title = title
    await fetchConversations()
  }

  // Walk tree from root to a given message, returning the chain
  function getChain(msgId) {
    if (!currentConv.value) return []
    const msgs = currentConv.value.messages
    const byId = Object.fromEntries(msgs.map(m => [m.id, m]))
    const chain = []
    let cur = byId[msgId]
    while (cur) {
      chain.unshift(cur)
      cur = cur.parent ? byId[cur.parent] : null
    }
    return chain
  }

  // Get children of a message
  function getChildren(msgId) {
    if (!currentConv.value) return []
    return currentConv.value.messages.filter(m => m.parent === msgId)
  }

  // Get the "active path" — from root following the last child at each fork
  const activePath = computed(() => {
    if (!currentConv.value?.messages?.length) return []
    const msgs = currentConv.value.messages
    const childMap = {}
    for (const m of msgs) {
      if (m.parent) {
        if (!childMap[m.parent]) childMap[m.parent] = []
        childMap[m.parent].push(m)
      }
    }
    const root = msgs.find(m => !m.parent)
    if (!root) return []
    const path = [root]
    let cur = root
    while (childMap[cur.id]?.length) {
      const children = childMap[cur.id]
      cur = children[children.length - 1]
      path.push(cur)
    }
    return path
  })

  // Send a message and stream the response
  async function sendMessage(userContent, parentMsgId) {
    if (!currentConv.value || streaming.value) return null

    const conv = currentConv.value
    const userMsg = {
      id: `msg-${Date.now().toString(36)}`,
      role: 'user',
      content: userContent,
      parent: parentMsgId || activePath.value[activePath.value.length - 1]?.id || null,
    }
    conv.messages.push(userMsg)

    const chain = getChain(userMsg.id)
    const apiMessages = chain.map(m => ({ role: m.role, content: m.content }))

    const assistantMsg = {
      id: `msg-${(Date.now() + 1).toString(36)}`,
      role: 'assistant',
      content: '',
      parent: userMsg.id,
    }
    conv.messages.push(assistantMsg)

    streaming.value = true
    streamContent.value = ''

    try {
      const res = await fetch(`${API}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          model: conv.model,
        }),
      })

      if (!res.ok) {
        const err = await res.text()
        assistantMsg.content = `[Error: ${err}]`
        return assistantMsg
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta?.content
            if (delta) {
              assistantMsg.content += delta
              streamContent.value = assistantMsg.content
            }
          } catch {}
        }
      }

      // Save conversation to server
      conv.updatedAt = new Date().toISOString()
      await fetch(`${API}/conversations/${conv.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: conv.messages }),
      })

      return assistantMsg
    } catch (e) {
      assistantMsg.content = `[Error: ${e.message}]`
      return assistantMsg
    } finally {
      streaming.value = false
      streamContent.value = ''
    }
  }

  // Regenerate — send same parent's user message again, creating a sibling branch
  async function regenerate(assistantMsgId) {
    if (!currentConv.value) return null
    const msgs = currentConv.value.messages
    const assistantMsg = msgs.find(m => m.id === assistantMsgId)
    if (!assistantMsg) return null
    const userMsg = msgs.find(m => m.id === assistantMsg.parent)
    if (!userMsg) return null
    return sendMessage(userMsg.content, userMsg.parent)
  }

  // Write an AI response to a chapter's version library
  async function writeToChapter(bookId, chapterId, msgId) {
    if (!currentConv.value) return null
    const msg = currentConv.value.messages.find(m => m.id === msgId)
    if (!msg) return null

    const res = await fetch(`${API}/books/${bookId}/chapters/${chapterId}/writes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: msg.content,
        provenance: {
          type: 'ai',
          conversationId: currentConv.value.id,
          messageId: msgId,
        },
      }),
    })
    return await res.json()
  }

  return {
    conversations, currentConv, loading, streaming, streamContent,
    activePath,
    fetchConversations, loadConversation, createConversation,
    deleteConversation, renameConversation,
    getChain, getChildren,
    sendMessage, regenerate, writeToChapter,
  }
})
