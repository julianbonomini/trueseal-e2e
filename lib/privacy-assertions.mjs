// G7 privacy assertions (E2E-7, relay ADR-0012 "Release gate",
// trueseal-roadmap#26): pure functions over captured relay log output and
// raw inbox.db bytes. Kept pure so the negative controls can drive them
// with planted data and prove they fail.
//
// The public wording this evidence backs: "The relay never logs, stores or
// uses your IP address" — in normal AND dev mode — plus "no client metadata
// in normal-mode logs" (key prefixes, sizes, blob IDs, session timing).

/**
 * The relay's own bind addresses appear in one startup lifecycle line
 * ("trueseal-relay running (push=… receive=… health=…)") — that is the
 * relay's own configuration, which ADR-0012 explicitly allows, not a client
 * address. Every other IP form fails. A client leak over loopback shows up
 * as 127.0.0.1:<ephemeral port>, which the allowlist rejects.
 */
export function collectAddressFindings(text, { allowedBindAddrs = [] } = {}) {
  const findings = []
  const allowed = new Set(allowedBindAddrs)

  for (const match of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g)) {
    if (!allowed.has(match[0])) {
      findings.push(`IPv4 form ${JSON.stringify(match[0])}`)
    }
  }
  for (const match of text.matchAll(/\[[0-9a-fA-F:]+\](?::\d{1,5})?/g)) {
    findings.push(`bracketed IPv6 form ${JSON.stringify(match[0])}`)
  }
  for (const match of text.matchAll(/\b::1\b/g)) {
    findings.push(`IPv6 loopback ${JSON.stringify(match[0])}`)
  }
  for (const match of text.matchAll(/\b(?:addr|peer|remote(?:_addr)?)\s*=/gi)) {
    findings.push(`address field name ${JSON.stringify(match[0])}`)
  }
  return findings
}

/**
 * Normal mode only: client metadata — the field names the relay's dev-mode
 * lines use (device=, recipient=, blob_id, envelope sizes, durations) plus
 * any known key material in hex, full or 4-byte prefix. me.id derives from
 * the device's SIGNING key, which the relay never sees; its appearance in
 * any form is a leak by construction.
 */
export function collectMetadataFindings(text, { knownIds = [] } = {}) {
  const findings = []
  for (const match of text.matchAll(/\b(?:device|recipient|blob_id|envelope|duration|size)\s*=/g)) {
    findings.push(`client metadata field ${JSON.stringify(match[0])}`)
  }
  for (const id of knownIds) {
    if (typeof id !== 'string' || id.length < 8) continue
    if (text.includes(id)) findings.push(`known device id ${JSON.stringify(id.slice(0, 12))}…`)
    const prefix = id.slice(0, 8)
    if (text.includes(prefix)) findings.push(`known device id prefix ${JSON.stringify(prefix)}`)
  }
  return findings
}

/**
 * The sealed envelope (sync ADR-0031) means a payload marker can never
 * appear in the store as plaintext; the schema stores recipient keys as raw
 * 32-byte blobs and ciphertext envelopes, so no ASCII address form or hex
 * key string has any legitimate reason to exist in the file bytes.
 */
export function collectStoreFindings(dbBuffer, { markers = [], knownIds = [] } = {}) {
  const findings = []
  const asText = dbBuffer.toString('latin1')
  for (const marker of markers) {
    if (asText.includes(marker)) findings.push(`plaintext payload marker ${JSON.stringify(marker)}`)
  }
  for (const match of asText.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
    findings.push(`ASCII IPv4 form in store ${JSON.stringify(match[0])}`)
  }
  for (const match of asText.matchAll(/\[?[0-9a-fA-F]*::[0-9a-fA-F:]+\]?/g)) {
    findings.push(`ASCII IPv6 form in store ${JSON.stringify(match[0])}`)
  }
  for (const id of knownIds) {
    if (typeof id !== 'string' || id.length < 8) continue
    if (asText.includes(id)) findings.push(`ASCII device id in store ${JSON.stringify(id.slice(0, 12))}…`)
  }
  return findings
}

/** Throws (fails the check) with full context when any finding exists. */
export function assertNoFindings(scope, findings) {
  if (findings.length > 0) {
    const error = new Error(`G7 privacy check failed (${scope}):\n - ${findings.join('\n - ')}`)
    error.findings = findings
    throw error
  }
}
