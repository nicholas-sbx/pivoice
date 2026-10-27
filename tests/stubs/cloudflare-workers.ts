/** Just enough of `cloudflare:workers` to run worker/room.ts under Vitest. */
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: DurableObjectState,
    protected env: Env
  ) {}
}
