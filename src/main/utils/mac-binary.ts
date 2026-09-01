import { spawnSync } from 'child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import path from 'path'
import { runtimeDir } from './dirs'

// ─────────────────────────────────────────────────────────────────────────────
// Зачем это нужно
// ─────────────────────────────────────────────────────────────────────────────
// Вложенные в Slipgate.app бинарники (TgWsProxy — PyInstaller onefile) попадают
// под подпись electron-builder: @electron/osx-sign проходит по ВСЕМ бинарным
// файлам внутри Contents/ и подписывает каждый из них, причём `hardenedRuntime`
// в electron-builder применяется к каждому файлу, а не только к самому .app.
//
// Итог: у TgWsProxy появляется hardened runtime → включается library validation,
// и при распаковкеonefile-архива dlopen() встроенного Python.framework
// (подписанного другим Team ID — например python.org) отвергается:
//
//   [PYI-xxxx:ERROR] Failed to load Python shared library '…/Python':
//   … mapping process and mapped file (non-platform) have different Team IDs
//
// Лечение: переподписать бинарник ad-hoc БЕЗ флага hardened runtime
// (`codesign --force --sign -`), тогда library validation отключается и
// встроенная dylib загружается. Плюс снимаем карантин (com.apple.quarantine),
// из-за которого Gatekeeper дополнительно блокирует запуск.
//
// Важно: правим НЕ файл внутри .app (это сломает подпись/печать бандла и при
// следующем запуске Gatekeeper скажет "app is damaged"), а копию в writable
// runtime-каталоге.

const PREPARED_DIR = 'prepared'

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8' })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    return { ok: r.status === 0, out }
  } catch (e) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) }
  }
}

/** Снять карантин Gatekeeper (com.apple.quarantine), если он выставлен. */
export function stripQuarantine(target: string): void {
  const rm = run('/usr/bin/xattr', ['-d', 'com.apple.quarantine', target])
  if (!rm.ok) {
    // Атрибута могло не быть — тогда пробуем очистить все xattr (best-effort).
    run('/usr/bin/xattr', ['-c', target])
  }
}

/**
 * Ad-hoc переподпись: снимает hardened runtime → отключает library validation.
 * Возвращает false, если codesign недоступен/отказал — вызывающий код должен
 * просто продолжить (бинарь может работать и без переподписи).
 */
export function adhocSign(target: string): boolean {
  const r = run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', target])
  return r.ok
}

/** Подготовить уже лежащий на диске (writable) бинарник «на месте». */
export function fixMacBinaryInPlace(target: string, log?: (m: string) => void): void {
  if (process.platform !== 'darwin') return
  try {
    chmodSync(target, 0o755)
  } catch {
    /* best-effort */
  }
  stripQuarantine(target)
  if (!adhocSign(target)) {
    log?.(`codesign: не удалось переподписать ${target} (запускаем как есть)`)
  }
}

function fingerprint(src: string): string | null {
  try {
    const st = statSync(src)
    return `${st.size}:${Math.floor(st.mtimeMs)}`
  } catch {
    return null
  }
}

/**
 * Вернуть путь к подготовленной копии бинарника, пригодной для запуска.
 * Копия кэшируется: перекладывается только если исходник изменился
 * (size+mtime). Возвращает исходный путь, если подготовка невозможна.
 */
export function prepareMacBinary(
  src: string,
  name: string,
  log?: (m: string) => void
): string {
  if (process.platform !== 'darwin') return src

  const fp = fingerprint(src)
  if (!fp) return src

  const dir = path.join(runtimeDir(), PREPARED_DIR)
  const dst = path.join(dir, name)
  const marker = `${dst}.src`

  let needCopy = true
  try {
    if (existsSync(dst) && readFileSync(marker, 'utf8') === fp) needCopy = false
  } catch {
    needCopy = true
  }

  if (needCopy) {
    try {
      mkdirSync(dir, { recursive: true })
      copyFileSync(src, dst)
      chmodSync(dst, 0o755)
      writeFileSync(marker, fp, 'utf8')
      log?.(`prepared binary: ${dst}`)
    } catch (e) {
      log?.(`prepare failed (${e instanceof Error ? e.message : String(e)}) — using ${src}`)
      return src
    }
  }

  stripQuarantine(dst)
  if (!adhocSign(dst)) {
    log?.('codesign: не удалось переподписать копию TgWsProxy (запускаем как есть)')
  }
  return dst
}
