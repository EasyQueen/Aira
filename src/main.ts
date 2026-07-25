import './style.css'
import { invoke } from '@tauri-apps/api/core'
import { LogicalSize, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { listen } from '@tauri-apps/api/event'
import { cursorPosition, currentMonitor, getCurrentWindow } from '@tauri-apps/api/window'
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import { confirm } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { relaunch } from '@tauri-apps/plugin-process'
import { load, type Store } from '@tauri-apps/plugin-store'
import { check, type Update } from '@tauri-apps/plugin-updater'
import {
  createIcons,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  LogOut,
  RefreshCw,
} from 'lucide'
import petDefault from './assets/pets/pet.png'
import petHappy from './assets/pets/pet-happy.png'
import petCute from './assets/pets/pet-cute.png'
import petSilly from './assets/pets/pet-silly.png'
import petEdgeTop from './assets/pets/pet-top.png'
import petEdgeBottom from './assets/pets/pet-bottom.png'
import petEdgeLeft from './assets/pets/pet-left.png'
import petEdgeRight from './assets/pets/pet-right.png'

/** Base status moods (driven by app state) plus playful interaction reactions. */
type PetMood = 'idle' | 'refreshing' | 'success' | 'alert' | 'happy' | 'cute' | 'silly'
/** Screen edge the pet is leaning against, or null when free-floating. */
type DockEdge = 'top' | 'bottom' | 'left' | 'right'

const MOOD_IMAGES: Record<PetMood, string> = {
  idle: petDefault,
  refreshing: petCute,
  success: petHappy,
  alert: petSilly,
  happy: petHappy,
  cute: petCute,
  silly: petSilly,
}

const EDGE_IMAGES: Record<DockEdge, string> = {
  top: petEdgeTop,
  bottom: petEdgeBottom,
  left: petEdgeLeft,
  right: petEdgeRight,
}

// Warm the browser cache so swapping moods / docking doesn't flash a blank frame.
for (const src of new Set([...Object.values(MOOD_IMAGES), ...Object.values(EDGE_IMAGES)])) {
  const preload = new Image()
  preload.src = src
}

/** Display toggles for pool platforms (maps to Sub2API account.platform). */
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
  /** Max accounts shown on the pet panel / tray. */
  maxDisplayAccounts: number
  /** Auto refresh interval in seconds. */
  refreshIntervalSec: number
  /** Which model families appear on the pet / tray. Default: all on. */
  showModels: ModelVisibility
  /**
   * Opacity of the frosted card behind the quota meters (0 = invisible, 1 = solid).
   * Stored as 0–1; settings UI uses percent.
   */
  cardOpacity: number
  windowX?: number
  windowY?: number
}

interface LoginResult {
  status: 'connected' | 'requires2fa'
  temp_token?: string
  email_masked?: string
}

interface QuotaWindow {
  label: string
  used_percent: number
  remaining_percent: number
  reset_at?: string | null
}

interface AccountQuotaRow {
  id: number
  name: string
  status: string
  plan?: string
  platform?: string
  account_type?: string
  remaining_percent?: number | null
  windows?: QuotaWindow[]
  updated_at?: string | null
  source?: 'active' | 'cached' | string | null
}

const BAR_SEGMENTS = 5

const isDesktop = '__TAURI_INTERNALS__' in window
/** Windows WebView2 pays a steep cost for backdrop-filter on transparent always-on-top windows. */
const isWindows =
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent || '')
if (isWindows) {
  document.documentElement.classList.add('is-windows')
}
const defaultShowModels: ModelVisibility = {
  claude: true,
  codex: true,
  grok: true,
}

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

let settings = { ...defaultSettings }
let appStore: Store | null = null
let poolRows: AccountQuotaRow[] = []
let connected = false
let settingsOpen = false
let refreshing = false
let tempToken = ''
let autoRefreshTimer: number | undefined
let moodTimer: number | undefined
let bubbleTimer: number | undefined
let idleChatterTimer: number | undefined
let moveSaveTimer: number | undefined
let currentMood: PetMood = 'idle'
let dockEdge: DockEdge | null = null
/** Temporarily expanded from dock peek while the pointer is over the pet. */
let dockHoverOpen = false
let dockHoverTimer: number | undefined
let dockHoverBusy = false
/** True while we are programmatically repositioning, so onMoved snapping doesn't recurse. */
let snapping = false
/** True while the dock/undock presentation handoff is running. */
let animating = false
/** Consecutive playful taps; resets after a short idle window. */
let tapStreak = 0
let tapStreakTimer: number | undefined
/** Avoid repeating the same bubble line back-to-back. */
let lastBubbleLine = ''
/** Peek dock is the collapsed edge footprint (not hover-expanded). Settings is a separate window. */
function isDockPeek(): boolean {
  return dockEdge != null && !dockHoverOpen
}

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="pet-shell" id="pet-shell">
    <section class="pet-stage" aria-live="polite">
      <div
        class="pet-hitbox"
        id="pet-button"
        data-tauri-drag-region
        role="button"
        tabindex="0"
        aria-label="单击互动，右键打开菜单，按住拖动"
        title="单击互动 · 右键菜单 · 按住拖动"
      >
        <div class="speech-bubble" id="speech-bubble" role="status" aria-live="polite">
          <p class="speech-text" id="speech-text"></p>
        </div>
        <img class="pet-image" id="pet-image" src="${petDefault}" alt="Sub2API 桌面宠物" draggable="false" />
        <img class="pet-peek" id="peek-image" alt="" aria-hidden="true" draggable="false" />
        <span class="refresh-orbit" aria-hidden="true"><i data-lucide="refresh-cw"></i></span>
      </div>

      <div class="quota-panel" id="quota-dock" aria-label="账号池额度面板">
        <div class="meter-card" id="meter-card">
          <div class="meter-board" id="account-list" role="list"></div>
        </div>
        <span class="visually-hidden" id="updated-label">尚未同步</span>
      </div>
      <div class="toast" id="toast" role="status"></div>
    </section>

    <section class="settings-sheet is-hidden" id="settings-sheet" aria-label="连接设置">
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
              <div class="model-checks" id="model-checks" role="group" aria-label="展示模型">
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
                <input
                  id="card-opacity"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value="62"
                  aria-valuemin="0"
                  aria-valuemax="100"
                />
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
    icons: {
      Eye,
      EyeOff,
      Download,
      ExternalLink,
      LogOut,
      RefreshCw,
    },
    attrs: { 'stroke-width': 2 },
  })
}

paintIcons()

const element = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const shell = element<HTMLElement>('#pet-shell')
const petImage = element<HTMLImageElement>('#pet-image')
const peekImage = element<HTMLImageElement>('#peek-image')
const petButton = element<HTMLElement>('#pet-button')
const speechBubble = element<HTMLElement>('#speech-bubble')
const speechText = element<HTMLElement>('#speech-text')
const quotaDock = element<HTMLElement>('#quota-dock')
const accountList = element<HTMLElement>('#account-list')

// Block native text/image selection on the pet stage (WebKit still selects otherwise).
const petStage = element<HTMLElement>('.pet-stage')
petStage.addEventListener('selectstart', (event) => event.preventDefault())
petStage.addEventListener('dragstart', (event) => event.preventDefault())
const updatedLabel = element<HTMLElement>('#updated-label')
const toast = element<HTMLElement>('#toast')
const settingsSheet = element<HTMLElement>('#settings-sheet')
const connectionForm = element<HTMLFormElement>('#connection-form')
const baseUrlInput = element<HTMLInputElement>('#base-url')
const emailInput = element<HTMLInputElement>('#email')
const passwordInput = element<HTMLInputElement>('#password')
const totpField = element<HTMLElement>('#totp-field')
const totpInput = element<HTMLInputElement>('#totp-code')
const alwaysOnTopInput = element<HTMLInputElement>('#always-on-top')
const autoStartInput = element<HTMLInputElement>('#auto-start')
const showClaudeInput = element<HTMLInputElement>('#show-claude')
const showCodexInput = element<HTMLInputElement>('#show-codex')
const showGrokInput = element<HTMLInputElement>('#show-grok')
const cardOpacityInput = element<HTMLInputElement>('#card-opacity')
const cardOpacityLabel = element<HTMLElement>('#card-opacity-label')
const maxDisplayAccountsInput = element<HTMLSelectElement>('#max-display-accounts')
const refreshIntervalInput = element<HTMLSelectElement>('#refresh-interval')
const refreshHint = element<HTMLElement>('#refresh-hint')
const formError = element<HTMLElement>('#form-error')
const connectButton = element<HTMLButtonElement>('#connect-button')
const checkUpdateButton = element<HTMLButtonElement>('#check-update-button')
const updateLabel = element<HTMLElement>('#update-label')

