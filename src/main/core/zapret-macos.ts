import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, chmodSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import { spawnSync } from 'child_process'
import AdmZip from 'adm-zip'
import { zapretRuntimeDir, zapretBundleDir } from '../utils/dirs'
import { getAppConfig } from '../config'
import { runAsAdminOnMac } from '../utils/elevation'
import { isVpnActive, VPN_BLOCK_MESSAGE } from '../utils/vpn'
import type { StrategyDescriptor } from './zapret'

// macOS backend: использует нативный payload Flowseal/zapret-mac-discord-youtube
// (utunws + pf + utun) вместо WinDivert/winws.exe. Требует root — повышение
// привилегий через osascript `do shell script … with administrator privileges`
// (системный запрос пароля, НЕ UAC). App Sandbox не включён (см. entitlements).

// Формат DATA_ROOT жёстко задан run.sh upstream: /Users/*/Library/Application Support/ZapretMac
const DATA_ROOT = path.join(app.getPath('home'), 'Library', 'Application Support', 'ZapretMac')
const INSTALL = '/Library/Application Support/ZapretMac'
const PLIST = '/Library/LaunchDaemons/io.github.flowseal.zapretmac.plist'
const REQUIRED_LISTS = [
  'list-general.txt',
  'list-general-user.txt',
  'list-google.txt',
  'list-exclude.txt',
  'list-exclude-user.txt',
  'ipset-all.txt',
  'ipset-exclude.txt',
  'ipset-exclude-user.txt'
] as const

let status: CoreStatus = { state: 'stopped' }

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args)
  }
}

function log(type: ControllerLog['type'], payload: string): void {
  broadcast('log', {
    time: Date.now(),
    type,
    source: 'zapret',
    payload
  } satisfies ControllerLog)
}

function setStatus(next: Partial<CoreStatus>): void {
  status = { ...status, ...next }
  broadcast('zapret:status', status)
}

export function getZapretStatus(): CoreStatus {
  return status
}

function isInstalled(): boolean {
  return existsSync(path.join(INSTALL, 'bin', 'utunws')) && existsSync(PLIST)
}

/** На macOS «winws»-аналог — процесс utunws. */
export async function isWinwsRunning(): Promise<boolean> {
  const r = spawnSync('/usr/bin/pgrep', ['-x', 'utunws'])
  return r.status === 0
}

export async function killWinws(): Promise<void> {
  try {
    spawnSync('/usr/bin/pkill', ['-9', '-x', 'utunws'])
  } catch {
    /* noop */
  }
}

export function ensureWinDivertReady(): void {
  // no-op на macOS — WinDivert не используется
}

/**
 * Стратегии на macOS — id из strategies.tsv (например `general-simple-fake`),
 * title = человекочитаемое имя (совпадает с названиями .bat стратегий Windows,
 * поэтому UI не меняется).
 */
export function listStrategies(): StrategyDescriptor[] {
  const dir = zapretBundleDir()
  const tsv = path.join(dir, 'strategies.tsv')
  if (!existsSync(tsv)) return []
  const out: StrategyDescriptor[] = []
  for (const line of readFileSync(tsv, 'utf-8').split(/\r?\n/)) {
    const [id, title] = line.split('\t').map((s) => s.trim())
    if (!id || !title) continue
    out.push({ file: id, title, description: '' })
  }
  return out
}

/**
 * Подготовить DATA_ROOT: каталог lists (run.sh требует все 8 файлов — пустые
 * затычки создаются, если в default-lists их нет) + selected-strategy + ipset-mode.
 */
