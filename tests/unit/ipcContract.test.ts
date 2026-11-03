import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import * as ts from 'typescript'
import { validateIpcArgs } from '../../src/main/ipc/contract'

const root = join(__dirname, '..', '..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf-8')
}

type ArgCat = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'union'

function typeArgCat(node: ts.TypeNode | undefined): ArgCat {
  if (!node) return 'object'
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return 'string'
    case ts.SyntaxKind.NumberKeyword:
      return 'number'
    case ts.SyntaxKind.BooleanKeyword:
      return 'boolean'
    case ts.SyntaxKind.TypeLiteral:
      return 'object'
    case ts.SyntaxKind.ArrayType:
      return 'array'
    case ts.SyntaxKind.UnionType:
      return 'union'
    case ts.SyntaxKind.OptionalType:
    case ts.SyntaxKind.ParenthesizedType:
      return typeArgCat((node as ts.OptionalTypeNode | ts.ParenthesizedTypeNode).type)
    case ts.SyntaxKind.TypeReference: {
      // RuntimeKind is the only string-valued alias used in an IPC tuple.
      return (node as ts.TypeReferenceNode).typeName.getText() === 'RuntimeKind'
        ? 'string'
        : 'object'
    }
    default:
      return 'object'
  }
}

function schemaArgCat(node: ts.Expression | undefined): ArgCat {
  if (!node) return 'object'
  if (ts.isIdentifier(node)) {
    if (node.text === 's') return 'string'
    if (node.text === 'n') return 'number'
    if (node.text === 'b') return 'boolean'
    if (node.text === 'strArray') return 'array'
    return 'object'
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'optional') {
    return schemaArgCat(node.expression)
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText()
    if (callee.endsWith('.optional') || callee.endsWith('.default')) {
      const inner = node.arguments[0]
      return inner
        ? schemaArgCat(inner)
        : ts.isPropertyAccessExpression(node.expression)
          ? schemaArgCat(node.expression.expression)
          : 'object'
    }
    if (callee.endsWith('.enum')) return 'union'
    if (callee.startsWith('z.array')) return 'array'
    return 'object'
  }
  return 'object'
}

