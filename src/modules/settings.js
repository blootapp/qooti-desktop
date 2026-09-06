import store from './store.js'
import * as events from './events.js'
import { api, listenEvent, popMobileInbox, mobileInboxCount, mobileConnectedAt } from './tauri-api.js'
import { t as tr, setLang } from './i18n.js'
import { openImageCropper } from './image-cropper.js'
import { sfx } from './sfx.js'
import { getLocalVocabVersion, getLatestVocabVersion, checkForVocabUpdate, forceSyncTagVocab } from './tag-sync.js'

let container = null
let settings = {}
let activeTab = 'general'
let _lastManualRefresh = 0
const REFRESH_COOLDOWN = 5 * 60 * 1000

// Accent presets: value = html class suffix (empty = default blue)
const ACCENTS = [
  { key: 'blue',   color: '#1B4FD8', label: 'Blue'   },
  { key: 'purple', color: '#7C3AED', label: 'Purple' },
  { key: 'green',  color: '#059669', label: 'Green'  },
  { key: 'orange', color: '#D97706', label: 'Orange' },
  { key: 'red',    color: '#DC2626', label: 'Red'    },
  { key: 'pink',   color: '#DB2777', label: 'Pink'   },
]

export function init(el, initialSettings) {
  container = el
  settings = initialSettings ?? {}
  applyVisualSettings(settings)
  store.on(events.NAV_CHANGE, ({ view }) => { if (view === 'settings') render() })
  // Keep cache in sync when settings are changed from outside (e.g. extension popup via ext-pref-changed)
  store.on(events.SETTINGS_CHANGED, ({ key, value }) => {
    settings[key] = value
    if (key === 'plan') updatePlanBadgeLive(value)
  })
}

export function showTab(tab) {
  activeTab = tab
  if (container && !container.hidden) render()
}

// Apply theme / density / accent to <html> immediately — call on boot and on change
export function applyVisualSettings(s) {
  const html = document.documentElement

  // Theme
  html.classList.remove('theme-light', 'theme-dark')
  const theme = s.theme ?? 'dark'
  if (theme === 'light') html.classList.add('theme-light')
  // 'dark' and 'system' need no class (default dark; system deferred to OS media query)

  // Density
  html.classList.remove('density-compact', 'density-comfortable')
  const density = s.grid_density ?? 'default'
  if (density === 'compact')     html.classList.add('density-compact')
  if (density === 'comfortable') html.classList.add('density-comfortable')

  // Accent
  const accentClasses = ACCENTS.map(a => `accent-${a.key}`)
  html.classList.remove(...accentClasses)
  const accent = s.accent_color ?? 'blue'
  if (accent !== 'blue') html.classList.add(`accent-${accent}`)

  // Card label visibility
  document.body.classList.toggle('hide-platform-label',   !(s.show_platform_label   ?? true))
  document.body.classList.toggle('hide-collection-label', !(s.show_collection_label ?? true))
}

export async function setSetting(key, value) {
  await api.setSetting(key, value)
  settings[key] = value
  store.emit(events.SETTINGS_CHANGED, { key, value })
  if (key === 'language') { setLang(value); render() }
  if (['theme', 'grid_density', 'accent_color', 'show_platform_label', 'show_collection_label'].includes(key)) applyVisualSettings(settings)
}

export function getSetting(key, fallback = null) {
  return settings[key] ?? fallback
}

