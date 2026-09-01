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

/**
 * Выполнить shell-скрипт от root на macOS через osascript
 * (`do shell script … with administrator privileges` — системный запрос пароля,
 * НЕ UAC). Используется для install/start/stop ZapretMac backend'а.
 */
export async function runAsAdminOnMac(body: string): Promise<{ code: number; out: string }> {
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
    return { code: 0, out: stdout }
  } catch (e) {
    return { code: 1, out: (e as { message?: string })?.message ?? String(e) }
  } finally {
    try {
      unlinkSync(scriptPath)
    } catch {
      /* noop */
    }
  }
}