/** Parse the runtime contract's explicit `set(channel, z.tuple([...]))` rows. */
function contractArgCats(): Map<string, ArgCat[]> {
  const sf = ts.createSourceFile(
    join(root, 'src/main/ipc/contract.ts'),
    read('src/main/ipc/contract.ts'),
    ts.ScriptTarget.Latest,
    true
  )
  const out = new Map<string, ArgCat[]>()
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.getText() === 'set') {
      const [ch, schema] = n.arguments
      if (ch && ts.isStringLiteral(ch) && schema && ts.isCallExpression(schema)) {
        const tuple = schema.arguments[0]
        if (tuple && ts.isArrayLiteralExpression(tuple)) {
          out.set(
            ch.text,
            tuple.elements.map((el) => schemaArgCat(el))
          )
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** Parse `IpcChannelMap` and reduce every `args` tuple element to a broad shape. */
function typedArgCats(): Map<string, ArgCat[]> {
  const sf = ts.createSourceFile(
    join(root, 'src/shared/types/ipc.ts'),
    read('src/shared/types/ipc.ts'),
    ts.ScriptTarget.Latest,
    true
  )
  const out = new Map<string, ArgCat[]>()
  const visit = (n: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === 'IpcChannelMap') {
      if (!ts.isTypeLiteralNode(n.type)) return
      for (const member of n.type.members) {
        if (!ts.isPropertySignature(member) || !member.name || !member.type) continue
        if (!ts.isTypeLiteralNode(member.type)) continue
        const channel = member.name.getText().replace(/^['"]|['"]$/g, '')
        const args = member.type.members.find(
          (p): p is ts.PropertySignature =>
            ts.isPropertySignature(p) && p.name?.getText() === 'args'
        )
        if (!args || !args.type || !ts.isTupleTypeNode(args.type)) continue
        out.set(
          channel,
          args.type.elements.map((el) => typeArgCat(ts.isNamedTupleMember(el) ? el.type : el))
        )
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

describe('IPC contract parity', () => {
  const typesSrc = read('src/shared/types/ipc.ts')
  const mapBlock = typesSrc.match(/export type IpcChannelMap = \{([\s\S]*?)\n\}/)
  expect(mapBlock, 'IpcChannelMap must exist').toBeTruthy()
  const channels = [...(mapBlock?.[1] || '').matchAll(/'([\w.]+)'\s*:/g)].map((m) => m[1])

  it('IpcChannelMap is non-empty', () => {
    expect(channels.length).toBeGreaterThan(50)
  })

  it('every IpcChannelMap key has an ipcMain.handle registration', () => {
    const handlersSrc = read('src/main/ipc/handlers.ts')
    const registered = new Set(
      [...handlersSrc.matchAll(/ipcMain\.handle\(\s*'([\w.]+)'/g)].map((m) => m[1])
    )
    const missing = channels.filter((c) => !registered.has(c))
    expect(missing, `handlers.ts missing: ${missing.join(', ')}`).toEqual([])
  })

  it('handlers register only known channels (no drift the other way)', () => {
    const handlersSrc = read('src/main/ipc/handlers.ts')
    const registered = [...handlersSrc.matchAll(/ipcMain\.handle\(\s*'([\w.]+)'/g)].map((m) => m[1])
    const known = new Set(channels)
    const extra = registered.filter((c) => !known.has(c))
    expect(extra, `handlers.ts unknown channels: ${extra.join(', ')}`).toEqual([])
  })

  it('every channel invoked from the renderer exists in IpcChannelMap', () => {
    const known = new Set(channels)
    const missing: string[] = []
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (/\.(vue|ts)$/.test(ent.name)) {
          const src = readFileSync(p, 'utf-8')
          for (const m of src.matchAll(/\bipc\(\s*'([\w.]+)'/g)) {
            if (!known.has(m[1])) missing.push(`${m[1]} (${ent.name})`)
          }
        }
      }
    }
    walk(join(root, 'src/renderer/src'))
    expect(missing, `renderer invokes unknown channels: ${missing.join(', ')}`).toEqual([])
  })

  it('runtime schemas match every IpcChannelMap argument tuple shape', () => {
    const typed = typedArgCats()
    const contract = contractArgCats()
    expect(typed.size).toBeGreaterThan(50)
    // Explicit rows only: a fallback `loose` schema is how drift stayed hidden
    // (market.install accepted two strings while the renderer sent an object).
    const missing = [...typed.keys()].filter((c) => !contract.has(c))
    expect(missing, `channels without an explicit schema: ${missing.join(', ')}`).toEqual([])
    const wrong: string[] = []
    for (const [channel, shape] of typed) {
      const actual = contract.get(channel) || []
      if (JSON.stringify(shape) !== JSON.stringify(actual)) {
        wrong.push(`${channel}: type=${JSON.stringify(shape)} contract=${JSON.stringify(actual)}`)
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([])
  })

  it('workflow.import accepts the documented third target argument', () => {
    expect(() =>
      validateIpcArgs('workflow.import', ['/tmp/a.json', 'inst-1', 'library'])
    ).not.toThrow()
    // The same channel must still reject an unknown target value.
    expect(() =>
      validateIpcArgs('workflow.import', ['/tmp/a.json', 'inst-1', 'elsewhere'])
    ).toThrow(/Invalid IPC arguments/)
  })

  it('monitor.interrupt accepts the optional prompt id sent by MonitorView', () => {
    expect(() =>
      validateIpcArgs('monitor.interrupt', ['http://127.0.0.1:8188', 'prompt-1'])
    ).not.toThrow()
    expect(() => validateIpcArgs('monitor.interrupt', ['http://127.0.0.1:8188'])).not.toThrow()
    expect(() => validateIpcArgs('monitor.interrupt', [])).toThrow(/Invalid IPC arguments/)
  })

  it('market.install accepts the object payload the renderer sends', () => {
    expect(() =>
      validateIpcArgs('market.install', [{ id: 'comfyui-impact-pack', version: '1.0.0' }])
    ).not.toThrow()
    // A bare positional string is the old, broken shape and must be rejected.
    expect(() => validateIpcArgs('market.install', ['comfyui-impact-pack'])).toThrow(
      /Invalid IPC arguments/
    )
  })

  it('IPC_EVENTS used by broadcast all appear in preload allowlist source', () => {
    const preload = read('src/preload/index.ts')
    expect(preload).toContain('ALLOWED_EVENTS')
    expect(preload).toContain('Object.values(IPC_EVENTS)')
  })

  it('bootstrap.cjs is staged into out/main by postbuild', () => {
    expect(existsSync(join(root, 'scripts/postbuild.cjs'))).toBe(true)
    const pkg = JSON.parse(read('package.json')) as { scripts: { build: string } }
    expect(pkg.scripts.build).toContain('postbuild.cjs')
  })
})
