// Masks a secret in output written in arbitrary chunks. Text is buffered to a newline and masked per whole line,
// so a key split across two write() calls is still caught. flush() writes what is left (call it on exit).
export function createLineMasker(secret, write) {
  const mask = (s) => (secret && secret.length >= 4 ? s.split(secret).join('[redacted]') : s);
  let buf = '';
  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      const nl = buf.lastIndexOf('\n');
      if (nl >= 0) { write(mask(buf.slice(0, nl + 1))); buf = buf.slice(nl + 1); }
      else if (buf.length > 65536) {
        // Over-long line: mask everything first, then write all but the last (key length - 1) characters, which is
        // the longest prefix of a key that could still be completed by the next write.
        const m = mask(buf), keep = secret && secret.length >= 4 ? secret.length - 1 : 0;
        write(m.slice(0, m.length - keep)); buf = m.slice(m.length - keep);
      }
    },
    /** End the current line: pending text is written masked, followed by a newline, so the next output starts fresh. */
    endLine() { if (buf) { write(mask(buf) + '\n'); buf = ''; } },
    flush() { if (buf) { write(mask(buf)); buf = ''; } },
  };
}
