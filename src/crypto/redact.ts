const sensitiveKey = /token|secret|password|authorization|cookie|api.?key|signature/i

/**
 * Removes credential-shaped fields and every known secret value from data
 * that may reach logs, the database or an API response.
 */
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map(item => redact(item, secrets))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !sensitiveKey.test(key))
    .map(([key, item]) => [key, redact(item, secrets)]))
}

export function redactText(value: string, secrets: readonly string[] = []) {
  let output = value
  for (const secret of secrets) if (secret.length >= 8) output = output.replaceAll(secret, '[redacted]')
  // Query-string credentials in URLs echoed by upstream errors.
  return output.replace(/(\b(?:access_token|client_secret|code|appsecret_proof|input_token|fb_exchange_token)=)[^&\s"']+/gi, '$1[redacted]')
}
