#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type --
   файл исполняется node напрямую (.mjs), TS-аннотации в нём недопустимы */
// Готовит resources/macos/** — то, что electron-builder кладёт в Slipgate.app:
//
//   resources/macos/zapret/**   — payload ZapretMac (bin/utunws, strategies/,
//                                 default-lists/, *.sh), распакованный ПЛОСКО
//                                 (без ZapretMac.app/Contents/Resources/Payload)
//   resources/macos/tgws/TgWsProxy — CLI-бинарник (строится отдельно, см.
//                                 scripts/build-tgws/build-mac.sh)
//
// Использование:
//   node scripts/build-mac-resources.mjs            # последний релиз
//   node scripts/build-mac-resources.mjs --tag 1.1.2
import { chmodSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'Flowseal/zapret-mac-discord-youtube'
const EXECUTABLES = [
  'bin/utunws',
  'install.sh',
  'run.sh',
  'stop.sh',
  'restart.sh',
  'watchdog.sh',
  'test-strategies.sh',
  'update-app.sh'
]

const tagArg = process.argv.indexOf('--tag')
const tag = tagArg !== -1 ? process.argv[tagArg + 1] : undefined

async function main() {
  const api = tag
    ? `https://api.github.com/repos/${REPO}/releases/tags/${tag}`
    : `https://api.github.com/repos/${REPO}/releases/latest`
  const res = await fetch(api, {
    headers: { 'User-Agent': 'Slipgate-Build', Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  const release = await res.json()
  const asset = (release.assets ?? []).find((a) => /\.zip$/i.test(a.name))
  if (!asset) throw new Error('В релизе нет .zip ассета')

  console.log(`[zapret] ${release.tag_name} → ${asset.name}`)
  const bin = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer())
  const zip = new AdmZip(bin)

  const norm = (n) => n.replace(/\\/g, '/')
  const marker = zip
    .getEntries()
    .find((e) => !e.isDirectory && /(^|\/)bin\/utunws$/i.test(norm(e.entryName)))
  if (!marker) throw new Error('Архив не содержит bin/utunws')
  // Отрезаем ВСЁ до каталога payload включительно → плоская раскладка,
  // которую ожидают zapretBundleDir()/installZapretBundle().
  const markerPath = norm(marker.entryName)
  const prefix = markerPath.slice(0, markerPath.lastIndexOf('bin/utunws'))

  const dest = join(ROOT, 'resources', 'macos', 'zapret')
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })

  let n = 0
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue
    const name = norm(e.entryName)
    if (prefix && !name.startsWith(prefix)) continue
    const rel = name.slice(prefix.length)
    if (!rel || rel.includes('..')) continue
    const out = join(dest, rel)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, e.getData())
    n++
  }
  for (const rel of EXECUTABLES) {
    const p = join(dest, rel)
    if (existsSync(p)) chmodSync(p, 0o755)
  }
  console.log(`[zapret] готово: ${n} файлов → resources/macos/zapret`)

  const tgws = join(ROOT, 'resources', 'macos', 'tgws', 'TgWsProxy')
  if (!existsSync(tgws)) {
    console.warn(
      '\n[tgws] resources/macos/tgws/TgWsProxy отсутствует.\n' +
        '       Upstream не публикует CLI-бинарник для macOS (только .dmg с .app).\n' +
        '       Соберите его из исходников: sh scripts/build-tgws/build-mac.sh\n' +
        '       Бинарник обязан быть ad-hoc подписан БЕЗ hardened runtime\n' +
        '       (иначе PyInstaller не сможет загрузить встроенный Python.framework).'
    )
  } else {
    console.log('[tgws] бинарник на месте')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
