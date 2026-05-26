<script setup>
import { ref, computed, onMounted } from 'vue'
import { useI18n } from '../i18n'

const { t } = useI18n()

// --- Status ---
const status = ref({ branch: '', changedFiles: 0, details: [], ahead: 0, behind: 0 })
const statusLoading = ref(false)
const statusError = ref('')

async function fetchStatus() {
  statusLoading.value = true
  statusError.value = ''
  try {
    const res = await fetch('/api/git/status')
    if (!res.ok) throw new Error((await res.json()).error || res.statusText)
    status.value = await res.json()
  } catch (e) {
    statusError.value = e.message
  } finally {
    statusLoading.value = false
  }
}

// --- Repo mode (private NovelWeb vs public AINovel) ---
const repoMode = ref({ isPrivate: false, publicExists: false, publicDir: '' })

async function fetchRepoMode() {
  try {
    const res = await fetch('/api/git/repo-mode')
    repoMode.value = await res.json()
  } catch {}
}

// --- Config ---
const cfg = ref({
  remoteUrl: '', branch: '', userName: '', userEmail: '',
  commitTemplate: 'update: {date}', forcePush: true, syncPublic: false,
  _live: { remoteUrl: '', branch: '', userName: '', userEmail: '' }
})
const cfgLoading = ref(false)
const cfgSaving = ref(false)
const cfgMsg = ref('')
const showConfig = ref(false)

async function fetchConfig() {
  cfgLoading.value = true
  try {
    const res = await fetch('/api/git/config')
    cfg.value = await res.json()
  } finally {
    cfgLoading.value = false
  }
}

async function saveConfig() {
  cfgSaving.value = true
  cfgMsg.value = ''
  try {
    const res = await fetch('/api/git/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        remoteUrl: cfg.value.remoteUrl,
        branch: cfg.value.branch,
        userName: cfg.value.userName,
        userEmail: cfg.value.userEmail,
        commitTemplate: cfg.value.commitTemplate,
        forcePush: cfg.value.forcePush,
        syncPublic: cfg.value.syncPublic
      })
    })
    const data = await res.json()
    if (data.ok) {
      cfg.value = data.config
      cfgMsg.value = t('git.configSaved')
      fetchStatus()
    } else {
      cfgMsg.value = t('git.configSaveFailed', { error: data.error || '?' })
    }
  } catch (e) {
    cfgMsg.value = t('git.configSaveFailed', { error: e.message })
  } finally {
    cfgSaving.value = false
    setTimeout(() => cfgMsg.value = '', 3000)
  }
}

function resetField(field) {
  cfg.value[field] = ''
}

// --- Push ---
const pushMsg = ref('')
const pushing = ref(false)
const commitMessage = ref('')

async function doPush() {
  pushing.value = true
  pushMsg.value = ''
  try {
    const res = await fetch('/api/git/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: commitMessage.value })
    })
    const data = await res.json()
    if (data.ok) {
      pushMsg.value = data.message
      commitMessage.value = ''
      fetchStatus()
    } else {
      pushMsg.value = t('git.pushFailed', { error: data.error || '?' })
    }
  } catch (e) {
    pushMsg.value = t('git.pushFailed', { error: e.message })
  } finally {
    pushing.value = false
    setTimeout(() => pushMsg.value = '', 5000)
  }
}

// --- Pull ---
const versions = ref([])
const versionsLoading = ref(false)
const pullScope = ref('all')
const pullVersion = ref('')
const pulling = ref(false)
const pullMsg = ref('')

async function fetchVersions() {
  versionsLoading.value = true
  try {
    const res = await fetch('/api/git/versions')
    versions.value = await res.json()
  } finally {
    versionsLoading.value = false
  }
}

