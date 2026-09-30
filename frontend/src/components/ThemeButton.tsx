import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from '../lib/theme'

const LABELS = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' }

export function ThemeButton() {
  const { theme, cycle } = useTheme()
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor
  return (
    <button
      type="button"
      className="icon-button theme-button"
      onClick={cycle}
      aria-label={`${LABELS[theme]} (click to change)`}
      title={`${LABELS[theme]} · click to change`}
    >
      <Icon size={15} />
    </button>
  )
}