function ensureDataRoot(strategyId: string): void {
  const lists = path.join(DATA_ROOT, 'lists')
  mkdirSync(lists, { recursive: true })
  // Источники дефолтных списков: распакованный runtime-bundle, затем уже
  // установленный payload в /Library (на случай, если runtime очищен).
  const sources = [
    path.join(zapretBundleDir(), 'default-lists'),
    path.join(INSTALL, 'default-lists')
  ]
  for (const name of REQUIRED_LISTS) {
    const target = path.join(lists, name)
    if (!existsSync(target)) {
      for (const src of sources) {
        const from = path.join(src, name)
        if (!existsSync(from)) continue
        try {
          copyFileSync(from, target)
          break
        } catch {
          /* noop */
        }
      }
    }
    // run.sh падает (exit 1), если файла нет вообще — создаём пустышку.
    if (!existsSync(target)) writeFileSync(target, '', 'utf8')
  }
  writeFileSync(path.join(DATA_ROOT, 'selected-strategy'), strategyId + '\n')
  writeFileSync(path.join(DATA_ROOT, 'ipset-mode'), 'loaded\n')
}

/**
 * Найти реальный корень payload: каталог, в котором лежат И bin/utunws, И
 * install.sh. В зависимости от шагов сборки и версии upstream-зипа этот
 * каталог может быть как плоским (resources/zapret), так и вложенным
 * (resources/zapret/Payload, resources/zapret/Contents/Resources/Payload).
 * Сначала проверяем сам base — это самый частый и желаемый случай.
 */
function resolvePayloadRoot(base: string): string | undefined {
  const hasBoth = (d: string): boolean =>
    existsSync(path.join(d, 'bin', 'utunws')) && existsSync(path.join(d, 'install.sh'))
  if (hasBoth(base)) return base
  for (const rel of ['Contents/Resources/Payload', 'Payload']) {
    const p = path.join(base, rel)
    if (existsSync(p) && hasBoth(p)) return p
  }
  return undefined
}

/** Рекурсивно найти файл с указанным именем под root (ограничение глубины). */
function findFileRecursive(root: string, name: string, depth = 0): string | undefined {
  if (depth > 4) return undefined
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return undefined
  }
  for (const e of entries) {
    const p = path.join(root, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isFile() && e === name) return p
    if (st.isDirectory() && !st.isSymbolicLink()) {
      const f = findFileRecursive(p, name, depth + 1)
      if (f) return f
    }
  }
  return undefined
}

/**
 * План Б: если copyDirRecursive из-за вложенной раскладки (Payload/) не
 * положила install.sh и/или bin/utunws на верхний уровень dest — вытаскиваем
 * их из глубины. Возвращает краткое описание того, что пришлось «поднять»,
 * либо пустую строку (для лога).
 */
function flattenPayloadToRoot(dest: string): string {
  const notes: string[] = []
  const topInstall = path.join(dest, 'install.sh')
  if (!existsSync(topInstall)) {
    const found = findFileRecursive(dest, 'install.sh')
    if (found) {
      copyFileSync(found, topInstall)
      notes.push(`install.sh pulled up from ${path.relative(dest, found)}`)
    }
  }
  const topUtun = path.join(dest, 'bin', 'utunws')
  if (!existsSync(topUtun)) {
    const found = findFileRecursive(dest, 'utunws')
    if (found) {
      mkdirSync(path.dirname(topUtun), { recursive: true })
      copyFileSync(found, topUtun)
      notes.push(`bin/utunws pulled up from ${path.relative(dest, found)}`)
    }
  }
  return notes.join('; ')
}

