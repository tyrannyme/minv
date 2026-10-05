const credentialParameter = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|secret|api[_-]?key|authorization|auth|signature|sig|key|client[_-]?secret|credential|x-amz-signature|x-amz-credential|x-amz-security-token)$/i;

/** For error/display text only. Never apply this to file contents or Git input. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/gi, '$1[redacted]@')
    .replace(/([?&])([a-z0-9_%.-]+)=([^&#\s"'<>]*)/gi, (whole: string, separator: string, encodedKey: string) => {
      let key = encodedKey;
      try { key = decodeURIComponent(encodedKey); } catch { /* Keep malformed names as display text. */ }
      return credentialParameter.test(key) ? `${separator}${encodedKey}=[redacted]` : whole;
    })
    .replace(/(authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]');
}

export function safeErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