let checkingUpdate = false

async function installUpdate(update: Update): Promise<void> {
  const accepted = await confirm(
    `发现新版本 v${update.version}，是否立即下载并安装？${update.body ? `\n\n${update.body}` : ''}`,
    { title: 'Sub2API Pet 更新', kind: 'info', okLabel: '立即升级', cancelLabel: '稍后' },
  )
  if (!accepted) {
    updateLabel.textContent = `可升级至 v${update.version}`
    return
  }

  checkUpdateButton.disabled = true
  updateLabel.textContent = '正在下载…'
  let downloaded = 0
  let total = 0
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0
      if (event.event === 'Progress') downloaded += event.data.chunkLength
      if (event.event === 'Finished') updateLabel.textContent = '正在安装…'
      if (total > 0 && event.event === 'Progress') {
        updateLabel.textContent = `下载 ${Math.min(100, Math.round((downloaded / total) * 100))}%`
      }
    })
    await relaunch()
  } catch (error) {
    updateLabel.textContent = '升级失败'
    showToast(`升级失败：${errorMessage(error)}`, 'error')
    checkUpdateButton.disabled = false
  }
}

async function checkForUpdate(manual = false): Promise<void> {
  if (!isDesktop || checkingUpdate) return
  checkingUpdate = true
  checkUpdateButton.disabled = true
  updateLabel.textContent = '正在检查…'
  try {
    const update = await check()
    if (update) {
      updateLabel.textContent = `发现 v${update.version}`
      await installUpdate(update)
    } else {
      updateLabel.textContent = '已是最新版'
      if (manual) showToast('当前已是最新版本')
    }
  } catch (error) {
    updateLabel.textContent = '检查失败'
    if (manual) showToast(`检查更新失败：${errorMessage(error)}`, 'error')
  } finally {
    checkingUpdate = false
    checkUpdateButton.disabled = false
  }
}

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

/** Accept 0–1 or 0–100; clamp to 0–1 for storage. */
function clampCardOpacity(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return defaultSettings.cardOpacity
  const unit = n > 1 ? n / 100 : n
  return Math.max(0, Math.min(1, Math.round(unit * 100) / 100))
}

function cardOpacityPercent(opacity: number = settings.cardOpacity): number {
  return Math.round(clampCardOpacity(opacity) * 100)
}

function applyCardOpacity(opacity: number = settings.cardOpacity): void {
  const alpha = clampCardOpacity(opacity)
  shell.style.setProperty('--meter-card-opacity', String(alpha))
  // Soften border / blur with the same knob so 0% truly disappears (no drop shadow).
  shell.style.setProperty('--meter-card-border', String(Math.min(0.45, alpha * 0.55)))
  // Skip backdrop blur on Windows — WebView2 transparent composition is too expensive.
  shell.style.setProperty(
    '--meter-card-blur',
    isWindows ? '0px' : `${Math.round(4 + alpha * 14)}px`,
  )
}

