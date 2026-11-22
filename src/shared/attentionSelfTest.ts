/**
 * Fixed Python self-test for the optional attention accelerators (0.2.6).
 *
 * The renderer never supplies code or arguments to this script: it is a
 * constant, and the main process only chooses the instance's interpreter. The
 * test goes beyond `import sageattention`: it verifies the package version and
 * runs a tiny CUDA attention kernel, so a wheel that imports but crashes on
 * this GPU is reported as failed instead of silently enabled.
 */
import type { AttentionSelfTestPackage, AttentionSelfTestResult } from './types'

export const ATTENTION_SELF_TEST_SCRIPT = `
import json, sys

def package_info(name):
    try:
        import importlib, importlib.metadata
        importlib.import_module(name)
        try:
            version = importlib.metadata.version(name)
        except Exception:
            version = ""
        return {"installed": True, "version": version, "ok": True, "error": ""}
    except Exception as e:
        return {
            "installed": False,
            "version": "",
            "ok": False,
            "error": type(e).__name__ + ": " + str(e),
        }

out = {
    "ok": True,
    "pythonVersion": sys.version.split()[0],
    "cudaAvailable": False,
    "sageattention": package_info("sageattention"),
    "xformers": package_info("xformers"),
}

try:
    import torch
    out["torchVersion"] = str(torch.__version__)
    out["cudaVersion"] = str(torch.version.cuda or "")
    out["cudaAvailable"] = bool(torch.cuda.is_available())
    if out["cudaAvailable"]:
        out["gpuName"] = torch.cuda.get_device_name(0)
        major, minor = torch.cuda.get_device_capability(0)
        out["computeCapability"] = str(major) + "." + str(minor)
except Exception as e:
    out["ok"] = False
    out["error"] = "torch: " + type(e).__name__ + ": " + str(e)

if out.get("cudaAvailable"):
    try:
        q = torch.randn(1, 64, 4, 64, device="cuda", dtype=torch.float16)
        k = torch.randn_like(q)
        v = torch.randn_like(q)
        if out["sageattention"]["installed"]:
            try:
                from sageattention import sageattn
                o = sageattn(q, k, v, tensor_layout="NHD", is_causal=False)
                torch.cuda.synchronize()
                out["sageattention"]["ok"] = bool(torch.isfinite(o).all())
                if not out["sageattention"]["ok"]:
                    out["sageattention"]["error"] = "non-finite output"
            except Exception as e:
                out["sageattention"]["ok"] = False
                out["sageattention"]["error"] = "kernel: " + type(e).__name__ + ": " + str(e)
        if out["xformers"]["installed"]:
            try:
                from xformers.ops import memory_efficient_attention
                o = memory_efficient_attention(q, k, v)
                torch.cuda.synchronize()
                out["xformers"]["ok"] = bool(torch.isfinite(o).all())
                if not out["xformers"]["ok"]:
                    out["xformers"]["error"] = "non-finite output"
            except Exception as e:
                out["xformers"]["ok"] = False
                out["xformers"]["error"] = "kernel: " + type(e).__name__ + ": " + str(e)
    except Exception as e:
        out["ok"] = False
        out["error"] = "kernel setup: " + type(e).__name__ + ": " + str(e)
else:
    for key in ("sageattention", "xformers"):
        if out[key]["installed"]:
            out[key]["ok"] = False
            out[key]["error"] = "CUDA unavailable; kernel not tested"

if not out["sageattention"]["ok"] and out["sageattention"]["installed"]:
    out["ok"] = False
if not out["xformers"]["ok"] and out["xformers"]["installed"]:
    out["ok"] = False

print(json.dumps(out))
`

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function packageResult(value: unknown): AttentionSelfTestPackage {
  const raw = asRecord(value)
  return {
    installed: Boolean(raw.installed),
    version: text(raw.version),
    ok: Boolean(raw.ok),
    error: text(raw.error)
  }
}

export function emptyAttentionSelfTest(
  error: string,
  testedAt = Date.now()
): AttentionSelfTestResult {
  return {
    ok: false,
    testedAt,
    cudaAvailable: false,
    sageattention: { installed: false, ok: false, error },
    xformers: { installed: false, ok: false, error },
    error
  }
}

/** Parse the last JSON line printed by the self-test script. */
export function parseAttentionSelfTest(
  stdout: string,
  testedAt = Date.now(),
  fallbackError?: string
): AttentionSelfTestResult {
  const line = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
  let parsed: unknown
  try {
    parsed = line ? JSON.parse(line) : null
  } catch {
    return emptyAttentionSelfTest(fallbackError || 'Invalid self-test JSON', testedAt)
  }
  if (!parsed || typeof parsed !== 'object') {
    return emptyAttentionSelfTest(fallbackError || 'Empty self-test output', testedAt)
  }
  const raw = asRecord(parsed)
  return {
    ok: Boolean(raw.ok),
    testedAt,
    pythonVersion: text(raw.pythonVersion),
    torchVersion: text(raw.torchVersion),
    cudaVersion: text(raw.cudaVersion),
    gpuName: text(raw.gpuName),
    computeCapability: text(raw.computeCapability),
    cudaAvailable: Boolean(raw.cudaAvailable),
    sageattention: packageResult(raw.sageattention),
    xformers: packageResult(raw.xformers),
    error: text(raw.error) || fallbackError
  }
}
