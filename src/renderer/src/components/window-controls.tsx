import { useEffect, useState } from 'react'
import { CopyIcon, MinusIcon, SquareIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function WindowControls() {
  const api = window.novaWindow
  const [maximized, setMaximized] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!api) return
    let active = true
    let updated = false
    const unsubscribe = api.onState((state) => { updated = true; setMaximized(state.maximized) })
    void api.getState().then((state) => {
      if (active && !updated) setMaximized(state.maximized)
    }).catch(() => { if (active) setError('无法读取窗口状态。') })
    return () => { active = false; unsubscribe() }
  }, [api])

  if (!api) return null
  const run = (action: () => Promise<void>) => {
    setError('')
    void action().catch(() => setError('无法操作窗口，请重试。'))
  }
  return (
    <div className="flex h-full items-center" role="group" aria-label="窗口控制">
      <Button variant="ghost" size="icon" className="h-full w-12 rounded-none" aria-label="最小化窗口" title="最小化" onClick={() => run(api.minimize)}>
        <MinusIcon />
      </Button>
      <Button variant="ghost" size="icon" className="h-full w-12 rounded-none" aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'} onClick={() => run(api.toggleMaximize)}>
        {maximized ? <CopyIcon /> : <SquareIcon />}
      </Button>
      <Button variant="ghost" size="icon" className="h-full w-12 rounded-none" aria-label="关闭窗口" title="关闭" onClick={() => run(api.close)}>
        <XIcon />
      </Button>
      <span className="sr-only" role="status">{error}</span>
    </div>
  )
}