function normalizeShowModels(raw: unknown): ModelVisibility {
  const source =
    raw && typeof raw === 'object' ? (raw as Partial<Record<ModelKey, unknown>>) : {}
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

/** Map Sub2API platform string → display model key. */
function modelKeyForPlatform(platform?: string | null): ModelKey {
  const value = (platform || '').toLowerCase()
  if (value === 'anthropic' || value === 'claude') return 'claude'
  if (value === 'xai' || value === 'grok') return 'grok'
  return 'codex'
}

function isModelEnabled(platform?: string | null): boolean {
  return settings.showModels[modelKeyForPlatform(platform)]
}

function readShowModelsFromForm(): ModelVisibility {
  return {
    claude: showClaudeInput.checked,
    codex: showCodexInput.checked,
    grok: showGrokInput.checked,
  }
}

function writeShowModelsToForm(models: ModelVisibility): void {
  showClaudeInput.checked = models.claude
  showCodexInput.checked = models.codex
  showGrokInput.checked = models.grok
}

function writeCardOpacityToForm(opacity: number = settings.cardOpacity): void {
  const percent = cardOpacityPercent(opacity)
  cardOpacityInput.value = String(percent)
  cardOpacityLabel.textContent = `${percent}%`
}

function populateSettingSelects(): void {
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

function refreshHintText(): string {
  const sec = settings.refreshIntervalSec
  if (sec < 60) return `每 ${sec} 秒自动同步`
  if (sec % 60 === 0) return `每 ${sec / 60} 分钟自动同步`
  return `每 ${sec} 秒自动同步`
}

function visiblePoolRows(): AccountQuotaRow[] {
  const limit = clampDisplayAccounts(settings.maxDisplayAccounts)
  return poolRows.filter((row) => isModelEnabled(row.platform)).slice(0, limit)
}

populateSettingSelects()

async function loadSettings(): Promise<void> {
  if (!isDesktop) {
    const raw = localStorage.getItem('sub2api-pet-settings')
    settings = normalizeSettings(raw ? JSON.parse(raw) : null)
    applyCardOpacity()
    return
  }
  appStore = await load('settings.json', { autoSave: true })
  settings = normalizeSettings(await appStore.get<PetSettings>('connection'))
  settings.autoStart = await isEnabled().catch(() => settings.autoStart)
  applyCardOpacity()
}

async function saveSettings(): Promise<void> {
  if (!isDesktop) {
    localStorage.setItem('sub2api-pet-settings', JSON.stringify(settings))
    return
  }
  await appStore?.set('connection', settings)
}

async function registerPositionPersistence(): Promise<void> {
  if (!isDesktop) return
  const appWindow = getCurrentWindow()
  if (Number.isFinite(settings.windowX) && Number.isFinite(settings.windowY)) {
    await appWindow.setPosition(new PhysicalPosition(settings.windowX!, settings.windowY!))
    // Restore a saved docked state instantly (no animation on launch).
    const edge = await nearestEdge(settings.windowX!, settings.windowY!)
    if (edge) {
      setDock(edge)
      await applyWindowSize()
      await snapToEdge()
    }
  }
  await appWindow.onMoved(({ payload }) => {
    if (snapping || settingsOpen) return
    settings.windowX = payload.x
    settings.windowY = payload.y
    // Pose/size stays put while dragging; the transition plays once the drag settles.
    window.clearTimeout(moveSaveTimer)
    moveSaveTimer = window.setTimeout(() => void finalizeMove(), 180)
  })
}

interface WinRect {
  x: number
  y: number
  w: number
  h: number
}

/** Which edge (if any) the window is currently close enough to lean on. */
async function nearestEdge(x: number, y: number): Promise<DockEdge | null> {
  if (!isDesktop) return null
  const monitor = await currentMonitor()
  if (!monitor) return null
  const size = await getCurrentWindow().outerSize()
  const threshold = Math.round(34 * monitor.scaleFactor)
  // Work area excludes the menu bar / dock / taskbar, so the top edge is reachable.
  const waL = monitor.workArea.position.x
  const waT = monitor.workArea.position.y
  const waR = waL + monitor.workArea.size.width
  const waB = waT + monitor.workArea.size.height
  const dLeft = x - waL
  const dTop = y - waT
  const dRight = waR - (x + size.width)
  const dBottom = waB - (y + size.height)
  const nearest = Math.min(dLeft, dTop, dRight, dBottom)
  if (nearest >= threshold) return null
  if (nearest === dTop) return 'top'
  if (nearest === dBottom) return 'bottom'
  if (nearest === dLeft) return 'left'
  return 'right'
}

/**
 * Target window rectangle (physical px).
 * - edge + peek: 48px dock footprint flush to that edge
 * - edge + expanded: full pet size still pinned to that edge (hover preview)
 * - null: free-floating full pet around the current center
 */
async function targetRect(edge: DockEdge | null, expanded = false): Promise<WinRect | null> {
  const monitor = await currentMonitor()
  if (!monitor) return null
  const sf = monitor.scaleFactor
  const waL = monitor.workArea.position.x
  const waT = monitor.workArea.position.y
  const waR = waL + monitor.workArea.size.width
  const waB = waT + monitor.workArea.size.height
  const win = getCurrentWindow()
  const cur = await win.outerSize()
  const pos = await win.outerPosition()
  const centerX = pos.x + cur.width / 2
  const centerY = pos.y + cur.height / 2
  let w: number
  let h: number
  if (edge && !expanded) {
    w = Math.round(DOCK_SIZE * sf)
    h = w
  } else {
    const s = petWindowSize()
    w = Math.round(s.width * sf)
    h = Math.round(s.height * sf)
  }
  // Shrink/grow around the current center, then pin the docked axis flush to the edge.
  let x = Math.round(centerX - w / 2)
  let y = Math.round(centerY - h / 2)
  if (edge === 'top') y = waT
  else if (edge === 'bottom') y = waB - h
  else if (edge === 'left') x = waL
  else if (edge === 'right') x = waR - w
  x = Math.max(waL, Math.min(waR - w, x))
  y = Math.max(waT, Math.min(waB - h, y))
  return { x, y, w, h }
}

function transitionOrigin(edge: DockEdge | null): string {
  if (edge === 'top') return 'center top'
  if (edge === 'bottom') return 'center bottom'
  if (edge === 'left') return 'left center'
  if (edge === 'right') return 'right center'
  return 'center center'
}

function transitionTransform(edge: DockEdge | null, scale: number): string {
  if (edge === 'top') return `translateY(-4px) scale(${scale})`
  if (edge === 'bottom') return `translateY(4px) scale(${scale})`
  if (edge === 'left') return `translateX(-4px) scale(${scale})`
  if (edge === 'right') return `translateX(4px) scale(${scale})`
  return `scale(${scale})`
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/**
 * Hand the visible pet pose over while the transparent native window is hidden.
 * Resizing a transparent window on every animation frame leaves compositor trails on
 * some systems. A short sequential fade keeps only one pose visible and lets the
 * native window move/resize exactly once between the two halves of the transition.
 */
async function transitionWindowPresentation(
  target: WinRect,
  updatePresentation: () => void,
  edge: DockEdge | null,
): Promise<void> {
  if (!isDesktop) return
  const win = getCurrentWindow()
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let outgoing: Animation | null = null
  let incoming: Animation | null = null
  snapping = true
  animating = true
  const previousOrigin = petStage.style.transformOrigin
  petStage.style.transformOrigin = transitionOrigin(edge)

  try {
    if (!reducedMotion) {
      outgoing = petStage.animate(
        [
          { opacity: 1, transform: 'translate(0, 0) scale(1)' },
          { opacity: 0, transform: transitionTransform(edge, 0.92) },
        ],
        { duration: 85, easing: 'ease-in', fill: 'forwards' },
      )
      await outgoing.finished
    }

    // The stage is fully transparent here. Resize first, then place the final rectangle;
    // serial AppKit updates avoid the occasional right/bottom-edge race from parallel IPC.
    await win.setSize(new PhysicalSize(target.w, target.h))
    await win.setPosition(new PhysicalPosition(target.x, target.y))
    updatePresentation()
    settings.windowX = target.x
    settings.windowY = target.y

    if (!reducedMotion) {
      // Keep the old pose fully transparent until the resized webview has laid out.
      await nextAnimationFrame()
      incoming = petStage.animate(
        [
          { opacity: 0, transform: transitionTransform(edge, 0.95) },
          { opacity: 1, transform: 'translate(0, 0) scale(1)' },
        ],
        { duration: 160, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)', fill: 'both' },
      )
      outgoing?.cancel()
      outgoing = null
      await incoming.finished
    }
  } finally {
    outgoing?.cancel()
    incoming?.cancel()
    petStage.style.transformOrigin = previousOrigin
    animating = false
    window.setTimeout(() => {
      snapping = false
    }, 60)
  }
}

/** After a drag settles, play the fluid transition into / out of the leaning state. */
async function finalizeMove(): Promise<void> {
  if (!isDesktop || animating || settingsOpen) return
  window.clearTimeout(dockHoverTimer)
  const edge = await nearestEdge(settings.windowX ?? 0, settings.windowY ?? 0)
  if (edge && !dockEdge) {
    const rect = await targetRect(edge, false)
    if (rect) await transitionWindowPresentation(rect, () => setDock(edge), edge)
    else setDock(edge)
  } else if (!edge && dockEdge) {
    const alreadyExpanded = dockHoverOpen
    if (alreadyExpanded) {
      // Hover expansion already uses the full layout and window size; only detach state.
      setDock(null)
    } else {
      const rect = await targetRect(null)
      if (rect) await transitionWindowPresentation(rect, () => setDock(null), dockEdge)
      else setDock(null)
    }
  } else if (edge && dockEdge && edge !== dockEdge) {
    dockHoverOpen = false
    const rect = await targetRect(edge, false)
    if (rect) await transitionWindowPresentation(rect, () => setDock(edge), edge)
    else setDock(edge)
  } else if (edge && dockEdge) {
    // Nudged along the same edge: keep it flush without a full animation.
    dockHoverOpen = false
    applyDockPresentation()
    await snapToEdge()
  }
  await saveSettings()
}

/** Snap the docked window flush to its edge (used on launch / same-edge nudges). */
async function snapToEdge(): Promise<void> {
  if (!isDesktop || !dockEdge) return
  const rect = await targetRect(dockEdge, dockHoverOpen)
  if (!rect) return
  if (rect.x === settings.windowX && rect.y === settings.windowY) return
  snapping = true
  try {
    const win = getCurrentWindow()
    await win.setPosition(new PhysicalPosition(rect.x, rect.y))
    settings.windowX = rect.x
    settings.windowY = rect.y
    await saveSettings()
  } finally {
    window.setTimeout(() => {
      snapping = false
    }, 120)
  }
}

function formatClock(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function formatReset(value?: string): string {
  if (!value) return '重置时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '重置时间未知'
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date)
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return `${weekday} ${time} 重置`
}

function applyPetImage(): void {
  // The transition hides the stage while handing over between these two art layers.
  petImage.src = MOOD_IMAGES[currentMood]
  if (dockEdge) peekImage.src = EDGE_IMAGES[dockEdge]
}

function setMood(mood: PetMood): void {
  window.clearTimeout(moodTimer)
  currentMood = mood
  shell.dataset.mood = mood
  applyPetImage()
}

const REACTION_LINES: Record<'happy' | 'cute' | 'silly', string[]> = {
  happy: [
    '嘿嘿，被摸到啦～',
    '心情超好！今天也冲！',
    '摸摸有效，继续加油写代码',
    '嘻嘻，再点一下？',
    '状态拉满！',
  ],
  cute: [
    '再摸一下嘛…',
    '呜呜好开心～',
    '要一起盯额度吗？',
    '轻轻的…好舒服',
    '粘人模式已开启',
  ],
  silly: [
    '欸？点我干嘛～',
    '别戳啦，会变傻的',
    '配额还够用吗？',
    '被抓包了！',
    '诶嘿，被你发现啦',
  ],
}

const STREAK_LINES = [
  '连续互动！你很闲嘛～',
  '停不下来了对吧',
  '再点我就要飞走了哦',
  '好啦好啦，我知道你在',
]

const TIP_LINES = [
  '右键我可以打开操作菜单',
  '菜单里可以刷新额度哦',
  '把我拖到屏幕边缘会躲起来',
  '右键托盘图标也能打开菜单',
  '低额度时我会提醒你哦',
  '单击我可以聊天互动',
]

function pickLine(lines: string[]): string {
  if (!lines.length) return ''
  const filtered = lines.filter((line) => line !== lastBubbleLine)
  const pool = filtered.length ? filtered : lines
  return pool[Math.floor(Math.random() * pool.length)]
}

function hideSpeechBubble(): void {
  window.clearTimeout(bubbleTimer)
  speechBubble.classList.remove('is-visible')
}

function showSpeechBubble(message: string, durationMs = 2600): void {
  if (!message || settingsOpen || isDockPeek()) return
  lastBubbleLine = message
  speechText.textContent = message
  speechBubble.classList.add('is-visible')
  window.clearTimeout(bubbleTimer)
  bubbleTimer = window.setTimeout(() => {
    speechBubble.classList.remove('is-visible')
  }, durationMs)
  scheduleIdleChatter()
}

function lowestActiveRemaining(): number | null {
  let lowest: number | null = null
  for (const row of poolRows) {
    if (row.status !== 'active') continue
    const remaining = lowestRemaining(row)
    if (remaining == null) continue
    lowest = lowest == null ? remaining : Math.min(lowest, remaining)
  }
  return lowest
}

function contextualTapLine(): string | null {
  if (!connected) return '先连上 Sub2API 吧～'
  const lowest = lowestActiveRemaining()
  if (lowest != null && lowest <= 15) {
    return pickLine([
      `有账号只剩 ${Math.round(lowest)}% 了…`,
      '额度告急，记得留意一下！',
      '右键我，选刷新额度看看',
    ])
  }
  if (lowest != null && lowest <= 35 && Math.random() < 0.45) {
    return pickLine([
      `最低额度大概 ${Math.round(lowest)}%`,
      '这波额度还算健康～',
      '继续盯着，别超了',
    ])
  }
  if (poolRows.length === 0 && connected) {
    return '账号池还是空的哦'
  }
  return null
}

function randomPlayMood(): 'happy' | 'cute' | 'silly' {
  return (['happy', 'cute', 'silly'] as const)[Math.floor(Math.random() * 3)]
}

/** Random playful reaction when the pet is tapped (not dragged, not double-clicked). */
function playReaction(): void {
  if (refreshing || settingsOpen || isDockPeek()) return

  window.clearTimeout(tapStreakTimer)
  tapStreak += 1
  tapStreakTimer = window.setTimeout(() => {
    tapStreak = 0
  }, 2200)

  let mood: PetMood
  let line: string

  if (tapStreak >= 4) {
    mood = 'silly'
    line = pickLine(STREAK_LINES)
  } else {
    const context = contextualTapLine()
    if (context && Math.random() < 0.55) {
      mood = restingMood() === 'alert' ? (Math.random() < 0.55 ? 'alert' : 'silly') : randomPlayMood()
      line = context
    } else {
      mood = randomPlayMood()
      line = pickLine(REACTION_LINES[mood])
    }
  }

  setMood(mood)
  showSpeechBubble(line, 2800)
  const holdMs = mood === 'alert' ? 1800 : 1500
  moodTimer = window.setTimeout(() => setMood(restingMood()), holdMs)
}

function scheduleIdleChatter(): void {
  window.clearTimeout(idleChatterTimer)
  if (!connected || settingsOpen || isDockPeek()) return
  // Ambient tip bubbles so the pet feels alive without constant noise.
  const delay = 45000 + Math.floor(Math.random() * 50000)
  idleChatterTimer = window.setTimeout(() => {
    if (refreshing || settingsOpen || isDockPeek() || speechBubble.classList.contains('is-visible')) {
      scheduleIdleChatter()
      return
    }
    const lowest = lowestActiveRemaining()
    let line: string
    if (lowest != null && lowest <= 15) {
      line = pickLine(['有账号额度偏低了…', '右键菜单可以刷新哦', '注意配额哦～'])
      setMood('alert')
      moodTimer = window.setTimeout(() => setMood(restingMood()), 1600)
    } else {
      line = pickLine(TIP_LINES)
      setMood('cute')
      moodTimer = window.setTimeout(() => setMood(restingMood()), 1400)
    }
    showSpeechBubble(line, 3200)
  }, delay)
}

/** Apply dock CSS / images for the current dockEdge + hover expand state. */
function applyDockPresentation(): void {
  const peek = isDockPeek()
  shell.classList.toggle('is-docked', peek)
  if (dockEdge) shell.dataset.dock = dockEdge
  else delete shell.dataset.dock
  applyPetImage()
  if (peek) {
    hideSpeechBubble()
    window.clearTimeout(idleChatterTimer)
  } else if (!dockEdge) {
    scheduleIdleChatter()
  }
}

/** Switch between free-floating and leaning-against-an-edge presentation. */
function setDock(edge: DockEdge | null): void {
  if (edge === dockEdge) return
  window.clearTimeout(dockHoverTimer)
  dockEdge = edge
  dockHoverOpen = false
  applyDockPresentation()
}

/**
 * While docked, hover expands to the full pet + meters; leave collapses back to the peek.
 * The outgoing pose disappears before the native window changes size, then the incoming
 * pose appears. This avoids both transparent-window trails and double-image ghosting.
 */
async function setDockHoverOpen(open: boolean): Promise<void> {
  if (!isDesktop || !dockEdge || settingsOpen || dockHoverBusy || pressActive) return
  if (open === dockHoverOpen) return
  dockHoverBusy = true
  try {
    if (open) {
      const rect = await targetRect(dockEdge, true)
      if (rect) {
        await transitionWindowPresentation(
          rect,
          () => {
            dockHoverOpen = true
            applyDockPresentation()
          },
          dockEdge,
        )
      } else {
        dockHoverOpen = true
        applyDockPresentation()
      }
    } else {
      const rect = await targetRect(dockEdge, false)
      if (rect) {
        await transitionWindowPresentation(
          rect,
          () => {
            dockHoverOpen = false
            applyDockPresentation()
          },
          dockEdge,
        )
      } else {
        dockHoverOpen = false
        applyDockPresentation()
      }
    }
  } finally {
    dockHoverBusy = false
    // If the pointer already left during the expand animation, collapse again.
    if (dockHoverOpen && !shell.matches(':hover') && !pressActive) {
      window.clearTimeout(dockHoverTimer)
      dockHoverTimer = window.setTimeout(() => void setDockHoverOpen(false), 80)
    }
  }
}

function scheduleDockHover(open: boolean): void {
  if (!dockEdge || settingsOpen) return
  window.clearTimeout(dockHoverTimer)
  if (open) {
    // Small delay avoids accidental expand while dragging past the edge.
    dockHoverTimer = window.setTimeout(() => void setDockHoverOpen(true), 60)
  } else {
    // Slightly longer leave delay so resize under the cursor doesn't flicker.
    dockHoverTimer = window.setTimeout(() => void setDockHoverOpen(false), 220)
  }
}

function rowWindows(row: AccountQuotaRow): QuotaWindow[] {
  if (row.windows?.length) return row.windows
  if (row.remaining_percent == null) return []
  return [
    {
      label: row.platform === 'anthropic' ? '7d' : '7d',
      used_percent: Math.max(0, 100 - row.remaining_percent),
      remaining_percent: row.remaining_percent,
      reset_at: null,
    },
  ]
}

function lowestRemaining(row: AccountQuotaRow): number | null {
  const windows = rowWindows(row)
  if (!windows.length) return row.remaining_percent ?? null
  return windows.reduce((min, window) => Math.min(min, window.remaining_percent), 100)
}

function restingMood(): PetMood {
  const hasLow = poolRows.some((row) => {
    if (row.status !== 'active') return false
    const remaining = lowestRemaining(row)
    return remaining != null && remaining <= 15
  })
  return hasLow ? 'alert' : 'idle'
}

function showToast(message: string, kind: 'normal' | 'error' = 'normal'): void {
  toast.textContent = message
  toast.className = `toast is-visible ${kind === 'error' ? 'is-error' : ''}`
  window.setTimeout(() => toast.classList.remove('is-visible'), 2600)
}

function mockPoolRows(): AccountQuotaRow[] {
  return [
    {
      id: 21,
      name: 'Claude 主账号',
      status: 'active',
      plan: 'max',
      platform: 'anthropic',
      account_type: 'oauth',
      remaining_percent: 68,
      windows: [
        {
          label: '5h',
          used_percent: 32,
          remaining_percent: 68,
          reset_at: new Date(Date.now() + 2 * 3600000).toISOString(),
        },
        {
          label: '7d',
          used_percent: 18,
          remaining_percent: 82,
          reset_at: new Date(Date.now() + 4.1 * 86400000).toISOString(),
        },
      ],
      updated_at: new Date().toISOString(),
      source: 'cached',
    },
    {
      id: 22,
      name: 'Claude 备用',
      status: 'active',
      plan: 'pro',
      platform: 'anthropic',
      account_type: 'oauth',
      remaining_percent: 45,
      windows: [
        {
          label: '5h',
          used_percent: 55,
          remaining_percent: 45,
          reset_at: new Date(Date.now() + 1.2 * 3600000).toISOString(),
        },
        {
          label: '7d',
          used_percent: 24,
          remaining_percent: 76,
          reset_at: new Date(Date.now() + 3.2 * 86400000).toISOString(),
        },
      ],
      updated_at: new Date().toISOString(),
      source: 'cached',
    },
    {
      id: 7,
      name: 'Codex 主账号',
      status: 'active',
      plan: 'team',
      platform: 'openai',
      account_type: 'oauth',
      remaining_percent: 60,
      windows: [
        {
          label: '7d',
          used_percent: 40,
          remaining_percent: 60,
          reset_at: new Date(Date.now() + 3.4 * 86400000).toISOString(),
        },
      ],
      updated_at: new Date().toISOString(),
      source: 'cached',
    },
    {
      id: 31,
      name: 'Grok 主账号',
      status: 'active',
      plan: 'super',
      platform: 'xai',
      account_type: 'api_key',
      remaining_percent: 72,
      windows: [
        {
          label: '7d',
          used_percent: 28,
          remaining_percent: 72,
          reset_at: new Date(Date.now() + 2.5 * 86400000).toISOString(),
        },
      ],
      updated_at: new Date().toISOString(),
      source: 'cached',
    },
  ]
}

function latestUpdatedAt(): string | null {
  let latest: number | null = null
  let latestIso: string | null = null
  for (const row of poolRows) {
    if (!row.updated_at) continue
    const time = new Date(row.updated_at).getTime()
    if (Number.isNaN(time)) continue
    if (latest === null || time > latest) {
      latest = time
      latestIso = row.updated_at
    }
  }
  return latestIso
}

function toneForWindow(platform: string | undefined, index: number, total: number): string {
  const model = modelKeyForPlatform(platform)
  if (model === 'claude') {
    return index === 0 && total > 1 ? 'amber' : 'violet'
  }
  if (model === 'grok') return 'amber'
  return 'violet'
}

const MODEL_ICON_PATHS: Record<ModelKey, string> = {
  grok: 'M395.47591 633.831048L735.904251 381.110023c16.68887-12.389903 40.543683-7.556941 48.495621 11.686908 41.853673 101.492207 23.154819 223.459254-60.11753 307.2016-83.271349 83.742346-199.135444 102.107202-305.038617 60.280529l-115.690097 53.865579c165.932704 114.058109 367.428129 85.851329 493.341146-40.86068 99.87422-100.438215 130.805978-237.343146 101.883204-360.803182l0.261998 0.262998C857.098304 231.376192 909.350896 158.880759 1016.392059 10.640917c2.52998-3.514973 5.06996-7.029945 7.599941-10.632917L883.1371 141.657893v-0.438996L395.388911 633.919048M325.223459 695.253568c-119.09707-114.410106-98.56323-291.472723 3.058976-393.579925 75.145413-75.57041 198.262451-106.413169 305.738612-61.071523l115.427098-53.601581c-20.796838-15.113882-47.446629-31.370755-78.02939-42.793666-138.23292-57.205553-303.728627-28.734776-416.09775 84.181343-108.088156 108.698151-142.07789 275.830845-83.709346 418.447731 43.602659 106.589167-27.873782 181.983578-99.873219 258.080983C46.223639 931.89372 20.621839 958.870509 0 987.429286l325.13646-292.087718',
  codex: 'M904.533333 435.285333c-2.730667-3.328-3.456-5.973333-2.218666-9.898666 10.197333-32.426667 13.013333-65.365333 7.466666-99.029334a220.501333 220.501333 0 0 0-83.413333-142.293333c-53.632-42.197333-115.029333-57.258667-182.741333-46.122667-6.4 1.024-10.24-0.725333-14.72-5.12-57.685333-57.301333-127.872-79.402667-207.573334-64.085333-84.522667 16.085333-142.506667 66.304-173.056 146.304-1.450667 3.669333-3.029333 5.674667-7.552 6.741333-52.309333 12.373333-95.701333 38.912-128.341333 81.194667-41.557333 54.058667-56.746667 114.773333-44.032 181.845333a216.618667 216.618667 0 0 0 50.346667 102.912c3.541333 4.096 4.138667 7.594667 2.56 12.501334-6.997333 20.565333-9.216 41.941333-9.770667 63.872 0.64 15.957333 1.706667 32.298667 5.546667 48.213333 27.178667 119.04 144.768 195.584 266.282666 173.269333 4.864-0.768 7.168 0.256 10.197334 3.413334 57.941333 58.837333 128.768 81.834667 209.706666 66.261333 84.608-16.213333 142.08-67.029333 172.885334-146.773333 1.408-3.584 2.986667-5.248 6.997333-6.186667 96.426667-21.973333 167.509333-102.826667 175.829333-200.106667 5.845333-62.592-12.757333-118.698667-54.4-166.912z m-55.210666-110.421333c3.882667 18.901333 5.12 37.802667 2.730666 56.96-0.256 2.176-0.981333 4.266667-1.578666 7.253333l-49.621334-28.245333c-43.52-24.874667-87.210667-49.493333-130.56-74.752a37.461333 37.461333 0 0 0-41.386666 0.085333c-66.304 38.357333-132.949333 75.946667-199.424 113.877334-2.133333 1.109333-3.882667 3.029333-7.253334 2.773333V318.037333c0-3.157333 2.048-4.138667 4.181334-5.418666 59.178667-33.706667 117.845333-68.437333 177.664-100.821334 97.493333-52.693333 222.976 5.76 245.248 113.066667z m-247.808 186.368c0 15.488-0.085333 30.890667 0.085333 46.293333 0 3.584-0.981333 5.717333-4.352 7.552-27.178667 15.317333-54.186667 30.805333-81.152 46.464-2.986667 1.664-5.12 1.834667-8.277333 0.085334-26.88-15.573333-54.016-31.061333-81.152-46.378667-3.541333-2.005333-4.608-4.266667-4.608-8.234667 0.170667-30.122667 0.170667-60.16 0-90.24 0-4.181333 1.237333-6.528 5.034666-8.746666 26.496-14.933333 52.906667-29.994667 79.232-45.226667 3.925333-2.176 6.741333-2.56 10.922667-0.170667 26.325333 15.317333 52.650667 30.378667 79.146667 45.312 3.712 2.133333 5.205333 4.394667 5.205333 8.661334-0.256 14.805333-0.085333 29.781333-0.085333 44.629333zM293.802667 294.4c0.085333-84.608 54.784-152.618667 138.709333-169.258667 51.584-10.026667 98.730667 2.986667 141.354667 36.053334l-69.12 39.253333c-38.314667 21.76-76.586667 43.733333-115.029334 65.322667a32 32 0 0 0-17.578666 30.464v236.970666c-2.645333 0.725333-4.138667-1.237333-5.930667-2.176-22.186667-12.501333-44.202667-25.386667-66.474667-37.632-4.608-2.56-5.930667-5.546667-5.930666-10.496 0.085333-62.848 0-125.653333 0-188.501333z m-169.514667 163.882667c-8.362667-72.96 37.290667-147.2 106.666667-172.8 1.152-0.341333 2.304-0.64 3.925333-0.981334V336.213333c0 51.626667 0.170667 103.253333 0 154.88-0.170667 15.146667 5.930667 25.6 19.413333 33.194667 67.072 37.717333 133.973333 76.032 200.832 114.090667l6.442667 3.84-74.24 42.453333c-2.56 1.493333-4.522667 2.133333-7.466667 0.341333-59.989333-34.389333-120.789333-67.2-179.626666-103.168-45.653333-27.818667-70.016-70.613333-75.946667-123.562666z m74.965333 297.898666a166.229333 166.229333 0 0 1-25.344-121.130666l11.776 6.4c56.917333 32.469333 113.92 64.938667 170.794667 97.578666a33.962667 33.962667 0 0 0 36.693333 0c67.797333-38.784 135.68-77.44 203.477334-116.053333l5.034666-2.773333c0 29.141333 0 57.130667 0.170667 85.12 0 3.413333-1.664 4.821333-4.138667 6.229333-58.581333 33.152-116.565333 67.413333-175.829333 99.413333-77.397333 41.472-173.994667 17.664-222.634667-54.784z m530.346667-12.074666c-1.706667 60.458667-41.045333 120.149333-107.776 146.346666a172.373333 172.373333 0 0 1-170.666667-28.032l80.426667-45.781333c34.218667-19.498667 68.352-39.210667 102.741333-58.368a31.274667 31.274667 0 0 0 17.536-30.165333c-0.256-76.672-0.085333-153.344-0.085333-230.144 0-8.405333 0-8.405333 7.168-4.48 22.058667 12.586667 44.16 25.301333 66.304 37.717333 3.541333 2.005333 4.949333 4.010667 4.864 8.106667-0.085333 68.181333 1.322667 136.533333-0.512 204.8z m68.266667-7.68c-8.832 3.754667-8.832 3.754667-8.832-5.632 0-66.56-0.256-133.162667 0.213333-199.68a32.426667 32.426667 0 0 0-18.261333-31.317334c-66.218667-37.461333-132.266667-75.264-198.357334-112.896l-10.112-5.888 75.178667-42.752c2.645333-1.578667 4.522667-0.725333 6.826667 0.512 59.349333 33.962667 119.381333 66.688 177.834666 101.76 44.672 26.965333 69.973333 67.84 76.928 119.168A167.125333 167.125333 0 0 1 797.866667 736.426667z',
  claude: 'M252.8 652.8l167.89504-94.29504 2.76992-8.10496-2.76992-4.48h-8.11008l-28.16-1.70496-96-2.56-83.2-3.41504-80.64-4.26496-20.26496-4.27008-18.98496-24.96 1.92-12.58496 17.06496-11.52 24.32 2.13504L182.61504 486.4 263.68 491.94496l58.66496 3.41504 87.04 9.17504h13.87008l1.92-5.55008-4.69504-3.40992-3.62496-3.41504-83.84-56.74496-90.67008-60.16-47.56992-34.56L168.96 323.2l-13.01504-16.42496-5.54496-35.84 23.25504-25.81504 31.36 2.13504 7.88992 2.12992 31.79008 24.32 67.84 52.48 88.52992 65.28 13.01504 10.88 5.12-3.62496 0.64-2.56-5.76-9.81504-48.21504-87.04-51.40992-88.52992L291.62496 174.08l-5.96992-21.97504a107.85792 107.85792 0 0 1-3.63008-26.02496l26.67008-36.05504 14.72-4.68992 35.40992 4.68992L373.76 103.04l21.97504 50.34496 35.62496 79.36L486.61504 340.48l16.20992 32 8.75008 29.65504 3.2 9.16992h5.54496v-5.12l4.48-60.8 8.32-74.44992 8.10496-96 2.77504-27.09504 13.44-32.42496 26.66496-17.49504 20.69504 10.02496 17.06496 24.32-2.34496 15.79008-10.24 65.92-19.84 103.24992-13.01504 69.12h7.47008l8.74496-8.74496 34.98496-46.50496 58.67008-73.39008 26.02496-29.22496 30.29504-32.21504 19.40992-15.36H798.72l27.09504 40.11008-12.16 41.38496-37.76 48-31.36 40.53504-45.01504 60.58496-28.16 48.42496 2.56 3.84 6.61504-0.64 101.54496-21.54496 54.82496-10.02496 65.49504-11.31008 29.65504 13.87008 3.2 14.08-11.73504 28.8-69.97504 17.28-82.12992 16.42496-122.24 29.01504-1.49504 1.06496 1.70496 2.13504 55.04 5.12 23.47008 1.28h57.6l107.30496 7.88992 28.16 18.56 16.85504 22.61504-2.77504 17.28-43.30496 21.97504-58.24-13.87008-136.11008-32.42496-46.72-11.73504h-6.4v3.84l38.83008 37.97504 71.24992 64.42496 89.17504 82.99008 4.48 20.48-11.52 16.20992L824.32 803.84l-78.50496-58.88-30.29504-26.66496-68.48-57.6h-4.48v5.96992l15.78496 23.04 83.41504 125.23008 4.26496 38.4-5.96992 12.58496-21.55008 7.46496-23.68-4.26496-48.84992-68.48-50.35008-77.22496-40.52992-69.12-4.91008 2.76992-23.88992 258.13504-11.31008 13.22496-26.02496 10.03008-21.54496-16.43008-11.52-26.66496 11.52-52.48L481.28 774.4l11.30496-54.4 10.24-67.62496 5.97504-22.4-0.42496-1.49504-4.91008 0.64-50.98496 69.97504L374.82496 803.84l-61.44 65.70496-14.72 5.76-25.38496-13.22496 2.34496-23.46496 14.29504-20.91008 84.90496-107.94496 51.2-66.98496L459.09504 604.16v-5.54496h-2.13504l-225.49504 146.56-40.10496 5.12L174.08 734.08l2.13504-26.66496L184.32 698.66496l67.84-46.72h-0.21504l0.85504 0.85504z',
}

function platformIconSvg(platform?: string): string {
  const model = modelKeyForPlatform(platform)
  return `<svg class="model-mark" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path d="${MODEL_ICON_PATHS[model]}" fill="currentColor"/></svg>`
}

function createMeterColumn(window: QuotaWindow, tone: string, accountName: string): HTMLElement {
  const remaining = Math.max(0, Math.min(100, window.remaining_percent))
  const filled = Math.round((remaining / 100) * BAR_SEGMENTS)
  const isLow = remaining <= 15

  const col = document.createElement('div')
  col.className = `meter-col tone-${tone}${isLow ? ' is-low' : ''}`
  col.title = `${accountName} · ${window.label} 剩余 ${Math.round(remaining)}%\n${formatReset(window.reset_at ?? undefined)}`

  const value = document.createElement('div')
  value.className = 'meter-value'
  value.textContent = `${Math.round(remaining)}%`

  const stack = document.createElement('div')
  stack.className = 'meter-stack'
  stack.setAttribute('role', 'progressbar')
  stack.setAttribute('aria-label', `${accountName} ${window.label} 剩余`)
  stack.setAttribute('aria-valuemin', '0')
  stack.setAttribute('aria-valuemax', '100')
  stack.setAttribute('aria-valuenow', String(Math.round(remaining)))

  for (let i = BAR_SEGMENTS; i >= 1; i -= 1) {
    const segment = document.createElement('span')
    segment.className = `meter-seg${i <= filled ? ' is-on' : ''}`
    stack.append(segment)
  }

  col.append(value, stack)
  return col
}

function renderPool(): void {
  accountList.replaceChildren()

  if (!connected) {
    updatedLabel.textContent = '等待连接'
    quotaDock.classList.remove('is-low', 'has-data')
    const empty = document.createElement('div')
    empty.className = 'meter-empty'
    empty.textContent = '连接后展示账号池'
    accountList.append(empty)
    void syncTrayMenu()
    return
  }

  if (!poolRows.length) {
    updatedLabel.textContent = '账号池为空'
    quotaDock.classList.remove('is-low')
    quotaDock.classList.add('has-data')
    const empty = document.createElement('div')
    empty.className = 'meter-empty'
    empty.textContent = '暂无账号池数据'
    accountList.append(empty)
    void syncTrayMenu()
    return
  }

  const displayRows = visiblePoolRows()
  if (!displayRows.length) {
    updatedLabel.textContent = '当前模型均未勾选或无匹配账号'
    quotaDock.classList.remove('is-low')
    quotaDock.classList.add('has-data')
    const empty = document.createElement('div')
    empty.className = 'meter-empty'
    empty.textContent = settings.showModels.claude || settings.showModels.codex || settings.showModels.grok
      ? '暂无已勾选模型的账号'
      : '请在设置中勾选要展示的模型'
    accountList.append(empty)
    void syncTrayMenu()
    return
  }

  const lowCount = displayRows.filter((row) => {
    if (row.status !== 'active') return false
    const remaining = lowestRemaining(row)
    return remaining != null && remaining <= 15
  }).length

  quotaDock.classList.add('has-data')
  quotaDock.classList.toggle('is-low', lowCount > 0)

  const latest = latestUpdatedAt()
  const anyCached = poolRows.some((row) => row.source === 'cached')
  updatedLabel.textContent = latest
    ? `${formatClock(latest)} 更新${anyCached ? ' · 缓存' : ''}`
    : '已同步'

  for (const [index, row] of displayRows.entries()) {
    const windows = rowWindows(row)
    const isInactive = row.status !== 'active'
    const group = document.createElement('article')
    group.className = `meter-group platform-${row.platform || 'openai'}${isInactive ? ' is-inactive' : ''}`
    group.setAttribute('role', 'listitem')
    group.dataset.name = row.name

    if (index > 0) {
      const divider = document.createElement('div')
      divider.className = 'meter-divider'
      divider.setAttribute('aria-hidden', 'true')
      accountList.append(divider)
    }

    const meters = document.createElement('div')
    meters.className = 'meter-columns'

    if (!windows.length) {
      const emptyCol = document.createElement('div')
      emptyCol.className = 'meter-col tone-muted'
      emptyCol.innerHTML = `<div class="meter-value">--%</div><div class="meter-stack empty-stack"><span class="meter-seg"></span><span class="meter-seg"></span><span class="meter-seg"></span><span class="meter-seg"></span><span class="meter-seg"></span></div>`
      emptyCol.title = `${row.name} · 暂无额度数据`
      meters.append(emptyCol)
    } else {
      windows.forEach((window, windowIndex) => {
        meters.append(
          createMeterColumn(
            window,
            toneForWindow(row.platform, windowIndex, windows.length),
            row.name,
          ),
        )
      })
    }

    const badge = document.createElement('div')
    badge.className = `platform-chip platform-${row.platform || 'openai'}`
    badge.title = `${row.name}${row.plan ? ` · ${row.plan}` : ''}`
    badge.innerHTML = platformIconSvg(row.platform)

    group.append(meters, badge)
    accountList.append(group)
  }

  void syncTrayMenu()
}

async function syncTrayMenu(options?: { refreshing?: boolean }): Promise<void> {
  if (!isDesktop) return
  try {
    await invoke('update_tray_menu', {
      payload: {
        accounts: visiblePoolRows().map((row) => {
          const windows = rowWindows(row)
          // Keep Claude order: 5h then 7d so both session and weekly limits appear.
          const ordered =
            row.platform === 'anthropic'
              ? [
                  ...windows.filter((window) => window.label === '5h'),
                  ...windows.filter((window) => window.label === '7d'),
                  ...windows.filter((window) => window.label !== '5h' && window.label !== '7d'),
                ]
              : windows
          return {
            id: row.id,
            name: row.name,
            platform: row.platform || 'openai',
            status: row.status,
            windows: ordered.map((window) => ({
              label: window.label,
              remaining_percent: window.remaining_percent,
              reset_at: window.reset_at ?? null,
            })),
          }
        }),
        synced_at: latestUpdatedAt(),
        refreshing: options?.refreshing ?? refreshing,
      },
    })
  } catch {
    // Tray updates are best-effort and should not interrupt the UI.
  }
}

async function refreshQuota(force: boolean): Promise<void> {
  if (refreshing || !connected) return
  refreshing = true
  setMood('refreshing')
  // Tooltip-only "syncing" indicator — backend skips full tray menu rebuild for this flag.
  void syncTrayMenu({ refreshing: true })
  if (force) showSpeechBubble(pickLine(['去查最新额度啦…', '稍等，我刷新一下', '正在同步账号池…']), 2200)
  quotaDock.classList.add('is-refreshing')
  try {
    poolRows = isDesktop
      ? await invoke<AccountQuotaRow[]>('refresh_pool_quotas', { force })
      : mockPoolRows().map((row) => ({
          ...row,
          source: force ? 'active' : 'cached',
          updated_at: new Date().toISOString(),
        }))
    renderPool()
    if (!settingsOpen) await applyWindowSize()
    setMood('success')
    if (force) {
      showSpeechBubble(
        pickLine([
          `刷新好啦！共 ${poolRows.length} 个账号`,
          '最新额度已更新～',
          '查完啦，看看柱状图吧',
        ]),
        2800,
      )
      showToast(`已更新 ${poolRows.length} 个账号额度`)
    }
    moodTimer = window.setTimeout(() => setMood(restingMood()), 1300)
  } catch (error) {
    setMood('alert')
    showSpeechBubble(pickLine(['刷新失败了…', '唔，连不上平台', '稍后再试试吧']), 3000)
    showToast(errorMessage(error), 'error')
    moodTimer = window.setTimeout(() => setMood(restingMood()), 2200)
  } finally {
    refreshing = false
    quotaDock.classList.remove('is-refreshing')
    // Single menu rebuild after data lands (fingerprint skips no-op rebuilds).
    void syncTrayMenu({ refreshing: false })
  }
}

function startAutoRefresh(): void {
  window.clearInterval(autoRefreshTimer)
  const intervalMs = clampRefreshInterval(settings.refreshIntervalSec) * 1000
  autoRefreshTimer = window.setInterval(() => void refreshQuota(false), intervalMs)
}

function petWindowSize(): { width: number; height: number } {
  // Fit the transparent window tightly around pet + meters.
  // Art 144 + gap 4 + card (pad ~19 + meters ~55) + stage padding ~6 + clip buffer 4 ≈ 232.
  const rows = visiblePoolRows()
  let content = 8
  for (const row of rows) {
    const count = Math.max(rowWindows(row).length, 1)
    // Dual Claude columns are only ~25px wide; single bar group ~28px + padding.
    content += count === 1 ? 34 : 42
  }
  content += Math.max(0, rows.length - 1) * 10
  // Keep at least as wide as the pet artwork.
  const width = Math.min(420, Math.max(168, content + 12))
  const height = 234
  return { width, height }
}

type WindowMode = 'pet' | 'settings'

/** Compact square footprint used when the pet is leaning on a screen edge. */
const DOCK_SIZE = 48

async function applyWindowSize(_mode?: WindowMode): Promise<void> {
  if (!isDesktop || animating) return
  const win = getCurrentWindow()
  // Settings is a separate OS window — main always stays the pet.
  if (isDockPeek()) {
    await win.setSize(new LogicalSize(DOCK_SIZE, DOCK_SIZE))
    return
  }
  const size = petWindowSize()
  await win.setSize(new LogicalSize(size.width, size.height))
}

/** Fill the in-page settings form (browser fallback only). */
function fillInPageSettingsForm(): void {
  baseUrlInput.value = settings.baseUrl
  emailInput.value = settings.email
  alwaysOnTopInput.checked = settings.alwaysOnTop
  autoStartInput.checked = settings.autoStart
  writeShowModelsToForm(settings.showModels)
  writeCardOpacityToForm(settings.cardOpacity)
  maxDisplayAccountsInput.value = String(clampDisplayAccounts(settings.maxDisplayAccounts))
  refreshIntervalInput.value = String(clampRefreshInterval(settings.refreshIntervalSec))
  if (![...refreshIntervalInput.options].some((option) => option.value === refreshIntervalInput.value)) {
    const option = document.createElement('option')
    option.value = refreshIntervalInput.value
    option.textContent = `${settings.refreshIntervalSec} 秒`
    refreshIntervalInput.append(option)
  }
  if (![...maxDisplayAccountsInput.options].some((option) => option.value === maxDisplayAccountsInput.value)) {
    const option = document.createElement('option')
    option.value = maxDisplayAccountsInput.value
    option.textContent = `${settings.maxDisplayAccounts} 个`
    maxDisplayAccountsInput.append(option)
  }
  refreshHint.textContent = refreshHintText()
  formError.textContent = ''
  document.querySelectorAll('.connected-only').forEach((item) => item.classList.toggle('is-hidden', !connected))
  document.querySelectorAll('.login-only').forEach((item) => item.classList.toggle('is-hidden', connected))
}

/**
 * Open / close settings.
 * Desktop: independent decorated window — pet stays visible in place.
 * Browser: in-page sheet overlay (pet stage remains visible underneath).
 */
async function setSettingsOpen(open: boolean): Promise<void> {
  settingsOpen = open

  if (!isDesktop) {
    settingsSheet.classList.toggle('is-hidden', !open)
    shell.classList.toggle('has-settings', open)
    // Do not hide the pet stage.
    shell.classList.remove('pet-hidden')
    if (open) {
      hideSpeechBubble()
      window.clearTimeout(idleChatterTimer)
      fillInPageSettingsForm()
      if (!connected) window.setTimeout(() => baseUrlInput.focus(), 120)
    } else {
      scheduleIdleChatter()
    }
    return
  }

  if (open) {
    hideSpeechBubble()
    window.clearTimeout(idleChatterTimer)
    try {
      await invoke('show_settings_window')
    } catch (error) {
      showToast(errorMessage(error), 'error')
      settingsOpen = false
    }
  } else {
    try {
      await invoke('hide_settings_window')
    } catch {
      // already closed
    }
    scheduleIdleChatter()
  }
}

/** Apply changes from the independent settings window. */
async function onSettingsChanged(kind: string, payload?: unknown): Promise<void> {
  if (kind === 'preview-opacity') {
    applyCardOpacity(Number(payload))
    return
  }

  await loadSettings()
  applyCardOpacity()

  if (kind === 'login') {
    connected = true
    settingsOpen = false
    renderPool()
    await refreshQuota(true)
    startAutoRefresh()
    await applyWindowSize()
    scheduleIdleChatter()
    showSpeechBubble(pickLine(['连接成功～', '账号池已就绪', '我开始盯额度啦']), 2600)
    return
  }

  if (kind === 'logout') {
    connected = false
    poolRows = []
    window.clearInterval(autoRefreshTimer)
    renderPool()
    await applyWindowSize()
    return
  }

  if (kind === 'save') {
    settingsOpen = false
    if (isDesktop) await getCurrentWindow().setAlwaysOnTop(settings.alwaysOnTop)
    renderPool()
    startAutoRefresh()
    await applyWindowSize()
    if (connected) await refreshQuota(false)
    scheduleIdleChatter()
  }
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
    await setSettingsOpen(false)
    await refreshQuota(true)
    startAutoRefresh()
  } catch (error) {
    formError.textContent = errorMessage(error)
  } finally {
    connectButton.disabled = false
    connectButton.textContent = tempToken ? '验证并连接' : '连接平台'
  }
}

async function saveConnectedSettings(): Promise<void> {
  const showModels = readShowModelsFromForm()
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
  applyCardOpacity()
  if (isDesktop) {
    await getCurrentWindow().setAlwaysOnTop(settings.alwaysOnTop)
    if (settings.autoStart) await enable()
    else await disable()
  }
  await saveSettings()
  refreshHint.textContent = refreshHintText()
  startAutoRefresh()
  await setSettingsOpen(false)
  renderPool()
  if (!settingsOpen) await applyWindowSize()
  await refreshQuota(false)
}

connectionForm.addEventListener('submit', (event) => {
  event.preventDefault()
  if (connected) void saveConnectedSettings()
  else void connect()
})

// Live-preview card opacity while dragging the slider (persists on 保存设置).
cardOpacityInput.addEventListener('input', () => {
  const percent = Math.max(0, Math.min(100, Number(cardOpacityInput.value) || 0))
  cardOpacityLabel.textContent = `${percent}%`
  applyCardOpacity(percent / 100)
})

// Distinguish a drag (window move) from a tap (playful reaction): start dragging only
// once the pointer has moved past a small threshold, otherwise treat the press as a tap.
let pressActive = false
let dragStarted = false
let pressStartX = 0
let pressStartY = 0

async function openActionMenu(): Promise<void> {
  if (!isDesktop) {
    // Browser preview: fall back to in-page settings affordance.
    showSpeechBubble('桌面版右键可打开独立菜单', 2200)
    return
  }
  hideSpeechBubble()
  try {
    const pos = await cursorPosition()
    // cursorPosition returns floats; Rust expects rounded physical pixels.
    await invoke('show_action_menu', {
      x: Math.round(pos.x),
      y: Math.round(pos.y),
    })
  } catch (error) {
    showToast(errorMessage(error), 'error')
  }
}

async function handleMenuAction(action: string): Promise<void> {
  switch (action) {
    case 'panel':
      // Large account info window listing every account's quota.
      if (isDesktop) {
        try {
          await invoke('show_account_panel')
        } catch (error) {
          showToast(errorMessage(error), 'error')
        }
      }
      break
    case 'refresh':
      await refreshQuota(true)
      break
    case 'settings':
      await setSettingsOpen(true)
      break
    case 'admin': {
      const url = (settings.baseUrl || baseUrlInput.value.trim()).replace(/\/+$/, '')
      if (!url) {
        showToast('请先配置平台地址', 'error')
        await setSettingsOpen(true)
        return
      }
      if (isDesktop) await openUrl(url)
      else window.open(url, '_blank', 'noopener')
      break
    }
    case 'quit':
      if (isDesktop) await invoke('quit_app')
      break
    default:
      break
  }
}

petButton.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return
  pressActive = true
  dragStarted = false
  pressStartX = event.screenX
  pressStartY = event.screenY
  // Keep expanded while the user may start a drag from a docked hover.
  window.clearTimeout(dockHoverTimer)
})
window.addEventListener('mousemove', (event) => {
  if (!pressActive || dragStarted || !isDesktop) return
  if (Math.hypot(event.screenX - pressStartX, event.screenY - pressStartY) > 4) {
    dragStarted = true
    hideSpeechBubble()
    void getCurrentWindow().startDragging()
  }
})
window.addEventListener('mouseup', () => {
  if (!pressActive) return
  pressActive = false
  if (!dragStarted) playReaction()
  // After a click without drag, re-evaluate hover so dock can collapse if needed.
  if (dockEdge && !shell.matches(':hover')) scheduleDockHover(false)
})

