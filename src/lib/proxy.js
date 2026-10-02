// Proxy tunneling helpers (HTTP CONNECT + SOCKS5) so Gmail IMAP/SMTP can be reached
// from networks that block the mail ports. Configured through GMAIL_PROXY=host:port.
import net from 'node:net';
import tls from 'node:tls';

export function parseProxy(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const withScheme = /^\w+:\/\//.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    return {
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'socks5:' ? 1080 : 8080)),
      type: url.protocol.startsWith('socks') ? 'socks5' : 'http',
    };
  } catch {
    return null;
  }
}

export function proxyFromEnv(env = process.env) {
  return (
    parseProxy(env.GMAIL_PROXY) ||
    parseProxy(env.SMTP_PROXY) ||
    parseProxy(env.HTTPS_PROXY || env.https_proxy) ||
    null
  );
}

function tcpConnect({ host, port }, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port }, () => resolve(sock));
    sock.on('error', reject);
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      reject(new Error(`连接代理 ${host}:${port} 超时`));
    });
  });
}

async function httpConnect(proxy, target, timeoutMs) {
  const sock = await tcpConnect(proxy, timeoutMs);
  return new Promise((resolve, reject) => {
    let buf = '';
    const done = (fn, arg) => {
      sock.removeListener('data', onData);
      sock.removeListener('close', onClose);
      fn(arg);
    };
    function onData(chunk) {
      buf += chunk.toString('utf8');
      if (buf.includes('\r\n\r\n')) {
        const statusLine = buf.split('\r\n')[0];
        if (/^HTTP\/1\.[01] 200/.test(statusLine)) {
          sock.setTimeout(0);
          done(resolve, sock);
        } else done(reject, new Error(`HTTP CONNECT 被拒绝：${statusLine}`));
      }
    }
    function onClose() {
      done(reject, new Error('代理在 CONNECT 阶段关闭了连接'));
    }
    sock.on('data', onData);
    sock.on('close', onClose);
    sock.on('error', (err) => done(reject, err));
    sock.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n\r\n`);
  });
}

async function socks5Connect(proxy, target, timeoutMs) {
  const sock = await tcpConnect(proxy, timeoutMs);
  return new Promise((resolve, reject) => {
    let stage = 0;
    const done = (fn, arg) => {
      sock.removeListener('data', onData);
      fn(arg);
    };
    function onData(chunk) {
      if (stage === 0) {
        if (chunk[0] !== 0x05) return done(reject, new Error('非 SOCKS5 响应'));
        if (chunk[1] !== 0x00) return done(reject, new Error(`SOCKS5 需要认证（method ${chunk[1]}）`));
        stage = 1;
        const hostBuf = Buffer.from(target.host, 'utf8');
        sock.write(
          Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
          ])
        );
      } else {
        if (chunk[1] !== 0x00) return done(reject, new Error(`SOCKS5 连接失败（code ${chunk[1]}）`));
        sock.setTimeout(0);
        done(resolve, sock);
      }
    }
    sock.on('data', onData);
    sock.on('error', (err) => done(reject, err));
    sock.on('close', () => done(reject, new Error('代理在 SOCKS5 握手阶段关闭了连接')));
  });
}

/** Open a TCP tunnel to target through the proxy (or a direct connection when no proxy). */
export async function openTunnel(target, proxy, timeoutMs = 12000) {
  if (!proxy) {
    return await new Promise((resolve, reject) => {
      const sock = net.connect({ host: target.host, port: target.port }, () => resolve(sock));
      sock.on('error', reject);
      sock.setTimeout(timeoutMs, () => {
        sock.destroy();
        reject(new Error(`连接 ${target.host}:${target.port} 超时`));
      });
    });
  }
  const order = proxy.type === 'socks5' ? [socks5Connect, httpConnect] : [httpConnect, socks5Connect];
  let lastError;
  for (const attempt of order) {
    try {
      return await attempt(proxy, target, timeoutMs);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('代理连接失败');
}

/** TLS-connect over a tunnel (implicit TLS, as used by SMTP:465 / IMAP:993). */
export function tlsOverTunnel(socket, servername, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername, rejectUnauthorized: false }, () => {
      tlsSocket.setTimeout(0);
      resolve(tlsSocket);
    });
    tlsSocket.on('error', reject);
    tlsSocket.setTimeout(timeoutMs, () => {
      tlsSocket.destroy();
      reject(new Error(`TLS 握手超时：${servername}`));
    });
  });
}