async function waitForEngine(timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isWinwsRunning()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

export async function installZapretBundle(
  zipBytes: Uint8Array
): Promise<{ strategies: number; installedVersion?: string }> {
  if (!zipBytes || zipBytes.length === 0) {
    throw new Error('Пустой архив')
  }

  if (status.state === 'running' || status.state === 'starting') {
    try {
      await stopZapret()
    } catch {
      /* best-effort */
    }
  }

  let zip: AdmZip
  try {
    zip = new AdmZip(Buffer.from(zipBytes))
  } catch (e) {
    throw new Error(`Не удалось прочитать архив: ${e instanceof Error ? e.message : String(e)}`)
  }

  const entries = zip.getEntries()
  const normalize = (n: string): string => n.replace(/\\/g, '/')

  const utunEntry = entries.find(
    (e) => !e.isDirectory && /(^|\/)bin\/utunws$/i.test(normalize(e.entryName))
  )
  if (!utunEntry) {
    throw new Error('Архив не содержит bin/utunws — это не сборка ZapretMac')
  }

  // Архив устроен как `ZapretMac.app/Contents/Resources/Payload/**`.
  // Надо отрезать ВСЁ вплоть до каталога payload (того, что содержит bin/),
  // иначе install.sh окажется по адресу <dest>/Contents/Resources/Payload/…
  // и `/bin/sh '<dest>/install.sh'` тихо не найдёт файл (ранее ошибка
  // поглощалась, установка не выполнялась и UI писал «Zapret не установлен»).
  const utunPath = normalize(utunEntry.entryName)
  const payloadPrefix = utunPath.slice(0, utunPath.lastIndexOf('bin/utunws'))

  const dest = zapretRuntimeDir()
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true })
  }
  mkdirSync(dest, { recursive: true })

  let written = 0
  for (const e of entries) {
    if (e.isDirectory) continue
    const name = normalize(e.entryName)
    if (payloadPrefix && !name.startsWith(payloadPrefix)) continue
    const rel = name.slice(payloadPrefix.length)
    if (!rel || rel.includes('..')) continue
    const out = path.join(dest, rel)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, e.getData())
    written++
  }

  // Исполняемые биты (архив из GitHub может их не сохранить).
  // Список совпадает с тем, что chmod'ит upstream install.sh.
  for (const rel of [
    'bin/utunws',
    'install.sh',
    'run.sh',
    'stop.sh',
    'restart.sh',
    'watchdog.sh',
    'test-strategies.sh',
    'update-app.sh'
  ]) {
    const p = path.join(dest, rel)
    if (existsSync(p)) {
      try {
        chmodSync(p, 0o755)
      } catch {
        /* noop */
      }
    }
  }

  // Всегда используем наш «усиленный» run.sh: zip из GitHub может принести
  // другую версию, в которой префлайт-проверки сети (default route / gateway
  // MAC / ARP) падают молча и демон не стартует. Наш run.sh логирует каждый
  // шаг в engine.log и делает bounded-retry сетевого детекта — это одновременно
  // и фикс, и диагностика «utunws не запустился».
  const bundledRun = path.join(zapretBundleDir(), 'run.sh')
  const destRun = path.join(dest, 'run.sh')
  if (existsSync(bundledRun)) {
    try {
      copyFileSync(bundledRun, destRun)
      chmodSync(destRun, 0o755)
    } catch {
      /* noop — fallback на run.sh из zip */
    }
  }

  if (!existsSync(path.join(dest, 'install.sh'))) {
    throw new Error(
      `Распакованный payload не содержит install.sh (префикс «${payloadPrefix}») — обновите Slipgate`
    )
  }

  const firstInstall = !isInstalled()
  await runInstallFlow(dest, firstInstall)

  if (!isInstalled()) {
    throw new Error(
      'Установка не подтвердилась: нет /Library/Application Support/ZapretMac/bin/utunws или LaunchDaemon-плиста. ' +
        'Проверьте пароль администратора и отсутствие запрета в «Системные настройки → Конфиденциальность».'
    )
  }

  const list = listStrategies()
  log(
    'info',
    `ZapretMac bundle ${firstInstall ? 'installed' : 'updated'}: ${written} files, ${list.length} strategies`
  )
  return { strategies: list.length }
}

/**
 * Собственно установка/обновление в /Library/Application Support/ZapretMac.
 * Общий код для установки из скачанного zip (`installZapretBundle`) и из
 * встроенного payload приложения (`installZapretFromBundle`). `dest` — уже
 * распакованный/скопированный payload во временный runtime-каталог.
 */
