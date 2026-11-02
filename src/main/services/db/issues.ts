import { readJsonc, writeJsonc } from './jsonc'

// ---------- Issues (0.2.0 IssueCenter) ----------
export function listIssues(): import('@shared/types').AppIssue[] {
  return readJsonc<import('@shared/types').AppIssue[]>('issues', [])
}

export function replaceIssues(items: import('@shared/types').AppIssue[]): void {
  writeJsonc('issues', items, 'ComfyPilot issues (v2)')
}
