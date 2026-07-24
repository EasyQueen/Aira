import './menu.css'
import { emitTo } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { createIcons, ExternalLink, LayoutDashboard, LogOut, RefreshCw, Settings, X } from 'lucide'

const win = getCurrentWindow()

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <nav class="menu-panel" aria-label="宠物操作菜单">
    <header class="menu-header">
      <span class="menu-title">SUB2API PET</span>
      <button type="button" class="menu-close" id="menu-close" title="关闭" aria-label="关闭">
        <i data-lucide="x"></i>
      </button>
    </header>
    <button type="button" class="menu-item" data-action="panel">
      <i data-lucide="layout-dashboard"></i><span>打开账号面板</span>
    </button>
    <button type="button" class="menu-item" data-action="refresh">
      <i data-lucide="refresh-cw"></i><span>刷新额度</span>
    </button>
    <button type="button" class="menu-item" data-action="admin">
      <i data-lucide="external-link"></i><span>打开网页管理</span>
    </button>
    <button type="button" class="menu-item" data-action="settings">
      <i data-lucide="settings"></i><span>设置</span>
    </button>
    <div class="menu-sep" role="separator"></div>
    <button type="button" class="menu-item danger" data-action="quit">
      <i data-lucide="log-out"></i><span>退出应用</span>
    </button>
  </nav>
`

createIcons({
  icons: { ExternalLink, LogOut, RefreshCw, Settings, X, LayoutDashboard },
  attrs: { 'stroke-width': 2 },
})

async function dismiss(): Promise<void> {
  try {
    await invoke('hide_action_menu')
  } catch {
    await win.hide()
  }
}

async function runAction(action: string): Promise<void> {
  if (action === 'quit') {
    await invoke('quit_app')
    return
  }
  // Tell the pet window what to do, then close this panel.
  try {
    await emitTo('main', 'pet-menu-action', action)
  } catch {
    // Fallback: broadcast app-wide if emit_to is unavailable.
    const { emit } = await import('@tauri-apps/api/event')
    await emit('pet-menu-action', action)
  }
  await dismiss()
}

document.getElementById('menu-close')!.addEventListener('click', () => {
  void dismiss()
})

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
  button.addEventListener('click', () => {
    void runAction(button.dataset.action || '')
  })
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void dismiss()
})

// Re-play enter animation when the window is re-shown at a new position.
void win.listen('action-menu-shown', () => {
  const panel = document.querySelector<HTMLElement>('.menu-panel')
  if (!panel) return
  panel.style.animation = 'none'
  void panel.offsetWidth
  panel.style.animation = ''
})