async function runInstallFlow(dest: string, firstInstall: boolean): Promise<void> {
  // run.sh (демон LaunchDaemon) ЖЁСТКО требует $DATA_ROOT/lists (все 8 файлов —
  // иначе exit 1) + selected-strategy + ipset-mode ПЕРЕД стартом, иначе utun50
  // никогда не появляется и install.sh пишет «utunws did not stay running» →
  // exit 1. Поэтому data-root создаём БЕЗУСЛОВНО, до любой ветки: неудачная
  // первая попытка могла уже оставить plist+bin (isInstalled()==true) БЕЗ lists,
  // и следующий клик уйдёт в ветку «обновление», которая сама lists не создаёт.
  ensureDataRoot('general-simple-fake')

  if (firstInstall) {
    // Первая установка: install.sh ставит LaunchDaemon и запускает zapret.
    const script =
      `set -eu\n` +
      `xattr -dr com.apple.quarantine ${sq(dest)} 2>/dev/null || true\n` +
      `/bin/sh ${sq(`${dest}/install.sh`)} ${sq(dest)} ${sq(DATA_ROOT)}\n` +
      `xattr -dr com.apple.quarantine "/Library/Application Support/ZapretMac" 2>/dev/null || true\n`
    const r = await runAsAdminOnMac(script)
    if (r.code !== 0) {
      throw new Error(installErrorText('установить', r))
    }
  } else {
    // Обновление: пересинхронизируем payload на месте и (пере)запустим демон,
    // чтобы установка гарантированно приводила к работающему сервису — в т.ч.
    // после неудачной попытки, когда демон остановлен (install.sh вызвал stop.sh).
    const chmodTargets = [
      'install.sh',
      'run.sh',
      'stop.sh',
      'restart.sh',
      'watchdog.sh',
      'test-strategies.sh',
      'update-app.sh',
      'bin/utunws'
    ]
      .filter((rel) => existsSync(path.join(dest, rel)))
      .map((rel) => sq(`${INSTALL}/${rel}`))
      .join(' ')
    const script = [
      'set -eu',
      `/usr/bin/rsync -a --delete ${sq(`${dest}/`)} ${sq(`${INSTALL}/`)}`,
      `/usr/sbin/chown -R root:wheel ${sq(INSTALL)}`,
      ...(chmodTargets ? [`/bin/chmod 755 ${chmodTargets}`] : []),
      `/bin/sh ${sq(`${INSTALL}/restart.sh`)}`,
      ''
    ].join('\n')
    const r = await runAsAdminOnMac(script)
    if (r.code !== 0) {
      throw new Error(installErrorText('обновить', r))
    }
  }
}

