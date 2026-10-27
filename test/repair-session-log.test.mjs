/**
 * Tests for `scripts/repair-session-log.mjs`.
 *
 * Synthetic fixtures cover:
 *   - the concatenated-zstd container (multiple frames, matching events in one
 *     or several frames, no-match logs, malformed payloads);
 *   - the plain-JSONL path (LF and CRLF);
 *   - `--dry-run`, `--no-backup`, backup creation and idempotence;
 *   - recursive discovery under a sessions root, including `*.bak-*` skipping;
 *   - exit codes and corruption/verification failure handling;
 *   - the verification invariants themselves (line/seq/header/event rules).
 *
 * A final test runs the tool on a COPY of a real broken session log when
 * `DSH_OMNISSIAH_BROKEN_LOG` points at one (path kept out of the repository),
 * and asserts the exact expected repair (1129 lines before and after, only
 * line 7 / seq 5 changes). The real log is only ever read.
 *
 * No dependencies beyond Node built-ins. Run: node test/repair-session-log.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as zlib from 'node:zlib'
import {
  decodeSessionLog,
  planRepair,
  scanZstdFrames,
  splitLines,
  verifyRepairedLog
} from '../scripts/repair-session-log.mjs'

if (
  typeof zlib.zstdCompressSync !== 'function'
  || typeof zlib.zstdDecompressSync !== 'function'
  || typeof zlib.constants?.ZSTD_c_checksumFlag !== 'number'
) {
  console.error('node:zlib zstd APIs are unavailable; Node >= 22.15 is required to run these tests')
  process.exit(1)
}

const TOOL = fileURLToPath(new URL('../scripts/repair-session-log.mjs', import.meta.url))
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-omnissiah-repair-test-'))
// Best-effort cleanup even if an unexpected error aborts the run before the
// summary below is reached.
process.on('exit', () => {
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true })
  } catch {
    // Already gone; nothing to clean up.
  }
})
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
// A v1.0.0-broken log is user data, so it never enters the repository. Point
// `DSH_OMNISSIAH_BROKEN_LOG` at one to run the real-log copy scenario.
const REAL_LOG = process.env.DSH_OMNISSIAH_BROKEN_LOG ?? ''

let checks = 0
let failures = 0

/** Run one labelled check; assertions throw and are reported without aborting the suite. */
function test(label, fn) {
  checks += 1
  try {
    fn()
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL  ${label}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

function section(title) {
  console.log(`\n${title}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Spawn the CLI and capture everything it printed. */
function runTool(args) {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return { status: result.status, stdout, stderr, output: `${stdout}${stderr}` }
}

/** Create (parents included) and return a path under the suite temp root. */
function tempPath(relativePath) {
  const absolutePath = path.join(TEMP_ROOT, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  return absolutePath
}

/** Write a fixture file under the suite temp root. */
function tempFile(relativePath, content) {
  const absolutePath = tempPath(relativePath)
  fs.writeFileSync(absolutePath, content)
  return absolutePath
}

/** Existing `<file>.bak-*` backups, sorted. */
function backupsOf(filePath) {
  const prefix = `${path.basename(filePath)}.bak-`
  return fs
    .readdirSync(path.dirname(filePath))
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => path.join(path.dirname(filePath), name))
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SESSION_HEADER = JSON.stringify({
  type: 'session',
  version: 4,
  id: 'session-00000000-0000-0000-0000-000000000000',
  cwd: 'D:\\tmp\\project',
  isSeeded: false
})

function eventLine(type, seq, data) {
  return JSON.stringify({ type, seq, time: 1792666208022 + seq, data })
}

function omnissiahLine(seq, data = { active: true, persona: 'omnissiah' }) {
  return eventLine('omnissiah/state', seq, data)
}

/** JSONL text from complete lines, trailing newline included. */
function jsonlText(lines) {
  return `${lines.join('\n')}\n`
}

function zstdFrame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM_OPTIONS)
}

/** Build a concatenated-zstd container with one frame per text chunk. */
function zstdContainer(frameTexts) {
  return Buffer.concat(frameTexts.map(zstdFrame))
}

/** Compressed byte slices per frame, in container order. */
function frameSlices(bytes) {
  const scan = scanZstdFrames(bytes)
  assert.equal(scan.tornStart, undefined, 'fixture must not be torn')
  return scan.frames.map((range) => bytes.subarray(range.start, range.end))
}

/** Plaintext of a synthetic fixture container. */
function plaintextOf(bytes) {
  return decodeSessionLog('zstd', bytes).plaintext
}

/** Parse every line's seq (undefined for the header, as in real logs). */
function lineSeqs(lines) {
  return lines.map((line) => JSON.parse(line.content.toString('utf8')).seq)
}

/** Assert line content + ending are byte-identical for the given indexes. */
function assertLinesUnchanged(beforeLines, afterLines, indexes) {
  assert.equal(beforeLines.length, afterLines.length, 'line count must not change')
  for (const index of indexes) {
    assert.ok(
      beforeLines[index].content.equals(afterLines[index].content),
      `line ${index + 1} content changed unexpectedly`
    )
    assert.ok(
      beforeLines[index].ending.equals(afterLines[index].ending),
      `line ${index + 1} line ending changed unexpectedly`
    )
  }
}

/** Indexes of plaintext lines that differ (content or ending). */
function changedLineIndexes(beforeLines, afterLines) {
  assert.equal(beforeLines.length, afterLines.length)
  const changed = []
  for (let index = 0; index < beforeLines.length; index += 1) {
    if (
      !beforeLines[index].content.equals(afterLines[index].content)
      || !beforeLines[index].ending.equals(afterLines[index].ending)
    ) changed.push(index)
  }
  return changed
}

/* -------------------------------------------------------------------------- */
/* [1] Frame scanner                                                          */
/* -------------------------------------------------------------------------- */

section('[1] zstd frame scanner')

test('finds every independently-decodable frame of a concatenated container', () => {
  const container = zstdContainer(['{"type":"session"}\n', 'a\nb\n', 'c\n'])
  const scan = scanZstdFrames(container)
  assert.equal(scan.tornStart, undefined)
  assert.equal(scan.frames.length, 3)
  assert.equal(scan.frames[0].start, 0)
  assert.equal(scan.frames[0].end, scan.frames[1].start)
  assert.equal(scan.frames[2].end, container.length)
  for (const range of scan.frames) {
    assert.equal(container.readUInt32LE(range.start), 0xfd2fb528)
    assert.ok(range.end > range.start)
  }
})

test('rejects a non-zstd payload with a clear structural error', () => {
  assert.throws(() => scanZstdFrames(Buffer.from('this is not a zstd container')), /invalid frame magic/)
})

test('reports a torn final frame instead of guessing at its end', () => {
  const container = zstdContainer(['{"type":"session"}\n', 'more\n'])
  const scan = scanZstdFrames(container.subarray(0, container.length - 1))
  assert.equal(scan.frames.length, 1)
  assert.equal(scan.tornStart, scan.frames[0].end)
})

/* -------------------------------------------------------------------------- */
/* [2] Repair planning and verification invariants                            */
/* -------------------------------------------------------------------------- */

section('[2] repair planning and verification invariants')

const unitOriginal = Buffer.from(jsonlText([
  SESSION_HEADER,
  eventLine('permission/preset', 0, { preset: 'workspace-write' }),
  eventLine('sandbox/mode', 1, { mode: 'workspace-write' }),
  omnissiahLine(5),
  eventLine('command/done', 6, { commandId: 'cmd-1' })
]))
const unitPlan = planRepair(unitOriginal, 'jsonl')
const unitRepaired = unitPlan.output

test('plan adds ignorable:true only to the matching event', () => {
  assert.equal(unitPlan.changed, true)
  assert.equal(unitPlan.repairedEvents, 1)
  assert.equal(unitPlan.updatedLines, 1)
  assert.equal(unitPlan.alreadyIgnorable, 0)
  assert.deepEqual(unitPlan.malformedEvents, [])
  const beforeLines = splitLines(unitOriginal)
  const afterLines = splitLines(unitRepaired)
  assert.deepEqual(changedLineIndexes(beforeLines, afterLines), [3])
  assertLinesUnchanged(beforeLines, afterLines, [0, 1, 2, 4])
  const repairedEvent = JSON.parse(afterLines[3].content.toString('utf8'))
  assert.equal(repairedEvent.ignorable, true)
  assert.equal(repairedEvent.type, 'omnissiah/state')
  assert.equal(repairedEvent.seq, 5)
  assert.deepEqual(repairedEvent.data, { active: true, persona: 'omnissiah' })
  assert.deepEqual(lineSeqs(afterLines), lineSeqs(beforeLines))
})

test('verification accepts a correctly repaired payload', () => {
  const verified = verifyRepairedLog(unitOriginal, unitRepaired)
  assert.equal(verified.lineCount, 5)
  assert.equal(verified.eventCount, 1)
})

test('verification rejects a changed line count', () => {
  assert.throws(
    () => verifyRepairedLog(unitOriginal, Buffer.concat([unitRepaired, Buffer.from('{"type":"extra"}\n')])),
    /line count changed/
  )
})

test('verification rejects a changed seq', () => {
  const tampered = Buffer.from(unitRepaired.toString('utf8').replace('"seq":5', '"seq":6'))
  assert.throws(() => verifyRepairedLog(unitOriginal, tampered), /seq changed/)
})

test('verification rejects a changed header line', () => {
  const tampered = Buffer.from(unitRepaired.toString('utf8').replace('"type":"session"', '"type":"sessionx"'))
  assert.throws(() => verifyRepairedLog(unitOriginal, tampered), /header line/)
})

test('verification rejects a matching event that did not gain ignorable', () => {
  const tampered = Buffer.from(unitRepaired.toString('utf8').replace(',"ignorable":true', ''))
  assert.throws(() => verifyRepairedLog(unitOriginal, tampered), /did not gain ignorable:true/)
})

test('verification rejects changes to a non-matching line', () => {
  const tampered = Buffer.from(unitRepaired.toString('utf8').replace('"cmd-1"', '"cmd-2"'))
  assert.throws(() => verifyRepairedLog(unitOriginal, tampered), /changed unexpectedly/)
})

test('verification rejects unparseable JSON in the output', () => {
  const tampered = Buffer.from(unitRepaired.toString('utf8').replace('"preset":"workspace-write"', '"preset":"workspace-write'))
  assert.throws(() => verifyRepairedLog(unitOriginal, tampered), /not valid JSON/)
})

test('plan is a no-op for a log without repairable events', () => {
  const original = Buffer.from(jsonlText([
    SESSION_HEADER,
    eventLine('turn/start', 0, {}),
    JSON.stringify({ type: 'omnissiah/state', seq: 1, time: 1, data: { active: false, persona: 'omnissiah' }, ignorable: true })
  ]))
  const plan = planRepair(original, 'jsonl')
  assert.equal(plan.changed, false)
  assert.equal(plan.repairedEvents, 0)
  assert.equal(plan.alreadyIgnorable, 1)
  assert.equal(plan.output, original)
})

test('plan skips malformed omnissiah/state payloads with a reason', () => {
  const original = Buffer.from(jsonlText([
    SESSION_HEADER,
    JSON.stringify({ type: 'omnissiah/state', seq: 2, time: 1, data: { active: 'yes', persona: 7 } })
  ]))
  const plan = planRepair(original, 'jsonl')
  assert.equal(plan.changed, false)
  assert.equal(plan.malformedEvents.length, 1)
  assert.equal(plan.malformedEvents[0].line, 2)
  assert.match(plan.malformedEvents[0].message, /malformed/)
})

/* -------------------------------------------------------------------------- */
/* [3] End-to-end zstd repair: one event in one frame                         */
/* -------------------------------------------------------------------------- */

section('[3] end-to-end zstd repair (single matching event)')

test('repairs one event, recompresses exactly one frame, and backs up the original', () => {
  const filePath = tempPath(path.join('sessions', 'a', 'session-1', 'session.v4.jsonl.zstd'))
  const zstdOriginal = zstdContainer([
    jsonlText([SESSION_HEADER]),
    jsonlText([
      eventLine('permission/preset', 0, { preset: 'ask' }),
      eventLine('sandbox/mode', 1, { mode: 'workspace-write' })
    ]),
    jsonlText([omnissiahLine(5)]),
    jsonlText([eventLine('command/done', 6, { kind: 'success' })])
  ])
  fs.writeFileSync(filePath, zstdOriginal)

  const beforeFrames = frameSlices(zstdOriginal)
  const before = decodeSessionLog('zstd', zstdOriginal)
  const beforeLines = splitLines(before.plaintext)

  const result = runTool([filePath])
  assert.equal(result.status, 0, result.output)
  assert.match(result.stdout, /\[REPAIRED\]/)
  assert.match(result.stdout, /verify: ok/)
  assert.match(result.stdout, /1 omnissiah\/state event\(s\)/)

  const repairedBytes = fs.readFileSync(filePath)
  const afterFrames = frameSlices(repairedBytes)
  const after = decodeSessionLog('zstd', repairedBytes)
  const afterLines = splitLines(after.plaintext)

  assert.equal(afterFrames.length, beforeFrames.length)
  assert.deepEqual(changedLineIndexes(beforeLines, afterLines), [3])
  assertLinesUnchanged(beforeLines, afterLines, [0, 1, 2, 4])
  assert.deepEqual(lineSeqs(afterLines), lineSeqs(beforeLines))

  const rewrittenFrames = beforeFrames
    .map((frame, index) => (frame.equals(afterFrames[index]) ? -1 : index))
    .filter((index) => index !== -1)
  assert.deepEqual(rewrittenFrames, [2], 'only the frame holding the event should be recompressed')
  assert.equal(after.segments[2].toString('utf8'), `${JSON.stringify({
    type: 'omnissiah/state',
    seq: 5,
    time: 1792666208022 + 5,
    data: { active: true, persona: 'omnissiah' },
    ignorable: true
  })}\n`)
  // Recompressed frames must keep the harness' checksummed-frame convention.
  assert.notEqual(repairedBytes[after.frames[2].start + 4] & 0x04, 0, 'recompressed frame must be checksummed')

  const backups = backupsOf(filePath)
  assert.equal(backups.length, 1)
  assert.match(path.basename(backups[0]), /\.bak-\d{8}-\d{6}(?:-\d+)?$/)
  assert.equal(sha256(fs.readFileSync(backups[0])), sha256(zstdOriginal))

  // Second run: idempotent no-op, no second backup, bytes untouched.
  const secondRun = runTool([filePath])
  assert.equal(secondRun.status, 0, secondRun.output)
  assert.match(secondRun.stdout, /\[UNCHANGED\]/)
  assert.equal(backupsOf(filePath).length, 1)
  assert.ok(fs.readFileSync(filePath).equals(repairedBytes))
})

/* -------------------------------------------------------------------------- */
/* [4] End-to-end zstd repair: events spread over several frames              */
/* -------------------------------------------------------------------------- */

section('[4] end-to-end zstd repair (multiple frames, multiple events)')

test('repairs events in separate frames and leaves every other frame untouched', () => {
  const filePath = tempPath(path.join('sessions', 'm', 'session-2', 'session.v4.jsonl.zstd'))
  const zstdOriginal = zstdContainer([
    jsonlText([SESSION_HEADER]),
    jsonlText([eventLine('turn/start', 0, {}), omnissiahLine(2), eventLine('step/start', 3, {})]),
    jsonlText([eventLine('step/end', 4, {}), eventLine('turn/end', 5, {})]),
    jsonlText([omnissiahLine(7), eventLine('tool/call', 8, { name: 'bash' }), omnissiahLine(9)])
  ])
  fs.writeFileSync(filePath, zstdOriginal)
  const before = decodeSessionLog('zstd', zstdOriginal)
  const beforeLines = splitLines(before.plaintext)

  const result = runTool([filePath])
  assert.equal(result.status, 0, result.output)
  assert.match(result.stdout, /\[REPAIRED\]/)
  assert.match(result.stdout, /3 omnissiah\/state event\(s\)/)

  const repairedBytes = fs.readFileSync(filePath)
  const after = decodeSessionLog('zstd', repairedBytes)
  const afterLines = splitLines(after.plaintext)
  assert.deepEqual(changedLineIndexes(beforeLines, afterLines), [2, 6, 8])
  assert.deepEqual(lineSeqs(afterLines), lineSeqs(beforeLines))
  for (const index of [2, 6, 8]) {
    assert.equal(JSON.parse(afterLines[index].content.toString('utf8')).ignorable, true)
  }

  const beforeFrames = frameSlices(zstdOriginal)
  const afterFrames = frameSlices(repairedBytes)
  const rewritten = beforeFrames
    .map((frame, index) => (frame.equals(afterFrames[index]) ? -1 : index))
    .filter((index) => index !== -1)
  assert.deepEqual(rewritten, [1, 3])
})

test('repairs an event whose line spans a frame boundary', () => {
  const filePath = tempPath(path.join('sessions', 'm', 'session-span', 'session.v4.jsonl.zstd'))
  const headerText = jsonlText([SESSION_HEADER])
  const eventText = `${omnissiahLine(5)}\n`
  const tailText = `${eventLine('command/done', 6, { kind: 'success' })}\n`
  const splitAt = Math.floor(eventText.length / 2)
  const zstdOriginal = zstdContainer([
    headerText,
    eventText.slice(0, splitAt),
    eventText.slice(splitAt) + tailText
  ])
  fs.writeFileSync(filePath, zstdOriginal)
  const before = decodeSessionLog('zstd', zstdOriginal)
  const beforeLines = splitLines(before.plaintext)
  assert.equal(beforeLines.length, 3)

  const result = runTool([filePath])
  assert.equal(result.status, 0, result.output)

  const repairedBytes = fs.readFileSync(filePath)
  const after = decodeSessionLog('zstd', repairedBytes)
  const afterLines = splitLines(after.plaintext)
  assert.deepEqual(changedLineIndexes(beforeLines, afterLines), [1])
  assert.deepEqual(lineSeqs(afterLines), lineSeqs(beforeLines))
  assert.equal(JSON.parse(afterLines[1].content.toString('utf8')).ignorable, true)
  // The whole repaired line belongs to the frame in which it starts; the frame
  // that only held its tail keeps the next line and loses the moved bytes.
  assert.equal(after.segments[1].toString('utf8'), `${JSON.stringify({
    type: 'omnissiah/state',
    seq: 5,
    time: 1792666208022 + 5,
    data: { active: true, persona: 'omnissiah' },
    ignorable: true
  })}\n`)
  assert.equal(after.segments[2].toString('utf8'), tailText)

  const beforeFrames = frameSlices(zstdOriginal)
  const afterFrames = frameSlices(repairedBytes)
  const rewritten = beforeFrames
    .map((frame, index) => (frame.equals(afterFrames[index]) ? -1 : index))
    .filter((index) => index !== -1)
  assert.deepEqual(rewritten, [1, 2], 'both frames touched by the split line must be rewritten')
})

/* -------------------------------------------------------------------------- */
/* [5] Plain JSONL handling                                                    */
/* -------------------------------------------------------------------------- */

section('[5] plain JSONL files')

test('repairs a plain .jsonl file line-wise and preserves untouched bytes', () => {
  const filePath = tempPath(path.join('sessions', 'b', 'session-3', 'session.v4.jsonl'))
  const original = Buffer.from(jsonlText([
    SESSION_HEADER,
    eventLine('permission/preset', 0, { preset: 'ask' }),
    omnissiahLine(5),
    eventLine('command/done', 6, { commandId: 'cmd-1' })
  ]))
  fs.writeFileSync(filePath, original)

  const result = runTool([filePath])
  assert.equal(result.status, 0, result.output)
  assert.match(result.stdout, /\[REPAIRED\]/)

  const beforeLines = splitLines(original)
  const afterLines = splitLines(fs.readFileSync(filePath))
  assert.deepEqual(changedLineIndexes(beforeLines, afterLines), [2])
  assertLinesUnchanged(beforeLines, afterLines, [0, 1, 3])
  assert.equal(afterLines[2].ending.toString('utf8'), '\n')
  assert.deepEqual(lineSeqs(afterLines), lineSeqs(beforeLines))
  assert.equal(backupsOf(filePath).length, 1)
})

test('plain .jsonl CRLF endings survive the repair', () => {
  const filePath = tempPath(path.join('sessions', 'b', 'session-4', 'session.v4.jsonl'))
  const original = Buffer.from(jsonlText([
    SESSION_HEADER,
    eventLine('turn/start', 0, {}),
    omnissiahLine(5)
  ]).replaceAll('\n', '\r\n'))
  fs.writeFileSync(filePath, original)

  const result = runTool([filePath])
  assert.equal(result.status, 0, result.output)

  const beforeLines = splitLines(original)
  const afterLines = splitLines(fs.readFileSync(filePath))
  assert.equal(afterLines.length, beforeLines.length)
  for (let index = 0; index < afterLines.length; index += 1) {
    assert.equal(afterLines[index].ending.toString('utf8'), '\r\n', `line ${index + 1} lost CRLF`)
  }
  assert.deepEqual(changedLineIndexes(beforeLines, afterLines), [2])
  assert.equal(JSON.parse(afterLines[2].content.toString('utf8')).ignorable, true)
})

test('a log with nothing to repair is reported as unchanged (no backup)', () => {
  const filePath = tempPath(path.join('sessions', 'n', 'session-5', 'session.v4.jsonl'))
  const original = Buffer.from(jsonlText([
    SESSION_HEADER,
    eventLine('turn/start', 0, {}),
    JSON.stringify({ type: 'omnissiah/state', seq: 1, time: 1, data: { active: false, persona: 'omnissiah' }, ignorable: true })
  ]))
  fs.writeFileSync(filePath, original)

  const result = runTool([filePath])
  assert.equal(result.status, 0, result.output)
  assert.match(result.stdout, /\[UNCHANGED\]/)
  assert.match(result.stdout, /1 already ignorable/)
  assert.equal(sha256(fs.readFileSync(filePath)), sha256(original))
  assert.deepEqual(backupsOf(filePath), [])
})

test('malformed payloads are reported and left byte-for-byte untouched', () => {
  const filePath = tempPath(path.join('sessions', 'b', 'session-6', 'session.v4.jsonl'))
  const malformedLine = JSON.stringify({ type: 'omnissiah/state', seq: 2, time: 1, data: { active: 'yes', persona: 7 } })
  const original = Buffer.from(jsonlText([
    SESSION_HEADER,
    eventLine('turn/start', 0, {}),
    malformedLine,
    omnissiahLine(5)
  ]))
  fs.writeFileSync(filePath, original)

  const result = runTool([filePath])
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /\[WARN\]/)
  assert.match(result.output, /malformed/)
  assert.match(result.stdout, /\[REPAIRED\]/)

  const beforeLines = splitLines(original)
  const afterLines = splitLines(fs.readFileSync(filePath))
  assert.deepEqual(changedLineIndexes(beforeLines, afterLines), [3])
  assertLinesUnchanged(beforeLines, afterLines, [0, 1, 2])
  assert.equal(JSON.parse(afterLines[3].content.toString('utf8')).ignorable, true)
})

/* -------------------------------------------------------------------------- */
/* [6] Flags: --dry-run and --no-backup                                       */
/* -------------------------------------------------------------------------- */

section('[6] flags')

test('--dry-run reports the repair and writes nothing', () => {
  const filePath = tempPath(path.join('sessions', 'd', 'session-7', 'session.v4.jsonl'))
  const original = Buffer.from(jsonlText([SESSION_HEADER, omnissiahLine(5)]))
  fs.writeFileSync(filePath, original)
  const beforeHash = sha256(original)

  const result = runTool(['--dry-run', filePath])
  assert.equal(result.status, 0, result.output)
  assert.match(result.stdout, /\[DRY-RUN\]/)
  assert.match(result.stdout, /would mark 1 omnissiah\/state event\(s\)/)
  assert.equal(sha256(fs.readFileSync(filePath)), beforeHash)
  assert.deepEqual(backupsOf(filePath), [])
  assert.equal(JSON.parse(splitLines(fs.readFileSync(filePath))[1].content.toString('utf8')).ignorable, undefined)
})

test('--no-backup replaces the file without creating a backup (flag after path)', () => {
  const filePath = tempPath(path.join('sessions', 'd', 'session-8', 'session.v4.jsonl'))
  fs.writeFileSync(filePath, jsonlText([SESSION_HEADER, omnissiahLine(5)]))

  const result = runTool([filePath, '--no-backup'])
  assert.equal(result.status, 0, result.output)
  assert.match(result.stdout, /\[REPAIRED\]/)
  assert.match(result.stdout, /none \(--no-backup\)/)
  assert.deepEqual(backupsOf(filePath), [])
  assert.equal(JSON.parse(splitLines(fs.readFileSync(filePath))[1].content.toString('utf8')).ignorable, true)
})

/* -------------------------------------------------------------------------- */
/* [7] Recursive discovery under a sessions root                              */
/* -------------------------------------------------------------------------- */

section('[7] recursive discovery')

test('finds session logs recursively, reaches nested zstd/jsonl, and skips backups', () => {
  const root = path.join(TEMP_ROOT, 'discover-root')
  const zstdPath = tempPath(path.join('discover-root', 'one', 'session-1', 'session.v4.jsonl.zstd'))
  const jsonlPath = tempPath(path.join('discover-root', 'two', 'session-2', 'session.v4.jsonl'))
  const staleZstd = zstdContainer([jsonlText([SESSION_HEADER]), jsonlText([omnissiahLine(5)])])
  fs.writeFileSync(zstdPath, staleZstd)
  fs.writeFileSync(jsonlPath, jsonlText([SESSION_HEADER, omnissiahLine(5)]))
  const backupPath = path.join(root, 'one', 'session-1', 'session.v4.jsonl.zstd.bak-20260101-000000')
  fs.writeFileSync(backupPath, staleZstd)
  const notesPath = path.join(root, 'two', 'notes.txt')
  fs.writeFileSync(notesPath, 'not a session log\n')
  const backupHash = sha256(staleZstd)

  const result = runTool([root])
  assert.equal(result.status, 0, result.output)
  assert.equal((result.stdout.match(/\[REPAIRED\]/g) ?? []).length, 2, result.output)
  assert.match(result.stdout, /repaired 2 file\(s\)/)

  const repairedZstd = decodeSessionLog('zstd', fs.readFileSync(zstdPath)).plaintext
  assert.equal(JSON.parse(splitLines(repairedZstd)[1].content.toString('utf8')).ignorable, true)
  const repairedJsonl = splitLines(fs.readFileSync(jsonlPath))
  assert.equal(JSON.parse(repairedJsonl[1].content.toString('utf8')).ignorable, true)

  assert.equal(sha256(fs.readFileSync(backupPath)), backupHash, '*.bak-* file must not be touched')
  assert.equal(fs.readFileSync(notesPath, 'utf8'), 'not a session log\n')
  // The pre-existing stale backup plus the backup this run created.
  assert.equal(backupsOf(zstdPath).length, 2)
  assert.ok(backupsOf(zstdPath).includes(backupPath))
  assert.equal(backupsOf(jsonlPath).length, 1)
})

/* -------------------------------------------------------------------------- */
/* [8] Exit codes, corruption and verification abort                          */
/* -------------------------------------------------------------------------- */

section('[8] exit codes, corruption and verification abort')

test('no arguments is a usage error (exit 2)', () => {
  const result = runTool([])
  assert.equal(result.status, 2, result.output)
  assert.match(result.stderr, /Usage:/)
})

test('an unknown option is a usage error (exit 2)', () => {
  const result = runTool(['--bogus'])
  assert.equal(result.status, 2, result.output)
  assert.match(result.stderr, /unknown option/)
})

test('a missing path is an error (exit 1)', () => {
  const result = runTool([path.join(TEMP_ROOT, 'does-not-exist')])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /\[ERROR\]/)
  assert.match(result.output, /path does not exist/)
})

test('a corrupt zstd container is an error and is left untouched', () => {
  const filePath = tempPath(path.join('corrupt', 'session-bad', 'session.v4.jsonl.zstd'))
  const original = Buffer.from('this is definitely not zstd')
  fs.writeFileSync(filePath, original)
  const result = runTool([filePath])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /corrupt Zstandard session log/)
  assert.equal(sha256(fs.readFileSync(filePath)), sha256(original))
  assert.deepEqual(backupsOf(filePath), [])
})

test('a truncated final frame is refused instead of rewritten', () => {
  const filePath = tempPath(path.join('corrupt', 'session-torn', 'session.v4.jsonl.zstd'))
  const container = zstdContainer([jsonlText([SESSION_HEADER]), jsonlText([omnissiahLine(5)])])
  const original = container.subarray(0, container.length - 1)
  fs.writeFileSync(filePath, original)
  const result = runTool([filePath])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /incomplete final frame/)
  assert.equal(sha256(fs.readFileSync(filePath)), sha256(original))
})

test('a verification failure aborts without writing or backing up', () => {
  // A log whose first line is itself a matching event: the repair is computed
  // but verification refuses because the header line would change.
  const filePath = tempPath(path.join('corrupt', 'session-header-event', 'session.v4.jsonl'))
  const original = Buffer.from(jsonlText([omnissiahLine(5), eventLine('turn/start', 6, {})]))
  fs.writeFileSync(filePath, original)

  const result = runTool([filePath])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /verification failed: header line/)
  assert.equal(sha256(fs.readFileSync(filePath)), sha256(original), 'file must not be replaced')
  assert.deepEqual(backupsOf(filePath), [], 'no backup may be left behind')
})

test('one failing file does not stop a good file from being repaired (exit 1)', () => {
  const badPath = tempPath(path.join('mixed', 'bad', 'session.v4.jsonl.zstd'))
  fs.writeFileSync(badPath, Buffer.from('garbage'))
  const goodPath = tempPath(path.join('mixed', 'good', 'session.v4.jsonl'))
  fs.writeFileSync(goodPath, jsonlText([SESSION_HEADER, omnissiahLine(5)]))

  const result = runTool([badPath, goodPath])
  assert.equal(result.status, 1, result.output)
  assert.equal(JSON.parse(splitLines(fs.readFileSync(goodPath))[1].content.toString('utf8')).ignorable, true)
})

test('an empty directory and a non-session file are skipped (exit 0)', () => {
  const emptyDirectory = path.join(TEMP_ROOT, 'empty-dir')
  fs.mkdirSync(emptyDirectory, { recursive: true })
  const notesPath = tempPath(path.join('skip', 'notes.md'))
  fs.writeFileSync(notesPath, 'notes\n')

  const directoryResult = runTool([emptyDirectory])
  assert.equal(directoryResult.status, 0, directoryResult.output)
  assert.match(directoryResult.stdout, /\[SKIP\]/)
  assert.match(directoryResult.stdout, /no session\.v4\.jsonl/)

  const fileResult = runTool([notesPath])
  assert.equal(fileResult.status, 0, fileResult.output)
  assert.match(fileResult.stdout, /\[SKIP\]/)
  assert.match(fileResult.stdout, /not a \.jsonl/)
})

test('--help prints usage and exits 0', () => {
  const result = runTool(['--help'])
  assert.equal(result.status, 0, result.output)
  assert.match(result.stdout, /Usage:/)
})

/* -------------------------------------------------------------------------- */
/* [9] The real broken session log (repaired on a temp copy only)             */
/* -------------------------------------------------------------------------- */

section('[9] real broken session log (temp copy)')

if (REAL_LOG === '' || !fs.existsSync(REAL_LOG)) {
  console.log('  SKIP  set DSH_OMNISSIAH_BROKEN_LOG to a real broken log to run the copy scenario; synthetic coverage used instead')
} else {
  test('real-log copy: every change is limited to adding ignorable:true to v1.0.0 state events', () => {
    const realHashBefore = sha256(fs.readFileSync(REAL_LOG))
    const originalBytes = fs.readFileSync(REAL_LOG)
    const copyPath = tempPath(path.join('real-log-copy', 'session.v4.jsonl.zstd'))
    fs.writeFileSync(copyPath, originalBytes)

    const before = decodeSessionLog('zstd', originalBytes)
    const beforeLines = splitLines(before.plaintext)

    const result = runTool([copyPath])
    assert.equal(result.status, 0, result.output)

    if (/\[UNCHANGED\]/.test(result.stdout)) {
      assert.equal(sha256(fs.readFileSync(copyPath)), sha256(originalBytes), 'unchanged input must not be rewritten')
      const backups = backupsOf(copyPath)
      assert.equal(backups.length, 0, 'a no-op must not create a backup')
      console.log('  INFO  provided log has nothing to repair (already repaired or no omnissiah/state events)')
      return
    }

    assert.match(result.stdout, /\[REPAIRED\]/)
    assert.match(result.stdout, /verify: ok/)

    const repairedBytes = fs.readFileSync(copyPath)
    const after = decodeSessionLog('zstd', repairedBytes)
    const afterLines = splitLines(after.plaintext)

    assert.equal(afterLines.length, beforeLines.length, 'line count must be unchanged')
    assert.equal(after.frames.length, before.frames.length, 'frame count must be unchanged')
    assert.ok(beforeLines[0].content.equals(afterLines[0].content), 'header content must be identical')
    assert.ok(beforeLines[0].ending.equals(afterLines[0].ending), 'header ending must be identical')
    assert.deepEqual(lineSeqs(afterLines), lineSeqs(beforeLines), 'every seq must be unchanged')

    const changed = changedLineIndexes(beforeLines, afterLines)
    assert.ok(changed.length >= 1, 'at least one v1.0.0 state event must be repaired')
    for (const index of changed) {
      const beforeEvent = JSON.parse(beforeLines[index].content.toString('utf8'))
      const afterEvent = JSON.parse(afterLines[index].content.toString('utf8'))
      assert.equal(beforeEvent.type, 'omnissiah/state', `line ${index + 1} must be an omnissiah/state event`)
      assert.equal(afterEvent.type, 'omnissiah/state')
      assert.notEqual(beforeEvent.ignorable, true)
      assert.equal(afterEvent.ignorable, true)
      assert.equal(typeof beforeEvent.data?.active, 'boolean')
      assert.equal(typeof beforeEvent.data?.persona, 'string')
      const beforeRest = { ...beforeEvent }
      delete beforeRest.ignorable
      const afterRest = { ...afterEvent }
      delete afterRest.ignorable
      assert.deepEqual(afterRest, beforeRest, 'event changes must be limited to the ignorable marker')
    }

    // Every frame that changed must be checksummed; unchanged frames are copied
    // through byte-for-byte by the container rebuild.
    const beforeFrames = frameSlices(originalBytes)
    const afterFrames = frameSlices(repairedBytes)
    const rewrittenFrames = beforeFrames
      .map((frame, index) => (frame.equals(afterFrames[index]) ? -1 : index))
      .filter((index) => index !== -1)
    assert.ok(rewrittenFrames.length >= 1, 'the frame holding a repaired line must be recompressed')
    for (const index of rewrittenFrames) {
      assert.notEqual(repairedBytes[after.frames[index].start + 4] & 0x04, 0, 'recompressed frame is checksummed')
    }

    const backups = backupsOf(copyPath)
    assert.equal(backups.length, 1)
    assert.match(path.basename(backups[0]), /\.bak-\d{8}-\d{6}(?:-\d+)?$/)
    assert.equal(sha256(fs.readFileSync(backups[0])), sha256(originalBytes), 'backup must hold the original bytes')

    assert.equal(sha256(fs.readFileSync(REAL_LOG)), realHashBefore, 'the real session log must never be modified')

    console.log(
      `  INFO  real copy: ${originalBytes.length} -> ${repairedBytes.length} bytes, ` +
      `frames ${beforeFrames.length} (rewritten: ${rewrittenFrames.length}), ` +
      `lines ${beforeLines.length} -> ${afterLines.length}, changed ${changed.length} line(s)`
    )
  })
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

try {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true })
} finally {
  const status = failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`
  console.log(`\n${checks} check(s), ${failures} failure(s)\n${status}\n`)
  process.exit(failures === 0 ? 0 : 1)
}