async function render() {
  if (!container) return

  const [vaultInfo, appInfo, tags, autostartEnabled] = await Promise.all([
    api.getVaultInfo().catch(() => null),
    api.getAppInfo().catch(() => null),
    api.listTags().catch(() => []),
    api.getAutostart().catch(() => false),
  ])

  const localVocabVersion  = getLocalVocabVersion()
  const latestVocabVersion = getLatestVocabVersion()
  const vocabHasUpdate     = latestVocabVersion > localVocabVersion && latestVocabVersion > 0

  const VALID_TABS = ['general', 'appearance', 'library', 'downloads', 'system', 'mobile']
  if (!VALID_TABS.includes(activeTab)) activeTab = 'general'

  const tabs = [
    { key: 'general',    label: tr('settings.tab.general')    },
    { key: 'appearance', label: tr('settings.tab.appearance') },
    { key: 'library',    label: tr('settings.tab.library')    },
    { key: 'downloads',  label: tr('settings.tab.downloads')  },
    { key: 'system',     label: tr('settings.tab.system')     },
    { key: 'mobile',     label: 'Mobile'                      },
  ]

  const curLang = settings.language ?? 'en'

  container.innerHTML = `
    <div class="settings-page">
      <div class="settings-header">
        <h1 class="settings-title">${tr('settings.title')}</h1>
      </div>
      <div class="settings-tabs">
        ${tabs.map(tab => `
          <button class="stab-btn ${tab.key === activeTab ? 'active' : ''}" data-tab="${tab.key}">${tab.label}</button>
        `).join('')}
      </div>

      <!-- General tab -->
      <div class="stab-panel ${activeTab === 'general' ? 'active' : ''}" data-panel="general">

        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.account')}</h2>
          ${settings.bloot_id ? `
            <div class="settings-row">
              <div class="settings-row-label">
                <span class="settings-row-name">${tr('settings.displayname')}</span>
              </div>
              <div class="settings-row-control" style="gap:8px">
                <span class="settings-row-value" id="s-displayname-val">${escHtml(settings.display_name ?? '—')}</span>
                <button class="settings-save-btn" id="s-displayname-edit">${tr('settings.edit')}</button>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-row-label">
                <span class="settings-row-name">${tr('settings.plan')}</span>
              </div>
              <div class="settings-row-control" style="gap:8px">
                ${buildPlanBadge(settings.plan)}
                ${buildPlanAction(settings.plan)}
              </div>
            </div>
          ` : `
            <div class="settings-row">
              <div class="settings-row-label">
                <span class="settings-row-name">${tr('settings.not_signed_in')}</span>
                <span class="settings-row-sub">${tr('settings.not_signed_in.sub')}</span>
              </div>
              <div class="settings-row-control">
                <button class="settings-save-btn" id="s-account-signin">${tr('settings.signin')}</button>
              </div>
            </div>
          `}
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.profile')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.photo')}</span>
              <span class="settings-row-sub">${tr('settings.photo.sub')}</span>
            </div>
            <div class="settings-row-control">
              <div class="settings-avatar" id="s-avatar-preview">
                ${settings.profile_image
                  ? `<img src="${settings.profile_image}" alt="" />`
                  : `<span>${(settings.display_name ?? 'U').charAt(0).toUpperCase()}</span>`}
              </div>
              <button class="settings-save-btn" id="s-photo-change">${tr('settings.photo.change')}</button>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.language')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.lang.label')}</span>
              <span class="settings-row-sub">${tr('settings.lang.sub')}</span>
            </div>
            <div class="settings-row-control">
              <select class="settings-select" id="s-lang">
                <option value="en" ${curLang === 'en' ? 'selected' : ''}>English</option>
                <option value="uz" ${curLang === 'uz' ? 'selected' : ''}>O'zbek</option>
              </select>
            </div>
          </div>
        </section>

        ${appInfo?.platform === 'windows' ? `
        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.startup')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.autostart')}</span>
              <span class="settings-row-sub">${tr('settings.autostart.sub')}</span>
            </div>
            <div class="settings-row-control">
              <label class="s-switch">
                <input type="checkbox" id="s-autostart" ${autostartEnabled ? 'checked' : ''} />
                <span class="s-switch-track"></span>
              </label>
            </div>
          </div>
        </section>
        ` : ''}
      </div>

      <!-- Appearance tab -->
      <div class="stab-panel ${activeTab === 'appearance' ? 'active' : ''}" data-panel="appearance">
        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.theme')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.theme.label')}</span>
              <span class="settings-row-sub">${tr('settings.theme.sub')}</span>
            </div>
            <div class="settings-row-control">
              <div class="settings-toggle-group" id="s-theme-toggle">
                <button class="stg-btn ${(settings.theme ?? 'dark') === 'dark' ? 'active' : ''}" data-theme="dark">${tr('settings.theme.dark')}</button>
                <button class="stg-btn stg-btn--locked" data-theme="light" disabled title="Coming soon">${tr('settings.theme.light')}</button>
                <button class="stg-btn stg-btn--locked" data-theme="system" disabled title="Coming soon">${tr('settings.theme.system')}</button>
              </div>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.grid')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.density')}</span>
              <span class="settings-row-sub">${tr('settings.density.sub')}</span>
            </div>
            <div class="settings-row-control">
              <div class="settings-toggle-group" id="s-density-toggle">
                <button class="stg-btn ${settings.grid_density === 'compact'     ? 'active' : ''}" data-density="compact">${tr('settings.density.compact')}</button>
                <button class="stg-btn ${(settings.grid_density ?? 'default') === 'default'  ? 'active' : ''}" data-density="default">${tr('settings.density.default')}</button>
                <button class="stg-btn ${settings.grid_density === 'comfortable' ? 'active' : ''}" data-density="comfortable">${tr('settings.density.comfortable')}</button>
              </div>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.cardlabels')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.platform_label')}</span>
              <span class="settings-row-sub">${tr('settings.platform_label.sub')}</span>
            </div>
            <div class="settings-row-control">
              <label class="s-switch">
                <input type="checkbox" id="s-platform-label" ${(settings.show_platform_label ?? true) ? 'checked' : ''} />
                <span class="s-switch-track"></span>
              </label>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.collection_label')}</span>
              <span class="settings-row-sub">${tr('settings.collection_label.sub')}</span>
            </div>
            <div class="settings-row-control">
              <label class="s-switch">
                <input type="checkbox" id="s-collection-label" ${(settings.show_collection_label ?? true) ? 'checked' : ''} />
                <span class="s-switch-track"></span>
              </label>
            </div>
          </div>
        </section>

      </div>

      <!-- Library tab -->
      <div class="stab-panel ${activeTab === 'library' ? 'active' : ''}" data-panel="library">
        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.libraryfolder')}</h2>
          <div class="vault-section-body">
            ${buildVaultFolderSection(vaultInfo)}
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.storage')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.total_items')}</span>
            </div>
            <span class="settings-row-value">${vaultInfo?.total_items ?? '—'}</span>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.library_size')}</span>
            </div>
            <span class="settings-row-value">${fmtBytes(vaultInfo?.size_bytes)}</span>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.tags')}</h2>
          <div id="s-tag-list" class="s-tag-chips">
            ${tags.length === 0
              ? `<p class="settings-row-sub" style="padding:8px 0">${tr('settings.no_tags')}</p>`
              : tags.map(tag => `
                <div class="s-tag-chip" data-tag-id="${tag.id}">
                  <span>${escHtml(tag.name)}</span>
                  <button class="s-tag-delete-btn s-tag-chip-x" data-tag-id="${tag.id}" aria-label="Delete ${escHtml(tag.name)}">×</button>
                </div>`).join('')}
          </div>
        </section>
      </div>

      <!-- Downloads tab -->
      <div class="stab-panel ${activeTab === 'downloads' ? 'active' : ''}" data-panel="downloads">
        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.video')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.quality')}</span>
              <span class="settings-row-sub">${tr('settings.quality.sub')}</span>
            </div>
            <div class="settings-row-control">
              <div class="settings-toggle-group" id="s-quality-toggle">
                <button class="stg-btn ${(settings.download_quality ?? 'best') === 'best'   ? 'active' : ''}" data-quality="best">${tr('settings.quality.best')}</button>
                <button class="stg-btn ${settings.download_quality === 'medium' ? 'active' : ''}" data-quality="medium">${tr('settings.quality.medium')}</button>
              </div>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">Cookies</h2>
          <div class="settings-row" style="align-items:flex-start;padding-top:10px;padding-bottom:10px">
            <div class="settings-row-label">
              <span class="settings-row-name">Cookies file</span>
              <span class="settings-row-sub">For sites like Instagram that require login. Export via "Get cookies.txt LOCALLY" Chrome extension. Used only when the qooti browser extension isn't available.</span>
            </div>
            <div class="settings-row-control" style="flex-direction:column;align-items:flex-end;gap:6px">
              <div id="s-cookies-path" style="font-size:11px;color:var(--clr-text-muted,#888);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right">${settings.cookies_txt_path ? settings.cookies_txt_path.replace(/.*[\\/]/, '') : 'No file selected'}</div>
              <div style="display:flex;gap:6px">
                <button class="settings-save-btn" id="s-cookies-browse-btn">Browse</button>
                ${settings.cookies_txt_path ? '<button class="settings-save-btn" id="s-cookies-clear-btn" style="background:transparent;border:1px solid var(--clr-border,#2a2a2e)">Clear</button>' : ''}
              </div>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.privacy')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.save_source_url')}</span>
              <span class="settings-row-sub">${tr('settings.save_source_url.sub')}</span>
            </div>
            <div class="settings-row-control">
              <label class="s-switch">
                <input type="checkbox" id="s-save-source-url" ${(settings.save_source_url ?? 'true') !== 'false' ? 'checked' : ''} />
                <span class="s-switch-track"></span>
              </label>
            </div>
          </div>
        </section>
      </div>

      <!-- System tab -->
      <div class="stab-panel ${activeTab === 'system' ? 'active' : ''}" data-panel="system">
        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.maintenance')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.reindex')}</span>
              <span class="settings-row-sub">${tr('settings.reindex.sub')}</span>
            </div>
            <div class="settings-row-control">
              <button class="settings-save-btn" id="s-reindex-btn">${tr('settings.reindex.btn')}</button>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.taglens')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.taglens.reco')}</span>
              <span class="settings-row-sub">${tr('settings.taglens.reco.sub')}</span>
            </div>
            <div class="settings-row-control">
              <label class="s-switch">
                <input type="checkbox" id="s-tag-reco" ${(settings.tag_recommendations_enabled ?? 'false') !== 'false' ? 'checked' : ''} />
                <span class="s-switch-track"></span>
              </label>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.taglens.vocab')}</span>
              <span class="settings-row-sub">${tr('settings.taglens.vocab.sub')}</span>
            </div>
            <div class="settings-row-control">
              <span class="settings-row-value" id="s-taglens-version">
                ${localVocabVersion > 0
                  ? `v${localVocabVersion}${vocabHasUpdate ? ` <span class="s-update-badge">v${latestVocabVersion} available</span>` : ''}`
                  : '—'}
              </span>
              <button class="settings-save-btn${vocabHasUpdate ? ' s-update-available' : ''}" id="s-taglens-check">
                ${vocabHasUpdate ? tr('settings.taglens.update') : tr('settings.taglens.check')}
              </button>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.about')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.version')}</span>
            </div>
            <span class="settings-row-value">${appInfo?.version ?? '—'}</span>
          </div>
        </section>
      </div>

      <!-- Mobile tab -->
      <div class="stab-panel ${activeTab === 'mobile' ? 'active' : ''}" data-panel="mobile">

        <section class="settings-section">
          <h2 class="settings-section-title">Sync</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Mobile device</span>
              <span class="settings-row-sub">Connected over your local Wi-Fi</span>
            </div>
            <div id="s-mobile-conn-pill">${buildConnectionPill(mobileConnectedAt())}</div>
          </div>

          <!-- Pending items -->
          <div id="s-mobile-pending-row" style="${mobileInboxCount() === 0 ? 'display:none' : ''}">
            <div style="border-top:0.5px solid var(--border-subtle);padding:16px 18px 18px">
              <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px">
                <div style="width:34px;height:34px;border-radius:50%;background:var(--accent-tint);border:1px solid rgba(37,99,235,0.2);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                  <span class="icon icon-16" style="mask-image:url('/icons/download-simple.svg');-webkit-mask-image:url('/icons/download-simple.svg');background:var(--accent-link)" aria-hidden="true"></span>
                </div>
                <div style="padding-top:2px">
                  <span class="settings-row-name" id="s-mobile-pending-label">${mobileInboxCount()} item${mobileInboxCount() === 1 ? '' : 's'} ready to sync</span>
                  <span class="settings-row-sub" style="display:block;margin-top:3px">Shared from your phone — ready to add to your library.</span>
                </div>
              </div>
              <div style="display:flex;gap:8px">
                <button id="s-mobile-sync-yes" style="flex:1;height:34px;background:var(--accent);border:none;border-radius:var(--radius-md);color:#fff;font:inherit;font-size:13px;font-weight:500;cursor:pointer;letter-spacing:-0.01em;transition:background 0.15s" onmouseover="this.style.background='var(--accent-hover)'" onmouseout="this.style.background='var(--accent)'">Sync now</button>
                <button id="s-mobile-sync-no" class="settings-save-btn">Dismiss</button>
                <button class="settings-save-btn s-mobile-refresh-btn" title="Refresh" style="width:34px;padding:0;display:flex;align-items:center;justify-content:center">
                  <span class="icon icon-14" style="mask-image:url('/icons/arrow-clockwise.svg');-webkit-mask-image:url('/icons/arrow-clockwise.svg')" aria-hidden="true"></span>
                </button>
              </div>
            </div>
          </div>

          <!-- Idle (no items) -->
          <div id="s-mobile-idle-row" style="${mobileInboxCount() > 0 ? 'display:none' : ''}">
            <div style="border-top:0.5px solid var(--border-subtle);padding:28px 18px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center">
              <div style="width:36px;height:36px;border-radius:var(--radius-md);background:var(--bg-raised);border:0.5px solid var(--border-default);display:flex;align-items:center;justify-content:center">
                <span class="icon icon-18" style="mask-image:url('/icons/wifi-high.svg');-webkit-mask-image:url('/icons/wifi-high.svg');background:var(--text-muted)" aria-hidden="true"></span>
              </div>
              <div>
                <p style="margin:0 0 4px;font-size:13.5px;font-weight:500;color:var(--text-primary)">No items pending</p>
                <p style="margin:0;font-size:11.5px;color:var(--text-muted);line-height:1.5">Items shared from your phone will appear here</p>
              </div>
              <button class="settings-save-btn s-mobile-refresh-btn" style="margin-top:2px">Refresh</button>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">Pairing</h2>
          <div id="s-mobile-qr-wrap" style="display:flex;flex-direction:column;align-items:center;padding:24px 24px 22px;gap:18px;border-top:0.5px solid var(--border-subtle)">
            <div style="background:#fff;border-radius:12px;padding:12px;display:inline-flex;box-shadow:0 0 0 1px rgba(255,255,255,0.06),0 6px 28px rgba(0,0,0,0.5)">
              <div id="s-mobile-qr">
                <span class="settings-row-sub">Loading…</span>
              </div>
            </div>
            <p style="margin:0;font-size:12.5px;color:var(--text-secondary);text-align:center;line-height:1.65;max-width:300px">
              Open qooti on your phone → <strong style="color:var(--text-primary)">Settings</strong> → <strong style="color:var(--text-primary)">Pair with desktop</strong> → scan this code
            </p>
            <div style="width:100%;background:var(--bg-raised);border:0.5px solid var(--border-subtle);border-radius:var(--radius-md);padding:10px 12px">
              <span id="s-mobile-uri" style="display:block;font-family:'Geist Mono',ui-monospace,monospace;font-size:9.5px;color:var(--text-muted);word-break:break-all;line-height:1.7"></span>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">Network</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Desktop port</span>
              <span class="settings-row-sub">Your phone and desktop must be on the same Wi-Fi network.</span>
            </div>
            <span class="settings-row-value">1420</span>
          </div>
        </section>
      </div>

    </div>
  `

  // ── Tab switching (cross-fade) ────────────────────────────────
  let _tabBusy = false
  container.querySelectorAll('.stab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newTab = btn.dataset.tab
      if (newTab === activeTab || _tabBusy) return

      const oldPanel = container.querySelector('.stab-panel.active')
      const newPanel = container.querySelector(`[data-panel="${newTab}"]`)
      if (!newPanel) return

      container.querySelectorAll('.stab-btn').forEach(b => b.classList.toggle('active', b === btn))
      activeTab = newTab

      if (!oldPanel) { newPanel.classList.add('active'); return }

      _tabBusy = true
      const DUR = 160

      // Pin old panel absolutely so new panel can appear in normal flow beneath it
      oldPanel.style.cssText = `position:absolute;top:${oldPanel.offsetTop}px;left:0;right:0;` +
        `opacity:1;pointer-events:none;transition:opacity ${DUR}ms ease`

      newPanel.style.cssText = `opacity:0;transition:opacity ${DUR}ms ease`
      newPanel.classList.add('active')

      // Trigger both fades on the next paint
      requestAnimationFrame(() => requestAnimationFrame(() => {
        oldPanel.style.opacity = '0'
        newPanel.style.opacity = '1'
      }))

      setTimeout(() => {
        oldPanel.classList.remove('active')
        oldPanel.style.cssText = ''
        newPanel.style.cssText = ''
        _tabBusy = false
        if (newTab === 'mobile') loadMobileQr()
      }, DUR + 20)
    })
  })

  // ── General tab bindings ──────────────────────────────────────
  container.querySelector('#s-account-signin')?.addEventListener('click', () => {
    openExternal('https://account.bloot.app/login/')
  })

  container.querySelector('#s-displayname-edit')?.addEventListener('click', () => {
    openExternal('https://account.bloot.app')
  })

  container.querySelector('#s-upgrade-btn')?.addEventListener('click', () => {
    openExternal('https://account.bloot.app/')
  })
  container.querySelector('#s-manage-btn')?.addEventListener('click', () => {
    openExternal('https://account.bloot.app/')
  })

  bindPlanRefreshBtn()

  const avatarPreview = container.querySelector('#s-avatar-preview')
  if (avatarPreview) {
    container.querySelector('#s-photo-change').addEventListener('click', () => {
      openImageCropper({
        onSave: async dataUrl => {
          await setSetting('profile_image', dataUrl)
          avatarPreview.innerHTML = ''
          const img = document.createElement('img')
          img.src = dataUrl
          img.alt = ''
          avatarPreview.appendChild(img)
        },
      })
    })

    container.querySelector('#s-lang').addEventListener('change', e => {
      setSetting('language', e.target.value)
    })

    container.querySelector('#s-autostart')?.addEventListener('change', async e => {
      await api.setAutostart(e.target.checked)
    })
  }

  // ── Appearance tab bindings ───────────────────────────────────
  container.querySelector('#s-theme-toggle')?.querySelectorAll('.stg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('#s-theme-toggle .stg-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      setSetting('theme', btn.dataset.theme)
    })
  })

  container.querySelector('#s-density-toggle')?.querySelectorAll('.stg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('#s-density-toggle .stg-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      setSetting('grid_density', btn.dataset.density)
    })
  })


  container.querySelector('#s-platform-label')?.addEventListener('change', e => {
    setSetting('show_platform_label', e.target.checked)
    document.body.classList.toggle('hide-platform-label', !e.target.checked)
  })

  container.querySelector('#s-collection-label')?.addEventListener('change', e => {
    setSetting('show_collection_label', e.target.checked)
    document.body.classList.toggle('hide-collection-label', !e.target.checked)
  })

  // ── System tab bindings ───────────────────────────────────────
  container.querySelector('#s-tag-reco')?.addEventListener('change', e => {
    setSetting('tag_recommendations_enabled', e.target.checked ? 'true' : 'false')
  })

  const tagLensBtn     = container.querySelector('#s-taglens-check')
  const tagLensVersion = container.querySelector('#s-taglens-version')
  if (tagLensBtn) {
    tagLensBtn.addEventListener('click', async () => {
      tagLensBtn.disabled = true
      tagLensBtn.textContent = tr('settings.taglens.checking')
      try {
        const { local, latest, hasUpdate } = await checkForVocabUpdate()
        if (!hasUpdate) {
          tagLensBtn.textContent = tr('settings.taglens.uptodate')
          tagLensBtn.classList.add('saved')
          setTimeout(() => {
            tagLensBtn.textContent = tr('settings.taglens.check')
            tagLensBtn.classList.remove('saved')
            tagLensBtn.disabled = false
          }, 2500)
          return
        }
        tagLensBtn.textContent = tr('settings.taglens.updating')
        const result = await forceSyncTagVocab()
        tagLensBtn.textContent = tr('settings.taglens.updated', { v: result.version })
        tagLensBtn.classList.add('saved')
        tagLensBtn.classList.remove('s-update-available')
        if (tagLensVersion) tagLensVersion.textContent = `v${result.version}`
        setTimeout(() => {
          tagLensBtn.textContent = tr('settings.taglens.check')
          tagLensBtn.classList.remove('saved')
          tagLensBtn.disabled = false
        }, 3000)
      } catch (err) {
        console.error('[settings] tag-lens check failed:', err)
        tagLensBtn.textContent = tr('settings.taglens.failed')
        setTimeout(() => {
          tagLensBtn.textContent = tr('settings.taglens.check')
          tagLensBtn.disabled = false
        }, 3000)
      }
    })
  }

  const reindexBtn = container.querySelector('#s-reindex-btn')
  if (reindexBtn) {
    reindexBtn.addEventListener('click', async () => {
      reindexBtn.disabled = true
      reindexBtn.textContent = tr('settings.reindex.working')
      try {
        const result = await api.reindexLibrary()
        // reindex_library resets ocr_status to NULL — wake the OCR + auto-tag
        // loops so the reset items get re-processed (they'd otherwise sit idle
        // until the next app restart).
        store.emit(events.GRID_RELOAD)
        reindexBtn.textContent = tr('settings.reindex.done', { n: result.media_requeued })
        reindexBtn.classList.add('saved')
        setTimeout(() => {
          reindexBtn.textContent = tr('settings.reindex.btn')
          reindexBtn.classList.remove('saved')
          reindexBtn.disabled = false
        }, 3000)
      } catch (err) {
        console.error('[settings] reindex failed:', err)
        reindexBtn.textContent = tr('settings.reindex.failed')
        setTimeout(() => {
          reindexBtn.textContent = tr('settings.reindex.btn')
          reindexBtn.disabled = false
        }, 3000)
      }
    })
  }

  // ── Library tab bindings (tags) ──────────────────────────────
  container.querySelectorAll('.s-tag-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tagId = btn.dataset.tagId
      btn.disabled = true
      btn.textContent = '…'
      try {
        await api.deleteTag(tagId)
        const chip = container.querySelector(`.s-tag-chip[data-tag-id="${tagId}"]`)
        chip?.remove()
        store.emit(events.TAG_DELETED, { id: tagId })
      } catch (err) {
        console.error('[settings] deleteTag failed:', err)
        btn.textContent = '×'
        btn.disabled = false
      }
    })
  })

  // ── Downloads tab bindings ────────────────────────────────────
  container.querySelector('#s-quality-toggle')?.querySelectorAll('.stg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('#s-quality-toggle .stg-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      setSetting('download_quality', btn.dataset.quality)
      sfx.success()
    })
  })

  container.querySelector('#s-save-source-url')?.addEventListener('change', e => {
    setSetting('save_source_url', e.target.checked ? 'true' : 'false')
  })

  container.querySelector('#s-cookies-browse-btn')?.addEventListener('click', async () => {
    try {
      const path = await api.pickCookiesFile()
      if (!path) return
      await setSetting('cookies_txt_path', path)
      const nameEl = container.querySelector('#s-cookies-path')
      if (nameEl) nameEl.textContent = path.replace(/.*[\\/]/, '')
      sfx.success()
    } catch (err) {
      store.emit(events.SYSTEM_TOAST, { type: 'error', message: String(err), duration: 6000 })
    }
  })

  container.querySelector('#s-cookies-clear-btn')?.addEventListener('click', async () => {
    await setSetting('cookies_txt_path', '')
    const nameEl = container.querySelector('#s-cookies-path')
    if (nameEl) nameEl.textContent = 'No file selected'
    container.querySelector('#s-cookies-clear-btn')?.remove()
    sfx.success()
  })


  // ── Library tab bindings (vault) ─────────────────────────────
  container.querySelector('#s-vault-browse-btn')?.addEventListener('click', handleVaultBrowse)

  const resetBtn = container.querySelector('#s-vault-reset-btn')
  if (resetBtn && vaultInfo?.default_path) {
    resetBtn.addEventListener('click', () => handleVaultReset(vaultInfo.default_path))
  }

  // ── Mobile tab: load QR code ─────────────────────────────────
  function loadMobileQr() {
    const qrEl  = container.querySelector('#s-mobile-qr')
    const uriEl = container.querySelector('#s-mobile-uri')
    if (!qrEl || qrEl.dataset.loaded) return
    api.getMobileConnectionQr()
      .then(({ svg, uri }) => {
        qrEl.dataset.loaded = '1'
        qrEl.innerHTML = svg
        const svgEl = qrEl.querySelector('svg')
        if (svgEl) { svgEl.setAttribute('width', '160'); svgEl.setAttribute('height', '160') }
        if (uriEl) uriEl.textContent = uri
      })
      .catch(err => {
        qrEl.innerHTML = `<span class="settings-row-sub" style="color:var(--clr-danger,#ef4444)">${err}</span>`
      })
  }
  loadMobileQr()

  // ── Mobile tab: pending sync row ──────────────────────────────
  function updatePendingRow(count) {
    const pendingRow = container.querySelector('#s-mobile-pending-row')
    const idleRow    = container.querySelector('#s-mobile-idle-row')
    const label      = container.querySelector('#s-mobile-pending-label')
    if (!pendingRow || !idleRow) return
    const hasPending = count > 0
    pendingRow.style.display = hasPending ? '' : 'none'
    idleRow.style.display    = hasPending ? 'none' : ''
    if (label) label.textContent = `${count} item${count === 1 ? '' : 's'} ready to sync`
  }

  // Live update when new items arrive from phone
  const _unlistenMobile = store.on(events.MOBILE_ITEMS_PENDING, ({ count }) => {
    updatePendingRow(count)
  })
  // Live update connection pill when mobile pings
  const _unlistenConn = store.on(events.MOBILE_CONNECTED, ({ ts }) => {
    const pill = container.querySelector('#s-mobile-conn-pill')
    if (pill) pill.innerHTML = buildConnectionPill(ts)
  })
  // Clean up listeners when settings panel is replaced on next render
  container.addEventListener('qooti:destroy', () => {
    store.off(events.MOBILE_ITEMS_PENDING, _unlistenMobile)
    store.off(events.MOBILE_CONNECTED, _unlistenConn)
  }, { once: true })

  container.querySelector('#s-mobile-sync-yes')?.addEventListener('click', () => {
    const items = popMobileInbox()
    updatePendingRow(0)
    for (const item of items) {
      store.emit(events.EXTENSION_ITEM_RECEIVED, {
        url: item.url,
        type: 'link',
        title: item.title ?? null,
        _ext_id: null,
        importSource: 'mobile',
      })
    }
  })

  container.querySelector('#s-mobile-sync-no')?.addEventListener('click', () => {
    updatePendingRow(0)
    // Items stay in inbox — they'll re-appear if more arrive or on next render
  })

  container.querySelectorAll('.s-mobile-refresh-btn').forEach(btn => {
    btn.addEventListener('click', () => updatePendingRow(mobileInboxCount()))
  })

}

