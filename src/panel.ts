/**
 * Account panel — AI 账号池 full quota view (summary + platform groups + per-window bars).
 * Opened as a normal OS window from the native tray menu / pet menu ("打开账号面板").
 * The tray icon itself uses the native menu; this window is intentionally separate.
 */
import './panel.css'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { createIcons, Users } from 'lucide'

type ModelKey = 'claude' | 'codex' | 'grok'

interface TrayWindow {
  label: string
  remaining_percent?: number | null
  reset_at?: string | null
}

interface TrayAccount {
  id: number
  name: string
  platform: string
  status: string
  windows: TrayWindow[]
}

interface TrayPayload {
  accounts: TrayAccount[]
  synced_at?: string | null
  refreshing?: boolean
}

const isDesktop = '__TAURI_INTERNALS__' in window
const win = isDesktop ? getCurrentWindow() : null
if (typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent || '')) {
  document.documentElement.classList.add('is-windows')
}

/** Same monochrome marks used by the pet meter chips. */
const MODEL_ICON_PATHS: Record<ModelKey, string> = {
  grok: 'M395.47591 633.831048L735.904251 381.110023c16.68887-12.389903 40.543683-7.556941 48.495621 11.686908 41.853673 101.492207 23.154819 223.459254-60.11753 307.2016-83.271349 83.742346-199.135444 102.107202-305.038617 60.280529l-115.690097 53.865579c165.932704 114.058109 367.428129 85.851329 493.341146-40.86068 99.87422-100.438215 130.805978-237.343146 101.883204-360.803182l0.261998 0.262998C857.098304 231.376192 909.350896 158.880759 1016.392059 10.640917c2.52998-3.514973 5.06996-7.029945 7.599941-10.632917L883.1371 141.657893v-0.438996L395.388911 633.919048M325.223459 695.253568c-119.09707-114.410106-98.56323-291.472723 3.058976-393.579925 75.145413-75.57041 198.262451-106.413169 305.738612-61.071523l115.427098-53.601581c-20.796838-15.113882-47.446629-31.370755-78.02939-42.793666-138.23292-57.205553-303.728627-28.734776-416.09775 84.181343-108.088156 108.698151-142.07789 275.830845-83.709346 418.447731 43.602659 106.589167-27.873782 181.983578-99.873219 258.080983C46.223639 931.89372 20.621839 958.870509 0 987.429286l325.13646-292.087718',
  codex: 'M904.533333 435.285333c-2.730667-3.328-3.456-5.973333-2.218666-9.898666 10.197333-32.426667 13.013333-65.365333 7.466666-99.029334a220.501333 220.501333 0 0 0-83.413333-142.293333c-53.632-42.197333-115.029333-57.258667-182.741333-46.122667-6.4 1.024-10.24-0.725333-14.72-5.12-57.685333-57.301333-127.872-79.402667-207.573334-64.085333-84.522667 16.085333-142.506667 66.304-173.056 146.304-1.450667 3.669333-3.029333 5.674667-7.552 6.741333-52.309333 12.373333-95.701333 38.912-128.341333 81.194667-41.557333 54.058667-56.746667 114.773333-44.032 181.845333a216.618667 216.618667 0 0 0 50.346667 102.912c3.541333 4.096 4.138667 7.594667 2.56 12.501334-6.997333 20.565333-9.216 41.941333-9.770667 63.872 0.64 15.957333 1.706667 32.298667 5.546667 48.213333 27.178667 119.04 144.768 195.584 266.282666 173.269333 4.864-0.768 7.168 0.256 10.197334 3.413334 57.941333 58.837333 128.768 81.834667 209.706666 66.261333 84.608-16.213333 142.08-67.029333 172.885334-146.773333 1.408-3.584 2.986667-5.248 6.997333-6.186667 96.426667-21.973333 167.509333-102.826667 175.829333-200.106667 5.845333-62.592-12.757333-118.698667-54.4-166.912z m-55.210666-110.421333c3.882667 18.901333 5.12 37.802667 2.730666 56.96-0.256 2.176-0.981333 4.266667-1.578666 7.253333l-49.621334-28.245333c-43.52-24.874667-87.210667-49.493333-130.56-74.752a37.461333 37.461333 0 0 0-41.386666 0.085333c-66.304 38.357333-132.949333 75.946667-199.424 113.877334-2.133333 1.109333-3.882667 3.029333-7.253334 2.773333V318.037333c0-3.157333 2.048-4.138667 4.181334-5.418666 59.178667-33.706667 117.845333-68.437333 177.664-100.821334 97.493333-52.693333 222.976 5.76 245.248 113.066667z m-247.808 186.368c0 15.488-0.085333 30.890667 0.085333 46.293333 0 3.584-0.981333 5.717333-4.352 7.552-27.178667 15.317333-54.186667 30.805333-81.152 46.464-2.986667 1.664-5.12 1.834667-8.277333 0.085334-26.88-15.573333-54.016-31.061333-81.152-46.378667-3.541333-2.005333-4.608-4.266667-4.608-8.234667 0.170667-30.122667 0.170667-60.16 0-90.24 0-4.181333 1.237333-6.528 5.034666-8.746666 26.496-14.933333 52.906667-29.994667 79.232-45.226667 3.925333-2.176 6.741333-2.56 10.922667-0.170667 26.325333 15.317333 52.650667 30.378667 79.146667 45.312 3.712 2.133333 5.205333 4.394667 5.205333 8.661334-0.256 14.805333-0.085333 29.781333-0.085333 44.629333zM293.802667 294.4c0.085333-84.608 54.784-152.618667 138.709333-169.258667 51.584-10.026667 98.730667 2.986667 141.354667 36.053334l-69.12 39.253333c-38.314667 21.76-76.586667 43.733333-115.029334 65.322667a32 32 0 0 0-17.578666 30.464v236.970666c-2.645333 0.725333-4.138667-1.237333-5.930667-2.176-22.186667-12.501333-44.202667-25.386667-66.474667-37.632-4.608-2.56-5.930667-5.546667-5.930666-10.496 0.085333-62.848 0-125.653333 0-188.501333z m-169.514667 163.882667c-8.362667-72.96 37.290667-147.2 106.666667-172.8 1.152-0.341333 2.304-0.64 3.925333-0.981334V336.213333c0 51.626667 0.170667 103.253333 0 154.88-0.170667 15.146667 5.930667 25.6 19.413333 33.194667 67.072 37.717333 133.973333 76.032 200.832 114.090667l6.442667 3.84-74.24 42.453333c-2.56 1.493333-4.522667 2.133333-7.466667 0.341333-59.989333-34.389333-120.789333-67.2-179.626666-103.168-45.653333-27.818667-70.016-70.613333-75.946667-123.562666z m74.965333 297.898666a166.229333 166.229333 0 0 1-25.344-121.130666l11.776 6.4c56.917333 32.469333 113.92 64.938667 170.794667 97.578666a33.962667 33.962667 0 0 0 36.693333 0c67.797333-38.784 135.68-77.44 203.477334-116.053333l5.034666-2.773333c0 29.141333 0 57.130667 0.170667 85.12 0 3.413333-1.664 4.821333-4.138667 6.229333-58.581333 33.152-116.565333 67.413333-175.829333 99.413333-77.397333 41.472-173.994667 17.664-222.634667-54.784z m530.346667-12.074666c-1.706667 60.458667-41.045333 120.149333-107.776 146.346666a172.373333 172.373333 0 0 1-170.666667-28.032l80.426667-45.781333c34.218667-19.498667 68.352-39.210667 102.741333-58.368a31.274667 31.274667 0 0 0 17.536-30.165333c-0.256-76.672-0.085333-153.344-0.085333-230.144 0-8.405333 0-8.405333 7.168-4.48 22.058667 12.586667 44.16 25.301333 66.304 37.717333 3.541333 2.005333 4.949333 4.010667 4.864 8.106667-0.085333 68.181333 1.322667 136.533333-0.512 204.8z m68.266667-7.68c-8.832 3.754667-8.832 3.754667-8.832-5.632 0-66.56-0.256-133.162667 0.213333-199.68a32.426667 32.426667 0 0 0-18.261333-31.317334c-66.218667-37.461333-132.266667-75.264-198.357334-112.896l-10.112-5.888 75.178667-42.752c2.645333-1.578667 4.522667-0.725333 6.826667 0.512 59.349333 33.962667 119.381333 66.688 177.834666 101.76 44.672 26.965333 69.973333 67.84 76.928 119.168A167.125333 167.125333 0 0 1 797.866667 736.426667z',
  claude: 'M252.8 652.8l167.89504-94.29504 2.76992-8.10496-2.76992-4.48h-8.11008l-28.16-1.70496-96-2.56-83.2-3.41504-80.64-4.26496-20.26496-4.27008-18.98496-24.96 1.92-12.58496 17.06496-11.52 24.32 2.13504L182.61504 486.4 263.68 491.94496l58.66496 3.41504 87.04 9.17504h13.87008l1.92-5.55008-4.69504-3.40992-3.62496-3.41504-83.84-56.74496-90.67008-60.16-47.56992-34.56L168.96 323.2l-13.01504-16.42496-5.54496-35.84 23.25504-25.81504 31.36 2.13504 7.88992 2.12992 31.79008 24.32 67.84 52.48 88.52992 65.28 13.01504 10.88 5.12-3.62496 0.64-2.56-5.76-9.81504-48.21504-87.04-51.40992-88.52992L291.62496 174.08l-5.96992-21.97504a107.85792 107.85792 0 0 1-3.63008-26.02496l26.67008-36.05504 14.72-4.68992 35.40992 4.68992L373.76 103.04l21.97504 50.34496 35.62496 79.36L486.61504 340.48l16.20992 32 8.75008 29.65504 3.2 9.16992h5.54496v-5.12l4.48-60.8 8.32-74.44992 8.10496-96 2.77504-27.09504 13.44-32.42496 26.66496-17.49504 20.69504 10.02496 17.06496 24.32-2.34496 15.79008-10.24 65.92-19.84 103.24992-13.01504 69.12h7.47008l8.74496-8.74496 34.98496-46.50496 58.67008-73.39008 26.02496-29.22496 30.29504-32.21504 19.40992-15.36H798.72l27.09504 40.11008-12.16 41.38496-37.76 48-31.36 40.53504-45.01504 60.58496-28.16 48.42496 2.56 3.84 6.61504-0.64 101.54496-21.54496 54.82496-10.02496 65.49504-11.31008 29.65504 13.87008 3.2 14.08-11.73504 28.8-69.97504 17.28-82.12992 16.42496-122.24 29.01504-1.49504 1.06496 1.70496 2.13504 55.04 5.12 23.47008 1.28h57.6l107.30496 7.88992 28.16 18.56 16.85504 22.61504-2.77504 17.28-43.30496 21.97504-58.24-13.87008-136.11008-32.42496-46.72-11.73504h-6.4v3.84l38.83008 37.97504 71.24992 64.42496 89.17504 82.99008 4.48 20.48-11.52 16.20992L824.32 803.84l-78.50496-58.88-30.29504-26.66496-68.48-57.6h-4.48v5.96992l15.78496 23.04 83.41504 125.23008 4.26496 38.4-5.96992 12.58496-21.55008 7.46496-23.68-4.26496-48.84992-68.48-50.35008-77.22496-40.52992-69.12-4.91008 2.76992-23.88992 258.13504-11.31008 13.22496-26.02496 10.03008-21.54496-16.43008-11.52-26.66496 11.52-52.48L481.28 774.4l11.30496-54.4 10.24-67.62496 5.97504-22.4-0.42496-1.49504-4.91008 0.64-50.98496 69.97504L374.82496 803.84l-61.44 65.70496-14.72 5.76-25.38496-13.22496 2.34496-23.46496 14.29504-20.91008 84.90496-107.94496 51.2-66.98496L459.09504 604.16v-5.54496h-2.13504l-225.49504 146.56-40.10496 5.12L174.08 734.08l2.13504-26.66496L184.32 698.66496l67.84-46.72h-0.21504l0.85504 0.85504z',
}

