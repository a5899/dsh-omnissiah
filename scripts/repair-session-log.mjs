#!/usr/bin/env node
/**
 * Offline repair tool for DSH session logs.
 *
 * dsh-plugin-omnissiah v1.0.0 appended `omnissiah/state` session events without
 * the `ignorable: true` marker. DSH 0.2.x refuses to open a whole session log
 * when it meets an event type it does not know and that is not marked
 * ignorable, so one such event bricks an otherwise healthy session.
 *
 * This script repairs a session log in place:
 *
 *   - only lines whose JSON is `{"type":"omnissiah/state", ...}` **and** whose
 *     `data` is `{active: boolean, persona: string}` **and** that are not
 *     already `"ignorable": true` are rewritten — with `"ignorable": true`
 *     added and nothing else changed;
 *   - every other line, and every other event, is preserved byte-for-byte;
 *   - for DSH's concatenated-zstd container every frame is decompressed
 *     independently, only frames containing a repaired line are recompressed
 *     (checksummed), and all other frames are copied through unmodified;
 *   - the result is decoded again and verified (lines parse, counts and seq are
 *     unchanged, the header line is identical, the repaired events are now
 *     ignorable) before anything is written; then a timestamped backup is made
 *     and the file is replaced atomically via a fsynced temp file in the same
 *     directory.
 *
 * `session.v4.jsonl.zstd` and `session.v4.jsonl` are both supported, as files
 * or via recursive discovery under a session directory or sessions root.
 *
 * Usage:
 *   node scripts/repair-session-log.mjs [--dry-run] [--no-backup] <path...>
 *
 * Exit codes: 0 success/no-op, 1 error, 2 usage error.
 *
 * The zstd container layout is the one used by
 * packages/session/session-persistence-jsonl/src/zstd.ts in the DeepSeek
 * Harness checkout: a concatenation of independent Zstandard frames, with the
 * header line in the first frame. The structural frame scanner below is a
 * direct synchronous port of that file; this script deliberately has **no
 * imports from the harness checkout** and no npm dependencies.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import * as zlib from 'node:zlib'

/** Zstandard frame magic number (little-endian at each frame start). */
const ZSTD_MAGIC = 0xFD2FB528

/** Session artifact basenames discovered by directory walks. */
const SESSION_LOG_NAMES = new Set(['session.v4.jsonl.zstd', 'session.v4.jsonl'])

/** Event type written by the plugin before it emitted `ignorable`. */
const OMNISSIAH_EVENT_TYPE = 'omnissiah/state'

/** Marker used by the backup file names; also excludes them from discovery. */
const BACKUP_MARKER = '.bak-'

/** Marker used by our own in-place temp files; never a discovery target. */
const TEMP_MARKER = '.repair-'

const MIN_NODE_ZSTD = '22.15'

const USAGE =
  'Usage: node scripts/repair-session-log.mjs [--dry-run] [--no-backup] <path...>\n' +
  '\n' +
  '  <path...>    one or more of:\n' +
  '                 - a session.v4.jsonl.zstd / session.v4.jsonl file\n' +
  '                 - a session directory\n' +
  '                 - a sessions root (searched recursively for session.v4.jsonl[.zstd])\n' +
  '  --dry-run    report what would change; write nothing (no backup either)\n' +
  '  --no-backup  replace the file without writing <file>.bak-<yyyyMMdd-HHmmss>\n' +
  '\n' +
  'Exit codes: 0 success/no-op, 1 error, 2 usage error.'

/** Error type for expected, user-facing failures. */
class RepairError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RepairError'
  }
}

/* -------------------------------------------------------------------------- */
/* Zstandard container primitives                                             */
/* -------------------------------------------------------------------------- */

/**
 * Locate complete Zstandard frames without decompressing their blocks.
 *
 * Ported from `scanZstdFrames` in the harness'
 * `packages/session/session-persistence-jsonl/src/zstd.ts`: walks the frame
 * header, the block chain and the optional checksum. Invalid complete
 * structure throws; EOF inside the final frame reports its start instead.
 *
 * @param {Buffer} buffer concatenated container bytes.
 * @param {number} [maxFrames] optional complete-frame limit.
 * @returns {{ frames: {start: number, end: number}[], tornStart?: number }}
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  /** @type {{start: number, end: number}[]} */
  const frames = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }

  return { frames }
}