async function handleVaultBrowse() {
  const newPath = await api.pickVaultFolder()
  if (!newPath) return

  const { showConfirm } = await import('./dialog.js')

  const ok = await showConfirm({
    title: tr('vault.change.title'),
    message: tr('vault.change.msg', { path: newPath }),
    confirmLabel: tr('vault.change.btn'),
  })
  if (!ok) return

  showVaultMigrationOverlay(newPath, true)
}

async function handleVaultReset(defaultPath) {
  const { showConfirm } = await import('./dialog.js')

  const ok = await showConfirm({
    title: tr('vault.reset.title'),
    message: tr('vault.reset.msg', { path: defaultPath }),
    confirmLabel: tr('vault.reset.btn'),
  })
  if (!ok) return

  showVaultMigrationOverlay(defaultPath, true)
}

function showVaultMigrationOverlay(newPath, migrate) {
  const overlay = document.createElement('div')
  overlay.className = 'vault-migrate-overlay'
  overlay.innerHTML = `
    <div class="vault-migrate-box">
      <div class="vault-migrate-title">${migrate ? tr('vault.moving') : tr('vault.updating_path')}</div>
      <div class="vault-migrate-sub">${tr('vault.do_not_close')}</div>
      <div class="vault-migrate-progress-wrap">
        <div class="vault-migrate-bar" id="vm-bar" style="width:0%"></div>
      </div>
      <div class="vault-migrate-count" id="vm-count">${migrate ? tr('vault.preparing') : ''}</div>
    </div>
  `
  document.getElementById('overlays').appendChild(overlay)

  const bar   = overlay.querySelector('#vm-bar')
  const count = overlay.querySelector('#vm-count')

  let unlistenProgress = null
  let unlistenComplete = null

  Promise.all([
    listenEvent('vault:relocate-progress', e => {
      const { done, total } = e.payload
      const pct = total > 0 ? (done / total) * 100 : 0
      bar.style.width = `${pct.toFixed(1)}%`
      count.textContent = tr('vault.count', { done, total })
    }),
    listenEvent('vault:relocate-complete', () => {
      bar.style.width = '100%'
      unlistenProgress?.()
      unlistenComplete?.()
      setTimeout(() => { overlay.remove(); render() }, 600)
    }),
  ]).then(([a, b]) => {
    unlistenProgress = a
    unlistenComplete = b
    return api.relocateVault(newPath, migrate)
  }).catch(async err => {
    unlistenProgress?.()
    unlistenComplete?.()
    overlay.remove()

    const deletePath = String(err).match(/You can delete the incomplete folder at (.+)\./)
    const message = deletePath
      ? `Your library is safe at its original location.\n\nThe incomplete folder can be deleted:\n${deletePath[1]}`
      : String(err)

    const { showAlert } = await import('./dialog.js')
    showAlert({ title: tr('vault.failed.title'), message, danger: true })
  })
}

