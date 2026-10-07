/**
 * Timing probe: build a full Registry catalog index the same way the app does.
 * Run: node scripts/diag-registry-index.cjs
 */
async function fetchPage(page, limit = 100) {
  const url = `https://api.comfy.org/nodes?limit=${limit}&page=${page}&sort_by=downloads`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ComfyPilot/0.1', Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function main() {
  const t0 = Date.now()
  const first = await fetchPage(1, 100)
  const pageSize = first.limit || 100
  const totalPages = first.totalPages || Math.ceil(first.total / pageSize)
  const collected = [...(first.nodes || [])]
  console.log(`page1 ok: ${collected.length} nodes, total=${first.total}, pages=${totalPages}`)

  const concurrency = 6
  let next = 2
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const pg = next++
      if (pg > totalPages) break
      try {
        const p = await fetchPage(pg, pageSize)
        collected.push(...(p.nodes || []))
      } catch (e) {
        console.log('page', pg, 'fail', e.message)
      }
      if (pg % 10 === 0) console.log(`progress page=${pg}/${totalPages} collected=${collected.length} ms=${Date.now() - t0}`)
    }
  })
  await Promise.all(workers)

  const hits = collected.filter((n) => {
    const text = [n.name, n.displayName, n.description, (n.publisher || {}).name, (n.tags || []).join(' ')]
      .join(' ')
      .toLowerCase()
    return text.includes('controlnet')
  })

  console.log('---')
  console.log('collected', collected.length, 'unique-ish', new Set(collected.map((n) => n.id || n.name)).size)
  console.log('controlnet hits', hits.length, hits.slice(0, 15).map((n) => n.name))
  console.log('total ms', Date.now() - t0)
  console.log('json bytes', JSON.stringify(collected.map((n) => ({ id: n.id, name: n.name, d: n.description }))).length)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
