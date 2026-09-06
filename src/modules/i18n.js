// Internationalisation — English and Uzbek (Latin).
// Usage: t('nav.home'), setLang('uz'), currentLang()
// DOM elements with data-i18n="key" are updated automatically on init and lang change.

let lang = 'en'

const strings = {
  en: {
    'nav.home':          'Home',
    'nav.collections':   'Collections',
    'nav.search':        'Search',
    'nav.activity':      'History',
    'nav.milestones':    'Milestones',
    'nav.notifications': 'Notifications',
    'nav.settings':      'Settings',

    'action.add':        'Add',
    'action.delete':     'Delete',
    'action.edit':       'Edit',
    'action.save':       'Save',
    'action.cancel':     'Cancel',
    'action.confirm':    'Confirm',
    'action.done':       'Done',
    'action.skip':       'Skip for now',
    'action.continue':   'Continue',
    'action.close':      'Close',
    'action.share':      'Share',
    'action.copy':       'Copy',
    'action.download':   'Download',
    'action.import':     'Import',
    'action.export':     'Export',

    'empty.grid':        'Your library is empty',
    'empty.grid.hint':   'Save your first inspiration using the Chrome extension',
    'empty.collections': 'No collections yet',
    'empty.search':      'No results found',
    'empty.milestones':  'No milestones yet',
    'empty.notifications': 'No notifications',

    // Settings — tabs
    'settings.title':           'Settings',
    'settings.tab.general':     'General',
    'settings.tab.appearance':  'Appearance',
    'settings.tab.library':     'Library',
    'settings.tab.downloads':   'Downloads',
    'settings.tab.system':      'System',

    // Settings — General — Account
    'settings.section.account':    'Account',
    'settings.displayname':        'Display name',
    'settings.plan':               'Plan',
    'settings.not_signed_in':      'Not signed in',
    'settings.not_signed_in.sub':  'Sign in to manage your subscription and sync your account',
    'settings.signin':             'Sign in',
    'settings.edit':               'Edit',

    // Settings — General — Profile
    'settings.section.profile':  'Profile',
    'settings.photo':            'Profile photo',
    'settings.photo.sub':        'Shown in the top bar',
    'settings.photo.change':     'Change photo',

    // Settings — General — Language
    'settings.section.language': 'Language',
    'settings.lang.label':       'App language',
    'settings.lang.sub':         'Changes take effect immediately',

    // Settings — General — Startup
    'settings.section.startup':  'Startup',
    'settings.autostart':        'Launch at login',
    'settings.autostart.sub':    'Start qooti automatically when Windows starts',

    // Settings — Appearance — Theme
    'settings.section.theme':    'Theme',
    'settings.theme.label':      'Color scheme',
    'settings.theme.sub':        'Dark mode active · Light & System coming soon',
    'settings.theme.dark':       'Dark',
    'settings.theme.light':      'Light',
    'settings.theme.system':     'System',

    // Settings — Appearance — Grid
    'settings.section.grid':         'Grid',
    'settings.density':              'Density',
    'settings.density.sub':          'Controls how many cards fit per row',
    'settings.density.compact':      'Compact',
    'settings.density.default':      'Default',
    'settings.density.comfortable':  'Comfortable',

    // Settings — Appearance — Card labels
    'settings.section.cardlabels':       'Card labels',
    'settings.platform_label':           'Source platform',
    'settings.platform_label.sub':       'Show where the media came from (e.g. Chrome, Local)',
    'settings.collection_label':         'Collection',
    'settings.collection_label.sub':     'Show which collection the item belongs to',

    // Settings — Library
    'settings.section.libraryfolder': 'Library folder',
    'settings.section.storage':       'Storage',
    'settings.total_items':           'Total items',
    'settings.library_size':          'Library size',
    'settings.section.tags':          'Tags',
    'settings.no_tags':               'No tags yet',

    // Settings — Downloads
    'settings.section.video':        'Video',
    'settings.quality':              'Download quality',
    'settings.quality.sub':          'Applies when saving videos via URL',
    'settings.quality.best':         'Best',
    'settings.quality.medium':       'Medium · 720p',
    'settings.section.privacy':      'Privacy',
    'settings.save_source_url':      'Save source URL',
    'settings.save_source_url.sub':  'Store the original link for items downloaded via URL',

    // Settings — System
    'settings.section.maintenance':  'Maintenance',
    'settings.reindex':              'Rebuild library index',
    'settings.reindex.sub':          'Recalculates tag counts and re-queues all media for analysis',
    'settings.reindex.btn':          'Rebuild',
    'settings.reindex.working':      'Rebuilding…',
    'settings.reindex.done':         'Done · {n} items requeued',
    'settings.reindex.failed':       'Failed — try again',
    'settings.section.taglens':      'Tag Intelligence',
    'settings.taglens.reco':         'Tag recommendations',
    'settings.taglens.reco.sub':     'Analyze media and suggest tags automatically · Uses local AI model',
    'settings.taglens.vocab':        'Tag Lens vocabulary',
    'settings.taglens.vocab.sub':    'Auto-tag categories and prompts · qooti-tag-lens',
    'settings.taglens.update':       'Update now',
    'settings.taglens.check':        'Check for updates',
    'settings.taglens.checking':     'Checking…',
    'settings.taglens.uptodate':     'Up to date ✓',
    'settings.taglens.updating':     'Updating…',
    'settings.taglens.updated':      'Updated to v{v} ✓',
    'settings.taglens.failed':       'Failed — check connection',
    'settings.section.about':        'About',
    'settings.version':              'Version',

    // Plan badges & actions
    'plan.free':        'Free',
    'plan.pro_monthly': 'Pro · Monthly',
    'plan.pro_yearly':  'Pro · Yearly',
    'plan.upgrade':     'Upgrade to Pro →',
    'plan.manage':      'Manage subscription',

    // Vault / Library folder
    'vault.loading':       'Loading…',
    'vault.low_disk':      'Less than 5 GB free on this disk — consider moving your library.',
    'vault.reset':         'Reset',
    'vault.browse':        'Browse…',
    'vault.used':          '{n} used',
    'vault.free':          '{n} free',
    'vault.free_custom':   '{n} free · custom',
    'vault.change.title':  'Change library folder?',
    'vault.change.msg':    'New location: {path}',
    'vault.change.btn':    'Move & Change',
    'vault.reset.title':   'Reset to default folder?',
    'vault.reset.msg':     'Default location: {path}',
    'vault.reset.btn':     'Reset & Move',
    'vault.moving':        'Moving library…',
    'vault.updating_path': 'Updating library path…',
    'vault.do_not_close':  'Do not close the app.',
    'vault.preparing':     'Preparing…',
    'vault.count':         '{done} / {total} files',
    'vault.failed.title':  'Library move failed',

    // Licence
    'license.trial':     'Free trial',
    'license.active':    'Active',
    'license.expired':   'Expired',
    'license.revoked':   'Revoked',
    'license.days_left': '{n} days left',
    'license.buy':       'Get qooti',

    // Settings — legacy keys kept for data-i18n
    'settings.storage':  'Storage',
    'settings.ocr':      'OCR & Search',
    'settings.language': 'Language',
    'settings.profile':  'Profile',
    'settings.extension':'Chrome Extension',
    'settings.mobile':   'Mobile (Coming soon)',
    'settings.license':  'License',
    'settings.about':    'About',

    // Onboarding
    'onboarding.name.heading':  'What should we call you?',
    'onboarding.name.hint':     'This shows on your milestone certificates. You can change it anytime.',
    'onboarding.name.placeholder': 'Your name',
    'onboarding.local.heading': 'Everything you save in qooti lives on your device.',
    'onboarding.local.body':    "No cloud. No one else's servers. Yours.",
    'onboarding.local.confirm': 'Got it',
    'onboarding.store.heading': 'Start with some inspiration',
    'onboarding.store.skip':    'Skip for now',

    // OCR
    'ocr.status.processing': 'Indexing text…',
    'ocr.status.done':       'Text indexed',
    'ocr.status.failed':     'Index failed',
    'ocr.status.paused':     'Paused',
    'ocr.pause':             'Pause indexing',
    'ocr.resume':            'Resume indexing',
    'ocr.reindex':           'Re-index all',

    // Walkthrough tour
    'wt.step1.title': 'Add your first item',
    'wt.step1.body':  'Drag any image, video, or GIF onto the window — or click the + button to browse your files.',
    'wt.step2.title': 'Find anything, instantly',
    'wt.step2.body':  'Search by title, tag, or even text inside your images. This is how you get things back.',
    'wt.step3.title': 'Navigate your library',
    'wt.step3.body':  'Open this menu to switch between Home, Collections, Search, Activity, and Settings.',
    'wt.step4.title': "You're all set",
    'wt.step4.body':  'Start saving things you want to keep. Your library grows with you — private, fast, and yours.',
    'wt.skip':        'Skip tour',
    'wt.next':        'Next →',
    'wt.getstarted':  'Get started',

    // Context menu (grid right-click)
    'ctx.source':   'Source',
    'ctx.collect':  'Collect',
    'ctx.loading':  'Loading…',

    // Extension promo (after tour)
    'ext.promo.title': 'Save from anywhere on the web.',
    'ext.promo.body':  "The Chrome extension lets you drop any image into your vault in one click — while you browse. It's free.",
    'ext.promo.cta':   'Get the Chrome extension →',
    'ext.promo.skip':  'Maybe later',

    // Errors
    'error.no_internet':    'qooti needs an internet connection to get started. Connect and relaunch.',
    'error.generic':        'Something went wrong. Please try again.',
  },

  uz: {
    'nav.home':          'Bosh sahifa',
    'nav.collections':   "To'plamlar",
    'nav.search':        'Qidirish',
    'nav.activity':      'Tarix',
    'nav.milestones':    'Yutuqlar',
    'nav.notifications': 'Bildirishnomalar',
    'nav.settings':      'Sozlamalar',

    'action.add':        "Qo'shish",
    'action.delete':     "O'chirish",
    'action.edit':       'Tahrirlash',
    'action.save':       'Saqlash',
    'action.cancel':     'Bekor qilish',
    'action.confirm':    'Tasdiqlash',
    'action.done':       'Tayyor',
    'action.skip':       "Hozircha o'tkazib yuborish",
    'action.continue':   'Davom etish',
    'action.close':      'Yopish',
    'action.share':      'Ulashish',
    'action.copy':       'Nusxa olish',
    'action.download':   'Yuklab olish',
    'action.import':     'Import',
    'action.export':     'Export',

    'empty.grid':        "Kutubxonangiz bo'sh",
    'empty.grid.hint':   'Chrome kengaytmasi orqali birinchi ilhomingizni saqlang',
    'empty.collections': "Hali to'plamlar yo'q",
    'empty.search':      'Natija topilmadi',
    'empty.milestones':  "Hali yutuqlar yo'q",
    'empty.notifications': "Bildirishnomalar yo'q",

    // Settings — tabs
    'settings.title':           'Sozlamalar',
    'settings.tab.general':     'Umumiy',
    'settings.tab.appearance':  "Ko'rinish",
    'settings.tab.library':     'Kutubxona',
    'settings.tab.downloads':   'Yuklamalar',
    'settings.tab.system':      'Tizim',

    // Settings — General — Account
    'settings.section.account':    'Hisob',
    'settings.displayname':        "Ko'rsatiladigan nom",
    'settings.plan':               'Tarif',
    'settings.not_signed_in':      'Tizimga kirmagansiz',
    'settings.not_signed_in.sub':  "Obunangizni boshqarish va hisobingizni sinxronlash uchun tizimga kiring",
    'settings.signin':             'Kirish',
    'settings.edit':               'Tahrirlash',

    // Settings — General — Profile
    'settings.section.profile':  'Profil',
    'settings.photo':            'Profil rasmi',
    'settings.photo.sub':        "Yuqori panelda ko'rsatiladi",
    'settings.photo.change':     "Rasmni o'zgartirish",

    // Settings — General — Language
    'settings.section.language': 'Til',
    'settings.lang.label':       'Ilova tili',
    'settings.lang.sub':         "O'zgarishlar darhol qo'llaniladi",

    // Settings — General — Startup
    'settings.section.startup':  'Ishga tushirish',
    'settings.autostart':        'Kirishda ishga tushirish',
    'settings.autostart.sub':    "Windows ishga tushganda qootini avtomatik boshlash",

    // Settings — Appearance — Theme
    'settings.section.theme':    'Mavzu',
    'settings.theme.label':      'Rang sxemasi',
    'settings.theme.sub':        "Qo'ng'ir rejim faol · Yorug' va Tizim tez orada",
    'settings.theme.dark':       "Qo'ng'ir",
    'settings.theme.light':      "Yorug'",
    'settings.theme.system':     'Tizim',

    // Settings — Appearance — Grid
    'settings.section.grid':         'Panjar',
    'settings.density':              'Zichlik',
    'settings.density.sub':          'Qatorda nechta karta joylashishini boshqaradi',
    'settings.density.compact':      'Ixcham',
    'settings.density.default':      'Standart',
    'settings.density.comfortable':  'Keng',

    // Settings — Appearance — Card labels
    'settings.section.cardlabels':       'Karta yorliqlari',
    'settings.platform_label':           'Manba platforma',
    'settings.platform_label.sub':       "Media qayerdan kelganini ko'rsatish (masalan, Chrome, Lokal)",
    'settings.collection_label':         "To'plam",
    'settings.collection_label.sub':     "Element qaysi to'plamga tegishli ekanini ko'rsatish",

    // Settings — Library
    'settings.section.libraryfolder': 'Kutubxona papkasi',
    'settings.section.storage':       'Saqlash',
    'settings.total_items':           'Jami elementlar',
    'settings.library_size':          'Kutubxona hajmi',
    'settings.section.tags':          'Teglar',
    'settings.no_tags':               "Hali teglar yo'q",

    // Settings — Downloads
    'settings.section.video':        'Video',
    'settings.quality':              'Yuklab olish sifati',
    'settings.quality.sub':          "URL orqali videolarni saqlashda qo'llaniladi",
    'settings.quality.best':         'Eng yaxshi',
    'settings.quality.medium':       "O'rta · 720p",
    'settings.section.privacy':      'Maxfiylik',
    'settings.save_source_url':      'Manba URL ni saqlash',
    'settings.save_source_url.sub':  "URL orqali yuklab olingan elementlar uchun asl havolani saqlash",

    // Settings — System
    'settings.section.maintenance':  'Texnik xizmat',
    'settings.reindex':              'Kutubxona indeksini qayta qurish',
    'settings.reindex.sub':          "Teg sonlarini qayta hisoblaydi va barcha medialarni tahlil uchun navbatga qo'yadi",
    'settings.reindex.btn':          'Qayta qurish',
    'settings.reindex.working':      'Qayta qurilmoqda…',
    'settings.reindex.done':         "Bajarildi · {n} ta element navbatga qo'yildi",
    'settings.reindex.failed':       "Xato — qayta urinib ko'ring",
    'settings.section.taglens':      'Teg intellekti',
    'settings.taglens.reco':         'Teg tavsiyalari',
    'settings.taglens.reco.sub':     'Medialarni tahlil qiladi va teglarni avtomatik tavsiya qiladi · Lokal AI modelidan foydalanadi',
    'settings.taglens.vocab':        "Tag Lens lug'ati",
    'settings.taglens.vocab.sub':    "Avtomatik teg kategoriyalari va so'rovlar · qooti-tag-lens",
    'settings.taglens.update':       'Hozir yangilash',
    'settings.taglens.check':        'Yangilanishlarni tekshirish',
    'settings.taglens.checking':     'Tekshirilmoqda…',
    'settings.taglens.uptodate':     'Yangilangan ✓',
    'settings.taglens.updating':     'Yangilanmoqda…',
    'settings.taglens.updated':      'v{v} ga yangilandi ✓',
    'settings.taglens.failed':       'Xato — internet aloqasini tekshiring',
    'settings.section.about':        'Dastur haqida',
    'settings.version':              'Versiya',

    // Plan badges & actions
    'plan.free':        'Bepul',
    'plan.pro_monthly': 'Pro · Oylik',
    'plan.pro_yearly':  'Pro · Yillik',
    'plan.upgrade':     "Pro ga o'tish →",
    'plan.manage':      'Obunani boshqarish',

    // Vault / Library folder
    'vault.loading':       'Yuklanmoqda…',
    'vault.low_disk':      "Bu diskda 5 GB dan kam joy bor — kutubxonani ko'chirish haqida o'ylang.",
    'vault.reset':         'Qaytarish',
    'vault.browse':        "Ko'rish…",
    'vault.used':          '{n} ishlatilgan',
    'vault.free':          "{n} bo'sh",
    'vault.free_custom':   "{n} bo'sh · maxsus",
    'vault.change.title':  "Kutubxona papkasini o'zgartirish?",
    'vault.change.msg':    'Yangi joylashuv: {path}',
    'vault.change.btn':    "Ko'chirish va o'zgartirish",
    'vault.reset.title':   'Standart papkaga qaytarish?',
    'vault.reset.msg':     'Standart joylashuv: {path}',
    'vault.reset.btn':     "Qaytarish va ko'chirish",
    'vault.moving':        "Kutubxona ko'chirilmoqda…",
    'vault.updating_path': "Kutubxona yo'li yangilanmoqda…",
    'vault.do_not_close':  'Ilovani yopmang.',
    'vault.preparing':     'Tayyorlanmoqda…',
    'vault.count':         '{done} / {total} fayl',
    'vault.failed.title':  "Kutubxona ko'chirilmadi",

    // Licence
    'license.trial':     'Bepul sinov',
    'license.active':    'Faol',
    'license.expired':   'Muddati tugagan',
    'license.revoked':   'Bekor qilingan',
    'license.days_left': '{n} kun qoldi',
    'license.buy':       'qooti olish',

    // Settings — legacy keys
    'settings.storage':  'Xotira',
    'settings.ocr':      'OCR va qidiruv',
    'settings.language': 'Til',
    'settings.profile':  'Profil',
    'settings.extension':'Chrome kengaytmasi',
    'settings.mobile':   'Mobil (Tez orada)',
    'settings.license':  'Litsenziya',
    'settings.about':    'Dastur haqida',

    // Onboarding
    'onboarding.name.heading':  'Sizni nima deb atashimiz kerak?',
    'onboarding.name.hint':     "Bu yutuq sertifikatlaringizda ko'rsatiladi. Istalgan vaqtda o'zgartirishingiz mumkin.",
    'onboarding.name.placeholder': 'Ismingiz',
    'onboarding.local.heading': 'qootiga saqlaydigan hamma narsa qurilmangizda saqlanadi.',
    'onboarding.local.body':    "Bulut yo'q. Boshqa serverlar yo'q. Faqat sizniki.",
    'onboarding.local.confirm': 'Tushunarli',
    'onboarding.store.heading': 'Bir oz ilhom bilan boshlang',
    'onboarding.store.skip':    "Hozircha o'tkazib yuborish",

    // OCR
    'ocr.status.processing': 'Matn indekslanmoqda…',
    'ocr.status.done':       'Matn indekslandi',
    'ocr.status.failed':     'Indekslash muvaffaqiyatsiz',
    'ocr.status.paused':     "To'xtatildi",
    'ocr.pause':             "Indekslashni to'xtatish",
    'ocr.resume':            'Indekslashni davom ettirish',
    'ocr.reindex':           'Hammasini qayta indekslash',

    // Walkthrough tour
    'wt.step1.title': "Birinchi elementingizni qo'shing",
    'wt.step1.body':  "Istalgan rasm, video yoki GIF ni oynaga tashlang — yoki fayllarni ko'rish uchun + tugmasini bosing.",
    'wt.step2.title': 'Istalgan narsani darhol toping',
    'wt.step2.body':  'Sarlavha, teg yoki rasmlaringizdagi matn orqali qidiring. Bu narsalarni topishning asosiy usuli.',
    'wt.step3.title': 'Kutubxonangizda harakatlaning',
    'wt.step3.body':  "Bosh sahifa, To'plamlar, Qidiruv, Faoliyat va Sozlamalar o'rtasida o'tish uchun ushbu menyuni oching.",
    'wt.step4.title': 'Hammasi tayyor',
    'wt.step4.body':  "Saqlamoqchi bo'lgan narsalarni saqlashni boshlang. Kutubxonangiz siz bilan o'sadi — shaxsiy, tez va sizniki.",
    'wt.skip':        "Turni o'tkazib yuborish",
    'wt.next':        'Keyingi →',
    'wt.getstarted':  'Boshlash',

    // Context menu (grid right-click)
    'ctx.source':   'Manba',
    'ctx.collect':  "To'plamga",
    'ctx.loading':  'Yuklanmoqda…',

    // Extension promo (after tour)
    'ext.promo.title': 'Internetdagi istalgan joydan saqlang.',
    'ext.promo.body':  "Chrome kengaytmasi sizga ko'rish jarayonida istalgan rasmni bir marta bosish bilan seyfingizkga qo'shish imkonini beradi. Bepul.",
    'ext.promo.cta':   'Chrome kengaytmasini olish →',
    'ext.promo.skip':  'Keyinroq',

    // Errors
    'error.no_internet':    "qooti boshlash uchun internet aloqasi kerak. Ulanib, qayta ishga tushiring.",
    'error.generic':        "Xatolik yuz berdi. Qayta urinib ko'ring.",
  },
}

export function initI18n(savedLang) {
  if (savedLang && strings[savedLang]) lang = savedLang
  applyToDOM()
}

export function setLang(newLang) {
  if (!strings[newLang]) return
  lang = newLang
  applyToDOM()
}

export function currentLang() { return lang }

export function t(key, vars = {}) {
  const str = strings[lang]?.[key] ?? strings.en?.[key] ?? key
  return str.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`)
}

function applyToDOM() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n
    el.textContent = t(key)
  })
}
