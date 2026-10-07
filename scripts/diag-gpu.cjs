// Verify sampleWindowsGpuMemory + mergeGpuMemory against the live machine.
const { spawnSync } = require('child_process')
const path = require('path')

// Use vitest to execute the TS module
const res = spawnSync(
  'cmd',
  [
    '/c',
    'npx',
    'vitest',
    'run',
    'tests/unit/gpuMemory.test.ts',
    '--reporter=verbose'
  ],
  { cwd: path.join(__dirname, '..'), encoding: 'utf8' }
)
console.log(res.stdout)
console.log(res.stderr)

// Also probe the live PowerShell counters through the same script shape
const script = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$u=Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue",
  "$l=Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Limit' -ErrorAction SilentlyContinue",
  "$map=@{}",
  "foreach($s in @($u.CounterSamples)){ $k=$s.InstanceName; if(-not $map[$k]){$map[$k]=@{used=0;total=0}}; $map[$k].used=[long]$s.CookedValue }",
  "foreach($s in @($l.CounterSamples)){ $k=$s.InstanceName; if(-not $map[$k]){$map[$k]=@{used=0;total=0}}; $map[$k].total=[long]$s.CookedValue }",
  "$map.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Output ($_.Name + ',' + $_.Value.used + ',' + $_.Value.total) }"
].join('; ')

const ps = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', script],
  { encoding: 'utf8', timeout: 8000 }
)
console.log('--- live GPU adapter counters ---')
console.log(ps.stdout)
if (ps.stderr) console.log('stderr:', ps.stderr)
