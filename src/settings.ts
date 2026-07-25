/**
 * Independent settings window — keeps the pet window visible and untouched.
 */
import './settings.css'
import { invoke } from '@tauri-apps/api/core'
import { emitTo } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import { openUrl } from '@tauri-apps/plugin-opener'
import { load, type Store } from '@tauri-apps/plugin-store'
import { check, type Update } from '@tauri-apps/plugin-updater'
import {
  createIcons,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  LogOut,
} from 'lucide'

type ModelKey = 'claude' | 'codex' | 'grok'

interface ModelVisibility {
  claude: boolean
  codex: boolean
  grok: boolean
}

interface PetSettings {
  baseUrl: string
  email: string
  alwaysOnTop: boolean
  autoStart: boolean
  maxDisplayAccounts: number
  refreshIntervalSec: number
  showModels: ModelVisibility
  cardOpacity: number
  windowX?: number
  windowY?: number
}

interface LoginResult {
  status: 'connected' | 'requires2fa'
  temp_token?: string
  email_masked?: string
}

const isDesktop = '__TAURI_INTERNALS__' in window
if (typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent || '')) {
  document.documentElement.classList.add('is-windows')
}
const defaultShowModels: ModelVisibility = { claude: true, codex: true, grok: true }
const defaultSettings: PetSettings = {
  baseUrl: '',
  email: '',
  alwaysOnTop: true,
  autoStart: false,
  maxDisplayAccounts: 5,
  refreshIntervalSec: 30,
  showModels: { ...defaultShowModels },
  cardOpacity: 0.62,
}

const DISPLAY_COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20] as const
const REFRESH_INTERVAL_OPTIONS = [
  { value: 10, label: '10 秒' },
  { value: 15, label: '15 秒' },
  { value: 30, label: '30 秒' },
  { value: 60, label: '1 分钟' },
  { value: 120, label: '2 分钟' },
  { value: 300, label: '5 分钟' },
  { value: 600, label: '10 分钟' },
] as const

let settings = { ...defaultSettings, showModels: { ...defaultShowModels } }
let appStore: Store | null = null
let connected = false
let tempToken = ''
let pendingUpdate: Update | null = null

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="settings-window-shell">
    <section class="settings-sheet" id="settings-sheet" aria-label="连接设置">
      <form id="connection-form" class="settings-form" autocomplete="on">
        <div class="settings-scroll">
          <header class="sheet-header">
            <div>
              <span class="eyebrow">SUB2API PET</span>
              <h1>账号池额度</h1>
            </div>
          </header>

          <label class="field">
            <span>平台地址</span>
            <div class="input-row">
              <input id="base-url" name="url" type="url" placeholder="https://api.example.com" required />
              <button type="button" class="input-icon" id="open-site" title="打开管理后台" aria-label="打开管理后台">
                <i data-lucide="external-link"></i>
              </button>
            </div>
          </label>

          <label class="field">
            <span>管理员邮箱</span>
            <input id="email" name="username" type="email" placeholder="admin@example.com" autocomplete="username" required />
          </label>

          <label class="field login-only">
            <span>密码</span>
            <div class="input-row">
              <input id="password" name="password" type="password" autocomplete="current-password" />
              <button type="button" class="input-icon" id="password-toggle" title="显示密码" aria-label="显示密码">
                <i data-lucide="eye"></i>
              </button>
            </div>
          </label>

          <label class="field totp-field is-hidden" id="totp-field">
            <span>两步验证码</span>
            <input id="totp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" />
          </label>

          <div class="setting-lines connected-only is-hidden">
            <div class="field model-pick-field">
              <span>展示模型</span>
              <div class="model-checks" role="group" aria-label="展示模型">
                <label class="model-check">
                  <input id="show-claude" type="checkbox" checked />
                  <span><strong>Claude</strong><small>Anthropic</small></span>
                </label>
                <label class="model-check">
                  <input id="show-codex" type="checkbox" checked />
                  <span><strong>Codex</strong><small>OpenAI</small></span>
                </label>
                <label class="model-check">
                  <input id="show-grok" type="checkbox" checked />
                  <span><strong>Grok</strong><small>xAI</small></span>
                </label>
              </div>
              <small class="field-hint">默认三项全开；取消勾选后对应账号不在宠物与托盘中展示</small>
            </div>
            <label class="field setting-select-field">
              <span>展示账号数</span>
              <select id="max-display-accounts"></select>
              <small class="field-hint">宠物面板与托盘最多展示前 N 个账号</small>
            </label>
            <label class="field setting-select-field">
              <span>刷新频率</span>
              <select id="refresh-interval"></select>
              <small class="field-hint">自动同步缓存额度的时间间隔</small>
            </label>
            <label class="field setting-select-field card-opacity-field">
              <span>卡片不透明度</span>
              <div class="opacity-row">
                <input id="card-opacity" type="range" min="0" max="100" step="1" value="62" />
                <span class="opacity-value" id="card-opacity-label">62%</span>
              </div>
              <small class="field-hint">柱状图背景卡片：0% 全透明，100% 不透明</small>
            </label>
            <label class="switch-line">
              <span><strong>始终置顶</strong><small>宠物保持在其他窗口上方</small></span>
              <input id="always-on-top" type="checkbox" role="switch" checked />
            </label>
            <label class="switch-line">
              <span><strong>开机启动</strong><small>登录系统后自动显示宠物</small></span>
              <input id="auto-start" type="checkbox" role="switch" />
            </label>
          </div>
          <p class="pool-hint connected-only is-hidden">按勾选的模型展示账号额度。右键宠物可打开操作菜单（刷新 / 设置 / 管理）。</p>

          <footer class="settings-footer">
            <button class="text-button danger connected-only is-hidden" id="logout-button" type="button">
              <i data-lucide="log-out"></i><span>退出登录</span>
            </button>
            <div class="footer-actions">
              <span class="connected-only is-hidden" id="refresh-hint">自动同步</span>
              <button class="text-button" id="check-update-button" type="button" title="检查应用更新">
                <i data-lucide="download"></i><span id="update-label">检查更新</span>
              </button>
            </div>
          </footer>
        </div>

        <div class="settings-actions">
          <p class="form-error" id="form-error"></p>
          <button class="primary-button login-only" id="connect-button" type="submit">连接平台</button>
          <button class="primary-button connected-only is-hidden" id="save-button" type="submit">保存设置</button>
        </div>
      </form>
    </section>
  </main>
