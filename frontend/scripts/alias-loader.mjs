// 仅供 scripts 下的 Node 验证脚本使用：把 Vite 的 '@/...' 路径别名映射到 ../src
import { pathToFileURL } from 'node:url'
import { resolve as resolvePath } from 'node:path'

const SRC = resolvePath(import.meta.dirname, '../src')

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = resolvePath(SRC, specifier.slice(2))
    return nextResolve(pathToFileURL(target).href, context)
  }
  return nextResolve(specifier, context)
}
