/**
 * A small YAML reader, sufficient for the DSH configuration files these test
 * scripts inspect.
 *
 * Why this exists instead of a dependency
 * ---------------------------------------
 * The measurement and verification scripts read `<DSH_HOME>/settings.yaml` and
 * `<DSH_HOME>/.credentials.yaml`. They used `js-yaml`, which meant none of them
 * could run from a fresh clone: ES module resolution for a bare specifier is
 * relative to the importing FILE's directory, so a checkout outside the DSH
 * installation's `node_modules` tree cannot resolve a third-party package at all.
 * Requiring a package install before a script can tell you what is misconfigured
 * is the wrong shape.
 *
 * Scope, stated plainly
 * ---------------------
 * Supported: block mappings, block sequences, nested combinations of the two,
 * inline `- key: value` sequence items, quoted and unquoted scalars, `key:` with
 * a nested block or an empty value, comments, blank lines, block scalars (`|`,
 * `>`, with `-`/`+` chomping), and single-line flow collections (`[text]`,
 * `{a: 1}`, nested).
 *
 * NOT supported: anchors and aliases, MULTI-LINE flow collections, multi-document
 * streams, tags, merge keys, complex keys (`?`), and YAML 1.1 scalar spellings
 * such as `yes`/`no`/`on`/`off` meaning booleans.
 *
 * `parseYaml` does not throw on unexpected content. A value it cannot represent
 * stays a string rather than being guessed at, so a caller sees `undefined` from
 * a lookup instead of a plausible-but-wrong value. If you need certainty about an
 * arbitrary YAML file, use a real implementation; these scripts need
 * `route.baseURL`, `refs[NAME]` and similar scalar lookups.
 *
 * @module tools/yaml-min
 */

/** A sequence item marker, used while classifying lines before parsing. */
const ITEM = 1
/** A `key: value` line marker. */
const PAIR = 2

/**
 * Strip a trailing comment, respecting quotes.
 *
 * A `#` begins a comment only at the start of a line or after whitespace, and
 * only outside quotes -- otherwise `sk-abc#1` and `"a # b"` would be truncated.
 *
 * @param {string} line
 * @returns {string}
 */
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') i++
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/**
 * Interpret one scalar token.
 *
 * @param {string} raw - the text after `key:` or `-`.
 * @returns {string|number|boolean|null}
 */
function scalar(raw) {
  const text = raw.trim()
  if (/^".*"$/.test(text)) return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  if (/^'.*'$/.test(text)) return text.slice(1, -1).replace(/''/g, "'")
  if (text === '') return ''
  if (text === '~' || text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) {
    const n = Number(text)
    return Number.isSafeInteger(n) ? n : text
  }
  if (/^-?\d+\.\d+$/.test(text)) return Number(text)
  return text
}

/** True when the token begins a quoted scalar (so it cannot be a mapping key). */
const startsQuoted = (text) => /^["']/.test(text.trim())

/** True when the token looks like a flow collection. */
const startsWithFlow = (text) => text.startsWith('[') || text.startsWith('{')

/**
 * Split a flow collection's body on top-level commas.
 *
 * Commas inside quotes or nested brackets do not separate items, so the split
 * tracks both.
 *
 * @param {string} body
 * @returns {string[]}
 */
function splitFlow(body) {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') { current += body[i + 1] ?? ''; i++ }
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue }
    if (ch === '[' || ch === '{') depth++
    if (ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += ch
  }
  if (current.trim() !== '' || parts.length > 0) parts.push(current)
  return parts
}

/**
 * Parse a value that may itself be a flow collection.
 *
 * @param {string} text
 * @returns {unknown}
 */
function parseFlowValue(text) {
  const trimmed = text.trim()
  if (startsWithFlow(trimmed)) {
    const flow = parseFlow(trimmed)
    if (flow !== undefined) return flow
  }
  return scalar(trimmed)
}