/** Рекурсивное копирование каталога (встроенный payload → runtime-каталог). */
function copyDirRecursive(from: string, to: string): void {
  for (const entry of readdirSync(from)) {
    const srcPath = path.join(from, entry)
    const destPath = path.join(to, entry)
    const st = statSync(srcPath)
    if (st.isDirectory()) {
      mkdirSync(destPath, { recursive: true })
      copyDirRecursive(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * Установить Zapret из встроенного payload, который уже лежит внутри .app
 * (resources/zapret). Используется на свежей установке macOS, когда баннер
 * обновления не появляется (версия в поставке совпадает с последней или нет
 * сети). Не требует скачивания — просто копируем payload в runtime-каталог
 * и запускаем тот же install.sh через runAsAdminOnMac.
 */
export async function installZapretFromBundle(): Promise<{ strategies: number }> {
  // Находим реальный корень payload: в зависимости от шагов сборки и версии
  // upstream-зипа каталог с bin/utunws+install.sh может оказаться вложенным
  // (Payload/, Contents/Resources/Payload/), а не плоским. resolvePayloadRoot
  // обрабатывает оба варианта и возвращает путь, откуда копировать.
  const base = zapretBundleDir()
  const src = resolvePayloadRoot(base)

  if (
    !src ||
    !existsSync(path.join(src, 'bin', 'utunws')) ||
    !existsSync(path.join(src, 'install.sh'))
  ) {
    throw new Error(
      'Встроенный payload Zapret не найден в пакете Slipgate (resources/zapret). ' +
        'Попробуйте обновление через баннер выше или переустановите приложение ' +
        'из официального релиза.'
    )
  }

  if (status.state === 'running' || status.state === 'starting') {
    try {
      await stopZapret()
    } catch {
      /* best-effort */
    }
  }

  const dest = zapretRuntimeDir()
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true })
  }
  mkdirSync(dest, { recursive: true })
  copyDirRecursive(src, dest)

  // План Б на случай экзотической раскладки: если install.sh или bin/utunws
  // не оказались на верхнем уровне dest после copyDirRecursive (вложенный
  // Payload/, symlink, что угодно) — вытаскиваем их из глубины. Без этого
  // установка падает с «Скопированный payload не содержит install.sh».
  const flattenNote = flattenPayloadToRoot(dest)
  if (flattenNote) {
    log('warn', `payload layout flattened: ${flattenNote}`)
  }

  for (const rel of [
    'bin/utunws',
    'install.sh',
    'run.sh',
    'stop.sh',
    'restart.sh',
    'watchdog.sh',
    'test-strategies.sh',
    'update-app.sh'
  ]) {
    const p = path.join(dest, rel)
    if (existsSync(p)) {
      try {
        chmodSync(p, 0o755)
      } catch {
        /* noop */
      }
    }
  }

  if (!existsSync(path.join(dest, 'install.sh'))) {
    // Сюда попадаем только если install.sh отсутствует и в глубине dest —
    // иначе flattenPayloadToRoot уже бы его поднял.
    throw new Error('Скопированный payload не содержит install.sh — обновите Slipgate')
  }

  const firstInstall = !isInstalled()
  await runInstallFlow(dest, firstInstall)

  if (!isInstalled()) {
    throw new Error(
      'Установка не подтвердилась: нет /Library/Application Support/ZapretMac/bin/utunws или LaunchDaemon-плиста. ' +
        'Проверьте пароль администратора и отсутствие запрета в «Системные настройки → Конфиденциальность».'
    )
  }

  const list = listStrategies()
  log('info', `ZapretMac installed from bundled resources: ${list.length} strategies`)
  return { strategies: list.length }
}

/** Установлен ли Zapret в систему (LaunchDaemon + bin/utunws). */
export function isZapretInstalled(): boolean {
  return isInstalled()
}

/** Надёжное одинарное кавычение для путей внутри shell-скрипта. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Понятный текст для ошибок install/update (включая отмену запроса пароля). */
function installErrorText(
  verb: string,
  r: { code: number; out: string; cancelled: boolean }
): string {
  if (r.cancelled) {
    return `Не удалось ${verb} ZapretMac: запрос пароля администратора отменён.`
  }
  const detail = r.out.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 500)
  return `Не удалось ${verb} ZapretMac (код ${r.code}).${detail ? ` ${detail}` : ''}`
}

let opLock: Promise<void> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = opLock.then(fn, fn)
  opLock = next.then(() => undefined, () => undefined)
  return next
}

export function withZapretLock<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(fn)
}

/**
 * Собрать диагностику при неудачном старте демона: состояние data-root,
 * выбранная стратегия, pgrep, хвост engine.log и статус launchctl. Без
 * этого пользователь видит «utunws не запустился» без причины и непонятно,
 * чинить DATA_ROOT, сеть или снимать карантин.
 */
