import { randomBytes } from "node:crypto";
import { Client } from "ssh2";
import { openSocket, buildConfig } from "./session/children/connection";

/**
 * Spin up a fresh DigitalOcean droplet with password auth enabled, then wait
 * until SSH actually accepts the login. The whole point is one-click: the app
 * mints a random root password (stored in the profile; the user never types
 * it), creates the box, and hands back a ready-to-connect host + password.
 *
 * Zero DO SDK dependency - the v2 REST API over fetch.
 */

const DO_API = "https://api.digitalocean.com/v2";

/** The standard research VM: 60 Intel vCPU / 120 GB / 750 GB NVMe, CPU-Optimized
 *  Premium Intel, about $1,639/mo. Slug `c-60-intel`, available in nyc1. */
export const DEFAULT_DROPLET = {
  size: "c-60-intel",
  image: "ubuntu-24-04-x64",
  region: "nyc1",
} as const;

export interface SpinupOptions {
  name?: string;
  region?: string;
  size?: string;
  image?: string;
  /** Optional problem.md contents to seed the snapshot on first provision. */
  seedProblem?: string;
}

export interface SpinupResult {
  host: string;
  username: "root";
  password: string;
  name: string;
  dropletId: number;
}

/** Mint a fresh random root password for a new droplet. It is stored in the
 *  machine profile (the user never types it). URL-safe base64 only, so it is
 *  safe inside the single-quoted `echo 'root:…' | chpasswd` in cloud-init. */
export function mintRootPassword(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * cloud-init that reliably enables root password login on Ubuntu 24.04.
 * DO images disable it via the main sshd_config AND a 50-cloud-init drop-in;
 * sshd uses the first value it reads, so we remove that drop-in, add a
 * first-sorted 00- drop-in forcing yes, sed the main file for good measure,
 * set the password, and restart ssh.
 */
export function buildCloudInit(password: string): string {
  return `#!/bin/bash
set -e
rm -f /etc/ssh/sshd_config.d/50-cloud-init.conf 2>/dev/null || true
printf 'PasswordAuthentication yes\\nPermitRootLogin yes\\n' > /etc/ssh/sshd_config.d/00-tabs.conf
sed -i 's/^#\\?PasswordAuthentication .*/PasswordAuthentication yes/g' /etc/ssh/sshd_config || true
sed -i 's/^#\\?PermitRootLogin .*/PermitRootLogin yes/g' /etc/ssh/sshd_config || true
echo 'root:${password}' | chpasswd
systemctl restart ssh || systemctl restart sshd || true
`;
}

async function doFetch(token: string, pathname: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${DO_API}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = (body as { message?: string })?.message || text || `HTTP ${res.status}`;
    throw new Error(`DigitalOcean API ${res.status}: ${msg}`);
  }
  return body;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the droplet until it is `active` and has a public IPv4. */
async function waitForActiveIp(
  token: string,
  id: number,
  onProgress: (m: string) => void
): Promise<string> {
  for (let attempt = 1; attempt <= 60; attempt++) {
    const body = (await doFetch(token, `/droplets/${id}`)) as {
      droplet?: { status?: string; networks?: { v4?: { type: string; ip_address: string }[] } };
    };
    const d = body.droplet;
    const pub = d?.networks?.v4?.find((n) => n.type === "public");
    if (d?.status === "active" && pub?.ip_address) return pub.ip_address;
    onProgress(`droplet booting (${d?.status ?? "new"})… ${attempt * 5}s`);
    await sleep(5000);
  }
  throw new Error("timed out waiting for the droplet to become active");
}

/** Retry an SSH password login until cloud-init has enabled it (~1-2 min). */
async function waitForSsh(
  host: string,
  password: string,
  onProgress: (m: string) => void
): Promise<void> {
  let lastErr = "";
  for (let attempt = 1; attempt <= 40; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        openSocket(host, 22)
          .then((sock) => {
            const conn = new Client();
            conn.once("ready", () => {
              conn.end();
              resolve();
            });
            conn.once("error", reject);
            conn.on("keyboard-interactive", (_n, _i, _l, _p, finish) => finish([password]));
            conn.connect(buildConfig(sock, "root", { password }));
          })
          .catch(reject);
      });
      return; // login succeeded
    } catch (e) {
      lastErr = (e as Error).message;
      onProgress(`waiting for SSH + cloud-init… ${attempt * 6}s`);
      await sleep(6000);
    }
  }
  throw new Error(`droplet up but SSH login never succeeded: ${lastErr}`);
}

/** Create the droplet and return connection details once it accepts SSH. */
export async function spinupDroplet(
  token: string,
  opts: SpinupOptions,
  onProgress: (m: string) => void = () => {}
): Promise<SpinupResult> {
  if (!token) throw new Error("DIGITAL_OCEAN_API_KEY is not set (add it to .env).");
  const name = opts.name?.trim() || `tabs-vm-${Date.now().toString(36)}`;
  const password = mintRootPassword();

  onProgress("creating droplet…");
  const created = (await doFetch(token, "/droplets", {
    method: "POST",
    body: JSON.stringify({
      name,
      region: opts.region || DEFAULT_DROPLET.region,
      size: opts.size || DEFAULT_DROPLET.size,
      image: opts.image || DEFAULT_DROPLET.image,
      user_data: buildCloudInit(password),
    }),
  })) as { droplet?: { id?: number } };

  const id = created.droplet?.id;
  if (!id) throw new Error("DigitalOcean did not return a droplet id");
  onProgress(`droplet ${id} created; waiting for boot…`);

  const host = await waitForActiveIp(token, id, onProgress);
  onProgress(`droplet active at ${host}; verifying SSH…`);
  await waitForSsh(host, password, onProgress);

  return { host, username: "root", password, name, dropletId: id };
}

/** Destroy a droplet by id (idempotent - a 404 is treated as already gone). */
export async function destroyDroplet(token: string, id: number): Promise<void> {
  if (!token) throw new Error("DIGITAL_OCEAN_API_KEY is not set (add it to .env).");
  const res = await fetch(`${DO_API}/droplets/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`DigitalOcean API ${res.status}: failed to destroy droplet ${id}`);
  }
}