/**
 * Fail up front when this Node build has no zlib zstd API.
 *
 * The namespace import (rather than named imports) is deliberate: on older
 * Node the named import itself throws, while this path can print an actionable
 * message.
 */
function assertZstdSupport() {
  const hasDecompress = typeof zlib.zstdDecompressSync === 'function'
  const hasCompress = typeof zlib.zstdCompressSync === 'function'
  const hasChecksumFlag = typeof zlib.constants?.ZSTD_c_checksumFlag === 'number'
  if (!hasDecompress || !hasCompress || !hasChecksumFlag) {
    throw new RepairError(
      `node:zlib in this Node build (${process.version}) has no zstd support; ` +
      `Node >= ${MIN_NODE_ZSTD} is required for concatenated-zstd session logs`
    )
  }
}

/** Compression options that preserve the harness' checksummed-frame contract. */
function checksumCompressionOptions() {
  return { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
}

/**
 * Decode a whole session artifact into its independently decodable segments.
 *
 * @param {'zstd' | 'jsonl'} kind container kind.
 * @param {Buffer} buffer raw file bytes.
 * @returns {{ frames: {start: number, end: number}[], segments: Buffer[], plaintext: Buffer }}
 */
export function decodeSessionLog(kind, buffer) {
  if (kind === 'jsonl') return { frames: [], segments: [], plaintext: buffer }
  if (kind !== 'zstd') throw new RepairError(`unsupported session log kind: ${String(kind)}`)
  assertZstdSupport()

  let scan
  try {
    scan = scanZstdFrames(buffer)
  } catch (error) {
    throw new RepairError(error instanceof Error ? error.message : String(error))
  }
  if (scan.tornStart !== undefined) {
    throw new RepairError(
      `corrupt Zstandard session log: incomplete final frame starting at byte ${scan.tornStart}`
    )
  }
  if (scan.frames.length === 0) {
    if (buffer.length === 0) return { frames: [], segments: [], plaintext: Buffer.alloc(0) }
    throw new RepairError('corrupt Zstandard session log: no complete frames found')
  }

  /** @type {Buffer[]} */
  const segments = []
  for (const range of scan.frames) {
    let plaintext
    try {
      plaintext = zlib.zstdDecompressSync(buffer.subarray(range.start, range.end))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new RepairError(
        `corrupt Zstandard session log: frame at byte ${range.start} failed to decompress (${detail})`
      )
    }
    segments.push(plaintext)
  }
  return { frames: scan.frames, segments, plaintext: Buffer.concat(segments) }
}

/* -------------------------------------------------------------------------- */
/* JSONL line handling                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Split a JSONL byte buffer into lines while keeping the exact line ending.
 *
 * The content excludes the ending (`\n` or `\r\n`), so JSON parsing never sees
 * a stray carriage return, while untouched lines can be copied through
 * byte-for-byte. A trailing newline does not create an empty final line.
 *
 * @param {Buffer} buffer JSONL plaintext.
 * @returns {{start: number, contentEnd: number, end: number, content: Buffer, ending: Buffer}[]}
 */
export function splitLines(buffer) {
  /** @type {{start: number, contentEnd: number, end: number, content: Buffer, ending: Buffer}[]} */
  const lines = []
  let start = 0
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start)
    let contentEnd = newline === -1 ? buffer.length : newline
    const end = newline === -1 ? buffer.length : newline + 1
    // Treat `\r\n` as one line ending so the JSON text excludes the CR.
    if (newline !== -1 && contentEnd > start && buffer[contentEnd - 1] === 0x0d) contentEnd -= 1
    lines.push({
      start,
      contentEnd,
      end,
      content: buffer.subarray(start, contentEnd),
      ending: buffer.subarray(contentEnd, end)
    })
    start = end
  }
  return lines
}