async function doPull() {
  const scopeLabel = {
    all: t('git.scopeAll'),
    data: t('git.scopeData'),
    code: t('git.scopeCode'),
  }[pullScope.value]
  if (!confirm(t('git.pullConfirm', { scope: scopeLabel }))) return
  pulling.value = true
  pullMsg.value = ''
  try {
    const body = { scope: pullScope.value }
    if (pullVersion.value) body.version = pullVersion.value
    const res = await fetch('/api/git/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    })
    const data = await res.json()
    if (data.ok) {
      pullMsg.value = data.message
      fetchStatus()
    } else {
      pullMsg.value = t('git.pullFailed', { error: data.error || '?' })
    }
  } catch (e) {
    pullMsg.value = t('git.pullFailed', { error: e.message })
  } finally {
    pulling.value = false
    setTimeout(() => pullMsg.value = '', 5000)
  }
}

const stateBadge = computed(() => {
  if (statusLoading.value) return { text: t('git.statusChecking'), color: 'var(--text-muted)' }
  if (statusError.value) return { text: t('git.statusReadError'), color: '#c04040' }
  const { ahead, behind, changedFiles } = status.value
  if (ahead === 0 && behind === 0 && changedFiles === 0) return { text: t('git.statusClean'), color: '#3a8a3a' }
  const parts = []
  if (changedFiles > 0) parts.push(t('git.statusUncommitted', { count: changedFiles }))
  if (ahead > 0) parts.push(t('git.statusAhead', { count: ahead }))
  if (behind > 0) parts.push(t('git.statusBehind', { count: behind }))
  return { text: parts.join(' · '), color: 'var(--accent)' }
})

onMounted(() => {
  fetchRepoMode()
  fetchStatus()
  fetchConfig()
  fetchVersions()
})
</script>

<template>
  <div style="max-width: 880px; margin: 0 auto;">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
      <div style="display: flex; align-items: center; gap: 12px;">
        <h2 style="font-family: var(--font-reading); margin: 0;">{{ t('git.title') }}</h2>
        <span v-if="repoMode.isPrivate" style="font-size: 11px; padding: 2px 8px; border-radius: 4px; background: var(--accent); color: #fff;">{{ t('git.modePrivate') }}</span>
        <span v-else style="font-size: 11px; padding: 2px 8px; border-radius: 4px; background: #3a8a3a; color: #fff;">{{ t('git.modePublic') }}</span>
      </div>
      <button class="btn btn-sm" @click="fetchStatus(); fetchVersions()" :disabled="statusLoading">
        ⟳ {{ t('common.refresh') }}
      </button>
    </div>

    <!-- ============ Status card ============ -->
    <section style="border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; background: var(--bg-secondary);">
      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px;">
        <div>
          <span class="text-muted" style="font-size: 12px;">{{ t('git.currentBranch') }}</span>
          <strong style="font-family: monospace; margin-left: 8px;">{{ status.branch || '—' }}</strong>
        </div>
        <span :style="{ color: stateBadge.color, fontSize: '13px' }">{{ stateBadge.text }}</span>
      </div>
      <details v-if="status.details.length > 0" style="margin-top: 8px;">
        <summary style="cursor: pointer; font-size: 13px;">{{ t('git.changedFiles', { count: status.changedFiles }) }}</summary>
        <pre style="font-size: 11px; margin-top: 6px; padding: 8px; background: var(--bg-primary); border-radius: 4px; max-height: 200px; overflow-y: auto;">{{ status.details.join('\n') }}</pre>
      </details>
      <p v-if="statusError" style="color: #c04040; font-size: 12px; margin: 6px 0 0;">{{ statusError }}</p>
    </section>

    <!-- ============ Push card ============ -->
    <section style="border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px;">
      <h3 style="margin: 0 0 12px; font-size: 15px;">{{ t('git.sectionPush') }}</h3>
      <input
        v-model="commitMessage"
        type="text"
        :placeholder="t('git.commitPlaceholder', { template: cfg.commitTemplate })"
        @keyup.enter="doPush"
        style="width: 100%; font-size: 13px; padding: 8px 10px; margin-bottom: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);"
      />
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span class="text-muted" style="font-size: 12px;">
          {{ t('git.pushDescription', { identity: `${cfg.userName} <${cfg.userEmail}>`, branch: cfg.branch }) }}
          <span v-if="cfg.forcePush" style="color: var(--accent); margin-left: 6px;">[force]</span>
        </span>
        <button class="btn btn-primary" @click="doPush" :disabled="pushing">
          {{ pushing ? t('git.pushing') : t('git.push') }}
        </button>
      </div>
      <!-- Sync public toggle (only visible in private repo mode) -->
      <div v-if="repoMode.isPrivate" style="display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border);">
        <label style="font-size: 13px; display: flex; align-items: center; gap: 6px; cursor: pointer;">
          <input type="checkbox" v-model="cfg.syncPublic" @change="saveConfig" />
          {{ t('git.syncPublic') }}
        </label>
        <span class="text-muted" style="font-size: 11px;">{{ t('git.syncPublicHint') }}</span>
        <span v-if="repoMode.publicExists" style="font-size: 11px; color: #3a8a3a;">✓ AINovel</span>
        <span v-else style="font-size: 11px; color: var(--text-muted);">{{ t('git.publicNotFound') }}</span>
      </div>
      <p v-if="pushMsg" style="font-size: 12px; color: var(--accent); margin: 8px 0 0;">{{ pushMsg }}</p>
    </section>

    <!-- ============ Pull card ============ -->
    <section style="border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px;">
      <h3 style="margin: 0 0 12px; font-size: 15px;">{{ t('git.sectionPull') }}</h3>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 10px;">
        <div>
          <label class="text-muted" style="font-size: 12px;">{{ t('git.pullScope') }}</label>
          <div style="display: flex; gap: 8px; margin-top: 4px; font-size: 13px;">
            <label><input type="radio" v-model="pullScope" value="all" /> {{ t('git.scopeAll') }}</label>
            <label><input type="radio" v-model="pullScope" value="data" /> {{ t('git.scopeData') }}</label>
            <label><input type="radio" v-model="pullScope" value="code" /> {{ t('git.scopeCode') }}</label>
          </div>
        </div>
        <div>
          <label class="text-muted" style="font-size: 12px;">{{ t('git.version') }}</label>
          <select v-model="pullVersion" style="width: 100%; margin-top: 4px; font-size: 12px; padding: 5px; background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px;">
            <option value="">{{ t('git.latestVersion') }}</option>
            <option v-for="v in versions" :key="v.hash" :value="v.hash">
              {{ v.hash.substring(0, 7) }} — {{ v.message }}
            </option>
          </select>
        </div>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span class="text-muted" style="font-size: 12px;">
          {{ t('git.pullWarning') }}
        </span>
        <button class="btn" @click="doPull" :disabled="pulling">
          {{ pulling ? t('git.pulling') : t('git.pull') }}
        </button>
      </div>
      <p v-if="pullMsg" style="font-size: 12px; color: var(--accent); margin: 8px 0 0;">{{ pullMsg }}</p>
    </section>

    <!-- ============ Config card ============ -->
    <section style="border: 1px solid var(--border); border-radius: 8px; padding: 16px;">
      <div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;" @click="showConfig = !showConfig">
        <h3 style="margin: 0; font-size: 15px;">{{ t('git.sectionConfig') }} {{ showConfig ? '▾' : '▸' }}</h3>
        <span class="text-muted" style="font-size: 12px;">
          {{ t('git.configHint') }}
        </span>
      </div>

      <div v-if="showConfig" style="margin-top: 16px; display: grid; gap: 12px;">
        <!-- Remote URL -->
        <div>
          <label style="font-size: 12px; display: block; margin-bottom: 4px;">
            {{ t('git.remoteUrl') }}
            <span v-if="cfg._live.remoteUrl" class="text-muted" style="font-weight: normal;">
              ({{ t('git.gitSettingPrefix') }}<code style="font-size: 11px;">{{ cfg._live.remoteUrl }}</code>)
            </span>
          </label>
          <div style="display: flex; gap: 6px;">
            <input v-model="cfg.remoteUrl" type="text" placeholder="git@github.com:you/your-repo.git"
              style="flex: 1; font-size: 12px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);" />
            <button class="btn btn-sm" @click="resetField('remoteUrl')" :title="t('git.resetField')">↺</button>
          </div>
        </div>

        <!-- Branch -->
        <div>
          <label style="font-size: 12px; display: block; margin-bottom: 4px;">
            {{ t('git.branch') }}
            <span v-if="cfg._live.branch" class="text-muted" style="font-weight: normal;">
              ({{ t('git.currentPrefix') }}<code style="font-size: 11px;">{{ cfg._live.branch }}</code>)
            </span>
          </label>
          <div style="display: flex; gap: 6px;">
            <input v-model="cfg.branch" type="text" placeholder="main"
              style="flex: 1; font-size: 12px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);" />
            <button class="btn btn-sm" @click="resetField('branch')" :title="t('git.resetField')">↺</button>
          </div>
        </div>

        <!-- Identity -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div>
            <label style="font-size: 12px; display: block; margin-bottom: 4px;">
              {{ t('git.userName') }}
              <span v-if="cfg._live.userName" class="text-muted" style="font-weight: normal;">
                ({{ t('git.gitSettingPrefix') }}<code style="font-size: 11px;">{{ cfg._live.userName }}</code>)
              </span>
            </label>
            <input v-model="cfg.userName" type="text" placeholder="NovelWeb"
              style="width: 100%; font-size: 12px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);" />
          </div>
          <div>
            <label style="font-size: 12px; display: block; margin-bottom: 4px;">
              {{ t('git.userEmail') }}
              <span v-if="cfg._live.userEmail" class="text-muted" style="font-weight: normal;">
                ({{ t('git.gitSettingPrefix') }}<code style="font-size: 11px;">{{ cfg._live.userEmail }}</code>)
              </span>
            </label>
            <input v-model="cfg.userEmail" type="email" placeholder="you@example.com"
              style="width: 100%; font-size: 12px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);" />
          </div>
        </div>

        <!-- Commit template -->
        <div>
          <label style="font-size: 12px; display: block; margin-bottom: 4px;">
            {{ t('git.commitTemplate') }}
            <span class="text-muted" style="font-weight: normal;">{{ t('git.commitTemplateHint', { token: '{date}' }) }}</span>
          </label>
          <input v-model="cfg.commitTemplate" type="text" placeholder="update: {date}"
            style="width: 100%; font-size: 12px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);" />
        </div>

        <!-- Force push -->
        <div>
          <label style="font-size: 13px;">
            <input type="checkbox" v-model="cfg.forcePush" />
            {{ t('git.forcePush') }}
            <span class="text-muted">{{ t('git.forcePushHint') }}</span>
          </label>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
          <span v-if="cfgMsg" style="font-size: 12px; color: var(--accent);">{{ cfgMsg }}</span>
          <span v-else></span>
          <button class="btn btn-primary" @click="saveConfig" :disabled="cfgSaving">
            {{ cfgSaving ? t('common.saving') : t('git.saveConfig') }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
