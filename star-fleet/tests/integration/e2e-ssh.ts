// Password-auth SSH helper for the e2e run, built on the app's own ssh2
// connection code (no sshpass needed). Two modes:
//   bun e2e-ssh.ts run   "<remote command>"   - run a command, print stdout
//   bun e2e-ssh.ts script <local-file>         - pipe a local script to bash -s
import { readFileSync } from "node:fs";
import { connect, runScript } from "../../src/electron/session/children/connection";

const vmEnvPath = process.env.E2E_VM || "/tmp/e2e-vm.env";
const vmEnv = Object.fromEntries(
  readFileSync(vmEnvPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const ip = vmEnv.IP;
const password = vmEnv.PASSWORD;

const mode = process.argv[2];
const arg = process.argv[3];

const conn = await connect(ip, 22, "root", { password });

if (mode === "script") {
  const script = readFileSync(arg, "utf8");
  await runScript(conn, script, (line) => console.log(line));
  conn.end();
} else if (mode === "run") {
  await new Promise<void>((resolve, reject) => {
    conn.exec(arg, (err, stream) => {
      if (err) return reject(err);
      stream.on("data", (d: Buffer) => process.stdout.write(d.toString()));
      stream.stderr.on("data", (d: Buffer) => process.stderr.write(d.toString()));
      stream.on("close", () => {
        conn.end();
        resolve();
      });
    });
  });
} else {
  console.error("usage: e2e-ssh.ts run '<cmd>' | script <file>");
  process.exit(1);
}
