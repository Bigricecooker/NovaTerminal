import { matchRegex, type RegexSearchRequest } from '@shared/regex-search'

self.onmessage = (event: MessageEvent<RegexSearchRequest>) => {
  self.postMessage(matchRegex(event.data))
}