/** @param {unknown} value parsed JSON value. */
function isOmnissiahEvent(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.type === OMNISSIAH_EVENT_TYPE
}

/**
 * Validate the event payload shape the repair is allowed to touch.
 * @param {unknown} data `event.data` from a parsed `omnissiah/state` event.
 * @returns {boolean} true when data is `{active: boolean, persona: string}`.
 */
export function isValidOmnissiahData(data) {
  return data !== null
    && typeof data === 'object'
    && !Array.isArray(data)
    && typeof data.active === 'boolean'
    && typeof data.persona === 'string'
}

/** Human-readable reason for skipping a malformed `omnissiah/state` payload. */
function describeMalformedData(data) {
  if (data === null || data === undefined) return 'data is missing'
  if (typeof data !== 'object' || Array.isArray(data)) return `data is ${Array.isArray(data) ? 'an array' : typeof data}`
  const problems = []
  if (typeof data.active !== 'boolean') problems.push(`data.active is ${data.active === null ? 'null' : typeof data.active}`)
  if (typeof data.persona !== 'string') problems.push(`data.persona is ${data.persona === null ? 'null' : typeof data.persona}`)
  return problems.length > 0 ? problems.join(', ') : 'unexpected data shape'
}

/** Parse one JSONL line's text, reporting the line number on failure. */
function parseLineJson(content, lineNumber) {
  try {
    return JSON.parse(content.toString('utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new RepairError(
      `input is not a valid JSONL session log: line ${lineNumber} is not valid JSON (${detail})`
    )
  }
}

/**
 * Stable, key-order-insensitive JSON serialization used by verification.
 * @param {unknown} value any JSON value.
 * @returns {string} canonical representation.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Copy a parsed event without its `ignorable` member. */
function withoutIgnorable(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const clone = { ...value }
  delete clone.ignorable
  return clone
}

/* -------------------------------------------------------------------------- */
/* Repair planning                                                            */
/* -------------------------------------------------------------------------- */

/** Apply recorded line replacements to a plaintext buffer. */
function applyReplacements(plaintext, lines, replacements) {
  const ordered = [...replacements.keys()].sort((a, b) => a - b)
  /** @type {Buffer[]} */
  const parts = []
  let cursor = 0
  for (const lineIndex of ordered) {
    const line = lines[lineIndex]
    if (line.start < cursor) throw new RepairError('internal error: overlapping line replacements')
    parts.push(plaintext.subarray(cursor, line.start), replacements.get(lineIndex))
    cursor = line.end
  }
  parts.push(plaintext.subarray(cursor))
  return Buffer.concat(parts)
}

/**
 * Rebuild a concatenated-zstd container, recompressing only frames that carry
 * a repaired line and copying every other frame's bytes through untouched.
 *
 * A repaired line's replacement text is owned by the frame in which the line
 * starts; frames that held the remainder of a line spanning a frame boundary
 * are part of the same dirty set. This keeps the concatenated plaintext exact
 * while never touching frames without repaired content.
 */
function rebuildZstdContainer(originalBuffer, decoded, lines, replacements) {
  const { plaintext, segments, frames } = decoded

  /** plaintext offset at which each frame starts. */
  const ranges = []
  let cursor = 0
  for (const segment of segments) {
    ranges.push({ start: cursor, end: cursor + segment.length })
    cursor += segment.length
  }

  /** Index of the frame containing plaintext offset `position`. */
  const frameIndexAt = (position) => {
    if (ranges.length === 0) throw new RepairError('internal error: no frames to map a line onto')
    if (position >= plaintext.length) return ranges.length - 1
    let low = 0
    let high = ranges.length - 1
    while (low < high) {
      const mid = (low + high) >>> 1
      if (ranges[mid].end <= position) low = mid + 1
      else high = mid
    }
    return low
  }

  /** @type {Buffer[][]} */
  const pieces = segments.map(() => [])
  /** @type {Set<number>} */
  const dirty = new Set()

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const replacement = replacements.get(lineIndex)
    if (replacement !== undefined) {
      const firstFrame = frameIndexAt(line.start)
      pieces[firstFrame].push(replacement)
      const lastFrame = frameIndexAt(Math.max(line.start, line.end - 1))
      for (let frame = firstFrame; frame <= lastFrame; frame += 1) dirty.add(frame)
      continue
    }
    let position = line.start
    while (position < line.end) {
      const frame = frameIndexAt(position)
      const stop = Math.min(line.end, ranges[frame].end)
      pieces[frame].push(plaintext.subarray(position, stop))
      position = stop
    }
  }

  /** @type {Buffer[]} */
  const parts = []
  for (let frame = 0; frame < frames.length; frame += 1) {
    if (dirty.has(frame)) {
      const text = Buffer.concat(pieces[frame])
      parts.push(zlib.zstdCompressSync(text, checksumCompressionOptions()))
    } else {
      parts.push(originalBuffer.subarray(frames[frame].start, frames[frame].end))
    }
  }
  return Buffer.concat(parts)
}