`

function paintIcons(): void {
  createIcons({
    icons: { Eye, EyeOff, Download, ExternalLink, LogOut },
    attrs: { 'stroke-width': 2 },
  })
}
paintIcons()

const el = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const connectionForm = el<HTMLFormElement>('#connection-form')
const baseUrlInput = el<HTMLInputElement>('#base-url')
const emailInput = el<HTMLInputElement>('#email')
const passwordInput = el<HTMLInputElement>('#password')
const totpField = el<HTMLElement>('#totp-field')
const totpInput = el<HTMLInputElement>('#totp-code')
const alwaysOnTopInput = el<HTMLInputElement>('#always-on-top')
const autoStartInput = el<HTMLInputElement>('#auto-start')
const showClaudeInput = el<HTMLInputElement>('#show-claude')
const showCodexInput = el<HTMLInputElement>('#show-codex')
const showGrokInput = el<HTMLInputElement>('#show-grok')
const cardOpacityInput = el<HTMLInputElement>('#card-opacity')
const cardOpacityLabel = el<HTMLElement>('#card-opacity-label')
const maxDisplayAccountsInput = el<HTMLSelectElement>('#max-display-accounts')
const refreshIntervalInput = el<HTMLSelectElement>('#refresh-interval')
const formError = el<HTMLElement>('#form-error')
const connectButton = el<HTMLButtonElement>('#connect-button')
const refreshHint = el<HTMLElement>('#refresh-hint')
const checkUpdateButton = el<HTMLButtonElement>('#check-update-button')
const updateLabel = el<HTMLElement>('#update-label')

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return '操作失败，请稍后重试'
}

function clampDisplayAccounts(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return defaultSettings.maxDisplayAccounts
  return Math.max(1, Math.min(20, Math.round(n)))
}

function clampRefreshInterval(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return defaultSettings.refreshIntervalSec
  return Math.max(10, Math.min(3600, Math.round(n)))
}

function clampCardOpacity(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return defaultSettings.cardOpacity
  const unit = n > 1 ? n / 100 : n
  return Math.max(0, Math.min(1, Math.round(unit * 100) / 100))
}

function normalizeShowModels(raw: unknown): ModelVisibility {
  const source = raw && typeof raw === 'object' ? (raw as Partial<Record<ModelKey, unknown>>) : {}
  return {
    claude: source.claude !== false,
    codex: source.codex !== false,
    grok: source.grok !== false,
  }
}

function normalizeSettings(raw: Partial<PetSettings> | null | undefined): PetSettings {
  return {
    ...defaultSettings,
    ...raw,
    maxDisplayAccounts: clampDisplayAccounts(raw?.maxDisplayAccounts),
    refreshIntervalSec: clampRefreshInterval(raw?.refreshIntervalSec),
    showModels: normalizeShowModels(raw?.showModels),
    cardOpacity: clampCardOpacity(raw?.cardOpacity),
  }
}

function refreshHintText(): string {
  const sec = settings.refreshIntervalSec
  if (sec < 60) return `每 ${sec} 秒自动同步`
  if (sec % 60 === 0) return `每 ${sec / 60} 分钟自动同步`
  return `每 ${sec} 秒自动同步`
}

function populateSelects(): void {
  maxDisplayAccountsInput.replaceChildren()
  for (const count of DISPLAY_COUNT_OPTIONS) {
    const option = document.createElement('option')
    option.value = String(count)
    option.textContent = `${count} 个`
    maxDisplayAccountsInput.append(option)
  }
  refreshIntervalInput.replaceChildren()
  for (const item of REFRESH_INTERVAL_OPTIONS) {
    const option = document.createElement('option')
    option.value = String(item.value)
    option.textContent = item.label
    refreshIntervalInput.append(option)
  }
}

async function notifyMain(kind: 'save' | 'login' | 'logout' | 'preview-opacity', payload?: unknown): Promise<void> {
  if (!isDesktop) return
  try {
    await emitTo('main', 'settings-changed', { kind, payload })
  } catch {
    // main may not be listening yet
  }
}

async function loadSettings(): Promise<void> {
  if (!isDesktop) {
    const raw = localStorage.getItem('sub2api-pet-settings')
    settings = normalizeSettings(raw ? JSON.parse(raw) : null)
    return
  }
  appStore = await load('settings.json', { autoSave: true })
  settings = normalizeSettings(await appStore.get<PetSettings>('connection'))
  settings.autoStart = await isEnabled().catch(() => settings.autoStart)
}

async function saveSettings(): Promise<void> {
  if (!isDesktop) {
    localStorage.setItem('sub2api-pet-settings', JSON.stringify(settings))
    return
  }
  await appStore?.set('connection', settings)
}

function fillForm(): void {
  baseUrlInput.value = settings.baseUrl
  emailInput.value = settings.email
  alwaysOnTopInput.checked = settings.alwaysOnTop
  autoStartInput.checked = settings.autoStart
  showClaudeInput.checked = settings.showModels.claude
  showCodexInput.checked = settings.showModels.codex
  showGrokInput.checked = settings.showModels.grok
  const percent = Math.round(clampCardOpacity(settings.cardOpacity) * 100)
  cardOpacityInput.value = String(percent)
  cardOpacityLabel.textContent = `${percent}%`
  maxDisplayAccountsInput.value = String(clampDisplayAccounts(settings.maxDisplayAccounts))
  refreshIntervalInput.value = String(clampRefreshInterval(settings.refreshIntervalSec))
  if (![...refreshIntervalInput.options].some((o) => o.value === refreshIntervalInput.value)) {
    const option = document.createElement('option')
    option.value = refreshIntervalInput.value
    option.textContent = `${settings.refreshIntervalSec} 秒`
    refreshIntervalInput.append(option)
  }
  if (![...maxDisplayAccountsInput.options].some((o) => o.value === maxDisplayAccountsInput.value)) {
    const option = document.createElement('option')
    option.value = maxDisplayAccountsInput.value
    option.textContent = `${settings.maxDisplayAccounts} 个`
    maxDisplayAccountsInput.append(option)
  }
  refreshHint.textContent = refreshHintText()
  formError.textContent = ''
  document.querySelectorAll('.connected-only').forEach((item) => item.classList.toggle('is-hidden', !connected))
  document.querySelectorAll('.login-only').forEach((item) => item.classList.toggle('is-hidden', connected))
  if (!connected) window.setTimeout(() => baseUrlInput.focus(), 80)
}

async function connect(): Promise<void> {
  const baseUrl = baseUrlInput.value.trim()
  const email = emailInput.value.trim()
  const password = passwordInput.value
  formError.textContent = ''
  connectButton.disabled = true
  connectButton.textContent = tempToken ? '验证中…' : '连接中…'
  try {
    const result = !isDesktop
      ? ({ status: 'connected' } as LoginResult)
      : tempToken
        ? await invoke<LoginResult>('complete_login', {
            baseUrl,
            email,
            tempToken,
            totpCode: totpInput.value.trim(),
          })
        : await invoke<LoginResult>('login', { baseUrl, email, password })
    if (result.status === 'requires2fa') {
      tempToken = result.temp_token ?? ''
      totpField.classList.remove('is-hidden')
      totpInput.required = true
      totpInput.focus()
      return
    }
    settings.baseUrl = baseUrl.replace(/\/+$/, '')
    settings.email = email
    connected = true
    tempToken = ''
    passwordInput.value = ''
    totpInput.value = ''
    totpField.classList.add('is-hidden')
    await saveSettings()
    await notifyMain('login')
    fillForm()
    if (isDesktop) await invoke('hide_settings_window')
  } catch (error) {
    formError.textContent = errorMessage(error)
  } finally {
    connectButton.disabled = false
    connectButton.textContent = tempToken ? '验证并连接' : '连接平台'
  }
}

async function saveConnectedSettings(): Promise<void> {
  const showModels = {
    claude: showClaudeInput.checked,
    codex: showCodexInput.checked,
    grok: showGrokInput.checked,
  }
  if (!showModels.claude && !showModels.codex && !showModels.grok) {
    formError.textContent = '请至少勾选一个展示模型'
    return
  }
  settings.alwaysOnTop = alwaysOnTopInput.checked
  settings.autoStart = autoStartInput.checked
  settings.showModels = showModels
  settings.cardOpacity = clampCardOpacity(Number(cardOpacityInput.value) / 100)
  settings.maxDisplayAccounts = clampDisplayAccounts(maxDisplayAccountsInput.value)
  settings.refreshIntervalSec = clampRefreshInterval(refreshIntervalInput.value)
  if (isDesktop) {
    // Apply always-on-top on the pet (main) via event; also set main from main listener.
    if (settings.autoStart) await enable()
    else await disable()
  }
  await saveSettings()
  refreshHint.textContent = refreshHintText()
  await notifyMain('save')
  if (isDesktop) await invoke('hide_settings_window')
}

async function checkForUpdate(manual = false): Promise<void> {
  if (!isDesktop) return
  checkUpdateButton.disabled = true
  updateLabel.textContent = '检查中…'
  try {
    const update = await check()
    pendingUpdate = update
    if (!update) {
      updateLabel.textContent = manual ? '已是最新' : '检查更新'
      return
    }
    updateLabel.textContent = `更新 ${update.version}`
  } catch {
    updateLabel.textContent = manual ? '检查失败' : '检查更新'
  } finally {
    checkUpdateButton.disabled = false
  }
}

populateSelects()

connectionForm.addEventListener('submit', (event) => {
  event.preventDefault()
  if (connected) void saveConnectedSettings()
  else void connect()
})

cardOpacityInput.addEventListener('input', () => {
  const percent = Math.max(0, Math.min(100, Number(cardOpacityInput.value) || 0))
  cardOpacityLabel.textContent = `${percent}%`
  void notifyMain('preview-opacity', percent / 100)
})

el('#open-site').addEventListener('click', () => {
  const url = baseUrlInput.value.trim()
  if (!url) return
  if (isDesktop) void openUrl(url)
  else window.open(url, '_blank', 'noopener')
})

el('#password-toggle').addEventListener('click', (event) => {
  const button = event.currentTarget as HTMLButtonElement
  const visible = passwordInput.type === 'text'
  passwordInput.type = visible ? 'password' : 'text'
  button.innerHTML = `<i data-lucide="${visible ? 'eye' : 'eye-off'}"></i>`
  button.title = visible ? '显示密码' : '隐藏密码'
  paintIcons()
})

el('#logout-button').addEventListener('click', async () => {
  if (isDesktop) await invoke('logout')
  connected = false
  await saveSettings()
  await notifyMain('logout')
  fillForm()
})

checkUpdateButton.addEventListener('click', () => void checkForUpdate(true))

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isDesktop) void invoke('hide_settings_window')
})

async function initialize(): Promise<void> {
  await loadSettings()
  connected = isDesktop ? await invoke<boolean>('has_session') : true
  fillForm()
  // Refresh form when the window is re-shown (reuse instance).
  if (isDesktop) {
    void getCurrentWindow().listen('settings-window-shown', async () => {
      await loadSettings()
      connected = await invoke<boolean>('has_session')
      fillForm()
    })
  }
}

void initialize()
