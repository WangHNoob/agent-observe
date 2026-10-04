import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";

function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function authRoutes(
  app: FastifyInstance,
  opts: { ctx: RouteContext },
): Promise<void> {
  app.post("/api/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { password?: unknown };
    const provided = typeof body.password === "string" ? body.password : "";

    // 管理员密码优先；配置了 OBS_VIEWER_PASSWORD 时允许只读访客登录
    let role: "admin" | "viewer" | null = null;
    if (safeEqual(provided, opts.ctx.config.adminPassword)) {
      role = "admin";
    } else if (opts.ctx.config.viewerPassword && safeEqual(provided, opts.ctx.config.viewerPassword)) {
      role = "viewer";
    }
    if (!role) {
      return reply.code(401).send({ error: "Invalid password" });
    }

    const token = app.jwt.sign({ sub: "observer", role }, { expiresIn: "12h" });
    return { token, role };
  });

  app.get(
    "/api/auth/me",
    { preHandler: opts.ctx.authenticate },
    async (req) => ({
      sub: (req.user as { sub?: string }).sub ?? "observer",
      role: (req.user as { role?: string }).role ?? "viewer",
    }),
  );
}
