import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";

export async function authRoutes(
  app: FastifyInstance,
  opts: { ctx: RouteContext },
): Promise<void> {
  app.post("/api/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { password?: unknown };
    const provided = typeof body.password === "string" ? body.password : "";
    const expected = opts.ctx.config.adminPassword;

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      return reply.code(401).send({ error: "Invalid password" });
    }

    const token = app.jwt.sign({ sub: "observer", role: "admin" }, { expiresIn: "12h" });
    return { token };
  });

  app.get(
    "/api/auth/me",
    { preHandler: opts.ctx.authenticate },
    async () => ({ sub: "observer", role: "admin" }),
  );
}
