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
const fetchApi = (path: string, init?: RequestInit) =>
  SELF.fetch(`https://app/api${path}`, init);
async function verifiedUser(name: string, email: string) {
  const response = await fetchApi("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: name,
      email,
      password: "correct-horse-battery-staple",
    }),
  });
  // Email is intentionally unconfigured in test workers; the account remains pending verification.
  expect(response.status).toBe(503);
  await env.DB.prepare(
    "UPDATE users SET email_verified_at = '2026-01-01T00:00:00Z' WHERE email = ?",
  )
    .bind(email)
    .run();
  const login = await fetchApi("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("Set-Cookie")?.split(";")[0];
  if (!cookie) throw new Error("Login did not create a session cookie");
  return {
    ...(
      await json<{ user: { id: string; fullName: string; email: string } }>(
        login,
      )
    ).user,
    cookie,
  };
}

describe("multi-user expense platform", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM email_logs"),
      env.DB.prepare("DELETE FROM notifications"),
      env.DB.prepare("DELETE FROM activity_logs"),
      env.DB.prepare("DELETE FROM settlements"),
      env.DB.prepare("DELETE FROM expense_participants"),
      env.DB.prepare("DELETE FROM expenses"),
      env.DB.prepare("DELETE FROM invitations"),
      env.DB.prepare("DELETE FROM group_members"),
      env.DB.prepare("DELETE FROM groups"),
      env.DB.prepare("DELETE FROM sessions"),
      env.DB.prepare("DELETE FROM verification_tokens"),
      env.DB.prepare("DELETE FROM password_reset_tokens"),
      env.DB.prepare("DELETE FROM users"),
      env.DB.prepare("DELETE FROM shares"),
      env.DB.prepare("DELETE FROM bills"),
      env.DB.prepare("DELETE FROM members"),
      env.DB.prepare("DELETE FROM homes"),
    ]);
  });

  it("enforces unique verified identities and rejects weak passwords", async () => {
    const invalid = await fetchApi("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        fullName: "A",
        email: "a@example.com",
        password: "weak",
      }),
    });
    expect(invalid.status).toBe(422);
    await verifiedUser("Asha", "asha@example.com");
    const duplicate = await fetchApi("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        fullName: "Other",
        email: "ASHA@example.com",
        password: "correct-horse-battery-staple",
      }),
    });
    expect(duplicate.status).toBe(409);
  });

  it("isolates groups, splits money correctly, and records creator activity", async () => {
    const asha = await verifiedUser("Asha", "asha@example.com");
    const amit = await verifiedUser("Amit", "amit@example.com");
    const group = await json<{ id: string }>(
      await fetchApi("/groups", {
        method: "POST",
        headers: { Cookie: asha.cookie },
        body: JSON.stringify({ name: "Friends" }),
      }),
    );
    await env.DB.prepare(
      "INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')",
    )
      .bind(group.id, amit.id)
      .run();
    const expense = await fetchApi(`/groups/${group.id}/expenses`, {
      method: "POST",
      headers: { Cookie: asha.cookie },
      body: JSON.stringify({
        title: "Dinner",
        totalCents: 10001,
        paidBy: asha.id,
        participants: [asha.id, amit.id],
        splitType: "equal",
      }),
    });
    expect(expense.status).toBe(201);
    const balances = await json<{
      balances: Array<{ id: string; netCents: number }>;
    }>(
      await fetchApi(`/groups/${group.id}/balances`, {
        headers: { Cookie: asha.cookie },
      }),
    );
    expect(
      balances.balances.find((item) => item.id === asha.id)?.netCents,
    ).toBe(5000);
    expect(
      balances.balances.find((item) => item.id === amit.id)?.netCents,
    ).toBe(-5000);
    const hidden = await fetchApi(`/groups/${group.id}`, {
      headers: {
        Cookie: (await verifiedUser("Ravi", "ravi@example.com")).cookie,
      },
    });
    expect(hidden.status).toBe(404);
    const activity = await json<{
      activity: Array<{ actorName: string; action: string }>;
    }>(
      await fetchApi(`/groups/${group.id}/activity`, {
        headers: { Cookie: asha.cookie },
      }),
    );
    expect(activity.activity[0]).toMatchObject({
      actorName: "Asha",
      action: "created",
    });
  });

  it("rejects exact split totals that do not equal the expense total", async () => {
    const user = await verifiedUser("Lee", "lee@example.com");
    const group = await json<{ id: string }>(
      await fetchApi("/groups", {
        method: "POST",
        headers: { Cookie: user.cookie },
        body: JSON.stringify({ name: "Flat" }),
      }),
    );
    const response = await fetchApi(`/groups/${group.id}/expenses`, {
      method: "POST",
      headers: { Cookie: user.cookie },
      body: JSON.stringify({
        title: "Rent",
        totalCents: 10000,
        paidBy: user.id,
        participants: [{ userId: user.id, value: 5000 }],
        splitType: "exact",
      }),
    });
    expect(response.status).toBe(422);
  });

  it("allocates percentage and share splits in whole paise", async () => {
    const payer = await verifiedUser("Mina", "mina@example.com");
    const friend = await verifiedUser("Noah", "noah@example.com");
    const group = await json<{ id: string }>(
      await fetchApi("/groups", {
        method: "POST",
        headers: { Cookie: payer.cookie },
        body: JSON.stringify({ name: "Trip" }),
      }),
    );
    await env.DB.prepare(
      "INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')",
    )
      .bind(group.id, friend.id)
      .run();
    const percentages = await json<{
      participants: Array<{ userId: string; shareCents: number }>;
    }>(
      await fetchApi(`/groups/${group.id}/expenses`, {
        method: "POST",
        headers: { Cookie: payer.cookie },
        body: JSON.stringify({
          title: "Tickets",
          totalCents: 10001,
          paidBy: payer.id,
          participants: [
            { userId: payer.id, value: 70 },
            { userId: friend.id, value: 30 },
          ],
          splitType: "percentage",
        }),
      }),
    );
    expect(percentages.participants.map((item) => item.shareCents)).toEqual([
      7001, 3000,
    ]);
    const shares = await json<{
      participants: Array<{ userId: string; shareCents: number }>;
    }>(
      await fetchApi(`/groups/${group.id}/expenses`, {
        method: "POST",
        headers: { Cookie: payer.cookie },
        body: JSON.stringify({
          title: "Hotel",
          totalCents: 10001,
          paidBy: payer.id,
          participants: [
            { userId: payer.id, value: 3 },
            { userId: friend.id, value: 1 },
          ],
          splitType: "shares",
        }),
      }),
    );
    expect(shares.participants.map((item) => item.shareCents)).toEqual([
      7501, 2500,
    ]);
  });

  it("limits expense edits to the creator and preserves the split proportions", async () => {
    const creator = await verifiedUser("Ira", "ira@example.com");
    const friend = await verifiedUser("Omar", "omar@example.com");
    const group = await json<{ id: string }>(
      await fetchApi("/groups", {
        method: "POST",
        headers: { Cookie: creator.cookie },
        body: JSON.stringify({ name: "Cabin" }),
      }),
    );
    await env.DB.prepare(
      "INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')",
    )
      .bind(group.id, friend.id)
      .run();
    const expense = await json<{ id: string }>(
      await fetchApi(`/groups/${group.id}/expenses`, {
        method: "POST",
        headers: { Cookie: creator.cookie },
        body: JSON.stringify({
          title: "Food",
          totalCents: 10000,
          paidBy: creator.id,
          participants: [
            { userId: creator.id, value: 70 },
            { userId: friend.id, value: 30 },
          ],
          splitType: "percentage",
        }),
      }),
    );
    const denied = await fetchApi(`/expenses/${expense.id}`, {
      method: "PUT",
      headers: { Cookie: friend.cookie },
      body: JSON.stringify({ title: "Changed", totalCents: 20000 }),
    });
    expect(denied.status).toBe(403);
    const updated = await fetchApi(`/expenses/${expense.id}`, {
      method: "PUT",
      headers: { Cookie: creator.cookie },
      body: JSON.stringify({ title: "Food updated", totalCents: 20000 }),
    });
    expect(updated.status).toBe(200);
    const participants = await env.DB.prepare(
      "SELECT user_id AS userId, share_cents AS shareCents FROM expense_participants WHERE expense_id = ? ORDER BY rowid",
    )
      .bind(expense.id)
      .all<{ userId: string; shareCents: number }>();
    expect(participants.results.map((item) => item.shareCents)).toEqual([
      14000, 6000,
    ]);
  });
});
