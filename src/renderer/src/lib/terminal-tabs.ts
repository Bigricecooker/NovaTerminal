import { MAX_SESSIONS, type SshOptions } from '../../../shared/terminal-protocol.ts'

export type TerminalTarget = { kind: 'local' } | ({ kind: 'ssh' } & Pick<SshOptions, 'host' | 'port' | 'username'>)
type TerminalTab = { id: string; label: string; target: TerminalTarget }
export type TerminalTabs = { tabs: TerminalTab[]; activeId: string | null; nextId: number }
type TabAction = { type: 'open'; ssh?: Pick<SshOptions, 'host' | 'port' | 'username'> } | { type: 'select' | 'close'; id: string }

export const initialTerminalTabs: TerminalTabs = { tabs: [], activeId: null, nextId: 1 }

export function terminalTabsReducer(state: TerminalTabs, action: TabAction): TerminalTabs {
  switch (action.type) {
    case 'open': {
      if (state.tabs.length >= MAX_SESSIONS) return state
      const tab: TerminalTab = action.ssh
        ? { id: `ssh-${state.nextId}`, label: `${action.ssh.username}@${action.ssh.host}`, target: { kind: 'ssh', ...action.ssh } }
        : { id: `local-${state.nextId}`, label: `本地终端 ${state.nextId}`, target: { kind: 'local' } }
      return { tabs: [...state.tabs, tab], activeId: tab.id, nextId: state.nextId + 1 }
    }
    case 'select':
      return state.tabs.some((tab) => tab.id === action.id) ? { ...state, activeId: action.id } : state
    case 'close': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id)
      if (index === -1) return state
      const tabs = state.tabs.filter((tab) => tab.id !== action.id)
      return {
        ...state, tabs,
        activeId: state.activeId === action.id
          ? (tabs[index] ?? tabs[index - 1])?.id ?? null
          : state.activeId,
      }
    }
  }
}
