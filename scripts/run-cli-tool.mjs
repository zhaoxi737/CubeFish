/**
 * 用参数数组直接跑一次工具调用（避免 PowerShell / cmd 的引号把 JSON 吃掉）。
 *
 *   node scripts/run-cli-tool.mjs install_mod '{"slug":"forgeconfigapiport"}'
 */
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const [name, json = '{}'] = process.argv.slice(2)
if (!name) {
  console.error('用法：node scripts/run-cli-tool.mjs <工具名> \'<JSON 参数>\'')
  process.exit(2)
}

const child = spawn(electronPath, ['.', `--call-tool=${name}::${json}`], {
  stdio: 'inherit',
  env: process.env,
})
child.on('exit', (code) => process.exit(code ?? 1))
