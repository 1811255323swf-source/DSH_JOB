// Minimal, dependency-free SMTP client (implicit TLS :465 and STARTTLS :587).
// It returns the raw server transcript so the caller can prove a real "SENT" acknowledgement.
import net from 'node:net';
import tls from 'node:tls';
import { openTunnel, tlsOverTunnel, proxyFromEnv } from '../lib/proxy.js';

const CRLF = '\r\n';

function dotStuff(body) {
  return body.replace(/\r?\n/g, CRLF).replace(/^\./gm, '..');
}

class SmtpSession {
  constructor(socket, onLine) {
    this.socket = socket;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.onLine = onLine;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, '');
        this.buffer = this.buffer.slice(idx + 1);
        this.lines.push(line);
        this.onLine?.(line);
        const w = this.waiters.shift();
        if (w) w(line);
      }
    });
  }

  nextLine(timeoutMs = 20000) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMTP 响应超时')), timeoutMs);
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  async command(cmd, expectCodes, timeoutMs = 20000) {
    this.socket.write(cmd + CRLF);
    const collected = [];
    // Read until a line whose code is final (4th char is a space) — handles multiline replies.
    for (;;) {
      const line = await this.nextLine(timeoutMs);
      collected.push(line);
      const code = Number(line.slice(0, 3));
      const sep = line[3];
      if (sep === ' ' || line.length < 4) {
        if (expectCodes && !expectCodes.includes(code)) {
          throw new Error(`SMTP 期望 ${expectCodes.join('/')} 实际 ${line}`);
        }
        return { code, lines: collected, text: collected.join('\n') };
      }
    }
  }
}

function connect({ host, port, timeoutMs, proxy }) {
  return openTunnel({ host, port }, proxy, timeoutMs);
}

/**
 * Send a MIME message through Gmail SMTP.
 * @returns {Promise<{ok:boolean, transcript:string[], messageId?:string, error?:string}>}
 */
export async function sendMail({
  user,
  password,
  to,
  rawMessage,
  host = 'smtp.gmail.com',
  port = 465,
  timeoutMs = 30000,
  useStartTls = false,
  proxy = proxyFromEnv(),
  log = () => {},
}) {
  const transcript = [];
  let socket;
  try {
    // Implicit TLS (:465) wraps the tunnel immediately; :587 speaks plain until STARTTLS.
    let rawSocket = await connect({ host, port, timeoutMs, proxy });
    socket = useStartTls ? rawSocket : await tlsOverTunnel(rawSocket, host, timeoutMs);
    const session = new SmtpSession(socket, (line) => {
      if (!/AUTH|LOGIN|^[0-9]{3} .*[Pp]assword/.test(line)) transcript.push(line);
    });

    const greet = await session.nextLine(timeoutMs);
    transcript.push(greet);
    if (!greet.startsWith('220')) throw new Error(`SMTP 问候异常：${greet}`);

    if (useStartTls) {
      await session.command('STARTTLS', [220]);
      const upgraded = await tlsOverTunnel(rawSocket, host, timeoutMs);
      socket = upgraded;
      session.socket = upgraded;
      session.buffer = '';
      session.lines = [];
      session.waiters = [];
      upgraded.setEncoding('utf8');
      upgraded.on('data', (chunk) => {
        session.buffer += chunk;
        let idx;
        while ((idx = session.buffer.indexOf('\n')) >= 0) {
          const line = session.buffer.slice(0, idx).replace(/\r$/, '');
          session.buffer = session.buffer.slice(idx + 1);
          session.lines.push(line);
          transcript.push(line);
          const w = session.waiters.shift();
          if (w) w(line);
        }
      });
      await session.command(`EHLO ${host}`, [250]);
    } else {
      await session.command(`EHLO ${host}`, [250]);
    }

    const authLogin = Buffer.from(String(user), 'utf8').toString('base64');
    const authPass = Buffer.from(String(password), 'utf8').toString('base64');
    const authStart = await session.command('AUTH LOGIN', [334, 235, 503]);
    if (authStart.code === 334) {
      await session.command(authLogin, [334]);
      const done = await session.command(authPass, [235]);
      if (done.code !== 235) throw new Error(`SMTP 认证失败：${done.text}`);
    }

    await session.command(`MAIL FROM:<${user}>`, [250]);
    await session.command(`RCPT TO:<${to}>`, [250, 251]);
    await session.command('DATA', [354]);
    socket.write(`${dotStuff(rawMessage)}${CRLF}.${CRLF}`);
    const accepted = await session.command('', [250]); // empty command: just read the reply after the body
    const status = accepted.text;
    transcript.push(status);

    try {
      await session.command('QUIT', [221, 250]);
    } catch {
      /* QUIT failures do not affect delivery */
    }
    socket.end();

    const messageId = (status.match(/(?:OK\s+)?([A-Za-z0-9._-]{8,}@[A-Za-z0-9._-]+)/) || [])[1] || '';
    const sentMarker = /^250[\s-]/m.test(status) && /OK/i.test(status);
    return { ok: sentMarker, messageId, transcript, status };
  } catch (err) {
    try {
      socket?.destroy();
    } catch {
      /* ignore */
    }
    return { ok: false, error: err.message, transcript };
  }
}

export function buildRawMessage({ from, fromName, to, subject, text, html, date = new Date() }) {
  const boundary = `----cppinternradar${Math.random().toString(36).slice(2)}`;
  const encodeHeader = (s) => (/^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
  const headers = [
    `From: ${encodeHeader(fromName)} <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(text, 'utf8').toString('base64')),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(html, 'utf8').toString('base64')),
    `--${boundary}--`,
    '',
  ];
  return `${headers.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}`;
}

function wrap76(b64) {
  return (b64.match(/.{1,76}/g) || []).join(CRLF);
}

export { net };
