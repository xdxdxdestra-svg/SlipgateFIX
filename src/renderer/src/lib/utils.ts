import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { CSSProperties } from 'react'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export const POWER_ON_BANNER_STYLE: CSSProperties = {
  background:
    'radial-gradient(at 30% 45%, color-mix(in oklab, var(--gradient-start-power-on) 60%, transparent), color-mix(in oklab, var(--gradient-end-power-on) 60%, transparent))',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  borderColor: 'var(--stroke-power-on)',
  color: 'var(--foreground)'
}

export const POWER_OFF_BANNER_STYLE: CSSProperties = {
  background:
    'radial-gradient(at 30% 45%, color-mix(in oklab, var(--gradient-start-power-off) 60%, transparent), color-mix(in oklab, var(--gradient-end-power-off) 60%, transparent))',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  borderColor: 'var(--stroke-power-off)',
  color: 'var(--foreground)'
}

export const BUNDLED_TGWS_VERSION = '1.6.6'
// Версия встроенного Zapret отличается по платформам: на macOS поставляется
// нативный payload Flowseal/zapret-mac-discord-youtube (1.1.2), на Windows —
// winws-сборка (1.9.8c). Используем платформозависимое значение, чтобы
// карточка версии показывала корректную цифру.
import { platform } from '@renderer/utils/init'
export const BUNDLED_ZAPRET_VERSION = platform === 'darwin' ? '1.1.2' : '1.9.8c'
