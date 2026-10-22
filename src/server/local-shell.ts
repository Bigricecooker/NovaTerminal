import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { platformShells, type Platform, type Shell } from '../shared/settings.ts'

export function resolveLocalShell(choice: Shell, platform: Platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux', env: NodeJS.ProcessEnv = process.env) {
  if (!platformShells(platform).includes(choice)) throw new Error('当前平台不支持此 Shell，请在设置中选择其他 Shell。')
  const windows = platform === 'win32'
  let file: string
  let args: string[]
  if (windows) {
    const system = join(env.SystemRoot ?? 'C:\\Windows', 'System32')
    switch (choice) {
      case 'default': case 'powershell': file = join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'); args = ['-NoLogo', '-NoProfile']; break
      case 'pwsh': file = join(env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'); args = ['-NoLogo', '-NoProfile']; break
      case 'cmd': file = env.COMSPEC || join(system, 'cmd.exe'); args = []; break
      case 'wsl': file = join(system, 'wsl.exe'); args = []; break
      default: throw new Error('当前平台不支持此 Shell。')
    }
  } else { file = choice === 'default' ? env.SHELL || '/bin/sh' : `/bin/${choice}`; args = ['-l'] }
  if (!existsSync(file)) throw new Error(`${choice === 'default' ? '默认' : choice} Shell 不可用，请安装后重试或在设置中选择其他 Shell。`)
  return { file, args, label: windows && (choice === 'default' || choice === 'powershell') ? 'PowerShell' : basename(file) }
}
