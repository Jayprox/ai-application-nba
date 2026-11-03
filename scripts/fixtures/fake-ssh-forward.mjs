// Test fixture only (scripts/fixtures/fake-railway.sh, M4). Stands in for the
// `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote> ...` child that the real
// `railway connect --tunnel-only` spawns in its own process group. Opens no
// outbound connection except to the local throwaway Postgres: it forwards
// 127.0.0.1:<local> to 127.0.0.1:<remote>, both taken from its `-L` argument.
// FAKE_SSH_LISTEN_PORT (drill negative case) makes it listen on a port that
// differs from the one its argv names.
import net from 'node:net';

const argv = process.argv.slice(2);
const spec = argv[argv.indexOf('-L') + 1] || '';
const m = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/.exec(spec);
if (!m) process.exit(2);
const listenPort = Number(process.env.FAKE_SSH_LISTEN_PORT || m[1]);
const target = Number(m[2]);
net.createServer((c) => {
  const t = net.connect(target, '127.0.0.1');
  c.pipe(t); t.pipe(c);
  c.on('error', () => t.destroy()); t.on('error', () => c.destroy());
}).listen(listenPort, '127.0.0.1');