// ── Account sync (called from main.js boot, throttled to once per 5 days) ───
const ACCOUNT_SYNC_INTERVAL = 5 * 24 * 60 * 60 * 1000

export async function syncAccountIfStale(s = settings) {
  const blootId = s.bloot_id
  if (!blootId) return

  const lastSync = parseInt(s.last_account_sync_at, 10) || 0
  if (Date.now() - lastSync < ACCOUNT_SYNC_INTERVAL) return

  try {
    const res = await fetch(`https://api.bloot.app/public/user/${encodeURIComponent(blootId)}`)
    if (!res.ok) return
    const data = await res.json()

    // Stamp first so we don't retry on network errors until the next 5-day window
    await setSetting('last_account_sync_at', String(Date.now()))
    if (data.display_name && data.display_name !== s.display_name) {
      await setSetting('display_name', data.display_name)
    }
    if (data.plan && data.plan !== s.plan) {
      await setSetting('plan', data.plan)
    }
  } catch {}
}

async function openExternal(url) {
  if ('__TAURI_INTERNALS__' in window) {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
  } else {
    window.open(url, '_blank', 'noopener')
  }
}

function bindPlanRefreshBtn() {
  const btn = container?.querySelector('#s-plan-refresh')
  if (!btn) return

  btn.addEventListener('click', async () => {
    const now = Date.now()
    if (now - _lastManualRefresh < REFRESH_COOLDOWN) return

    _lastManualRefresh = now
    btn.disabled = true
    btn.textContent = '…'

    store.emit(events.LICENSE_MANUAL_REFRESH)

    // Re-enable after cooldown; label updates when LICENSE_STATUS_CHANGED fires
    setTimeout(() => {
      const b = container?.querySelector('#s-plan-refresh')
      if (b) { b.disabled = false; b.textContent = '↻' }
    }, REFRESH_COOLDOWN)
  })

  // Show tick briefly when the server responds with updated status
  const wrapped = store.on(events.LICENSE_STATUS_CHANGED, () => {
    const b = container?.querySelector('#s-plan-refresh')
    if (b) {
      b.textContent = '✓'
      setTimeout(() => { if (container?.querySelector('#s-plan-refresh')) b.textContent = '↻' }, 2000)
    }
    store.off(events.LICENSE_STATUS_CHANGED, wrapped)
  })
}

