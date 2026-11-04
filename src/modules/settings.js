import store from './store.js'
import * as events from './events.js'
import { api, listenEvent, popMobileInbox, mobileInboxCount, mobileConnectedAt } from './tauri-api.js'
import { t as tr, setLang } from './i18n.js'
import { sfx } from './sfx.js'
import { getLocalVocabVersion, getLatestVocabVersion, checkForVocabUpdate, forceSyncTagVocab } from './tag-sync.js'
import { openHub } from './licensing.js'
import { enhanceSelect } from './select-menu.js'
import * as motion from './motion.js'
import { setPageBar } from './page-bar.js'

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

function systemPrefersLight() {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false
}

// Re-apply the theme when the OS light/dark preference flips, but only while the
// user's choice is 'system'. Bound once, lazily, from applyVisualSettings.
let _systemThemeBound = false
function bindSystemThemeWatch() {
  if (_systemThemeBound) return
  _systemThemeBound = true
  window.matchMedia?.('(prefers-color-scheme: light)')
    ?.addEventListener?.('change', () => {
      if ((settings.theme ?? 'dark') === 'system') applyVisualSettings(settings)
    })
}

// Apply theme / density / accent to <html> immediately — call on boot and on change
export function applyVisualSettings(s) {
  const html = document.documentElement

  // Theme — 'system' resolves to light/dark via the OS media query; the watcher
  // above re-applies on OS change. 'dark' is the default (no class).
  html.classList.remove('theme-light', 'theme-dark')
  const theme = s.theme ?? 'dark'
  const effective = theme === 'system' ? (systemPrefersLight() ? 'light' : 'dark') : theme
  if (effective === 'light') html.classList.add('theme-light')
  bindSystemThemeWatch()

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

/** A setting the backend owns (the plan, from the licence ticket): update the local
 *  copy and tell listeners, without writing it. */
export function mirrorSetting(key, value) {
  if (settings[key] === value) return
  settings[key] = value
  store.emit(events.SETTINGS_CHANGED, { key, value })
}

export function getSetting(key, fallback = null) {
  return settings[key] ?? fallback
}

async function render() {
  if (!container) return
  // Top bar (guide I1): no search and no Import — just "Settings" in the centre
  if (!container.hidden) setPageBar({ title: tr('settings.title') })

  const [vaultInfo, appInfo, tags, autostartEnabled, browsers] = await Promise.all([
    api.getVaultInfo().catch(() => null),
    api.getAppInfo().catch(() => null),
    api.listTags().catch(() => []),
    api.getAutostart().catch(() => false),
    api.listExtensionClients().catch(() => []),
  ])
  const addedOn = ms => new Date(ms).toLocaleDateString(settings.language === 'uz' ? 'uz-UZ' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  const localVocabVersion  = getLocalVocabVersion()
  const latestVocabVersion = getLatestVocabVersion()
  const vocabHasUpdate     = latestVocabVersion > localVocabVersion && latestVocabVersion > 0

  const VALID_TABS = ['general', 'appearance', 'library', 'downloads', 'system', 'mobile']
  if (!VALID_TABS.includes(activeTab)) activeTab = 'general'

  const tabs = [
    { key: 'general',    label: tr('settings.tab.general'),    icon: 'user-circle'     },
    { key: 'appearance', label: tr('settings.tab.appearance'), icon: 'sun'             },
    { key: 'library',    label: tr('settings.tab.library'),    icon: 'folder'          },
    { key: 'downloads',  label: tr('settings.tab.downloads'),  icon: 'download-simple' },
    { key: 'system',     label: tr('settings.tab.system'),     icon: 'sliders'         },
    { key: 'mobile',     label: tr('settings.tab.mobile'),     icon: 'device-mobile'   },
  ]

  const curLang = settings.language ?? 'en'

  container.innerHTML = `
    <div class="settings-page">
      <div class="settings-header">
        <h1 class="settings-title">${tr('settings.title')}</h1>
      </div>
      <div class="settings-tabs">
        ${tabs.map(tab => `
          <button class="stab-btn ${tab.key === activeTab ? 'active' : ''}" data-tab="${tab.key}"><span class="icon icon-16" style="mask-image:url('/icons/${tab.icon}.svg');-webkit-mask-image:url('/icons/${tab.icon}.svg')" aria-hidden="true"></span>${tab.label}</button>
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
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-row-label">
                <span class="settings-row-name">${tr('settings.bloot_id')}</span>
              </div>
              <div class="settings-row-control" style="gap:8px">
                <span class="settings-row-value" style="font-family:var(--font-mono, ui-monospace, monospace);letter-spacing:0.02em">${escHtml(settings.bloot_id)}</span>
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
                <button class="settings-save-btn" id="s-account-signin">${tr('onboarding.hub.continue')}</button>
              </div>
            </div>
          `}
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
                <option value="uz" ${curLang === 'uz' ? 'selected' : ''}>O‘zbekcha</option>
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
                <button class="stg-btn ${(settings.theme ?? 'dark') === 'dark'   ? 'active' : ''}" data-theme="dark">${tr('settings.theme.dark')}</button>
                <button class="stg-btn ${(settings.theme ?? 'dark') === 'light'  ? 'active' : ''}" data-theme="light">${tr('settings.theme.light')}</button>
                <button class="stg-btn ${(settings.theme ?? 'dark') === 'system' ? 'active' : ''}" data-theme="system">${tr('settings.theme.system')}</button>
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
          <h2 class="settings-section-title">${tr('settings.cookies')}</h2>
          <div class="settings-row" style="align-items:flex-start;padding-top:10px;padding-bottom:10px">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.cookies_file')}</span>
              <span class="settings-row-sub">${escHtml(tr('settings.cookies_file.sub'))}</span>
            </div>
            <div class="settings-row-control" style="flex-direction:column;align-items:flex-end;gap:6px">
              <div id="s-cookies-path" style="font-size:12px;color:var(--text-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right">${settings.cookies_txt_path ? settings.cookies_txt_path.replace(/.*[\\/]/, '') : tr('settings.no_file')}</div>
              <div style="display:flex;gap:6px">
                <button class="settings-save-btn" id="s-cookies-browse-btn">${tr('settings.browse')}</button>
                ${settings.cookies_txt_path ? `<button class="settings-save-btn settings-save-btn--ghost" id="s-cookies-clear-btn">${tr('settings.clear')}</button>` : ''}
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

        <!-- Browsers the qooti extension is connected in (each was allowed once) -->
        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.section.browsers')}</h2>
          ${browsers.length ? browsers.map(b => `
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${escHtml(b.browser)}</span>
              <span class="settings-row-sub">${escHtml(tr('settings.browser_added', { date: addedOn(b.approved_at) }))}</span>
            </div>
            <div class="settings-row-control">
              <button class="settings-save-btn s-browser-remove" data-origin="${escHtml(b.origin)}" data-browser="${escHtml(b.browser)}">${tr('settings.browser_remove')}</button>
            </div>
          </div>`).join('') : `
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.browsers_none')}</span>
              <span class="settings-row-sub">${tr('settings.browsers_none.sub')}</span>
            </div>
          </div>`}
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
              <span class="settings-row-sub" id="s-update-status"></span>
            </div>
            <div class="settings-row-control">
              <span class="settings-row-value">${appInfo?.version ?? '—'}</span>
              <button class="settings-save-btn" id="s-check-update">${tr('settings.update.check')}</button>
            </div>
          </div>
        </section>
      </div>

      <!-- Mobile tab -->
      <div class="stab-panel stab-panel--soon ${activeTab === 'mobile' ? 'active' : ''}" data-panel="mobile">
        <!-- Not ready yet: the page shows through, dimmed, under a "Coming soon" note -->
        <div class="soon-overlay" role="note">
          <div class="soon-card">
            <span class="soon-icon icon" style="mask-image:url('/icons/device-mobile.svg');-webkit-mask-image:url('/icons/device-mobile.svg')" aria-hidden="true"></span>
            <span class="soon-badge">${tr('settings.mobile_soon_badge')}</span>
            <h3>${tr('settings.mobile_soon_title')}</h3>
            <p>${tr('settings.mobile_soon_body')}</p>
          </div>
        </div>
        <div class="soon-content" inert>

        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.sync')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.mobile_device')}</span>
              <span class="settings-row-sub">${tr('settings.mobile_device.sub')}</span>
            </div>
            <div id="s-mobile-conn-pill">${buildConnectionPill(mobileConnectedAt())}</div>
          </div>

          <!-- Pending items -->
          <div id="s-mobile-pending-row" style="${mobileInboxCount() === 0 ? 'display:none' : ''}">
            <div style="padding:16px 18px 18px">
              <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px">
                <div style="width:32px;height:32px;border-radius:50%;background:var(--bg-hover);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                  <span class="icon icon-16" style="mask-image:url('/icons/download-simple.svg');-webkit-mask-image:url('/icons/download-simple.svg');background:var(--text-secondary)" aria-hidden="true"></span>
                </div>
                <div style="padding-top:2px">
                  <span class="settings-row-name" id="s-mobile-pending-label">${readyToSync(mobileInboxCount())}</span>
                  <span class="settings-row-sub" style="display:block;margin-top:3px">${tr('settings.mobile_ready.sub')}</span>
                </div>
              </div>
              <div style="display:flex;gap:8px">
                <button id="s-mobile-sync-yes" class="btn btn-primary btn-sm" style="flex:1">${tr('settings.sync_now')}</button>
                <button id="s-mobile-sync-no" class="settings-save-btn">${tr('update.dismiss')}</button>
                <button class="settings-save-btn s-mobile-refresh-btn" title="${tr('settings.refresh')}" style="width:34px;padding:0;display:flex;align-items:center;justify-content:center">
                  <span class="icon icon-14" style="mask-image:url('/icons/arrow-clockwise.svg');-webkit-mask-image:url('/icons/arrow-clockwise.svg')" aria-hidden="true"></span>
                </button>
              </div>
            </div>
          </div>

          <!-- Idle (no items) -->
          <div id="s-mobile-idle-row" style="${mobileInboxCount() > 0 ? 'display:none' : ''}">
            <div style="padding:28px 18px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center">
              <div style="width:32px;height:32px;border-radius:50%;background:var(--bg-hover);display:flex;align-items:center;justify-content:center">
                <span class="icon icon-18" style="mask-image:url('/icons/wifi-high.svg');-webkit-mask-image:url('/icons/wifi-high.svg');background:var(--text-muted)" aria-hidden="true"></span>
              </div>
              <div>
                <p style="margin:0 0 4px;font-size:13.5px;font-weight:500;color:var(--text-primary)">${tr('settings.no_pending')}</p>
                <p style="margin:0;font-size:11.5px;color:var(--text-muted);line-height:1.5">${tr('settings.no_pending.sub')}</p>
              </div>
              <button class="settings-save-btn s-mobile-refresh-btn" style="margin-top:2px">${tr('settings.refresh')}</button>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.pairing')}</h2>
          <div id="s-mobile-qr-wrap" style="display:flex;flex-direction:column;align-items:center;padding:24px 24px 22px;gap:18px">
            <div style="background:#fff;border-radius:8px;padding:10px;display:inline-flex">
              <div id="s-mobile-qr">
                <span class="settings-row-sub">${tr('vault.loading')}</span>
              </div>
            </div>
            <p style="margin:0;font-size:12.5px;color:var(--text-secondary);text-align:center;line-height:1.65;max-width:300px">
              ${tr('settings.pair_how', {
                settings: `<strong style="color:var(--text-primary)">${tr('nav.settings')}</strong>`,
                pair: `<strong style="color:var(--text-primary)">${tr('settings.pair_with_desktop')}</strong>`,
              })}
            </p>
            <div style="width:100%;background:var(--bg-raised);border-radius:var(--radius-sm);padding:10px 12px">
              <span id="s-mobile-uri" style="display:block;font-family:'Geist Mono',ui-monospace,monospace;font-size:9.5px;color:var(--text-muted);word-break:break-all;line-height:1.7"></span>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.mobile_qr_reset')}</span>
              <span class="settings-row-sub">${tr('settings.mobile_qr_reset_sub')}</span>
            </div>
            <button id="s-mobile-qr-reset" class="settings-save-btn">${tr('settings.mobile_qr_reset_ok')}</button>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-title">${tr('settings.network')}</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">${tr('settings.desktop_port')}</span>
              <span class="settings-row-sub">${tr('settings.desktop_port.sub')}</span>
            </div>
            <span class="settings-row-value">1420</span>
          </div>
        </section>
        </div>
      </div>

    </div>
  `

  // Guide I: the section title sits above a card that holds the rows
  container.querySelectorAll('.settings-section').forEach(sec => {
    const title = sec.querySelector(':scope > .settings-section-title')
    const card  = document.createElement('div')
    card.className = 'settings-card'
    ;[...sec.children].filter(c => c !== title).forEach(c => card.appendChild(c))
    sec.appendChild(card)
  })

  // ── Tab switching (cross-fade) ────────────────────────────────
  // Switching tabs: the old panel goes at once and the new one fades in rising 4 px.
  // (The old crossfade pinned the outgoing panel across the whole page, so both could
  // show on top of each other — for seconds when the app was busy.)
  container.querySelectorAll('.stab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newTab = btn.dataset.tab
      if (newTab === activeTab) return

      const newPanel = container.querySelector(`[data-panel="${newTab}"]`)
      if (!newPanel) return

      container.querySelectorAll('.stab-btn').forEach(b => b.classList.toggle('active', b === btn))
      container.querySelectorAll('.stab-panel.active').forEach(p => p.classList.remove('active'))
      activeTab = newTab
      newPanel.classList.add('active')
      motion.fadeIn(newPanel)
      if (newTab === 'mobile') loadMobileQr()
    })
  })

  // ── General tab bindings ──────────────────────────────────────
  // Account lives in bloot apps: sign-in, name, plan and sign-out are all managed there.
  container.querySelector('#s-account-signin')?.addEventListener('click', () => openHub('signin'))
  container.querySelector('#s-hub-manage')?.addEventListener('click', () => openHub('account'))

  bindPlanRefreshBtn()

  // The profile photo is set in bloot apps; qooti only shows it (top bar).
  const langSelect = container.querySelector('#s-lang')
  if (langSelect) {
    langSelect.addEventListener('change', e => {
      setSetting('language', e.target.value)
    })
    enhanceSelect(langSelect)   // app-styled list instead of the OS one

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

  // ── Check for app updates ──────────────────────────────────────
  const checkUpdateBtn = container.querySelector('#s-check-update')
  const updateStatus   = container.querySelector('#s-update-status')
  if (checkUpdateBtn) {
    checkUpdateBtn.addEventListener('click', async () => {
      // Second phase: an update was found → this button now installs it.
      if (checkUpdateBtn.dataset.mode === 'install') {
        checkUpdateBtn.disabled  = true
        checkUpdateBtn.innerHTML = `<span class="spinner-ring" aria-hidden="true"></span><span>${tr('update.installing')}</span>`
        try {
          await api.applyUpdate()   // downloads, installs, then restarts the app
        } catch (err) {
          console.error('[settings] update install failed:', err)
          checkUpdateBtn.disabled  = false
          checkUpdateBtn.textContent = tr('update.failed')
        }
        return
      }

      checkUpdateBtn.disabled  = true
      checkUpdateBtn.textContent = tr('settings.update.checking')
      if (updateStatus) updateStatus.textContent = ''
      try {
        const info = await api.checkForUpdate()
        if (info?.version) {
          if (updateStatus) updateStatus.textContent = tr('settings.update.available', { version: info.version })
          checkUpdateBtn.dataset.mode = 'install'
          checkUpdateBtn.classList.add('s-update-available')
          checkUpdateBtn.disabled  = false
          checkUpdateBtn.textContent = tr('settings.update.install', { version: info.version })
          store.emit(events.UPDATE_AVAILABLE, info)   // also surface the home banner
        } else {
          checkUpdateBtn.textContent = tr('settings.update.uptodate')
          checkUpdateBtn.classList.add('saved')
          setTimeout(() => {
            checkUpdateBtn.textContent = tr('settings.update.check')
            checkUpdateBtn.classList.remove('saved')
            checkUpdateBtn.disabled = false
          }, 2500)
        }
      } catch (err) {
        console.error('[settings] check for update failed:', err)
        checkUpdateBtn.textContent = tr('settings.update.failed')
        setTimeout(() => {
          checkUpdateBtn.textContent = tr('settings.update.check')
          checkUpdateBtn.disabled = false
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
    if (nameEl) nameEl.textContent = tr('settings.no_file')
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

  // ── Downloads tab: disconnect a browser ───────────────────────
  container.querySelectorAll('.s-browser-remove').forEach(btn => btn.addEventListener('click', async () => {
    const { showConfirm } = await import('./dialog.js')
    const browser = btn.dataset.browser
    const ok = await showConfirm({
      title: tr('settings.browser_remove_title', { browser }),
      message: tr('settings.browser_remove_msg', { browser }),
      danger: true,
      confirmLabel: tr('settings.browser_remove'),
    })
    if (!ok) return
    try {
      await api.removeExtensionClient(btn.dataset.origin)
      store.emit(events.SYSTEM_TOAST, { type: 'success', message: tr('settings.browser_removed', { browser }) })
      render()
    } catch (err) {
      console.error('[settings] remove browser failed:', err)
      store.emit(events.SYSTEM_TOAST, { type: 'error', message: tr('settings.browser_remove_failed') })
    }
  }))

  // ── Mobile tab: new QR code (new connection key) ──────────────
  container.querySelector('#s-mobile-qr-reset')?.addEventListener('click', async () => {
    const { showConfirm } = await import('./dialog.js')
    const ok = await showConfirm({
      title: tr('settings.mobile_qr_reset_title'),
      message: tr('settings.mobile_qr_reset_msg'),
      danger: true,
      confirmLabel: tr('settings.mobile_qr_reset_ok'),
    })
    if (!ok) return
    try {
      await api.resetMobileConnectionKey()
      const qrEl = container.querySelector('#s-mobile-qr')
      if (qrEl) delete qrEl.dataset.loaded
      loadMobileQr()
      store.emit(events.SYSTEM_TOAST, { type: 'success', message: tr('settings.mobile_qr_reset_done') })
    } catch (err) {
      console.error('[settings] QR reset failed:', err)
      store.emit(events.SYSTEM_TOAST, { type: 'error', message: tr('settings.mobile_qr_reset_failed') })
    }
  })

  // ── Mobile tab: pending sync row ──────────────────────────────
  function updatePendingRow(count) {
    const pendingRow = container.querySelector('#s-mobile-pending-row')
    const idleRow    = container.querySelector('#s-mobile-idle-row')
    const label      = container.querySelector('#s-mobile-pending-label')
    if (!pendingRow || !idleRow) return
    const hasPending = count > 0
    pendingRow.style.display = hasPending ? '' : 'none'
    idleRow.style.display    = hasPending ? 'none' : ''
    if (label) label.textContent = readyToSync(count)
  }

// "3 items ready to sync"
function readyToSync(n) {
  return n === 1 ? tr('settings.mobile_ready_one') : tr('settings.mobile_ready_many', { n })
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
  const ctrl = (container.querySelector('#s-hub-manage') ?? container.querySelector('#s-plan-refresh') ?? container.querySelector('.s-plan-badge'))?.closest('.settings-row-control')
  if (!ctrl) return
  ctrl.innerHTML = buildPlanBadge(plan) + buildPlanAction(plan)
  ctrl.querySelector('#s-hub-manage')?.addEventListener('click', () => openHub('account'))
  bindPlanRefreshBtn()
}

function buildPlanBadge(plan) {
  if (!plan || plan === 'free') return `<span class="s-plan-badge s-plan-free">${tr('plan.free')}</span>`
  return `<span class="s-plan-badge s-plan-pro">${tr('plan.pro')}</span>`
}

function buildPlanAction(plan) {
  const cooldownLeft = _lastManualRefresh ? Math.max(0, REFRESH_COOLDOWN - (Date.now() - _lastManualRefresh)) : 0
  const refreshDisabled = cooldownLeft > 0 ? 'disabled' : ''
  const refreshBtn = `<button class="settings-save-btn" id="s-plan-refresh" ${refreshDisabled} title="${tr('settings.plan_refresh')}">↻</button>`

  return `<button class="settings-save-btn" id="s-hub-manage">${tr('settings.account.manage')}</button>${refreshBtn}`
}

function buildConnectionPill(ts) {
  const CONNECTED_WINDOW_MS = 90_000
  const connected = ts > 0 && (Date.now() - ts) < CONNECTED_WINDOW_MS
  if (connected) {
    return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#22c55e;font-weight:500">
      <span style="width:6px;height:6px;border-radius:50%;background:#22c55e;flex-shrink:0"></span>${tr('settings.mobile.connected')}
    </span>`
  }
  if (ts > 0) {
    const mins = Math.round((Date.now() - ts) / 60000)
    const label = mins < 2 ? tr('settings.mobile.seen_now') : tr('settings.mobile.seen_min', { n: mins })
    return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--clr-text-muted,#6e6e76)">
      <span style="width:6px;height:6px;border-radius:50%;background:var(--clr-text-muted,#6e6e76);flex-shrink:0"></span>${label}
    </span>`
  }
  return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--clr-text-muted,#6e6e76)">
    <span style="width:6px;height:6px;border-radius:50%;background:#3a3a40;flex-shrink:0"></span>${tr('settings.mobile.not_found')}
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
  // White like the rest of the UI; amber / red only when the disk is getting full
  const barColor   = usedPct > 90 ? 'var(--error)' : usedPct > 70 ? '#D97706' : 'var(--text-primary)'

  return `
    ${lowDisk ? `
    <div class="vault-low-disk-warn">
      <span class="icon icon-14" style="mask-image:url('/icons/warning.svg');-webkit-mask-image:url('/icons/warning.svg')" aria-hidden="true"></span>
      ${tr('vault.low_disk')}
    </div>` : ''}

    <div class="vault-path-row">
      <span class="icon icon-16" style="mask-image:url('/icons/folder.svg');-webkit-mask-image:url('/icons/folder.svg');flex-shrink:0;color:var(--text-primary)" aria-hidden="true"></span>
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
