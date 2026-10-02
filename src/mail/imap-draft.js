// Gmail Drafts fallback over IMAP: used when SMTP delivery fails twice.
// Appends the message to "[Gmail]/Drafts" so the user still has it ready to send.
import tls from 'node:tls';
import { openTunnel, tlsOverTunnel, proxyFromEnv } from '../lib/proxy.js';

function quote(s) {
  return `"${String(s).replace(/([\\"])/g, '\\$1')}"`;
}

function createReader(socket) {
  let buffer = '';
  const lines = [];
  const waiters = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  return {
    lines,
    nextLine(timeoutMs = 20000) {
      if (lines.length) return Promise.resolve(lines.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('IMAP 响应超时')), timeoutMs);
        waiters.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      });
    },
  };
}

/** Read complete IMAP responses until a tagged completion line arrives. */
async function command(socket, reader, tag, text, timeoutMs = 25000) {
  socket.write(`${tag} ${text}\r\n`);
  const collected = [];
  for (;;) {
    const line = await reader.nextLine(timeoutMs);
    collected.push(line);
    if (line.startsWith(`${tag} `)) {
      return { ok: /^OK/i.test(line.slice(tag.length + 1).trim()), text: collected.join('\n') };
    }
  }
}

export async function appendDraft({
  user,
  password,
  rawMessage,
  host = 'imap.gmail.com',
  port = 993,
  proxy = proxyFromEnv(),
  log = () => {},
}) {
  let socket;
  try {
    const tunnel = await openTunnel({ host, port }, proxy, 15000);
    socket = await tlsOverTunnel(tunnel, host, 20000);
  } catch (err) {
    return { ok: false, error: `IMAP 连接失败：${err.message}`, transcript: [] };
  }
  return new Promise((resolve) => {
    {
      const reader = createReader(socket);
      const transcript = [];
      const record = (line) => transcript.push(line);
      (async () => {
        try {
          const greeting = await reader.nextLine();
          record(greeting);
          const login = await command(socket, reader, 'a1', `LOGIN ${quote(user)} ${quote(password)}`);
          record(`a1 LOGIN ... ${login.ok ? 'OK' : login.text}`);
          if (!login.ok) return resolve({ ok: false, error: login.text, transcript });

          const bytes = Buffer.byteLength(rawMessage, 'utf8');
          socket.write(`a2 APPEND "[Gmail]/Drafts" (\\Draft) {${bytes}}\r\n`);
          const cont = await reader.nextLine();
          record(cont);
          if (!cont.startsWith('+')) return resolve({ ok: false, error: `APPEND 未获得续行许可：${cont}`, transcript });
          socket.write(`${rawMessage}\r\n`);
          const appended = await command(socket, reader, 'a2', '', 30000).catch(() => ({ ok: false, text: 'timeout' }));
          record(`a2 APPEND ... ${appended.ok ? 'OK' : appended.text}`);
          await command(socket, reader, 'a3', 'LOGOUT').catch(() => {});
          socket.end();
          return resolve({ ok: appended.ok, transcript, draftMailbox: '[Gmail]/Drafts' });
        } catch (err) {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
          return resolve({ ok: false, error: err.message, transcript });
        }
      })();
    }
  });
}
