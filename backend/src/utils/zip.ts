/**
 * ★ Sprint 40 T1 (PM msg-20261112-171): 极简 ZIP 打包 (STORE 方式, 不压缩)。
 *
 * 【为什么不引依赖】素材包里装的是 mp4 / srt —— 本身就是压缩格式, 再 deflate 一遍
 *   几乎不省空间, 却要多一个依赖 (archiver / jszip) → 还要同步 package-lock (Sprint 10 的坑)。
 *   所以这里手写一个只支持 STORE 的最小 ZIP 写入器 (本地文件头 + 中央目录 + EOCD)。
 *
 * 【能力】只做「把若干文件写成一个 zip」, 不解压、不做目录树。
 *   文件名用 UTF-8 (标志位 0x0800) → 中文名在 macOS / Windows 的解压工具里都正常。
 */
import fs from 'fs'
import path from 'path'

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

/** CRC32 (ZIP 用) */
export function crc32(buf: Buffer): number {
  let c = (-1) >>> 0
  for (let i = 0; i < buf.length; i++) c = ((c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF]) >>> 0
  return (c ^ (-1)) >>> 0
}

export interface ZipEntry {
  /** zip 内的路径 (用 / 分隔) */
  name: string
  /** 源文件绝对路径 */
  filePath: string
}

/**
 * 把若干文件写成一个 ZIP (STORE, 不压缩)。
 * 逐个文件读进内存 → 写盘 → 释放 (所以峰值内存只有一个文件的大小, 不会把整个包读进内存)。
 */
export function createZipFile(entries: ZipEntry[], outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const fd = fs.openSync(outPath, 'w')
  const central: Buffer[] = []
  let offset = 0
  try {
    for (const e of entries) {
      const data = fs.readFileSync(e.filePath)
      const nameBuf = Buffer.from(e.name, 'utf-8')
      const crc = crc32(data)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)     // local file header 签名
      local.writeUInt16LE(20, 4)            // version needed
      local.writeUInt16LE(0x0800, 6)        // flags: 文件名 UTF-8
      local.writeUInt16LE(0, 8)             // method: store
      local.writeUInt16LE(0, 10)            // mod time (固定 → 可复现)
      local.writeUInt16LE(0x21, 12)         // mod date (1980-01-01)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(data.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      local.writeUInt16LE(0, 28)            // extra len
      fs.writeSync(fd, local)
      fs.writeSync(fd, nameBuf)
      fs.writeSync(fd, data)

      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(0x02014b50, 0)      // central directory 签名
      cd.writeUInt16LE(20, 4)              // version made by
      cd.writeUInt16LE(20, 6)              // version needed
      cd.writeUInt16LE(0x0800, 8)          // flags: UTF-8
      cd.writeUInt16LE(0, 10)              // method: store
      cd.writeUInt16LE(0, 12)              // mod time
      cd.writeUInt16LE(0x21, 14)           // mod date
      cd.writeUInt32LE(crc, 16)
      cd.writeUInt32LE(data.length, 20)
      cd.writeUInt32LE(data.length, 24)
      cd.writeUInt16LE(nameBuf.length, 28)
      cd.writeUInt16LE(0, 30)              // extra len
      cd.writeUInt16LE(0, 32)              // comment len
      cd.writeUInt16LE(0, 34)              // disk number
      cd.writeUInt16LE(0, 36)              // internal attrs
      cd.writeUInt32LE(0, 38)              // external attrs
      cd.writeUInt32LE(offset, 42)         // 本地头偏移
      central.push(cd, nameBuf)
      offset += local.length + nameBuf.length + data.length
    }
    const cdBuf = Buffer.concat(central)
    fs.writeSync(fd, cdBuf)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)      // EOCD 签名
    eocd.writeUInt16LE(0, 4)               // disk number
    eocd.writeUInt16LE(0, 6)               // 中央目录所在磁盘
    eocd.writeUInt16LE(entries.length, 8)   // 本盘条目数
    eocd.writeUInt16LE(entries.length, 10)  // 总条目数
    eocd.writeUInt32LE(cdBuf.length, 12)   // 中央目录大小
    eocd.writeUInt32LE(offset, 16)         // 中央目录偏移
    eocd.writeUInt16LE(0, 20)              // comment len
    fs.writeSync(fd, eocd)
  } finally {
    fs.closeSync(fd)
  }
}