/**
 * Compute a repair plan without writing anything.
 *
 * @param {Buffer} buffer raw session artifact bytes.
 * @param {'zstd' | 'jsonl'} kind container kind.
 * @returns {{
 *   kind: 'zstd' | 'jsonl',
 *   changed: boolean,
 *   output: Buffer,
 *   originalPlaintext: Buffer,
 *   repairedEvents: number,
 *   updatedLines: number,
 *   alreadyIgnorable: number,
 *   malformedEvents: {line: number, message: string}[],
 *   frameCount: number,
 *   recompressedFrames: number,
 * }}
 */
export function planRepair(buffer, kind) {
  if (kind !== 'zstd' && kind !== 'jsonl') {
    throw new RepairError(`unsupported session log kind: ${String(kind)}`)
  }
  const decoded = decodeSessionLog(kind, buffer)
  const plaintext = decoded.plaintext
  const lines = splitLines(plaintext)

  /** @type {Map<number, Buffer>} */
  const replacements = new Map()
  /** @type {{line: number, message: string}[]} */
  const malformedEvents = []
  let repairedEvents = 0
  let alreadyIgnorable = 0

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const parsed = parseLineJson(line.content, lineIndex + 1)
    if (!isOmnissiahEvent(parsed)) continue

    if (parsed.ignorable === true) {
      alreadyIgnorable += 1
      continue
    }
    if (!isValidOmnissiahData(parsed.data)) {
      malformedEvents.push({
        line: lineIndex + 1,
        message: `omnissiah/state payload malformed (${describeMalformedData(parsed.data)}); left untouched`
      })
      continue
    }

    // Inserting `ignorable` at the end is the smallest possible change: the
    // existing members keep their order and their serialized bytes.
    const repaired = { ...parsed, ignorable: true }
    replacements.set(lineIndex, Buffer.concat([
      Buffer.from(JSON.stringify(repaired), 'utf8'),
      line.ending
    ]))
    repairedEvents += 1
  }

  if (replacements.size === 0) {
    return {
      kind,
      changed: false,
      output: buffer,
      originalPlaintext: plaintext,
      repairedEvents,
      updatedLines: 0,
      alreadyIgnorable,
      malformedEvents,
      frameCount: decoded.frames.length,
      recompressedFrames: 0
    }
  }

  const output = kind === 'jsonl'
    ? applyReplacements(plaintext, lines, replacements)
    : rebuildZstdContainer(buffer, decoded, lines, replacements)

  return {
    kind,
    changed: true,
    output,
    originalPlaintext: plaintext,
    repairedEvents,
    updatedLines: replacements.size,
    alreadyIgnorable,
    malformedEvents,
    frameCount: decoded.frames.length,
    recompressedFrames: kind === 'zstd'
      ? countRecompressedFrames(buffer, output)
      : 0
  }
}