/**
 * Parse a flow collection (`[a, b]` or `{a: 1}`).
 *
 * These appear in the DSH configuration in one common form, `input: [text]`, and
 * supporting only that would leave the reader silently wrong for a flow sequence
 * of quoted strings. Nested flow is handled by recursing, which costs a few lines
 * and removes the whole class of error rather than one instance of it.
 *
 * @param {string} text - a trimmed token starting with `[` or `{`.
 * @returns {unknown[]|Record<string, unknown>|undefined} undefined when the token is
 *   not a complete flow collection, so the caller can treat it as a string instead.
 */
function parseFlow(text) {
  const open = text[0]
  const close = open === '[' ? ']' : '}'
  if (!text.endsWith(close)) return undefined
  const body = text.slice(1, -1).trim()
  if (body === '') return open === '[' ? [] : {}

  if (open === '[') return splitFlow(body).map((part) => parseFlowValue(part))

  const out = {}
  for (const part of splitFlow(body)) {
    const pair = splitKeyValue(part.trim())
    out[pair ? pair.key : part.trim()] = pair ? parseFlowValue(pair.rest) : ''
  }
  return out
}

/**
 * Interpret a value token: a flow collection, or a scalar.
 *
 * @param {string} raw
 * @returns {unknown}
 */
function valueOf(raw) {
  const trimmed = raw.trim()
  if (startsWithFlow(trimmed)) {
    const flow = parseFlow(trimmed)
    if (flow !== undefined) return flow
  }
  return scalar(trimmed)
}

