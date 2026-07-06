<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AppSettingsDto } from '../../../electron/api/types'
import { chromeShowToast } from '../../chrome/use-chrome-menu'

const emit = defineEmits<{
  saved: []
  close: []
}>()

const visible = defineModel<boolean>('visible', { default: false })

const busy = ref(false)
const settings = ref<AppSettingsDto | null>(null)

const llmApiKey = ref('')
const llmBaseUrl = ref('')
const llmModel = ref('')
const tavilyApiKey = ref('')

async function load() {
  const api = window.electronAPI?.app
  if (!api) return
  settings.value = await api.getSettings()
  llmApiKey.value = settings.value.llm.apiKey ?? ''
  llmBaseUrl.value = settings.value.llm.baseUrl ?? ''
  llmModel.value = settings.value.llm.model ?? ''
  tavilyApiKey.value = settings.value.skills.tavilyApiKey ?? ''
}

onMounted(() => { void load() })

async function onSave() {
  const api = window.electronAPI?.app
  if (!api || busy.value) return
  busy.value = true
  try {
    await api.saveSettings({
      llm: {
        apiKey: llmApiKey.value.trim() || undefined,
        baseUrl: llmBaseUrl.value.trim() || undefined,
        model: llmModel.value.trim() || undefined,
      },
      skills: {
        tavilyApiKey: tavilyApiKey.value.trim() || undefined,
      },
    })
    await load()
    emit('saved')
    chromeShowToast('设置已保存')
  } catch (e) {
    chromeShowToast(e instanceof Error ? e.message : '保存失败')
  } finally {
    busy.value = false
  }
}

async function onTestLlm() {
  const api = window.electronAPI?.app
  if (!api || busy.value) return
  busy.value = true
  try {
    await api.saveSettings({
      llm: {
        apiKey: llmApiKey.value.trim() || undefined,
        baseUrl: llmBaseUrl.value.trim() || undefined,
        model: llmModel.value.trim() || undefined,
      },
    })
    const result = await api.testLlm()
    chromeShowToast(result.ok ? '模型连接成功' : (result.error ?? '连接失败'))
  } finally {
    busy.value = false
  }
}

function onClose() {
  visible.value = false
  emit('close')
}
</script>

<template>
  <div v-if="visible" class="backdrop" @click.self="onClose">
    <div class="panel settings-panel" role="dialog" aria-labelledby="agent-settings-title">
      <header class="head">
        <h2 id="agent-settings-title">智能体设置</h2>
        <button type="button" class="close" @click="onClose">×</button>
      </header>

      <section class="section">
        <h3>全局模型</h3>
        <p class="hint">
          未单独指定模型的智能体将使用此配置。留空字段回退到 .env 或内置默认。
        </p>
        <label class="field">
          <span>API Key</span>
          <input v-model="llmApiKey" type="password" autocomplete="off" spellcheck="false">
        </label>
        <label class="field">
          <span>Base URL</span>
          <input
            v-model="llmBaseUrl"
            type="text"
            :placeholder="settings?.defaults.baseUrl"
            spellcheck="false"
          >
        </label>
        <label class="field">
          <span>Model</span>
          <input
            v-model="llmModel"
            type="text"
            :placeholder="settings?.defaults.model"
            spellcheck="false"
          >
        </label>
        <div class="row-actions">
          <button type="button" :disabled="busy" @click="onTestLlm">测试连接</button>
        </div>
      </section>

      <section class="section">
        <h3>技能 API</h3>
        <label class="field">
          <span>Tavily API Key（网页搜索）</span>
          <input v-model="tavilyApiKey" type="password" autocomplete="off" spellcheck="false">
        </label>
        <p v-if="settings?.configured.tavilyApiKey" class="status ok">Tavily 已配置</p>
        <p v-else class="status warn">Tavily 未配置，web_search 技能将不可用</p>
      </section>

      <footer class="footer">
        <button type="button" @click="onClose">取消</button>
        <button type="button" class="primary" :disabled="busy" @click="onSave">
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.settings-panel {
  width: min(440px, 92vw);
  max-height: 90vh;
  overflow: auto;
  padding: var(--space-md);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-md);
}

.head h2 {
  margin: 0;
  font-size: var(--ui-font-size-md);
}

.close {
  border: none;
  background: transparent;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 0 6px;
}

.section {
  margin-bottom: var(--space-md);
  padding-bottom: var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
}

.section h3 {
  margin: 0 0 var(--space-xs);
  font-size: var(--ui-font-size-sm);
}

.hint {
  margin: 0 0 var(--space-sm);
  font-size: 11px;
  color: var(--text-muted);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--space-sm);
  font-size: var(--ui-font-size-sm);
}

.field input {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-viewport);
}

.row-actions {
  display: flex;
  gap: var(--space-sm);
}

.status {
  font-size: 11px;
  margin: 0;
}

.status.ok {
  color: var(--success);
}

.status.warn {
  color: var(--warning);
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
}

button.primary {
  background: var(--accent, #2563eb);
  color: #fff;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
}
</style>