function updatePlanBadgeLive(plan) {
  if (!container) return
  const ctrl = (container.querySelector('#s-upgrade-btn') ?? container.querySelector('#s-manage-btn') ?? container.querySelector('#s-plan-refresh') ?? container.querySelector('.s-plan-badge'))?.closest('.settings-row-control')
  if (!ctrl) return
  ctrl.innerHTML = buildPlanBadge(plan) + buildPlanAction(plan)
  ctrl.querySelector('#s-upgrade-btn')?.addEventListener('click', () => openExternal('https://account.bloot.app/'))
  ctrl.querySelector('#s-manage-btn')?.addEventListener('click', () => openExternal('https://account.bloot.app/'))
  bindPlanRefreshBtn()
}

function buildPlanBadge(plan) {
  if (!plan || plan === 'free') return `<span class="s-plan-badge s-plan-free">${tr('plan.free')}</span>`
  if (plan === 'pro_yearly')   return `<span class="s-plan-badge s-plan-pro">${tr('plan.pro_yearly')}</span>`
  return `<span class="s-plan-badge s-plan-pro">${tr('plan.pro_monthly')}</span>`
}

function buildPlanAction(plan) {
  const cooldownLeft = _lastManualRefresh ? Math.max(0, REFRESH_COOLDOWN - (Date.now() - _lastManualRefresh)) : 0
  const refreshDisabled = cooldownLeft > 0 ? 'disabled' : ''
  const refreshBtn = `<button class="settings-save-btn" id="s-plan-refresh" ${refreshDisabled} title="Check subscription status">↻</button>`

  if (!plan || plan === 'free') {
    return `<button class="settings-save-btn s-upgrade-btn" id="s-upgrade-btn">${tr('plan.upgrade')}</button>${refreshBtn}`
  }
  return `<button class="settings-save-btn" id="s-manage-btn">${tr('plan.manage')}</button>${refreshBtn}`
}