/** Count frames whose compressed bytes differ between two zstd containers. */
function countRecompressedFrames(originalBuffer, outputBuffer) {
  const before = scanZstdFrames(originalBuffer)
  const after = scanZstdFrames(outputBuffer)
  if (before.tornStart !== undefined || after.tornStart !== undefined) return 0
  if (before.frames.length !== after.frames.length) return after.frames.length
  let count = 0
  for (let i = 0; i < before.frames.length; i += 1) {
    const oldBytes = originalBuffer.subarray(before.frames[i].start, before.frames[i].end)
    const newBytes = outputBuffer.subarray(after.frames[i].start, after.frames[i].end)
    if (!oldBytes.equals(newBytes)) count += 1
  }
  return count
}

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Verify a repaired plaintext JSONL payload against the original plaintext.
 *
 * Fails unless:
 *   - the line count and the count of `omnissiah/state` lines are unchanged;
 *   - the first (header) line is byte-identical;
 *   - every non-repaired line is byte-identical;
 *   - every repaired event is now `"ignorable": true` and otherwise identical;
 *   - every parsed `seq` is unchanged.
 *
 * @param {Buffer} originalPlaintext pre-repair JSONL text.
 * @param {Buffer} repairedPlaintext post-repair JSONL text.
 * @returns {{lineCount: number, eventCount: number}}
 */
export function verifyRepairedLog(originalPlaintext, repairedPlaintext) {
  const before = splitLines(originalPlaintext)
  const after = splitLines(repairedPlaintext)
  if (before.length !== after.length) {
    throw new RepairError(`verification failed: line count changed (${before.length} -> ${after.length})`)
  }

  let eventsBefore = 0
  let eventsAfter = 0

  for (let lineIndex = 0; lineIndex < before.length; lineIndex += 1) {
    const originalLine = before[lineIndex]
    const repairedLine = after[lineIndex]
    const lineNumber = lineIndex + 1
    const original = parseLineJson(originalLine.content, lineNumber)
    const repaired = parseLineJson(repairedLine.content, lineNumber)
    const lineChanged = !originalLine.content.equals(repairedLine.content)
      || !originalLine.ending.equals(repairedLine.ending)

    if (lineIndex === 0 && lineChanged) {
      throw new RepairError('verification failed: header line is not byte-identical')
    }

    // Sequence numbers are the session's event cursor; check the invariant
    // before the per-type content rules so a shifted/reused seq is reported as
    // such rather than as a generic content change.
    const hadSeq = original !== null && typeof original === 'object'
      && Object.prototype.hasOwnProperty.call(original, 'seq')
    const hasSeq = repaired !== null && typeof repaired === 'object'
      && Object.prototype.hasOwnProperty.call(repaired, 'seq')
    if (hadSeq !== hasSeq) {
      throw new RepairError(`verification failed: line ${lineNumber} seq presence changed`)
    }
    if (hadSeq && !Object.is(original.seq, repaired.seq)) {
      throw new RepairError(`verification failed: line ${lineNumber} seq changed`)
    }

    if (isOmnissiahEvent(original)) {
      eventsBefore += 1
      if (isOmnissiahEvent(repaired)) eventsAfter += 1

      const required = original.ignorable !== true && isValidOmnissiahData(original.data)
      if (required) {
        if (repaired.ignorable !== true) {
          throw new RepairError(
            `verification failed: line ${lineNumber} omnissiah/state event did not gain ignorable:true`
          )
        }
        if (canonicalJson(withoutIgnorable(repaired)) !== canonicalJson(withoutIgnorable(original))) {
          throw new RepairError(
            `verification failed: line ${lineNumber} changed beyond the ignorable marker`
          )
        }
      } else if (lineChanged) {
        throw new RepairError(
          `verification failed: line ${lineNumber} changed although it was not a repairable event`
        )
      }
    } else if (lineChanged) {
      throw new RepairError(`verification failed: line ${lineNumber} changed unexpectedly`)
    }
  }

  if (eventsBefore !== eventsAfter) {
    throw new RepairError(
      `verification failed: omnissiah/state event count changed (${eventsBefore} -> ${eventsAfter})`
    )
  }

  return { lineCount: after.length, eventCount: eventsBefore }
}