const PLATFORM_ORDER: { key: ModelKey; label: string; match: (p: string) => boolean }[] = [
  { key: 'claude', label: 'Claude', match: (p) => p === 'anthropic' || p === 'claude' },
  { key: 'codex', label: 'Codex', match: (p) => p === 'openai' || p === 'codex' },
  { key: 'grok', label: 'Grok', match: (p) => p === 'xai' || p === 'grok' },
]

function modelKey(platform: string): ModelKey {
  const p = (platform || '').toLowerCase()
  if (p === 'anthropic' || p === 'claude') return 'claude'
  if (p === 'xai' || p === 'grok') return 'grok'
  return 'codex'
}

function platformMarkSvg(key: ModelKey): string {
  return `<span class="platform-mark ${key}" aria-hidden="true"><svg viewBox="0 0 1024 1024" focusable="false"><path d="${MODEL_ICON_PATHS[key]}" fill="currentColor"/></svg></span>`
}

function windowLabel(label: string): string {
  if (label === '5h') return '5小时'
  if (label === '7d') return '7天'
  return label
}

function lowestRemaining(windows: TrayWindow[]): number | null {
  if (!windows.length) return null
  return windows.reduce((min, w) => {
    if (w.remaining_percent == null) return min
    return min == null ? w.remaining_percent : Math.min(min, w.remaining_percent)
  }, null as number | null)
}

