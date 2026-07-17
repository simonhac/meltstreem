import { describe, it, expect } from "vitest";
import { resolveStationNow } from "@/do/client";
import type { Env } from "@/env";

// A fake STATION_RENDERER namespace whose stub's resolveNow is `fn` — enough to exercise the
// deadline / fallback / error contract of the client wrapper without the Workers runtime or a browser.
const envWith = (fn: (code: string, url: string) => Promise<string | null>): Env =>
  ({ STATION_RENDERER: { idFromName: () => ({}), get: () => ({ resolveNow: fn }) } }) as unknown as Env;

describe("resolveStationNow", () => {
  it("returns the DO-resolved name when it lands inside the deadline", async () => {
    const name = await resolveStationNow(envWith(async () => "ABC 24"), "CODE", "https://viewer", 500);
    expect(name).toBe("ABC 24");
  });

  it("returns null when the render exceeds the deadline (the DO keeps going in the background)", async () => {
    const slow = () => new Promise<string>((r) => setTimeout(() => r("ABC 24"), 200));
    const name = await resolveStationNow(envWith(slow), "CODE", "https://viewer", 20);
    expect(name).toBeNull();
  });

  it("returns null (deferred) when the DO resolves to null", async () => {
    const name = await resolveStationNow(envWith(async () => null), "CODE", "https://viewer", 500);
    expect(name).toBeNull();
  });

  it("returns null with no STATION_RENDERER binding (unit/local)", async () => {
    const name = await resolveStationNow({} as unknown as Env, "CODE", "https://viewer", 500);
    expect(name).toBeNull();
  });

  it("swallows an RPC error and returns null", async () => {
    const boom = async () => {
      throw new Error("rpc down");
    };
    const name = await resolveStationNow(envWith(boom), "CODE", "https://viewer", 500);
    expect(name).toBeNull();
  });
});