function collectZapretDiag(): string {
  const parts: string[] = []
  try {
    parts.push(`isInstalled=${isInstalled()}`)
    parts.push(`dataRoot=${DATA_ROOT}`)
    parts.push(
      `dataRootLists=${existsSync(path.join(DATA_ROOT, 'lists')) ? 'yes' : 'NO'}`
    )
    const ss = path.join(DATA_ROOT, 'selected-strategy')
    if (existsSync(ss)) {
      parts.push(
        `selected-strategy=${JSON.stringify(readFileSync(ss, 'utf8').trim())}`
      )
    } else {
      parts.push('selected-strategy=MISSING')
    }
  } catch {
    /* noop */
  }
  try {
    const pg = spawnSync('/usr/bin/pgrep', ['-x', 'utunws'])
    parts.push(
      `pgrep utunws: exit=${pg.status ?? 'n/a'} (running=${pg.status === 0})`
    )
  } catch {
    /* noop */
  }
  const logFile = path.join(INSTALL, 'engine.log')
  if (existsSync(logFile)) {
    try {
      const tail = readFileSync(logFile, 'utf8').split(/\r?\n/).slice(-40).join('\n')
      parts.push(`--- engine.log (last 40 lines) ---\n${tail}`)
    } catch {
      /* noop */
    }
  } else {
    parts.push('engine.log: MISSING')
  }

  // zapret.log — stdout/stderr демона (перенаправлены из plist). Туда попадают
  // shell-ошибки run.sh, которые не дошли до engine.log (например, если
  // какой-то встроенный вызов упал под set -e до наших logf).
  const zlog = path.join(INSTALL, 'zapret.log')
  if (existsSync(zlog)) {
    try {
      const tail = readFileSync(zlog, 'utf8').split(/\r?\n/).slice(-25).join('\n')
      parts.push(`--- zapret.log (last 25 lines) ---\n${tail}`)
    } catch {
      /* noop */
    }
  } else {
    parts.push('zapret.log: MISSING')
  }

  // Текущее состояние сети на момент диагностики. Может отличаться от момента
  // сбоя run.sh, но показывает, есть ли сейчас default route и ARP-запись шлюза.
  try {
    const route = spawnSync('/sbin/route', ['-n', 'get', 'default'], { encoding: 'utf8' })
    const routeOut = (route.stdout || '').trim()
    if (routeOut) parts.push(`--- route -n get default ---\n${routeOut}`)
    const arp = spawnSync('/usr/sbin/arp', ['-an'], { encoding: 'utf8' })
    const arpOut = (arp.stdout || '').trim().split(/\r?\n/).slice(-12).join('\n')
    if (arpOut) parts.push(`--- arp -an (last 12) ---\n${arpOut}`)
  } catch {
    /* noop */
  }

  try {
    const lc = spawnSync(
      '/bin/launchctl',
      ['print', 'system/io.github.flowseal.zapretmac'],
      { encoding: 'utf8' }
    )
    const lcOut = (lc.stdout || lc.stderr || '')
      .toString()
      .split(/\r?\n/)
      .slice(-25)
      .join('\n')
    if (lcOut.trim()) {
      parts.push(`--- launchctl print (last 25 lines) ---\n${lcOut}`)
    }
  } catch {
    /* noop */
  }
  return parts.join('\n')
}

export function startZapret(): Promise<void> {
  return withLock(() => startZapretImpl())
}