function formatResetShort(resetAt?: string | null): string {
  if (!resetAt) return ''
  const date = new Date(resetAt)
  if (Number.isNaN(date.getTime())) return ''
  const now = Date.now()
  const diffMs = date.getTime() - now
  if (diffMs <= 0) return '已重置'
  const hours = Math.floor(diffMs / 3600000)
  if (hours < 48) {
    const h = Math.floor(diffMs / 3600000)
    const m = Math.floor((diffMs % 3600000) / 60000)
    return `重置 ${h}h ${String(m).padStart(2, '0')}m`
  }
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date)
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${weekday} ${time}`
}

function formatSynced(syncedAt?: string | null): string {
  if (!syncedAt) return '尚未同步'
  const date = new Date(syncedAt)
  if (Number.isNaN(date.getTime())) return '尚未同步'
  return `同步于 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`
}

function orderedWindows(account: TrayAccount): TrayWindow[] {
  const windows = account.windows || []
  if (modelKey(account.platform) !== 'claude') return windows
  return [
    ...windows.filter((w) => w.label === '5h'),
    ...windows.filter((w) => w.label === '7d'),
    ...windows.filter((w) => w.label !== '5h' && w.label !== '7d'),
  ]
}

function statusClass(account: TrayAccount): string {
  if (account.status !== 'active') return 'bad'
  const low = lowestRemaining(account.windows)
  if (low != null && low <= 15) return 'warn'
  if (low != null && low <= 0) return 'bad'
  return ''
}

function isAbnormal(account: TrayAccount): boolean {
  if (account.status !== 'active') return true
  const low = lowestRemaining(account.windows)
  return low != null && low <= 0
}

document.body.classList.add('is-account-panel')

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="tray-shell">
    <section class="tray-panel" aria-label="AI 账号池">
      <header class="tray-header">
        <div class="tray-title">
          <i data-lucide="users"></i>
          <span>AI 账号池</span>
        </div>
        <div class="tray-meta">
          <span id="synced-label">尚未同步</span>
        </div>
      </header>

      <div class="summary-row" id="summary-row">
        <div class="summary-card tone-total"><strong id="sum-total">0</strong><span>总账号</span></div>
        <div class="summary-card tone-online"><strong id="sum-online">0</strong><span>在线</span></div>
        <div class="summary-card tone-bad"><strong id="sum-bad">0</strong><span>异常</span></div>
        <div class="summary-card tone-quota"><strong id="sum-quota">--%</strong><span>总体额度</span></div>
      </div>

      <div class="account-scroll" id="account-scroll"></div>
    </section>
  </div>
`

