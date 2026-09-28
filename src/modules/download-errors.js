// Turns raw download failures (yt-dlp stderr lines, backend messages, error codes)
// into short, translated messages a user can act on. The raw text still goes to the
// logs / feedback trail — this is only what the UI shows.

import { t } from './i18n.js'

// Mirrors FREE_DOWNLOAD_DAILY_LIMIT in commands.rs.
const FREE_DOWNLOAD_DAILY_LIMIT = 20

export function isCancelled(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'cancelled'
}

export function friendlyDownloadError(raw) {
  const s = String(raw ?? '')
  const l = s.toLowerCase()

  if (l.includes('upgrade_required:download_limit'))
    return t('dl.err.limit', { n: FREE_DOWNLOAD_DAILY_LIMIT })
  if (l.includes("couldn't set up youtube"))
    return t('dl.err.youtube_setup')
  if (l.includes("couldn't read the video link"))
    return t('dl.err.no_video_id')
  if (l.includes('timed out'))
    return t('dl.err.timeout')
  if (l.includes('chrome blocks cookie') || l.includes('qooti extension') || l.includes('browser session'))
    return t('dl.err.needs_extension')
  if (l.includes('private video') || l.includes('video unavailable') || l.includes('is unavailable')
      || l.includes('has been removed') || l.includes('members-only') || l.includes('not available in your country'))
    return t('dl.err.unavailable')
  if (l.includes('sign in to confirm') || l.includes('confirm your age') || l.includes('age-restricted'))
    return t('dl.err.sign_in')
  if (l.includes('unsupported url') || l.includes('private or unsupported'))
    return t('dl.err.unsupported')
  if (l.includes('http error 403') || l.includes('forbidden') || l.includes('http error 429')
      || l.includes('http error 503') || l.includes('challenge'))
    return t('dl.err.blocked')
  if (l.includes('unable to download webpage') || l.includes('getaddrinfo') || l.includes('failed to resolve')
      || l.includes('connection') || l.includes('network'))
    return t('dl.err.network')
  if (l.includes('yt-dlp not found'))
    return t('dl.err.broken')
  if (l.includes('no importable files') || l.includes('no output files') || l.includes('requested format is not available'))
    return t('dl.err.no_media')
  if (l.includes('failed to save image') || l.includes('failed to download image'))
    return t('dl.err.image')
  return t('dl.err.generic')
}
