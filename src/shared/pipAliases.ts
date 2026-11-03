/**
 * Import-name → distribution-name aliases (0.2.0).
 *
 * Custom nodes often declare the module they import (`cv2`, `PIL`,
 * `OpenGL_accelerate`) rather than the distribution that provides it. Without
 * this table the audit reports a package as missing forever even though the
 * environment is complete.
 */
const ALIASES: Record<string, string> = {
  cv2: 'opencv-python',
  pil: 'pillow',
  yaml: 'pyyaml',
  bs4: 'beautifulsoup4',
  sklearn: 'scikit-learn',
  skimage: 'scikit-image',
  opencv: 'opencv-python',
  'opengl-accelerate': 'pyopengl-accelerate',
  opengl_accelerate: 'pyopengl-accelerate',
  opengl: 'pyopengl',
  torch_npu: 'torch-npu',
  'torch-npu': 'torch-npu',
  onnxruntime_gpu: 'onnxruntime-gpu',
  tensorflow_gpu: 'tensorflow-gpu',
  // SAM 2 publishes the distribution as `SAM-2`, while Impact Pack's direct
  // Git requirement is named `sam2`.
  sam2: 'sam-2'
}

export function resolvePipAlias(name: string): string {
  const key = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-')
  return ALIASES[key] || ALIASES[key.replace(/_/g, '-')] || key
}

/** All accepted names for a requirement (canonical first, aliases after). */
export function pipAliasCandidates(name: string): string[] {
  const canonical = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-')
  const out = new Set<string>([canonical])
  for (const [from, to] of Object.entries(ALIASES)) {
    const normFrom = from.replace(/[-_.]+/g, '-')
    if (normFrom === canonical || to === canonical) out.add(to)
  }
  const alias = resolvePipAlias(canonical)
  if (alias) out.add(alias)
  return [...out]
}
