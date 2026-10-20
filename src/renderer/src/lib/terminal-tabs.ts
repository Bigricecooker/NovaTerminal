import { MAX_SESSIONS, type SavedSshConnection } from '../../../shared/terminal-protocol.ts'

export type TerminalTarget = { kind: 'local'; cwd?: string } | ({ kind: 'ssh' } & SavedSshConnection)
type TerminalTab = { id: string; label: string; target: TerminalTarget }
export type TerminalTabs = { tabs: TerminalTab[]; activeId: string | null; nextId: number }
type TabAction = { type: 'open'; ssh?: SavedSshConnection; local?: { directory: string; name: string } }
  | { type: 'select' | 'close'; id: string }
  | { type: 'move'; id: string; targetId: string; position: 'before' | 'after' }

export const initialTerminalTabs: TerminalTabs = { tabs: [], activeId: null, nextId: 1 }

export function terminalTabsReducer(state: TerminalTabs, action: TabAction): TerminalTabs {
  switch (action.type) {
    case 'open': {
      if (state.tabs.length >= MAX_SESSIONS) return state
      const tab: TerminalTab = action.ssh
        ? { id: `ssh-${state.nextId}`, label: `${action.ssh.username}@${action.ssh.host}`, target: { kind: 'ssh', ...action.ssh } }
        : { id: `local-${state.nextId}`, label: action.local?.name ?? `本地终端 ${state.nextId}`, target: { kind: 'local', ...(action.local ? { cwd: action.local.directory } : {}) } }
      return { tabs: [...state.tabs, tab], activeId: tab.id, nextId: state.nextId + 1 }
    }
    case 'select':
      return state.tabs.some((tab) => tab.id === action.id) ? { ...state, activeId: action.id } : state
    case 'move': {
      const source = state.tabs.find((tab) => tab.id === action.id)
      if (!source || action.id === action.targetId || !state.tabs.some((tab) => tab.id === action.targetId)) return state
      const tabs = state.tabs.filter((tab) => tab.id !== action.id)
      const index = tabs.findIndex((tab) => tab.id === action.targetId) + Number(action.position === 'after')
      tabs.splice(index, 0, source)
      return tabs.every((tab, i) => tab === state.tabs[i]) ? state : { ...state, tabs }
    }
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