// Docked peek ↔ full pet + meters while the pointer is over the window.
shell.addEventListener('mouseenter', () => {
  if (dockEdge && !settingsOpen) scheduleDockHover(true)
})
shell.addEventListener('mouseleave', () => {
  if (dockEdge && !settingsOpen && !pressActive) scheduleDockHover(false)
})

petButton.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  event.stopPropagation()
  void openActionMenu()
})
petButton.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    playReaction()
  } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault()
    void openActionMenu()
  }
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && settingsOpen) void setSettingsOpen(false)
})
element('#open-site').addEventListener('click', () => {
  const url = baseUrlInput.value.trim()
  if (!url) return
  if (isDesktop) void openUrl(url)
  else window.open(url, '_blank', 'noopener')
})
element('#password-toggle').addEventListener('click', (event) => {
  const button = event.currentTarget as HTMLButtonElement
  const visible = passwordInput.type === 'text'
  passwordInput.type = visible ? 'password' : 'text'
  button.innerHTML = `<i data-lucide="${visible ? 'eye' : 'eye-off'}"></i>`
  button.title = visible ? '显示密码' : '隐藏密码'
  paintIcons()
})
element('#logout-button').addEventListener('click', async () => {
  if (isDesktop) await invoke('logout')
  window.clearInterval(autoRefreshTimer)
  connected = false
  poolRows = []
  await saveSettings()
  renderPool()
  await setSettingsOpen(true)
})
checkUpdateButton.addEventListener('click', () => void checkForUpdate(true))

