// On-demand daemon discovery: parallel Promise.allSettled scan of
// 127.0.0.1:47800-47820/handshake. Runs only when the popup opens or the user
// clicks Refresh — no persistent polling.

import { PORT_RANGE, type HandshakeInfo } from '../shared/protocol';

const SCAN_TIMEOUT_MS = 400;

export async function scanForDaemons(): Promise<HandshakeInfo[]> {
  const attempts = PORT_RANGE.map(async (port): Promise<HandshakeInfo | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/handshake`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) return null;
      const info = (await res.json()) as HandshakeInfo;
      if (info.protocol_version !== 2) return null; // incompatible daemon
      info.port = port;
      return info;
    } catch {
      return null; // no daemon on this port
    } finally {
      clearTimeout(timer);
    }
  });

  const settled = await Promise.allSettled(attempts);
  const found: HandshakeInfo[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) {
      found.push(s.value);
    }
  }
  found.sort((a, b) => a.port - b.port);
  return found;
}
