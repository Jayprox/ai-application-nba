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
      else if (buf.length > 65536) { write(mask(buf.slice(0, buf.length - secret.length))); buf = buf.slice(buf.length - secret.length); } // bounded memory; keep a key-length tail
    },
    flush() { if (buf) { write(mask(buf)); buf = ''; } },
  };
}