/**
 * Decode a repaired artifact and verify it against the original artifact.
 *
 * @param {'zstd' | 'jsonl'} kind container kind.
 * @param {Buffer} originalBuffer pre-repair file bytes.
 * @param {Buffer} repairedBuffer post-repair file bytes.
 * @returns {{lineCount: number, eventCount: number, frameCount: number}}
 */
export function verifyContainerRepair(kind, originalBuffer, repairedBuffer) {
  const before = decodeSessionLog(kind, originalBuffer)
  const after = decodeSessionLog(kind, repairedBuffer)
  if (kind === 'zstd' && before.frames.length !== after.frames.length) {
    throw new RepairError(
      `verification failed: zstd frame count changed (${before.frames.length} -> ${after.frames.length})`
    )
  }
  const verified = verifyRepairedLog(before.plaintext, after.plaintext)
  return { ...verified, frameCount: after.frames.length }
}

/* -------------------------------------------------------------------------- */
/* Filesystem helpers                                                         */
/* -------------------------------------------------------------------------- */

/** `yyyyMMdd-HHmmss` in local time, matching the backup naming contract. */
export function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('')
}

/** Choose a non-existing `<file>.bak-<timestamp>` path. */
function nextBackupPath(filePath) {
  const stamp = formatTimestamp(new Date())
  let candidate = `${filePath}${BACKUP_MARKER}${stamp}`
  for (let suffix = 1; fs.existsSync(candidate); suffix += 1) {
    candidate = `${filePath}${BACKUP_MARKER}${stamp}-${suffix}`
  }
  return candidate
}