async function startZapretImpl(): Promise<void> {
  if (await isWinwsRunning()) {
    setStatus({ state: 'running', startedAt: Date.now() })
    return
  }

  // --- VPN gate (macOS) ---
  // ПРИЧИНА «краша»: запуск Zapret (pf + utun50) ПОВЕРХ живого VPN-туннеля
  // ломает сетевой стек macOS — pf перехватывает/перенаправляет трафик
  // VPN-клиента, туннель рассыпается, и приложение (вместе с IPC и
  // сетевыми вызовами) оказывается в невалидном состоянии. Фикс — не
  // выполнять НИКАКИХ сетевых операций (restart.sh / pf / utun), если VPN
  // активен. Детект нативный, не привязан к конкретному интерфейсу, и
  // сам НИКОГДА не бросает — поэтому не может стать новым источником падения.
  if (process.platform === 'darwin') {
    const vpn = isVpnActive()
    if (vpn.status === 'active') {
      setStatus({ state: 'error', lastError: VPN_BLOCK_MESSAGE })
      throw new Error(VPN_BLOCK_MESSAGE)
    }
    if (vpn.status === 'unknown') {
      // Не смогли достоверно определить — НЕ блокируем (ложный запрет хуже),
      // но и НЕ падаем. Логируем для диагностики, запуск продолжается.
      log('warn', `VPN detection inconclusive: ${vpn.detail ?? ''} — продолжаем запуск Zapret.`)
    }
  }

  if (!isInstalled()) {
    const msg =
      'Zapret не установлен. Откройте страницу «Запрет» и нажмите «Установить/обновить» ' +
      '(понадобится пароль администратора).'
    setStatus({ state: 'error', lastError: msg })
    throw new Error('Zapret не установлен на macOS')
  }

  const cfg = await getAppConfig()
  const strategy = cfg.zapret?.activeStrategy ?? 'general-simple-fake'

  ensureDataRoot(strategy)
  setStatus({ state: 'starting', startedAt: Date.now(), lastError: undefined })
  log('info', `starting ZapretMac (strategy=${strategy})`)

  const script = `set -eu\n/bin/sh '${INSTALL}/restart.sh'\n`
  const r = await runAsAdminOnMac(script)
  if (r.code !== 0) {
    const msg = installErrorText('запустить', r)
    log('error', msg)
    setStatus({ state: 'error', lastError: msg })
    throw new Error(msg)
  }

  const ok = await waitForEngine()
  if (ok) {
    setStatus({ state: 'running', startedAt: Date.now() })
    log('info', 'utunws is up')
  } else {
    const diag = collectZapretDiag()
    log('error', `utunws did not start within 15s\n${diag}`)
    // В UI показываем самое полезное — хвост engine.log (если есть) — и отсылку
    // к полному логу Slipgate (там же launchctl print и process state).
    const engineLogTail = ((): string => {
      const lf = path.join(INSTALL, 'engine.log')
      if (!existsSync(lf)) return ''
      try {
        return readFileSync(lf, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-15)
          .join('\n')
      } catch {
        return ''
      }
    })()
    setStatus({
      state: 'error',
      lastError: engineLogTail
        ? 'utunws не запустился за 15с.\nengine.log:\n' +
          `${engineLogTail}\n\nПолная диагностика (launchctl + процессы) — в логе Slipgate.`
        : // engine.log вообще не создан — Zapret даже не смог поднять сеть.
          // Чаще всего это значит, что мешает активный системный/VPN-клиент.
          'Отключите VPN и попробуйте запустить Zapret ещё раз.'
    })
    throw new Error('utunws did not start')
  }
}

export function stopZapret(): Promise<void> {
  return withLock(() => stopZapretImpl())
}

async function stopZapretImpl(): Promise<void> {
  setStatus({ state: 'stopping', lastError: undefined })
  if (isInstalled()) {
    const script = `set -eu\n/bin/sh '${INSTALL}/stop.sh'\n`
    const r = await runAsAdminOnMac(script)
    if (r.code !== 0) {
      // Остановка best-effort: не роняем UI, но причина должна быть в логах.
      log('warn', `stop.sh завершился с ошибкой: ${r.out.trim().slice(0, 300)}`)
    }
  }
  await new Promise((r) => setTimeout(r, 300))
  setStatus({ state: 'stopped', lastError: undefined })
  log('info', 'zapret stopped')
}

export async function restartZapret(): Promise<void> {
  await stopZapret()
  await new Promise((r) => setTimeout(r, 500))
  await startZapret()
}
