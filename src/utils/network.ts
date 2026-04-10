import os from "os";

/** Return non-internal IPv4 addresses (useful for printing server mode instructions). */
export function getLocalIPs(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}
