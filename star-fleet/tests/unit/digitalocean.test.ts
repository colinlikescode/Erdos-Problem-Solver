import { test, expect, describe } from "bun:test";
import { buildCloudInit, mintRootPassword, DEFAULT_DROPLET } from "../../src/electron/digitalocean";
import { bashSyntaxOk } from "./util";

describe("digitalocean - root password", () => {
  test("is random per droplet, long, and shell-safe (URL-safe base64)", () => {
    const a = mintRootPassword();
    const b = mintRootPassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("digitalocean - cloud-init password enablement", () => {
  const password = mintRootPassword();
  const script = buildCloudInit(password);

  test("is valid bash", () => {
    expect(bashSyntaxOk(script).ok).toBe(true);
  });
  test("removes DO's disabling drop-in and forces password + root login", () => {
    expect(script).toContain("rm -f /etc/ssh/sshd_config.d/50-cloud-init.conf");
    expect(script).toContain("PasswordAuthentication yes");
    expect(script).toContain("PermitRootLogin yes");
    // a first-sorted drop-in wins over DO's 50- one (sshd = first value wins)
    expect(script).toContain("/etc/ssh/sshd_config.d/00-tabs.conf");
  });
  test("sets the minted root password (single-quoted) and restarts ssh", () => {
    expect(script).toContain(`echo 'root:${password}' | chpasswd`);
    expect(script).toMatch(/systemctl restart ssh/);
  });
  test("a password containing $ stays literal (single-quoted)", () => {
    const s = buildCloudInit("ab$cd");
    expect(bashSyntaxOk(s).ok).toBe(true);
    expect(s).toContain("echo 'root:ab$cd' | chpasswd");
  });
});

describe("digitalocean - default droplet spec", () => {
  test("matches the sized research box (60 vCPU / 120 GB / 750 GB, Ubuntu 24.04, NYC1)", () => {
    // Slug per the /v2/sizes API: CPU-Optimized Premium
    // Intel, 60 vCPU / 120 GB / 750 GB NVMe, available in nyc1.
    expect(DEFAULT_DROPLET.size).toBe("c-60-intel");
    expect(DEFAULT_DROPLET.image).toBe("ubuntu-24-04-x64");
    expect(DEFAULT_DROPLET.region).toBe("nyc1");
  });
});
