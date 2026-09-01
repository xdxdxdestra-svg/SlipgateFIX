import * as windowsImpl from './zapret-windows'
import * as macosImpl from './zapret-macos'

export interface StrategyDescriptor {
  file: string
  title: string
  description: string
}

// Платформенный диспетчер: Windows сохраняет прежнюю логику (winws.exe,
// WinDivert, .bat), macOS использует нативный backend (utunws + LaunchDaemon
// + osascript-повышение привилегий). Публичный API не меняется — IPC/renderer
// продолжают работать без изменений.
const impl = process.platform === 'darwin' ? macosImpl : windowsImpl

export const getZapretStatus = impl.getZapretStatus
export const listStrategies = impl.listStrategies
export const installZapretBundle = impl.installZapretBundle
export const withZapretLock = impl.withZapretLock
export const startZapret = impl.startZapret
export const stopZapret = impl.stopZapret
export const restartZapret = impl.restartZapret

// Windows-only helpers остаются в контракте (их импортирует zapret-tester).
// На macOS — безопасные эквиваленты (pkill utunws / проверка процесса).
export const killWinws = impl.killWinws
export const ensureWinDivertReady = impl.ensureWinDivertReady
export const isWinwsRunning = impl.isWinwsRunning
