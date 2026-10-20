import { parseSshOptions } from '@shared/terminal-protocol'

export function sshOptionsFromForm(data: FormData) {
  const text = (name: string) => { const value = data.get(name); return typeof value === 'string' ? value : '' }
  const method = text('authMethod')
  return parseSshOptions({
    host: text('host').trim(), port: Number(text('port')), username: text('username').trim(),
    auth: method === 'password' ? { method, password: text('password') }
      : { method, privateKey: text('privateKey').trim(), passphrase: text('passphrase') },
  })
}
