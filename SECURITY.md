# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting on this repository ("Security" -> "Report a
vulnerability"). We aim to acknowledge within 72 hours.

## What this software does with your credentials

- The repo-root `.env` is read by the desktop app only. A subset (see
  `SKILL_PROVIDER_KEYS` in `star-fleet/src/electron/agentEnv.ts`) is written
  to `~/.tabs-agent.env` on every VM you open so the agent's skills can call
  the providers. Treat every VM as holding those keys.
- Cloudflare R2 and DigitalOcean credentials never leave the laptop; VMs only
  receive presigned URLs.
- Codex OAuth refresh tokens live only in the codex-broker's volume. VMs
  receive short-lived access tokens.
- Machine profiles (SSH keys / passwords, including minted droplet root
  passwords) are stored unencrypted in Electron's `userData` directory on the
  laptop.
- One-click droplets enable root password login over SSH. Restrict inbound
  access with a DigitalOcean firewall if that is not acceptable for you.

## The agent runs arbitrary code

The autonomous agent has a shell on the VM and can call your compute providers.
Do not point it at machines or accounts you cannot afford to lose or pay for.
