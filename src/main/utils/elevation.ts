import { execFile } from 'child_process'
import { promisify } from 'util'

const execFilePromise = promisify(execFile)

let isAdminCached: boolean | null = null

export async function isRunningAsAdmin(): Promise<boolean> {
  if (isAdminCached !== null) {
    return isAdminCached
  }

  if (process.platform !== 'win32') {
    // POSIX: root = uid 0 (macOS/Linux).
    isAdminCached = typeof process.getuid === 'function' ? process.getuid() === 0 : false
    return isAdminCached
  }

  try {
    await execFilePromise('net', ['session'], { timeout: 2000 })
    isAdminCached = true
    return true
  } catch {
    isAdminCached = false
    return false
  }
}

export interface MacAdminResult {
  code: number
  out: string
  /** Пользователь закрыл/отменил системный запрос пароля. */
  cancelled: boolean
}

function normalizeOsascriptError(err: unknown): { code: number; out: string; cancelled: boolean } {
  const raw = (err as { message?: string; stderr?: string; code?: number }) ?? {}
  const text = `${raw.stderr ?? ''}\n${raw.message ?? ''}`
  // -128 = userCanceledErr; osascript оборачивает его в текст "User canceled.".
  const cancelled = /-128|User canceled/i.test(text)
  // Достаём полезную часть: osascript выбрасывает всё, включая сам скрипт.
  const meaningful = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Command:') && !l.startsWith('do shell script'))
  return {
    code: typeof raw.code === 'number' ? raw.code : 1,
    out: meaningful.join('\n') || text.trim() || 'неизвестная ошибка',
    cancelled
  }
}

/**
 * Выполнить shell-скрипт от root на macOS через osascript
 * (`do shell script … with administrator privileges` — системный запрос пароля,
 * НЕ UAC). Используется для install/start/stop ZapretMac backend'а.
 *
 * ВАЖНО: результат нужно проверять — при code !== 0 установка/запуск НЕ
 * состоялись (раньше вызывающий код игнорировал ошибки и статус врал).
 */
export async function runAsAdminOnMac(body: string): Promise<MacAdminResult> {
  const os = await import('node:os')
  const { writeFileSync, unlinkSync } = await import('node:fs')
  const { join } = await import('node:path')

  const scriptPath = join(os.tmpdir(), `slipgate-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
  writeFileSync(scriptPath, '#!/bin/sh\n' + body + '\n', { mode: 0o755 })
  try {
    // quoted form — безопасная передача пути с пробелами в do shell script.
    const appleScript = `do shell script "/bin/sh " & quoted form of ${JSON.stringify(scriptPath)} with administrator privileges`
    const { stdout } = await execFilePromise('/usr/bin/osascript', ['-e', appleScript], {
      timeout: 180_000
    })
    return { code: 0, out: stdout ?? '', cancelled: false }
  } catch (e) {
    return normalizeOsascriptError(e)
  } finally {
    try {
      unlinkSync(scriptPath)
    } catch {
      /* noop */
    }
  }
}
