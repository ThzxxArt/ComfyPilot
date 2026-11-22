// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { NSwitch } from 'naive-ui'
import AttentionAccelerationCard from '../../src/renderer/src/components/AttentionAccelerationCard.vue'
import { i18n } from '../../src/renderer/src/i18n'
import type { AttentionSelfTestResult, ComfyInstanceInfo, EnvProbe } from '../../src/shared/types'

const instance = {
  id: 'i1',
  name: 'Comfy',
  path: '/tmp/comfy',
  port: 8188,
  listen: '127.0.0.1',
  extraArgs: [],
  launchProfile: { attention: 'sage' as const },
  enabled: true,
  status: 'running'
} as unknown as ComfyInstanceInfo

function probe(over: Partial<EnvProbe> = {}): EnvProbe {
  return {
    pythonPath: 'C:/env/python.exe',
    pythonVersion: '3.13.18',
    torchVersion: '2.14.1+cu130',
    cudaVersion: '13.0',
    packages: [
      { name: 'sageattention', version: '1.0.6' },
      { name: 'xformers', version: '0.0.36' }
    ],
    ok: true,
    errors: [],
    ...over
  }
}

const selfTest: AttentionSelfTestResult = {
  ok: false,
  testedAt: 1,
  torchVersion: '2.14.1+cu130',
  gpuName: 'NVIDIA GeForce RTX 4070 Ti SUPER',
  computeCapability: '8.9',
  cudaAvailable: true,
  sageattention: { installed: true, version: '2.2.0', ok: true },
  xformers: { installed: true, version: '0.0.36', ok: false, error: 'kernel boom' },
  error: 'one package failed'
}

function mountCard(over: Record<string, unknown> = {}) {
  return mount(AttentionAccelerationCard, {
    props: {
      instance,
      probe: probe(),
      selfTest: null,
      platform: 'win32',
      ...over
    },
    global: { plugins: [i18n] }
  })
}

function button(wrapper: ReturnType<typeof mountCard>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(text))
}

describe('AttentionAccelerationCard (0.2.6)', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'zh-CN'
  })

  it('renders versions/status and emits install and self-test actions', async () => {
    const wrapper = mountCard()
    expect(wrapper.text()).toContain('SageAttention')
    expect(wrapper.text()).toContain('1.0.6')
    expect(wrapper.text()).toContain('版本过旧')
    expect(wrapper.text()).toContain('0.0.36')

    await button(wrapper, '升级/修复')!.trigger('click')
    expect(wrapper.emitted('install')?.[0]).toEqual(['sageattention'])

    await button(wrapper, '自检')!.trigger('click')
    expect(wrapper.emitted('self-test')).toHaveLength(1)
    wrapper.unmount()
  })

  it('emits launch-profile toggles for the active backend and xFormers', async () => {
    const wrapper = mountCard()
    const switches = wrapper.findAllComponents(NSwitch)
    expect(switches).toHaveLength(2)
    switches[0].vm.$emit('update:value', false)
    switches[1].vm.$emit('update:value', true)
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('toggle-sage')?.[0]).toEqual([false])
    expect(wrapper.emitted('toggle-xformers')?.[0]).toEqual([true])
    wrapper.unmount()
  })

  it('offers reinstall for current packages and renders a fully passing self-test', () => {
    const wrapper = mountCard({
      probe: probe({
        packages: [
          { name: 'sageattention', version: '2.2.0' },
          { name: 'xformers', version: '0.0.36' }
        ]
      })
    })
    expect(wrapper.text()).toContain('已安装')
    expect(wrapper.findAll('button').filter((b) => b.text().includes('重新安装'))).toHaveLength(2)
    wrapper.unmount()

    const passing = mountCard({
      probe: probe({ pythonVersion: '', torchVersion: '', packages: [] }),
      selfTest: {
        ...selfTest,
        ok: true,
        error: undefined,
        sageattention: { installed: true, version: '2.2.0', ok: true },
        xformers: { installed: true, version: '0.0.36', ok: true }
      }
    })
    expect(passing.text()).toContain('—')
    expect(
      passing.findAll('.n-tag').filter((t) => t.text().includes('通过')).length
    ).toBeGreaterThanOrEqual(2)
    passing.unmount()
  })

  it('shows a failing SageAttention kernel while xFormers passes', () => {
    const wrapper = mountCard({
      selfTest: {
        ...selfTest,
        sageattention: { installed: true, version: '2.2.0', ok: false, error: 'sage boom' },
        xformers: { installed: true, version: '0.0.36', ok: true }
      }
    })
    expect(wrapper.text()).toContain('sage boom')
    expect(wrapper.text()).toContain('通过')
    expect(wrapper.text()).toContain('失败')
    wrapper.unmount()
  })

  it('shows a generic failure when a package has no error text', () => {
    const wrapper = mountCard({
      selfTest: {
        ...selfTest,
        xformers: { installed: true, version: '0.0.36', ok: false }
      }
    })
    expect(wrapper.text()).toContain('失败')
    wrapper.unmount()
  })

  it('shows the probe hint and requests a probe before the first result', async () => {
    const wrapper = mountCard({ probe: null })
    expect(wrapper.text()).toContain('先点击「环境探测」')
    await button(wrapper, '重新探测')!.trigger('click')
    expect(wrapper.emitted('probe')).toHaveLength(1)
    wrapper.unmount()
  })

  it('renders per-package self-test failures without hiding the success side', () => {
    const wrapper = mountCard({ selfTest, probe: probe({ packages: [] }) })
    expect(wrapper.text()).toContain('RTX 4070 Ti SUPER')
    expect(wrapper.text()).toContain('sm89')
    expect(wrapper.text()).toContain('2.2.0')
    expect(wrapper.text()).toContain('通过')
    expect(wrapper.text()).toContain('失败')
    expect(wrapper.text()).toContain('kernel boom')
    expect(wrapper.text()).toContain('one package failed')
    wrapper.unmount()
  })

  it('does not offer automatic install when the platform/torch cannot support it', () => {
    const wrapper = mountCard({
      probe: probe({ torchVersion: '2.9.1+cu130', packages: [] }),
      platform: 'linux'
    })
    expect(wrapper.text()).toContain('当前环境不支持自动安装')
    expect(button(wrapper, '安装')).toBeUndefined()
    wrapper.unmount()
  })
})
