// src/cars/index.ts
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import resolverPlugin from "./resolver";

export default async function carsPlugin(app: FastifyInstance, _opts: FastifyPluginOptions) {
  // ping: GET /cars/health
  app.get("/health", async () => ({ ok: true, scope: "cars", version: "1.0.0" }));

  // routes Cars (resolver /connect + /connect/health)
  await app.register(resolverPlugin);
}
