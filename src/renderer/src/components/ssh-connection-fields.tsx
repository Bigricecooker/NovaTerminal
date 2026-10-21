import { useId, useState } from 'react'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import type { SshEndpoint } from '@shared/terminal-protocol'

export function SshConnectionFields({ endpoint, required = true, allowKeepAuth = false }: { endpoint?: SshEndpoint; required?: boolean; allowKeepAuth?: boolean }) {
  const id = useId()
  const [method, setMethod] = useState(allowKeepAuth ? 'keep' : 'password')
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-host`}>主机</FieldLabel>
        <Input id={`${id}-host`} name="host" required={required} maxLength={253} defaultValue={endpoint?.host ?? ''} placeholder="域名或 IP 地址" autoCapitalize="none" spellCheck={false} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-port`}>端口</FieldLabel>
        <Input id={`${id}-port`} name="port" type="number" required={required} min={1} max={65535} defaultValue={endpoint?.port ?? 22} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-username`}>用户名</FieldLabel>
        <Input id={`${id}-username`} name="username" required={required} maxLength={128} defaultValue={endpoint?.username ?? ''} autoCapitalize="none" spellCheck={false} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-method`}>认证方式</FieldLabel>
        <NativeSelect id={`${id}-method`} name="authMethod" value={method} onChange={(event) => { setMethod(event.target.value) }}>
          {allowKeepAuth && <NativeSelectOption value="keep">保留现有认证</NativeSelectOption>}
          <NativeSelectOption value="password">密码</NativeSelectOption>
          <NativeSelectOption value="privateKey">私钥</NativeSelectOption>
        </NativeSelect>
        {allowKeepAuth && <FieldDescription>修改主机、端口或用户名时，请选择密码或私钥并重新填写认证信息。已保存的秘密不会回填。</FieldDescription>}
      </Field>
      {method === 'password' ? (
        <Field>
          <FieldLabel htmlFor={`${id}-password`}>密码</FieldLabel>
          <Input id={`${id}-password`} name="password" type="password" required={required} maxLength={4096} autoComplete="off" />
        </Field>
      ) : method === 'privateKey' ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-privateKey`}>私钥内容</FieldLabel>
            <Textarea id={`${id}-privateKey`} name="privateKey" required={required} maxLength={65536} rows={5} spellCheck={false} autoCapitalize="none" />
            <FieldDescription>粘贴完整私钥内容，包括 BEGIN / END 行；不填写本机文件路径。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-passphrase`}>私钥口令（可选）</FieldLabel>
            <Input id={`${id}-passphrase`} name="passphrase" type="password" maxLength={4096} autoComplete="off" />
          </Field>
        </>
      ) : null}
    </>
  )
}
