import { is } from '@electron-toolkit/utils'
import { existsSync, mkdirSync } from 'fs'
import { app } from 'electron'
import path from 'path'

export const homeDir = app.getPath('home')

export function isPortable(): boolean {
  return existsSync(path.join(exeDir(), 'PORTABLE'))
}

export function dataDir(): string {
  if (isPortable()) {
    return path.join(exeDir(), 'data')
  }
  return app.getPath('userData')
}

export function taskDir(): string {
  const dir = path.join(app.getPath('userData'), 'tasks')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function exeDir(): string {
  return path.dirname(exePath())
}

export function exePath(): string {
  return app.getPath('exe')
}

export function resourcesDir(): string {
  if (is.dev) {
    // In dev __dirname is <project>/out/main, so ../.. resolves to the
    // project root which contains the `resources/` folder with all
    // Slipgate runtime binaries (tgws/, zapret/, icon files).
    const root = path.join(__dirname, '../..')
    return path.join(root, 'resources')
  }
  if (app.getAppPath().endsWith('asar')) {
    return process.resourcesPath
  }
  return path.join(app.getAppPath(), 'resources')
}

export function resourcesFilesDir(): string {
  return path.join(resourcesDir(), 'files')
}

export function themesDir(): string {
  return path.join(dataDir(), 'themes')
}

export function appConfigPath(): string {
  return path.join(dataDir(), 'config.yaml')
}

export function logDir(): string {
  return path.join(dataDir(), 'logs')
}

export function logPath(): string {
  const date = new Date()
  const name = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
  return path.join(logDir(), `${name}.log`)
}

export function runtimeDir(): string {
  return path.join(dataDir(), 'runtime')
}

export function tgwsRuntimeDir(): string {
  return path.join(runtimeDir(), 'tgws')
}

const IS_MAC = process.platform === 'darwin'
// В dev-режиме ресурсы лежат в resources/<platform>/; в packaged-режиме
// electron-builder раскладывает resources/common + resources/<platform>
// плоско в resources/ (to: ''), поэтому плоский путь — основной кандидат.
const PLATFORM_DIR = IS_MAC ? 'macos' : 'windows'
const TGWS_BIN_NAME = IS_MAC ? 'TgWsProxy' : 'TgWsProxy_windows.exe'
const ZAPRET_MARKER = IS_MAC ? 'bin/utunws' : 'general.bat'

export function tgwsBinaryPath(): string {
  // Runtime dir first (downloaded updates), then bundled resources/.
  const rt = path.join(tgwsRuntimeDir(), TGWS_BIN_NAME)
  if (existsSync(rt)) return rt
  const flat = path.join(resourcesDir(), 'tgws', TGWS_BIN_NAME) // packaged (плоско)
  if (existsSync(flat)) return flat
  return path.join(resourcesDir(), PLATFORM_DIR, 'tgws', TGWS_BIN_NAME) // dev
}

export function zapretRuntimeDir(): string {
  return path.join(runtimeDir(), 'zapret')
}

export function zapretBundleDir(): string {
  const rt = zapretRuntimeDir()
  if (existsSync(path.join(rt, ZAPRET_MARKER))) return rt
  const flat = path.join(resourcesDir(), 'zapret') // packaged (плоско)
  if (existsSync(path.join(flat, ZAPRET_MARKER))) return flat
  return path.join(resourcesDir(), PLATFORM_DIR, 'zapret') // dev
}

export function zapretBinaryPath(): string {
  return path.join(zapretBundleDir(), 'bin', IS_MAC ? 'utunws' : 'winws.exe')
}