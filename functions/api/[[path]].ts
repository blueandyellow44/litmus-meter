// Pages Functions entry for every /api/* path. All logic is in server/router.ts.

import { defaultDeps, handle, type Env } from "../../server/router.ts";

export const onRequest: PagesFunction<Env> = (ctx) =>
  handle(ctx.request, ctx.env, defaultDeps(ctx.env, ctx.request, (p) => ctx.waitUntil(p)));
