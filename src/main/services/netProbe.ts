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

/**
 * One probe attempt over session fetch (app proxy) with a Node fetch fallback.
 * The body is never consumed — any HTTP response proves the host is reachable.
 */
async function probeOnce(url: string, method: 'HEAD' | 'GET', timeoutMs: number): Promise<number> {
  const started = Date.now()
  try {
    const res = await session.defaultSession.fetch(url, {
      method,
      signal: AbortSignal.timeout(timeoutMs)
    })
    void res.status
    try {
      await res.body?.cancel()
    } catch {
      /* ignore */
    }
    return Date.now() - started
  } catch {
    // session fetch unavailable — fall back to Node fetch
  }
  void proxyEnv(loadSettings().proxy)
  const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) })
  void res.status
  try {
    await res.body?.cancel()
  } catch {
    /* ignore */
  }
  return Date.now() - started
}

async function probeOne(url: string, timeoutMs = 4000): Promise<number> {
  // HEAD first — the probe only needs latency, so never download a page body.
  // Hosts that reject HEAD fall back to GET, still without reading the body.
  try {
    return await probeOnce(url, 'HEAD', timeoutMs)
  } catch {
    return probeOnce(url, 'GET', timeoutMs)
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
