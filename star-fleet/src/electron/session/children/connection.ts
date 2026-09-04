import { Client } from "ssh2";
import type { ConnectConfig } from "ssh2";
import * as net from "node:net";
import type { SshCredential } from "../../../shared/types";

/** Open a keep-alive TCP socket to the host, rejecting on timeout/error. */
export function openSocket(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10_000);
    const fail = (err: Error) => {
      sock.destroy();
      reject(err);
    };
    sock.setTimeout(20_000, () => fail(new Error("TCP connection timed out")));
    sock.once("error", fail);
    sock.connect(port, host, () => {
      sock.setTimeout(0);
      sock.removeListener("error", fail);
      resolve(sock);
    });
  });
}

/** Cheap liveness probe: can we open a TCP socket to host:port? No SSH, no
 * provisioning - just reachability, for the dashboard's status dots. */
export async function pingHost(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, host, () => done(true));
  });
}

/** Map a credential to the ssh2 auth fields (private key OR password). */
export function authConfig(cred: SshCredential): Pick<ConnectConfig, "privateKey" | "password"> {
  if (cred.pemKey) return { privateKey: cred.pemKey };
  if (cred.password) return { password: cred.password };
  throw new Error("no SSH credential provided (need a key or a password)");
}

/** ssh2 connect config over an existing socket with sensible keepalive. */
export function buildConfig(sock: net.Socket, username: string, cred: SshCredential): ConnectConfig {
  return {
    sock,
    username,
    ...authConfig(cred),
    // Password-only hosts advertise keyboard-interactive; answer it with the password.
    tryKeyboard: Boolean(cred.password),
    readyTimeout: 30_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,
  };
}

/** Connect an ssh2 Client over a fresh socket; resolves once ready. */
export async function connect(
  host: string,
  port: number,
  username: string,
  cred: SshCredential
): Promise<Client> {
  const conn = new Client();
  const sock = await openSocket(host, port);
  await new Promise<void>((resolve, reject) => {
    conn.once("ready", resolve);
    conn.once("error", reject);
    // Some password hosts only accept keyboard-interactive; feed the password.
    if (cred.password) {
      conn.on("keyboard-interactive", (_n, _i, _l, _p, finish) => finish([cred.password!]));
    }
    conn.connect(buildConfig(sock, username, cred));
  });
  return conn;
}

/**
 * Run a script over `bash -s`, streaming each output line to `onLine`. Resolves
 * on exit code 0, rejects otherwise.
 */
export function runScript(conn: Client, script: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.exec("bash -s", (err, stream) => {
      if (err) return reject(err);
      let buffered = "";
      const onData = (data: Buffer) => {
        buffered += data.toString();
        let idx: number;
        while ((idx = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, idx).trimEnd();
          buffered = buffered.slice(idx + 1);
          if (line) onLine(line);
        }
      };
      stream.on("data", onData);
      stream.stderr.on("data", onData);
      stream.on("close", (code: number) => {
        if (buffered.trim()) onLine(buffered.trim());
        if (code === 0) resolve();
        else reject(new Error(`setup script exited with code ${code}`));
      });
      stream.end(script);
    });
  });
}