/** Split `key: value` on the first colon that is outside quotes. */
function splitKeyValue(content) {
  let quote = null
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') i++
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ':') {
      const key = content.slice(0, i).trim()
      if (key === '') return undefined
      const after = content.slice(i + 1)
      // `a:b` with no space after the colon is a plain scalar in YAML, not a mapping.
      if (after.length > 0 && !/^\s/.test(after)) return undefined
      return { key: key.replace(/^["']|["']$/g, ''), rest: after.trim() }
    }
  }
  return undefined
}

/**
 * Read a block scalar (`|` or `>`) and its indented lines.
 *
 * The cursor already points at the first candidate content line.
 */
function readBlockScalar(nodes, cursor, parentIndent, style, chomp) {
  const lines = []
  let blockIndent = null
  while (cursor.i < nodes.length) {
    const node = nodes[cursor.i]
    if (node.indent <= parentIndent) break
    if (blockIndent === null) blockIndent = node.indent
    lines.push(node.raw.replace(/\r$/, '').slice(Math.min(blockIndent, node.raw.length)))
    cursor.i++
  }
  let joined = style === '>'
    ? lines.join(' ').replace(/[ \t]+/g, ' ').trim()
    : lines.join('\n')
  if (chomp === '-') joined = joined.replace(/\n+$/, '')
  else if (chomp === '+') joined += '\n'
  else joined = `${joined.replace(/\n*$/, '')}\n`
  return joined
}

/**
 * Parse the block that starts at the cursor.
 *
 * The block's container type is decided by its first line; every line at the
 * same indentation and of the same kind belongs to it, and a line of the other
 * kind at that indentation ends it -- which is how a `key:` followed by
 * `- item` lines becomes a mapping whose value is a sequence.
 *
 * @param {Array<{kind: number, indent: number, rest: string, raw: string}>} nodes
 * @param {{i: number}} cursor
 * @param {number} minIndent
 * @param {number|null} kind - forced container kind, or null to decide from content.
 * @returns {{value: unknown, kind: number|null}}
 */
function parseBlock(nodes, cursor, minIndent, kind) {
  const items = []
  const map = {}
  let resolved = kind
  let first = true

  while (cursor.i < nodes.length) {
    const node = nodes[cursor.i]
    if (node.indent < minIndent) break
    // Only the first line may sit deeper than the requested indent; afterwards a
    // deeper line belongs to a child that has already been consumed.
    if (!first && node.indent > minIndent) break
    if (resolved !== null && node.indent === minIndent && node.kind !== resolved) break

    if (node.kind === ITEM) {
      resolved = ITEM
      first = false
      const itemIndent = node.indent
      const rest = node.rest
      cursor.i++

      if (rest === '') {
        // The item is whatever block follows, whatever its indentation.
        const child = parseBlock(nodes, cursor, cursor.i < nodes.length ? nodes[cursor.i].indent : minIndent + 1, null)
        items.push(child.value)
        continue
      }

      const pair = startsQuoted(rest) ? undefined : splitKeyValue(rest)
      if (pair) {
        // `- key: value` opens a mapping whose later keys align under `key`.
        //
        // That alignment is NOT `itemIndent + 1`. For `- id: x` the following
        // keys line up under `id`, two columns deeper than the dash. Passing
        // `itemIndent + 1` made the block parser judge those keys as belonging to
        // a parent block and stop after the first pair, which silently dropped
        // every other field of the item -- `contextWindow` in a model entry, for
        // example. Deriving the indent from the first child is exact.
        const nestedIndent = cursor.i < nodes.length && nodes[cursor.i].indent > itemIndent
          ? nodes[cursor.i].indent
          : itemIndent + 1
        const child = parseBlock(nodes, cursor, nestedIndent, PAIR)
        const entry = child.value !== null && typeof child.value === 'object' && !Array.isArray(child.value)
          ? child.value
          : {}
        if (pair.rest === '') entry[pair.key] = undefined
        else {
          const indicators = /^([|>])([-+]?)$/.exec(pair.rest)
          entry[pair.key] = indicators
            ? readBlockScalar(nodes, cursor, itemIndent, indicators[1], indicators[2])
            : valueOf(pair.rest)
        }
        items.push(entry)
        continue
      }

      // A plain or quoted scalar item may still be followed by a nested block.
      if (!startsQuoted(rest) && cursor.i < nodes.length && nodes[cursor.i].indent > itemIndent) {
        const child = parseBlock(nodes, cursor, nodes[cursor.i].indent, null)
        items.push(child.value)
      } else {
        items.push(valueOf(rest))
      }
      continue
    }

    // --- a `key: value` line ------------------------------------------------
    const pair = startsQuoted(node.rest) ? undefined : splitKeyValue(node.rest)
    if (!pair) {
      // A bare scalar where a mapping was expected. Accept it only as the whole
      // block; otherwise skip the line rather than inventing a key.
      if (first && resolved === null) {
        cursor.i++
        return { value: valueOf(node.rest), kind: PAIR }
      }
      cursor.i++
      continue
    }

    resolved = PAIR
    first = false
    cursor.i++

    if (pair.rest === '') {
      // Either a nested block or an empty value.
      const deeper = cursor.i < nodes.length && nodes[cursor.i].indent > node.indent
      if (deeper) {
        const child = parseBlock(nodes, cursor, nodes[cursor.i].indent, null)
        map[pair.key] = child.value
      } else {
        map[pair.key] = ''
      }
    } else {
      const indicators = /^([|>])([-+]?)$/.exec(pair.rest)
      map[pair.key] = indicators
        ? readBlockScalar(nodes, cursor, node.indent, indicators[1], indicators[2])
        : valueOf(pair.rest)
    }
  }

  if (resolved === ITEM) return { value: items, kind: ITEM }
  return { value: map, kind: resolved ?? PAIR }
}

/**
 * Parse a YAML document into plain JavaScript values.
 *
 * @param {string} text - file contents.
 * @returns {unknown} a mapping, a sequence, a scalar, or `undefined` for empty input.
 */
export function parseYaml(text) {
  /** Non-blank, comment-stripped lines with their indentation. */
  const nodes = []
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.trim() === '') continue
    const stripped = stripComment(raw)
    if (stripped.trim() === '') continue
    const trimmed = stripped.trim()
    if (trimmed === '---' || trimmed === '...') continue
    const indent = stripped.length - stripped.trimStart().length
    if (trimmed === '-' || /^-\s/.test(trimmed)) {
      nodes.push({ kind: ITEM, indent, rest: trimmed === '-' ? '' : trimmed.slice(1).trim(), raw })
    } else {
      nodes.push({ kind: PAIR, indent, rest: trimmed, raw })
    }
  }
  if (nodes.length === 0) return undefined

  const cursor = { i: 0 }
  return parseBlock(nodes, cursor, nodes[0].indent, null).value
}
