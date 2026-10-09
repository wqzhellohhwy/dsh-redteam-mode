// 最小 asar 读取器：list / cat / extract / extract-tree
//
// 用途：DSH Desktop 把内部包打包在 `app.asar` 里，shell 的 ls/cat 都打不开它，
// 而维护本插件几乎总要核对官方 API 签名（dsh-agent / dsh-commands /
// dsh-system-prompt / dsh-agent-loop / cordis …）。这个脚本就是那把钥匙。
//
// 用法（Windows PowerShell 里直接跑，不需要 bash）：
//   node scripts/asar-read.mjs list  "<asar>" "dsh-commands/lib"
//   node scripts/asar-read.mjs cat   "<asar>" "dsh/node_modules/@deepseek-ai/dsh-commands/README.zh.md"
//   node scripts/asar-read.mjs extract-tree "<asar>" "dsh/node_modules/@deepseek-ai/dsh-agent/" ref/dsh-agent
//
// 典型 asar 路径：
//   "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar"
//
// 头部格式备忘（踩过坑）：16 字节 = [0..3] pickle 大小(4) + [4..7] headerBuf 长度
// + [8..11] 内层 pickle payload 大小 + [12..15] JSON 字符串长度，JSON 从 offset 16 开始；
// 文件数据区从 8 + headerBuf 长度（即第 [4..7] 字节）起算，每个文件的 offset 相对它。
import { open } from 'node:fs/promises'

const [cmd, asarPath, arg3, arg4] = process.argv.slice(2)
if (!cmd || !asarPath) {
  console.error('usage: list <asar> <filter> | cat <asar> <inner> [max] | extract <asar> <inner> <out>')
  process.exit(2)
}

const fh = await open(asarPath, 'r')
const sizeBuf = Buffer.alloc(16)
await fh.read(sizeBuf, 0, 16, 0)
const headerSize = sizeBuf.readUInt32LE(4) // header pickle 总长（含长度前缀）
const strLen = sizeBuf.readUInt32LE(12) // JSON 字符串长度
const headerBuf = Buffer.alloc(strLen)
await fh.read(headerBuf, 0, strLen, 16)
const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, '').trim())
const dataStart = 8 + headerSize

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p, out)
    else out.push({ path: p, size: entry.size, offset: entry.offset, unpacked: !!entry.unpacked })
  }
  return out
}
const all = walk(header, '', [])

if (cmd === 'list') {
  const filter = arg3 ?? ''
  const hits = all.filter((f) => f.path.includes(filter))
  for (const f of hits) console.log(`${String(f.size).padStart(10)}  ${f.path}`)
  console.log(`# total ${hits.length} / ${all.length}`)
} else if (cmd === 'extract-tree') {
  const prefix = arg3.replace(/^\/+/, '')
  const outDir = arg4
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const hits = all.filter((f) => f.path.startsWith(prefix) && !f.unpacked)
  let n = 0
  for (const f of hits) {
    const rel = f.path.slice(prefix.length).replace(/^\/+/, '')
    const target = join(outDir, rel)
    await mkdir(dirname(target), { recursive: true })
    const buf = Buffer.alloc(Number(f.size))
    await fh.read(buf, 0, Number(f.size), dataStart + Number(f.offset))
    await writeFile(target, buf)
    n += 1
  }
  console.log(`extracted ${n} files -> ${outDir}`)
} else if (cmd === 'cat' || cmd === 'extract') {
  const inner = arg3.replace(/^\/+/, '')
  const entry = all.find((f) => f.path === inner)
  if (!entry) {
    console.error(`not found: ${inner}`)
    process.exit(1)
  }
  if (entry.unpacked) {
    console.error(`unpacked entry -> read from app.asar.unpacked: ${inner}`)
    process.exit(3)
  }
  const max = cmd === 'cat' ? Number(arg4 ?? entry.size) : entry.size
  const len = Math.min(max, entry.size)
  const buf = Buffer.alloc(len)
  await fh.read(buf, 0, len, dataStart + Number(entry.offset))
  if (cmd === 'cat') process.stdout.write(buf.toString('utf8'))
  else {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(arg4, buf)
    console.log(`wrote ${arg4} (${len} bytes)`)
  }
}
await fh.close()