/** fsync a file that is closed again before returning. */
function fsyncPath(filePath) {
  const fd = fs.openSync(filePath, 'r+')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Replace `targetPath` atomically with `bytes`.
 *
 * Sequence: write a temp file in the same directory, fsync it, read it back
 * and run `verify` on the actual on-disk bytes, copy the original to a
 * timestamped backup, then rename the temp file over the target.
 *
 * @param {string} targetPath file to replace.
 * @param {Buffer} originalBytes current content, used for the backup check.
 * @param {Buffer} bytes replacement content.
 * @param {{noBackup: boolean, verify: (onDisk: Buffer) => void}} options
 * @returns {{backupPath: string | null}}
 */
function installRepairedFile(targetPath, originalBytes, bytes, options) {
  const directory = path.dirname(targetPath)
  const tempPath = path.join(
    directory,
    `.${path.basename(targetPath)}${TEMP_MARKER}${process.pid}-${Date.now().toString(36)}.tmp`
  )

  const fd = fs.openSync(tempPath, 'wx')
  try {
    fs.writeSync(fd, bytes, 0, bytes.length)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }

  try {
    const onDisk = fs.readFileSync(tempPath)
    if (!onDisk.equals(bytes)) throw new RepairError('temporary file does not match the repaired bytes')
    options.verify(onDisk)

    // A live DSH session may append between our read and this replace. Never
    // overwrite bytes we did not plan against: abort and let the operator close
    // the session (or rerun) instead of silently dropping a committed event.
    if (!fs.readFileSync(targetPath).equals(originalBytes)) {
      throw new RepairError('target changed while repairing (concurrent session append?); aborting without touching it')
    }

    let backupPath = null
    if (!options.noBackup) {
      backupPath = nextBackupPath(targetPath)
      fs.copyFileSync(targetPath, backupPath)
      try {
        fsyncPath(backupPath)
      } catch {
        // The backup is a copy; durability of the *target* is what matters and
        // some filesystems refuse fsync on a freshly copied file. Not fatal.
      }
      if (!fs.readFileSync(backupPath).equals(originalBytes)) {
        throw new RepairError(`backup verification failed: ${backupPath}`)
      }
    }

    // Narrow the append window once more immediately before the atomic rename.
    if (!fs.readFileSync(targetPath).equals(originalBytes)) {
      throw new RepairError('target changed while repairing (concurrent session append?); aborting without touching it')
    }

    fs.renameSync(tempPath, targetPath)
    return { backupPath }
  } catch (error) {
    try {
      fs.unlinkSync(tempPath)
    } catch {
      // Already renamed or already gone; nothing to clean up.
    }
    throw error
  }
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

/** True for backup files and our own temp artifacts. */
function isExcludedArtifact(name) {
  return name.includes(BACKUP_MARKER) || name.includes(TEMP_MARKER) || name.endsWith('.tmp')
}

/** Container kind from a file name, or null when unsupported. */
function kindOf(filePath) {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.jsonl.zstd')) return 'zstd'
  if (lower.endsWith('.jsonl')) return 'jsonl'
  return null
}

/**
 * Resolve CLI paths into a deduplicated list of session artifacts.
 *
 * Directories are searched recursively for `session.v4.jsonl.zstd` /
 * `session.v4.jsonl`; backups and temp artifacts are ignored. Explicitly named
 * files are accepted when they look like a session log (`.jsonl[.zstd]`).
 *
 * @param {string[]} inputPaths CLI path operands.
 * @returns {{files: string[], skipped: {path: string, reason: string}[], errors: {path: string, message: string}[]}}
 */
export function discoverSessionFiles(inputPaths) {
  /** @type {Map<string, string>} */
  const files = new Map()
  /** @type {{path: string, reason: string}[]} */
  const skipped = []
  /** @type {{path: string, message: string}[]} */
  const errors = []

  const add = (absolutePath) => {
    const key = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath
    if (!files.has(key)) files.set(key, absolutePath)
  }

  /** @param {string} directory */
  const walk = (directory) => {
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      errors.push({ path: directory, message: `cannot read directory: ${detail}` })
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(entryPath)
      else if (entry.isFile() && SESSION_LOG_NAMES.has(entry.name) && !isExcludedArtifact(entry.name)) {
        add(entryPath)
      }
    }
  }

  for (const input of inputPaths) {
    const absolutePath = path.resolve(input)
    let stats
    try {
      stats = fs.statSync(absolutePath)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const message = /** @type {{code?: string}} */ (error)?.code === 'ENOENT'
        ? 'path does not exist'
        : `cannot access path: ${detail}`
      errors.push({ path: absolutePath, message })
      continue
    }

    if (stats.isDirectory()) {
      const sizeBefore = files.size
      walk(absolutePath)
      if (files.size === sizeBefore) {
        skipped.push({ path: absolutePath, reason: 'no session.v4.jsonl[.zstd] files found' })
      }
      continue
    }

    if (stats.isFile()) {
      const name = path.basename(absolutePath)
      if (isExcludedArtifact(name)) {
        skipped.push({ path: absolutePath, reason: 'backup/temp artifact, not a session log to repair' })
        continue
      }
      if (!SESSION_LOG_NAMES.has(name) && kindOf(name) === null) {
        skipped.push({ path: absolutePath, reason: 'not a .jsonl / .jsonl.zstd session log' })
        continue
      }
      add(absolutePath)
      continue
    }

    errors.push({ path: absolutePath, message: 'path is neither a regular file nor a directory' })
  }

  return { files: [...files.values()], skipped, errors }
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

/** @typedef {{kind: 'ok', dryRun: boolean, noBackup: boolean, paths: string[]} | {kind: 'help'} | {kind: 'usage-error', message: string}} ParsedArgs */

/**
 * Parse CLI arguments (flags may appear before or after paths).
 * @param {string[]} argv process arguments after the script path.
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const paths = []
  let dryRun = false
  let noBackup = false

  for (const argument of argv) {
    if (argument === '--dry-run') dryRun = true
    else if (argument === '--no-backup') noBackup = true
    else if (argument === '--help' || argument === '-h') return { kind: 'help' }
    else if (argument.startsWith('-') && argument !== '-') {
      return { kind: 'usage-error', message: `unknown option: ${argument}` }
    } else paths.push(argument)
  }

  if (paths.length === 0) return { kind: 'usage-error', message: 'no session log path given' }
  return { kind: 'ok', dryRun, noBackup, paths }
}

/**
 * Repair (or dry-run) one session log file.
 * @param {string} filePath absolute artifact path.
 * @param {{dryRun: boolean, noBackup: boolean}} options CLI options.
 */
function repairOneFile(filePath, options) {
  const kind = kindOf(filePath)
  if (kind === null) throw new RepairError('not a .jsonl / .jsonl.zstd session log')
  const before = fs.readFileSync(filePath)
  const plan = planRepair(before, kind)

  for (const malformed of plan.malformedEvents) {
    console.warn(`[WARN] ${filePath}: line ${malformed.line}: ${malformed.message}`)
  }

  if (!plan.changed) {
    console.log(
      `[UNCHANGED] ${filePath} — no omnissiah/state event needs repair ` +
      `(${splitLines(plan.originalPlaintext).length} line(s) scanned, ${plan.alreadyIgnorable} already ignorable)`
    )
    return { status: 'unchanged', plan }
  }

  const verified = verifyContainerRepair(kind, before, plan.output)

  if (options.dryRun) {
    const frames = kind === 'zstd' ? `, ${plan.recompressedFrames}/${plan.frameCount} zstd frame(s) would be recompressed` : ''
    console.log(
      `[DRY-RUN] ${filePath} — would mark ${plan.repairedEvents} omnissiah/state event(s) ` +
      `ignorable:true (${plan.updatedLines} line(s)${frames})`
    )
    console.log(`  verify: ok (in memory; nothing written)`)
    return { status: 'dry-run', plan, verified }
  }

  const { backupPath } = installRepairedFile(filePath, before, plan.output, {
    noBackup: options.noBackup,
    verify: (onDisk) => {
      verifyContainerRepair(kind, before, onDisk)
    }
  })

  const frames = kind === 'zstd' ? `, ${plan.recompressedFrames}/${plan.frameCount} zstd frame(s) recompressed` : ''
  console.log(`[REPAIRED] ${filePath}`)
  console.log(
    `  marked ${plan.repairedEvents} omnissiah/state event(s) ignorable:true ` +
    `(${plan.updatedLines} line(s)${frames})`
  )
  console.log(`  backup: ${backupPath === null ? 'none (--no-backup)' : backupPath}`)
  console.log(
    `  verify: ok (${verified.lineCount} line(s), ${verified.eventCount} omnissiah/state event(s), ` +
    `seq intact, header identical)`
  )
  return { status: 'repaired', plan, verified, backupPath }
}

/**
 * CLI entry point.
 * @param {string[]} argv arguments after the script path.
 * @returns {number} process exit code.
 */
export function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.kind === 'help') {
    console.log(USAGE)
    return 0
  }
  if (parsed.kind === 'usage-error') {
    console.error(`repair-session-log: ${parsed.message}`)
    console.error(USAGE)
    return 2
  }

  try {
    assertZstdSupport()
  } catch (error) {
    console.error(`repair-session-log: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const discovery = discoverSessionFiles(parsed.paths)
  for (const skipped of discovery.skipped) {
    console.log(`[SKIP] ${skipped.path} — ${skipped.reason}`)
  }
  for (const discoveryError of discovery.errors) {
    console.error(`[ERROR] ${discoveryError.path}: ${discoveryError.message}`)
  }

  let repaired = 0
  let dryRun = 0
  let unchanged = 0
  let errors = discovery.errors.length

  for (const file of discovery.files) {
    try {
      const result = repairOneFile(file, parsed)
      if (result.status === 'repaired') repaired += 1
      else if (result.status === 'dry-run') dryRun += 1
      else unchanged += 1
    } catch (error) {
      errors += 1
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`[ERROR] ${file}: ${detail}`)
    }
  }

  const summary = parsed.dryRun
    ? `would repair ${dryRun} file(s), ${unchanged} unchanged, ${discovery.skipped.length} skipped, ${errors} error(s) (dry-run)`
    : `repaired ${repaired} file(s), ${unchanged} unchanged, ${discovery.skipped.length} skipped, ${errors} error(s)`
  console.log(`repair-session-log: ${summary}`)
  return errors > 0 ? 1 : 0
}

/* Execute only when invoked as a CLI; importing this module is side-effect free. */
const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined
  && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
if (isMain) process.exitCode = main(process.argv.slice(2))
