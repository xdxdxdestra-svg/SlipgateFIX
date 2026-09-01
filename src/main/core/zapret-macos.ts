import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, chmodSync } from 'fs'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import { spawnSync } from 'child_process'
import AdmZip from 'adm-zip'
import { zapretRuntimeDir, zapretBundleDir } from '../utils/dirs'
import { getAppConfig } from '../config'
import { runAsAdminOnMac } from '../utils/elevation'
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
  const src = path.join(zapretBundleDir(), 'default-lists')
  for (const name of REQUIRED_LISTS) {
    const target = path.join(lists, name)
    if (!existsSync(target) && existsSync(path.join(src, name))) {
      try {
        copyFileSync(path.join(src, name), target)
      } catch {
        /* noop */
      }
    }
    if (!existsSync(target)) writeFileSync(target, '', 'utf8')
  }
  writeFileSync(path.join(DATA_ROOT, 'selected-strategy'), strategyId + '\n')
  writeFileSync(path.join(DATA_ROOT, 'ipset-mode'), 'loaded\n')
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

  const utunPath = normalize(utunEntry.entryName)
  const rootPrefixDir = utunPath.includes('/')
    ? utunPath.slice(0, utunPath.lastIndexOf('/') + 1)
    : ''
  // Верхнеуровневая папка архива (например `ZapretMac-macOS-universal/`).
  const topPrefix = rootPrefixDir.includes('/')
    ? rootPrefixDir.slice(0, rootPrefixDir.indexOf('/') + 1)
    : ''

  const dest = zapretRuntimeDir()
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true })
  }
  mkdirSync(dest, { recursive: true })

  let written = 0
  for (const e of entries) {
    if (e.isDirectory) continue
    const name = normalize(e.entryName)
    if (topPrefix && !name.startsWith(topPrefix)) continue
    const rel = name.slice(topPrefix.length)
    if (!rel || rel.includes('..')) continue
    const out = path.join(dest, rel)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, e.getData())
    written++
  }

  // Исполняемые биты (архив из GitHub может их не сохранить).
  for (const rel of ['bin/utunws', 'install.sh', 'run.sh', 'stop.sh', 'restart.sh', 'watchdog.sh']) {
    const p = path.join(dest, rel)
    if (existsSync(p)) {
      try {
        chmodSync(p, 0o755)
      } catch {
        /* noop */
      }
    }
  }

  if (!isInstalled()) {
    // Первая установка: install.sh ставит LaunchDaemon и запускает zapret.
    const script = `set -eu\n/bin/sh '${dest}/install.sh' '${dest}' '${DATA_ROOT}'\n`
    await runAsAdminOnMac(script)
  } else {
    // Обновление: пересинхронизируем payload на месте.
    const script = [
      'set -eu',
      `/usr/bin/rsync -a --delete '${dest}/' '${INSTALL}/'`,
      `/usr/sbin/chown -R root:wheel '${INSTALL}'`,
      `/bin/chmod 755 '${INSTALL}'/install.sh '${INSTALL}'/run.sh '${INSTALL}'/stop.sh '${INSTALL}'/restart.sh '${INSTALL}'/watchdog.sh '${INSTALL}'/bin/utunws`,
      ''
    ].join('\n')
    await runAsAdminOnMac(script)
  }

  const list = listStrategies()
  log('info', `ZapretMac bundle installed: ${written} files, ${list.length} strategies`)
  return { strategies: list.length }
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

export function startZapret(): Promise<void> {
  return withLock(() => startZapretImpl())
}

async function startZapretImpl(): Promise<void> {
  if (await isWinwsRunning()) {
    setStatus({ state: 'running', startedAt: Date.now() })
    return
  }
  if (!isInstalled()) {
    setStatus({
      state: 'error',
      lastError: 'Zapret не установлен. Сначала установите/обновите Zapret (потребуется пароль администратора).'
    })
    throw new Error('Zapret не установлен на macOS')
  }

  const cfg = await getAppConfig()
  const strategy = cfg.zapret?.activeStrategy ?? 'general-simple-fake'

  ensureDataRoot(strategy)
  setStatus({ state: 'starting', startedAt: Date.now(), lastError: undefined })
  log('info', `starting ZapretMac (strategy=${strategy})`)

  const script = `set -eu\n/bin/sh '${INSTALL}/restart.sh'\n`
  await runAsAdminOnMac(script)

  const ok = await waitForEngine()
  if (ok) {
    setStatus({ state: 'running', startedAt: Date.now() })
    log('info', 'utunws is up')
  } else {
    setStatus({
      state: 'error',
      lastError: 'utunws не запустился за 15с. Проверьте /Library/Application Support/ZapretMac/engine.log'
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
    try {
      await runAsAdminOnMac(script)
    } catch {
      /* best-effort */
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
