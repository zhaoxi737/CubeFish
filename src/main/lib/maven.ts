/** Maven 坐标 ↔ 仓库相对路径。加载器库（Fabric/Forge/NeoForge）没有 downloads 节点，只能靠坐标拼路径。 */

export interface MavenCoord {
  group: string
  artifact: string
  version: string
  classifier?: string
  ext: string
  /** 例如 net/fabricmc/loader/0.16.0/loader-0.16.0.jar */
  path: string
}

/** `group:artifact:version[:classifier][@ext]` */
export function parseMaven(name: string): MavenCoord | undefined {
  if (!name) return undefined
  let rest = name
  let ext = 'jar'
  const at = rest.lastIndexOf('@')
  if (at > 0) {
    ext = rest.slice(at + 1).trim() || 'jar'
    rest = rest.slice(0, at)
  }
  const parts = rest.split(':')
  if (parts.length < 3) return undefined
  const [group, artifact, version] = parts
  const classifier = parts.length >= 4 ? parts.slice(3).join(':') : undefined
  const dir = `${group.replace(/\./g, '/')}/${artifact}/${version}`
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`
  return { group, artifact, version, classifier, ext, path: `${dir}/${file}` }
}

export function mavenDirOf(coord: MavenCoord): string {
  return coord.path.slice(0, coord.path.lastIndexOf('/'))
}