function buildConnectionPill(ts) {
  const CONNECTED_WINDOW_MS = 90_000
  const connected = ts > 0 && (Date.now() - ts) < CONNECTED_WINDOW_MS
  if (connected) {
    return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#22c55e;font-weight:500">
      <span style="width:6px;height:6px;border-radius:50%;background:#22c55e;flex-shrink:0"></span>Connected
    </span>`
  }
  if (ts > 0) {
    const mins = Math.round((Date.now() - ts) / 60000)
    const label = mins < 2 ? 'just now' : `${mins}m ago`
    return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--clr-text-muted,#6e6e76)">
      <span style="width:6px;height:6px;border-radius:50%;background:var(--clr-text-muted,#6e6e76);flex-shrink:0"></span>Last seen ${label}
    </span>`
  }
  return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--clr-text-muted,#6e6e76)">
    <span style="width:6px;height:6px;border-radius:50%;background:#3a3a40;flex-shrink:0"></span>Not detected
  </span>`
}

function escHtml(str) {
  if (!str) return ''
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function fmtBytes(bytes) {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024)             return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function buildVaultFolderSection(info) {
  if (!info) return `<p class="settings-row-sub" style="padding:12px 0">${tr('vault.loading')}</p>`

  const usedBytes  = info.size_bytes      ?? 0
  const freeBytes  = info.disk_free_bytes ?? 0
  const totalBytes = usedBytes + freeBytes
  const usedPct    = totalBytes > 0 ? Math.min(100, (usedBytes / totalBytes) * 100) : 0
  const lowDisk    = freeBytes < 5 * 1024 * 1024 * 1024 && freeBytes > 0
  const barColor   = usedPct > 90 ? 'var(--error)' : usedPct > 70 ? '#D97706' : 'var(--accent)'

  return `
    ${lowDisk ? `
    <div class="vault-low-disk-warn">
      <span class="icon icon-14" style="mask-image:url('/icons/warning.svg');-webkit-mask-image:url('/icons/warning.svg')" aria-hidden="true"></span>
      ${tr('vault.low_disk')}
    </div>` : ''}

    <div class="vault-path-row">
      <span class="icon icon-16" style="mask-image:url('/icons/folder.svg');-webkit-mask-image:url('/icons/folder.svg');flex-shrink:0;color:var(--accent)" aria-hidden="true"></span>
      <span class="vault-path-text" title="${escHtml(info.path)}">${escHtml(truncatePath(info.path, 52))}</span>
      <div class="vault-path-actions">
        ${!info.is_default ? `<button class="vault-reset-btn" id="s-vault-reset-btn">${tr('vault.reset')}</button>` : ''}
        <button class="vault-browse-btn" id="s-vault-browse-btn">${tr('vault.browse')}</button>
      </div>
    </div>

    <div class="vault-disk-area">
      <div class="vault-disk-track">
        <div class="vault-disk-fill" style="width:${usedPct.toFixed(1)}%;background:${barColor}"></div>
      </div>
      <div class="vault-disk-labels">
        <span>${tr('vault.used', { n: fmtBytes(usedBytes) })}</span>
        <span>${info.is_default ? tr('vault.free', { n: fmtBytes(freeBytes) }) : tr('vault.free_custom', { n: fmtBytes(freeBytes) })}</span>
      </div>
    </div>
  `
}

function truncatePath(p, max) {
  if (!p || p.length <= max) return p
  const parts = p.replace(/\\/g, '/').split('/')
  if (parts.length <= 2) return p.slice(0, max) + '…'
  return parts[0] + '/…/' + parts.slice(-2).join('/')
}