if (isDesktop) {
  void listen('open-settings', () => void setSettingsOpen(true))
  void listen('open-admin', () => void handleMenuAction('admin'))
  void listen<string>('pet-menu-action', (event) => {
    void handleMenuAction(event.payload)
  })
  void listen('main-close-requested', () => {
    void getCurrentWindow().hide()
  })
  void listen('settings-closed', () => {
    settingsOpen = false
    scheduleIdleChatter()
  })
  void listen<{ kind: string; payload?: unknown }>('settings-changed', (event) => {
    void onSettingsChanged(event.payload.kind, event.payload.payload)
  })
}

async function initialize(): Promise<void> {
  await loadSettings()
  if (isDesktop) window.setTimeout(() => void checkForUpdate(), 3000)
  await registerPositionPersistence()
  connected = isDesktop ? await invoke<boolean>('has_session') : true
  if (isDesktop) await getCurrentWindow().setAlwaysOnTop(settings.alwaysOnTop)
  if (!connected) {
    renderPool()
    await setSettingsOpen(true)
    return
  }
  try {
    renderPool()
    await refreshQuota(false)
    await applyWindowSize()
    window.setTimeout(() => {
      showSpeechBubble(pickLine(['我在这里盯着额度哦', '点我可以互动～', '右键打开菜单哦']), 3000)
      setMood('happy')
      moodTimer = window.setTimeout(() => setMood(restingMood()), 1400)
    }, 600)
  } catch (error) {
    showToast(errorMessage(error), 'error')
    if (errorMessage(error).includes('登录')) {
      connected = false
      await setSettingsOpen(true)
    }
  }
  startAutoRefresh()
  scheduleIdleChatter()
}

void initialize()
