/**
 * workflowService.queue against `remote:<id>` targets (0.1.11): the request
 * must go to the remote baseUrl and carry the configured apiKey.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ROOT = join(tmpdir(), `cp-wfq-remote-${process.pid}`)

vi.mock('electron', () => ({ app: { getPath: () => ROOT } }))

import { workflowService } from '../../src/main/services/workflow'

function seedRemote(apiKey?: string): void {
  mkdirSync(join(ROOT, 'data'), { recursive: true })
  writeFileSync(
    join(ROOT, 'data', 'remote_instances.jsonc'),
    JSON.stringify([
      {
        id: 'r1',
        name: 'Cloud',
        baseUrl: 'http://10.1.1.1:9000/',
        label: '',
        enabled: true,
        apiKey
      }
    ])
  )
}

function writeApiWorkflow(name: string): string {
  mkdirSync(join(ROOT, 'wf'), { recursive: true })
  const p = join(ROOT, 'wf', name)
  writeFileSync(p, JSON.stringify({ '1': { class_type: 'KSampler', inputs: { seed: 1 } } }))
  return p
}

function stubPrompt(): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ prompt_id: 'pid-r' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
  )
  return calls
}

describe('workflowService.queue remote targets (0.1.11)', () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
  })

  it('submits to a remote baseUrl and carries the apiKey on the request', async () => {
    seedRemote('k-1')
    const p = writeApiWorkflow('remote.json')
    const calls = stubPrompt()
    const pid = await workflowService.queue({ workflowPath: p, instanceId: 'remote:r1' })
    expect(pid).toBe('pid-r')
    const call = calls.find((c) => c.url.includes('/prompt'))!
    expect(call.url.startsWith('http://10.1.1.1:9000/')).toBe(true)
    expect((call.init?.headers as Record<string, string>).Authorization).toBe('Bearer k-1')
    // Queue-time sidecar persists for later output attribution.
    const links = JSON.parse(
      readFileSync(join(ROOT, 'data', 'prompt_links.jsonc'), 'utf-8')
    ) as Record<string, unknown>
    expect(links['pid-r']).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('omits the Authorization header for a keyless remote', async () => {
    seedRemote(undefined)
    const p = writeApiWorkflow('remote2.json')
    const calls = stubPrompt()
    const pid = await workflowService.queue({ workflowPath: p, instanceId: 'remote:r1' })
    expect(pid).toBe('pid-r')
    const call = calls.find((c) => c.url.includes('/prompt'))!
    expect(
      (call.init?.headers as Record<string, string> | undefined)?.Authorization
    ).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('throws when the remote id does not resolve and no local instance exists', async () => {
    seedRemote(undefined)
    const p = writeApiWorkflow('remote3.json')
    await expect(
      workflowService.queue({ workflowPath: p, instanceId: 'remote:zzz' })
    ).rejects.toThrow(/No instance configured/)
  })
})
