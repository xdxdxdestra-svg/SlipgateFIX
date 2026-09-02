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

/** «Сильный» VPN/туннельный интерфейс: ppp / ipsec / tap / pppoe.
 *  На macOS это практически всегда VPN либо туннель, конфликтующий с Zapret
 *  (L2TP → ppp0, IKEv2/IPsec → ipsecN, Tap-мост OpenVPN → tapN, PPPoE → ppp0).
 *  Любой поднятый такой интерфейс считаем VPN. НЕ включаем сюда utun/tun,
 *  потому что macOS САМА создаёт utun0/utun1 для системных сервисов
 *  (mDNSResponder, Content Caching, Xcode Simulator, iCloud Private Relay …) —
 *  это и давало ложные срабатывания «VPN включён». */
function isVpnTunnelInterface(name: string): boolean {
  if (!name) return false
  if (name === ZAPRET_OWN_INTERFACE) return false
  return /^(?:ppp|ipsec|tap|pppoe)\d+/i.test(name)
}

/** «Слабый» виртуальный интерфейс: utun / tun. Сам по себе НЕ признак VPN
 *  (система тоже их поднимает), поэтому используется только в связке с
 *  проверкой основного маршрута (см. defaultRouteInterface). */
function isVpnVirtualInterface(name: string): boolean {
  if (!name) return false
  if (name === ZAPRET_OWN_INTERFACE) return false
  return /^(?:utun|tun)\d+/i.test(name)
}

/** Интерфейс, несущий основной маршрут (default route).
 *  `route -n get default` → строка «    interface: utun2». null при любой
 *  ошибке/таймауте — тогда слабый сигнал просто игнорируется. */
function defaultRouteInterface(): string | null {
  const out = probe('/usr/sbin/route', ['-n', 'get', 'default'])
  if (!out) return null
  const m = out.match(/interface:\s*(\S+)/i)
  return m ? m[1] : null
}

/**
 * Нативная (macOS) проверка активного VPN. НЕ привязываемся к конкретному
 * интерфейсу вроде utun3 — используем несколько независимых сигналов,
 * отранжированных по надёжности, чтобы НЕ было ложных срабатываний на
 * системных интерфейсах macOS:
 *  1) `scutil --nc list` — системные VPN-сервисы (IKEv2 / L2TP / PPTP /
 *     Cisco IPSec и сетевые расширения, включая официальный WireGuard).
 *     `(Connected)` = активный туннель. Не зависит от имени интерфейса.
 *     САМЫЙ надёжный сигнал.
 *  2) «Сильные» туннельные интерфейсы ppp/ipsec/tap/pppoe — любой поднятый
 *     (через `scutil --nwi` Active interfaces и фолбэк `ifconfig -l`)
 *     считаем VPN.
 *  3) «Слабый» сигнал для сторонних VPN (OpenVPN / Tunnelblick / WireGuard),
 *     которые поднимают utun/tun напрямую БЕЗ записи в `scutil --nc`:
 *     считаем VPN ТОЛЬКО если такой интерфейс несёт основной маршрут
 *     (full-tunnel VPN). Системные utun0/utun1 НЕ являются маршрутом по
 *     умолчанию, поэтому ложных срабатываний нет. Split-tunnel VPN (который
 *     не забирает default route) этим методом не ловится — это безопасный
 *     режим «пропустили», бан запустится (лучше, чем ложная блокировка).
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

    // 2) «Сильные» туннельные интерфейсы (ppp/ipsec/tap/pppoe).
    const nwi = probe('/usr/sbin/scutil', ['--nwi'])
    const ifaces = nwi ? activeInterfacesFromNwi(nwi) : []
    for (const i of ifaces) {
      if (isVpnTunnelInterface(i)) {
        return { status: 'active', detail: `scutil --nwi active interface: ${i}` }
      }
    }
    const ifl = probe('/sbin/ifconfig', ['-l'])
    if (ifl) {
      for (const n of ifl.split(/\s+/).filter(Boolean)) {
        if (isVpnTunnelInterface(n)) {
          return { status: 'active', detail: `ifconfig interface: ${n}` }
        }
      }
    }

    // 3) «Слабый» сигнал: utun/tun считаем VPN ТОЛЬКО если несёт default route
    //    (full-tunnel VPN). Системные utun0/utun1 не являются маршрутом по
    //    умолчанию → ложных срабатываний нет.
    const def = defaultRouteInterface()
    if (def && isVpnVirtualInterface(def)) {
      return { status: 'active', detail: `default route via ${def}` }
    }

    // Все пробы пусты — на macOS этого быть не должно, но перестрахуемся:
    // считаем «неизвестно», чтобы не блокировать запуск на ложном срабатывании.
    if (!nc && !nwi && !ifl && !def) {
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
