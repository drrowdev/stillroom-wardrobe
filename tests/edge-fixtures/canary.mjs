// CI-only PR-3b egress canary on the separate non-internal `stillroom-canary` network. It records every TCP
// connection and every DNS datagram/connection it receives; the fixture runtime must never reach it.
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { pathToFileURL } from 'node:url';

export const CANARY_TCP_PORT = 8443;
export const CANARY_DNS_PORT = 5300;
export const CANARY_NAME = 'edge-canary.example.test';
export const RECORD = 'EDGE-CANARY-HIT';

/** Counts canary hit records in container log text. */
export function canaryHits(logText) {
  if (typeof logText !== 'string') return null;
  return logText.split(/\r?\n/).filter((line) => line.startsWith(`${RECORD} `)).length;
}

function main() {
  const hit = (kind) => console.log(`${RECORD} ${kind}`);
  createServer((socket) => { hit('tcp'); socket.destroy(); }).listen(CANARY_TCP_PORT, '0.0.0.0');
  createServer((socket) => { hit('dns-tcp'); socket.destroy(); }).listen(CANARY_DNS_PORT, '0.0.0.0');
  const udp = createSocket('udp4');
  udp.on('message', () => hit('dns-udp'));
  udp.bind(CANARY_DNS_PORT, '0.0.0.0');
  console.log('EDGE-CANARY listening');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