function paintIcons(): void {
  createIcons({ icons: { Users }, attrs: { 'stroke-width': 2 } })
}
paintIcons()

const syncedLabel = document.querySelector('#synced-label')!
const sumTotal = document.querySelector('#sum-total')!
const sumOnline = document.querySelector('#sum-online')!
const sumBad = document.querySelector('#sum-bad')!
const sumQuota = document.querySelector('#sum-quota')!
const accountScroll = document.querySelector('#account-scroll')!

function renderPayload(payload: TrayPayload): void {
  const accounts = payload.accounts || []
  const total = accounts.length
  const online = accounts.filter((a) => a.status === 'active').length
  const bad = accounts.filter(isAbnormal).length
  const actives = accounts.filter((a) => a.status === 'active')
  const overall =
    actives.length === 0
      ? null
      : actives.reduce((sum, a) => sum + (lowestRemaining(a.windows) ?? 0), 0) / actives.length

  syncedLabel.textContent = payload.refreshing ? '同步中…' : formatSynced(payload.synced_at)
  sumTotal.textContent = String(total)
  sumOnline.textContent = String(online)
  sumBad.textContent = String(bad)
  sumQuota.textContent = overall == null ? '--%' : `${Math.round(overall)}%`

  accountScroll.replaceChildren()
  if (!accounts.length) {
    const empty = document.createElement('div')
    empty.className = 'tray-empty'
    empty.textContent = '暂无账号数据，连接平台后会显示在这里'
    accountScroll.append(empty)
    return
  }

  for (const group of PLATFORM_ORDER) {
    const rows = accounts.filter((a) => group.match((a.platform || '').toLowerCase()))
    if (!rows.length) continue

    const block = document.createElement('section')
    block.className = 'platform-block'

    const head = document.createElement('div')
    head.className = 'platform-head'
    head.innerHTML = `${platformMarkSvg(group.key)}<span>${group.label}</span><span class="platform-count">${rows.length}</span>`
    block.append(head)

    for (const account of rows) {
      const row = document.createElement('article')
      row.className = `account-row${account.status !== 'active' ? ' is-inactive' : ''}`

      const sc = statusClass(account)
      const dot = document.createElement('span')
      dot.className = `status-dot${sc ? ` ${sc}` : ''}`
      dot.title = account.status === 'active' ? '在线' : '异常'

      const name = document.createElement('div')
      name.className = 'account-name'
      name.textContent = account.name
      name.title = account.name

      const lines = document.createElement('div')
      lines.className = 'quota-lines'
      const windows = orderedWindows(account)
      if (!windows.length) {
        const line = document.createElement('div')
        line.className = 'quota-line'
        line.innerHTML = `<span class="quota-label">—</span><div class="quota-track"><div class="quota-fill empty" style="width:0%"></div></div><span class="quota-pct">--%</span>`
        lines.append(line)
      } else {
        for (const w of windows) {
          // 0% remaining still shows the track + "0%", with default empty colors (no red).
          const remaining = Math.max(
            0,
            Math.min(100, Number.isFinite(w.remaining_percent as number) ? (w.remaining_percent as number) : 0),
          )
          const low = remaining > 0 && remaining <= 15
          const mk = modelKey(account.platform)
          const line = document.createElement('div')
          line.className = 'quota-line'
          const fillClass = remaining <= 0 ? 'empty' : `${mk}${low ? ' low' : ''}`
          line.innerHTML = `
            <span class="quota-label">${windowLabel(w.label)}</span>
            <div class="quota-track"><div class="quota-fill ${fillClass}" style="width:${remaining}%"></div></div>
            <span class="quota-pct${low ? ' low' : ''}">${Math.round(remaining)}%</span>
          `
          lines.append(line)
        }
      }

      const reset = document.createElement('div')
      reset.className = 'reset-col'
      if (account.status !== 'active') {
        reset.innerHTML = `<span class="bad-tag">异常</span>`
      } else {
        const primary = orderedWindows(account)[0]
        const text = formatResetShort(primary?.reset_at)
        reset.textContent = text || '重置 —'
        reset.title = primary?.reset_at ? new Date(primary.reset_at).toLocaleString('zh-CN') : ''
      }

      row.append(dot, name, lines, reset)
      block.append(row)
    }

    accountScroll.append(block)
  }
}

