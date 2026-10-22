export const SHELLS = ['default', 'powershell', 'pwsh', 'cmd', 'wsl', 'bash', 'zsh', 'sh'] as const
export type Shell = typeof SHELLS[number]
export type Platform = 'win32' | 'darwin' | 'linux'
export const FONT_STACKS = {
  default: 'Cascadia Mono, Consolas, Menlo, monospace',
  system: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
} as const
export type Settings = {
  theme: 'light' | 'dark' | 'system'; fontFamily: keyof typeof FONT_STACKS
  fontSize: number; lineHeight: number; scrollback: number
  cursorStyle: 'block' | 'underline' | 'bar'; cursorBlink: boolean
  copyOnSelect: boolean; confirmMultiline: boolean; confirmClose: boolean
  shell: Shell; directory: string; maxSessions: number; confirmExit: boolean
}
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  theme: 'system', fontFamily: 'default', fontSize: 14, lineHeight: 1.25, scrollback: 5_000,
  cursorStyle: 'block', cursorBlink: true, copyOnSelect: false, confirmMultiline: false,
  confirmClose: true, shell: 'default', directory: '', maxSessions: 4, confirmExit: true,
})
export type SettingsSnapshot = { values: Settings; dark: boolean; platform: Platform; warning: string }
export function platformShells(platform: Platform): readonly Shell[] {
  return platform === 'win32' ? ['default', 'powershell', 'pwsh', 'cmd', 'wsl'] : ['default', 'bash', 'zsh', 'sh']
}
export function isShell(value: unknown): value is Shell { return SHELLS.some((shell) => shell === value) }
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function option<T extends string>(value: unknown, options: readonly T[], label: string): T {
  const found = options.find((item) => item === value)
  if (found === undefined) throw new Error(`${label}无效。`)
  return found
}
function number(value: unknown, min: number, max: number, step: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
    || Math.abs((value - min) / step - Math.round((value - min) / step)) > 0.000001) throw new Error(`${label}无效。`)
  return value
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}无效。`)
  return value
}
export function parseSettings(raw: unknown, platform: Platform): Settings {
  if (!record(raw)) throw new Error('设置格式无效。')
  const value = { ...DEFAULT_SETTINGS, ...raw }
  if (typeof value.directory !== 'string' || value.directory.length > 4096
    || Array.from(value.directory).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || value.directory !== '' && !(platform === 'win32' ? /^(?:[a-z]:[\\/]|\\\\)/i : /^\//).test(value.directory)) throw new Error('默认起始目录无效。')
  return {
    theme: option(value.theme, ['light', 'dark', 'system'], '主题'),
    fontFamily: option(value.fontFamily, ['default', 'system'], '字体'),
    fontSize: number(value.fontSize, 10, 24, 1, '字号'),
    lineHeight: number(value.lineHeight, 1, 2, .05, '行高'),
    scrollback: number(value.scrollback, 1000, 50_000, 1000, '回滚行数'),
    cursorStyle: option(value.cursorStyle, ['block', 'underline', 'bar'], '光标样式'),
    cursorBlink: boolean(value.cursorBlink, '光标闪烁'),
    copyOnSelect: boolean(value.copyOnSelect, '选中即复制'),
    confirmMultiline: boolean(value.confirmMultiline, '多行粘贴确认'),
    confirmClose: boolean(value.confirmClose, '关闭标签确认'),
    shell: option(value.shell, platformShells(platform), 'Shell'), directory: value.directory,
    maxSessions: number(value.maxSessions, 1, 8, 1, '最大会话数'), confirmExit: boolean(value.confirmExit, '退出确认'),
  }
}
