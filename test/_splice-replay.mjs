import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const buffer = fs.readFileSync(file)
const offsets = []
for (let index = 0; index + 4 <= buffer.length; index += 1) {
  if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) offsets.push(index)
}
const rows = []
for (let index = 0; index < offsets.length; index += 1) {
  let text
  try {
    text = zlib.zstdDecompressSync(buffer.subarray(offsets[index], offsets[index + 1] ?? buffer.length))
  } catch {
    continue
  }
  for (const line of text.toString('utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // ignore
    }
  }
}
const splices = rows.filter((row) => row.type === 'agent/inbox/spliced')
console.log('rows', rows.length, 'splices', splices.length)
for (const row of splices.slice(0, 3)) console.log(JSON.stringify(row).slice(0, 700), '\n')
// Replay the projection to find the first invalid splice.
const state = { 'next-turn': [], 'next-step': [] }
for (const row of rows) {
  if (row.type !== 'agent/inbox/spliced') continue
  const splice = row.data ?? {}
  const inbox = state[splice.target] ?? []
  const removedCount = splice.removedCount ?? 0
  const inserted = splice.inserted ?? []
  const problems = []
  if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length) problems.push(`start ${splice.start} out of 0..${inbox.length}`)
  if (!Number.isSafeInteger(removedCount) || removedCount < 0 || splice.start + removedCount > inbox.length) problems.push(`removedCount ${removedCount} exceeds ${inbox.length}`)
  const union = splice.target === 'next-turn' ? [...inserted, ...state['next-step']] : [...state['next-turn'], ...inserted]
  const ids = new Set()
  for (const message of union) {
    if (ids.has(message?.id)) problems.push(`duplicate pending id ${message?.id}`)
    ids.add(message?.id)
  }
  if (problems.length > 0) {
    console.log(`INVALID at seq ${row.seq} target ${splice.target}: ${problems.join('; ')}`)
    console.log('  state sizes:', Object.fromEntries(Object.entries(state).map(([key, value]) => [key, value.length])))
    break
  }
  const next = inbox.toSpliced(splice.start, removedCount, ...inserted)
  state[splice.target] = next
}
console.log('final state sizes:', Object.fromEntries(Object.entries(state).map(([key, value]) => [key, value.length])))