async function loadAndRender(): Promise<void> {
  if (!isDesktop) {
    renderPayload(mockPayload())
    return
  }
  try {
    const payload = await invoke<TrayPayload>('get_tray_payload')
    renderPayload(payload)
  } catch {
    renderPayload({ accounts: [], synced_at: null })
  }
}

/** Sample data so `npm run dev` (browser, no Tauri) previews a populated panel. */
function mockPayload(): TrayPayload {
  const now = Date.now()
  const iso = (hours: number) => new Date(now + hours * 3600000).toISOString()
  return {
    synced_at: new Date(now - 120000).toISOString(),
    accounts: [
      {
        id: 21,
        name: 'Claude 主账号',
        platform: 'anthropic',
        status: 'active',
        windows: [
          { label: '5h', remaining_percent: 68, reset_at: iso(2) },
          { label: '7d', remaining_percent: 82, reset_at: iso(98) },
        ],
      },
      {
        id: 22,
        name: 'Claude 备用',
        platform: 'anthropic',
        status: 'active',
        windows: [
          { label: '5h', remaining_percent: 12, reset_at: iso(1) },
          { label: '7d', remaining_percent: 54, reset_at: iso(76) },
        ],
      },
      {
        id: 7,
        name: 'Codex 主账号',
        platform: 'openai',
        status: 'active',
        windows: [{ label: '7d', remaining_percent: 60, reset_at: iso(82) }],
      },
      {
        id: 31,
        name: 'Grok 主账号',
        platform: 'xai',
        status: 'active',
        windows: [{ label: '7d', remaining_percent: 73, reset_at: iso(60) }],
      },
      {
        id: 40,
        name: 'Codex 停用号',
        platform: 'openai',
        status: 'inactive',
        windows: [],
      },
    ],
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void win?.hide()
})

if (isDesktop && win) {
  // Live updates pushed on each pet refresh.
  void listen<TrayPayload>('tray-data', (event) => {
    renderPayload(event.payload)
  })

  // Re-play the entrance animation and reload data when the window is re-shown.
  void win.listen('tray-panel-shown', () => {
    void loadAndRender()
    const panel = document.querySelector<HTMLElement>('.tray-panel')
    if (!panel) return
    panel.style.animation = 'none'
    void panel.offsetWidth
    panel.style.animation = ''
  })
}

void loadAndRender()
