/**
 * Network speed / latency probe for mirror auto-recommendation.
 * Times HEAD/GET against candidate hosts and ranks them so the installer
 * can pre-select the fastest PyPI / Torch / GitHub mirror for the user.
 */
import { session } from 'electron'
import { proxyEnv } from './proxy'
import { loadSettings } from './db'

export interface ProbeResult {
  id: string
  /** Stable i18n key fragment (e.g. pipOfficial) — renderer translates. */
  label: string
  url: string
  ok: boolean
  latencyMs: number
  error?: string
}

export interface MirrorRecommendation {
  pipIndex: string
  pipLabel: string
  torchIndexMirror: string
  torchLabel: string
  githubEndpoint: string
  githubLabel: string
  probes: ProbeResult[]
}

const PIP_CANDIDATES: Array<{ id: string; label: string; value: string; probe: string }> = [
  {
    id: 'pypi-official',
    label: 'pipOfficial',
    value: '',
    probe: 'https://pypi.org/simple/pip/'
  },
  {
    id: 'tuna',
    label: 'pipTsinghua',
    value: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    probe: 'https://pypi.tuna.tsinghua.edu.cn/simple/pip/'
  },
  {
    id: 'aliyun',
    label: 'mirrorAliyun',
    value: 'https://mirrors.aliyun.com/pypi/simple/',
    probe: 'https://mirrors.aliyun.com/pypi/simple/pip/'
  },
  {
    id: 'ustc',
    label: 'pipUstc',
    value: 'https://pypi.mirrors.ustc.edu.cn/simple/',
    probe: 'https://pypi.mirrors.ustc.edu.cn/simple/pip/'
  }
]

const TORCH_CANDIDATES: Array<{ id: string; label: string; value: string; probe: string }> = [
  {
    id: 'torch-official',
    label: 'torchOfficial',
    value: '',
    probe: 'https://download.pytorch.org/whl/cpu/'
  },
  {
    id: 'sjtu',
    label: 'torchSjtu',
    value: 'https://mirror.sjtu.edu.cn/pytorch-wheels',
    probe: 'https://mirror.sjtu.edu.cn/pytorch-wheels/'
  },
  {
    id: 'aliyun',
    label: 'mirrorAliyun',
    value: 'https://mirrors.aliyun.com/pytorch-wheels/',
    probe: 'https://mirrors.aliyun.com/pytorch-wheels/'
  }
]

const GITHUB_CANDIDATES: Array<{ id: string; label: string; value: string; probe: string }> = [
  {
    id: 'github-official',
    label: 'githubOfficial',
    value: '',
    probe: 'https://github.com/comfyanonymous/ComfyUI'
  },
  {
    id: 'ghproxy',
    label: 'githubGhproxy',
    value: 'https://mirror.ghproxy.com',
    probe: 'https://mirror.ghproxy.com/https://github.com/comfyanonymous/ComfyUI'
  }
]

async function probeOne(url: string, timeoutMs = 4000): Promise<number> {
  const started = Date.now()
  // Prefer session fetch so the app proxy is honored; fall back to Node fetch.
  try {
    const res = await session.defaultSession.fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs)
    })
    // Any HTTP response means the host is reachable.
    void res.status
    return Date.now() - started
  } catch {
    // ignore — try node fetch below
  }
  try {
    void proxyEnv(loadSettings().proxy)
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
    void res.status
    return Date.now() - started
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err))
  }
}

async function probeList(
  candidates: Array<{ id: string; label: string; value: string; probe: string }>
): Promise<ProbeResult[]> {
  return Promise.all(
    candidates.map(async (c) => {
      try {
        const latencyMs = await probeOne(c.probe)
        return { id: c.id, label: c.label, url: c.value, ok: true, latencyMs }
      } catch (err) {
        return {
          id: c.id,
          label: c.label,
          url: c.value,
          ok: false,
          latencyMs: Number.POSITIVE_INFINITY,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    })
  )
}

function bestOf(probes: ProbeResult[]): ProbeResult | undefined {
  const ok = probes.filter((p) => p.ok).sort((a, b) => a.latencyMs - b.latencyMs)
  return ok[0]
}

/**
 * Probe all mirror families concurrently and return the fastest healthy set.
 * Does not mutate settings — the UI decides whether to apply.
 */
export async function recommendMirrors(): Promise<MirrorRecommendation> {
  const [pip, torch, github] = await Promise.all([
    probeList(PIP_CANDIDATES),
    probeList(TORCH_CANDIDATES),
    probeList(GITHUB_CANDIDATES)
  ])
  const pipBest = bestOf(pip)
  const torchBest = bestOf(torch)
  const githubBest = bestOf(github)
  return {
    pipIndex: pipBest?.url ?? '',
    pipLabel: pipBest?.label ?? 'pipOfficial',
    torchIndexMirror: torchBest?.url ?? '',
    torchLabel: torchBest?.label ?? 'torchOfficial',
    githubEndpoint: githubBest?.url ?? '',
    githubLabel: githubBest?.label ?? 'githubOfficial',
    probes: [...pip, ...torch, ...github]
  }
}
