import { spawnSync } from 'child_process'

export type VpnStatus = 'active' | 'inactive' | 'unknown'

export interface VpnCheck {
  status: VpnStatus
  /** Best-effort explanation for logs only — never shown to the user. */
  detail?: string
}

// Интерфейс, который сам Zapret поднимает (utun50 из run.sh upstream). Его
// НЕ считаем VPN — иначе после успешного запуска Zapret детект ложно
// срабатывал бы при каждом повторном старте/перезапуске и блокировал бы
// работающий Zapret.
const ZAPRET_OWN_INTERFACE = 'utun50'

/** Запустить команду и вернуть склейку stdout+stderr, либо null при любой
 *  проблеме (нет файла, таймаут, убит сигналом, нет статуса). Никогда не
 *  бросает исключение — вызывающий сам решает, что считать «неизвестно». */
function probe(cmd: string, args: string[]): string | null {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 })
    if (!r || r.error) return null
    if (typeof r.status !== 'number') return null
    return `${(r.stdout ?? '').trim()}\n${(r.stderr ?? '').trim()}`
  } catch {
    return null
  }
}

/** Извлечь список активных интерфейсов из вывода `scutil --nwi`
 *  (строка вида «Active interfaces: en0, utun0, utun1»). */
function activeInterfacesFromNwi(out: string): string[] {
  const m = out.match(/Active interfaces?:\s*(.+)/i)
  if (!m) return []
  return m[1]
    .split(',')
    .map((s) => s.trim().split(/\s+/)[0])
    .filter(Boolean)
}

/** Интерфейс, характерный для VPN/туннеля, но НЕ наш собственный (utun50). */
function isVpnInterface(name: string): boolean {
  if (!name) return false
  if (name === ZAPRET_OWN_INTERFACE) return false
  return /^(?:utun|tun|ppp|ipsec|pppoe)\d+/i.test(name)
}

/**
 * Нативная (macOS) проверка активного VPN. НЕ привязываемся к конкретному
 * интерфейсу вроде utun3 — используем сразу несколько независимых сигналов:
 *  1) `scutil --nc list` — системные VPN-сервисы (IKEv2 / L2TP / PPTP /
 *     Cisco IPSec и сетевые расширения, включая официальный WireGuard).
 *     `(Connected)` = активный туннель. Не зависит от имени интерфейса.
 *  2) `scutil --nwi` — «Active interfaces». Ловит сторонние VPN
 *     (OpenVPN / Tunnelblick), которые поднимают utun/tun/ppp напрямую
 *     без записи в `scutil --nc`.
 *  3) `ifconfig -l` — фолбэк: любой поднятый utun/tun/ppp кроме нашего.
 *
 * Функция НИКОГДА не бросает исключение: nil-результат, ошибка spawn,
 * пустой вывод или неожиданный формат трактуются как `unknown`/`inactive`,
 * поэтому сама проверка VPN не может уронить приложение. Вне macOS
 * возвращает `inactive` (гейт запуска Zapret не применяется).
 */
export function isVpnActive(): VpnCheck {
  if (process.platform !== 'darwin') {
    return { status: 'inactive' }
  }
  try {
    // 1) Системные VPN-сервисы (самый надёжный нативный сигнал).
    const nc = probe('/usr/sbin/scutil', ['--nc', 'list'])
    if (nc && /\(\s*(?:connected|connecting)\s*\)/i.test(nc)) {
      return { status: 'active', detail: 'scutil --nc list: connected VPN service' }
    }

    // 2) Активные интерфейсы из scutil --nwi (сторонние VPN через utun/tun/ppp).
    const nwi = probe('/usr/sbin/scutil', ['--nwi'])
    const ifaces = nwi ? activeInterfacesFromNwi(nwi) : []
    for (const i of ifaces) {
      if (isVpnInterface(i)) {
        return { status: 'active', detail: `scutil --nwi active interface: ${i}` }
      }
    }

    // 3) Фолбэк: любой поднятый VPN-туннельный интерфейс.
    const ifl = probe('/sbin/ifconfig', ['-l'])
    if (ifl) {
      for (const n of ifl.split(/\s+/).filter(Boolean)) {
        if (isVpnInterface(n)) {
          return { status: 'active', detail: `ifconfig interface: ${n}` }
        }
      }
    }

    // Все пробы пусты — на macOS этого быть не должно, но перестрахуемся:
    // считаем «неизвестно», чтобы не блокировать запуск на ложном срабатывании.
    if (!nc && !nwi && !ifl) {
      return { status: 'unknown', detail: 'all native VPN probes returned no output' }
    }
    return { status: 'inactive' }
  } catch (e) {
    return {
      status: 'unknown',
      detail: `isVpnActive threw: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

/** Сообщение, которое показываем пользователю, когда запуск Zapret
 *  заблокирован из-за активного VPN. */
export const VPN_BLOCK_MESSAGE =
  'VPN включён. Запрет невозможно запустить при активном VPN.'
