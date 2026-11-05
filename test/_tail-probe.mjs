import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const buffer = fs.readFileSync(file)
const offsets = []
for (let index = 0; index + 4 <= buffer.length; index += 1) {
  if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) offsets.push(index)
}
console.log('size', buffer.length, 'frames', offsets.length)
const last = offsets[offsets.length - 1]
console.log('last frame offset', last, 'slice length', buffer.length - last)
let text
try {
  text = zlib.zstdDecompressSync(buffer.subarray(last))
  console.log('last frame decompressed bytes:', text.length)
  console.log('last frame ends with newline:', text.length > 0 && text[text.length - 1] === 0x0a)
  console.log('last 160 chars:', JSON.stringify(text.subarray(Math.max(0, text.length - 160)).toString('utf8')))
} catch (error) {
  console.log('last frame does NOT decompress:', error.message)
}
console.log('raw tail hex:', buffer.subarray(Math.max(0, buffer.length - 40)).toString('hex'))
// Does the whole concatenation end on a record boundary?
let all = Buffer.alloc(0)
let bad = 0
for (let index = 0; index < offsets.length; index += 1) {
  try {
    all = Buffer.concat([all, zlib.zstdDecompressSync(buffer.subarray(offsets[index], offsets[index + 1] ?? buffer.length))])
  } catch {
    bad += 1
  }
}
console.log('concatenated plaintext bytes:', all.length, '| undecodable frames:', bad)
console.log('concatenation ends with newline:', all.length > 0 && all[all.length - 1] === 0x0a)
