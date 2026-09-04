// Driver Worker for Cloudflare Sandboxes: POST {id, cmd} -> runs `cmd` in the
// sandbox named `id` and returns {stdout, stderr, exitCode}. Each distinct id
// is its own persistent container (sleeps when idle, wakes on request).
import { getSandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("POST {id, cmd}", { status: 405 });
    }
    const { id, cmd } = (await request.json()) as { id: string; cmd: string };
    if (!id || !cmd) {
      return Response.json({ error: "need id and cmd" }, { status: 400 });
    }
    const sandbox = getSandbox(env.Sandbox, id);
    const result = await sandbox.exec(cmd);
    return Response.json({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  },
};
