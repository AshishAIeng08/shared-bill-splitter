import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  }
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("shared bill splitter", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM shares"),
      env.DB.prepare("DELETE FROM bills"),
      env.DB.prepare("DELETE FROM members"),
      env.DB.prepare("DELETE FROM homes"),
    ]);
  });

  it("creates homes and ordered members, then splits remainder cents by signup order", async () => {
    const home = await json<{ id: string }>(
      await SELF.fetch("https://app/api/homes", {
        method: "POST",
        body: JSON.stringify({ name: "Maple House" }),
      }),
    );
    expect(
      (
        await SELF.fetch(`https://app/api/homes/${home.id}/members`, {
          method: "POST",
          body: JSON.stringify({ name: "Ada" }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await SELF.fetch(`https://app/api/homes/${home.id}/members`, {
          method: "POST",
          body: JSON.stringify({ name: "Sam" }),
        })
      ).status,
    ).toBe(201);
    const last = await SELF.fetch(`https://app/api/homes/${home.id}/members`, {
      method: "POST",
      body: JSON.stringify({ name: "Lee" }),
    });
    expect(last.status).toBe(201);
    const made = await SELF.fetch(`https://app/api/homes/${home.id}/bills`, {
      method: "POST",
      body: JSON.stringify({ title: "Groceries", totalCents: 1000 }),
    });
    expect(made.status).toBe(201);
    const bill = await json<{ shares: Array<{ amountCents: number }> }>(made);
    expect(bill.shares.map((share) => share.amountCents)).toEqual([
      334, 333, 333,
    ]);
  });

  it("rejects a bill for an empty home and invalid amounts", async () => {
    const home = await json<{ id: string }>(
      await SELF.fetch("https://app/api/homes", {
        method: "POST",
        body: JSON.stringify({ name: "Empty" }),
      }),
    );
    expect(
      (
        await SELF.fetch(`https://app/api/homes/${home.id}/bills`, {
          method: "POST",
          body: JSON.stringify({ title: "Rent", totalCents: 1 }),
        })
      ).status,
    ).toBe(422);
  });

  it("makes payments idempotent and rejects a different key after payment", async () => {
    const home = await json<{ id: string }>(
      await SELF.fetch("https://app/api/homes", {
        method: "POST",
        body: JSON.stringify({ name: "Home" }),
      }),
    );
    await SELF.fetch(`https://app/api/homes/${home.id}/members`, {
      method: "POST",
      body: JSON.stringify({ name: "Jo" }),
    });
    const bill = await json<{ id: string; shares: Array<{ id: string }> }>(
      await SELF.fetch(`https://app/api/homes/${home.id}/bills`, {
        method: "POST",
        body: JSON.stringify({ title: "Tea", totalCents: 120 }),
      }),
    );
    const url = `https://app/api/bills/${bill.id}/shares/${bill.shares[0]?.id}/pay`;
    const pay = () =>
      SELF.fetch(url, {
        method: "POST",
        headers: { "Idempotency-Key": "once" },
      });
    const first = await pay();
    const second = await pay();
    expect(first.status).toBe(200);
    expect(await json(second)).toEqual(await json(first));
    expect(
      (
        await SELF.fetch(url, {
          method: "POST",
          headers: { "Idempotency-Key": "different" },
        })
      ).status,
    ).toBe(409);
  });
});
