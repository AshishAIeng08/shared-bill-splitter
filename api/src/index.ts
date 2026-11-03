import { Hono } from "hono";

type Env = { Bindings: { DB: D1Database } };
const app = new Hono<Env>().basePath("/api");

const jsonError = (message: string, status: 400 | 404 | 409 | 422) =>
  Response.json({ error: message }, { status });

async function bodyRecord(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function validText(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 200
  );
}

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "Internal server error" }, 500);
});
app.notFound((c) => c.json({ error: "Not found" }, 404));

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/homes", async (c) => {
  const body = await bodyRecord(c.req.raw);
  if (!body || !validText(body.name))
    return jsonError("Name must be a non-empty string", 422);
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO homes (id, name) VALUES (?, ?)")
    .bind(id, body.name.trim())
    .run();
  return c.json({ id, name: body.name.trim() }, 201);
});

app.post("/homes/:homeId/members", async (c) => {
  const homeId = c.req.param("homeId");
  const body = await bodyRecord(c.req.raw);
  if (!body || !validText(body.name))
    return jsonError("Name must be a non-empty string", 422);
  const home = await c.env.DB.prepare("SELECT id FROM homes WHERE id = ?")
    .bind(homeId)
    .first<{ id: string }>();
  if (!home) return jsonError("Home not found", 404);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)",
  )
    .bind(id, homeId, body.name.trim())
    .run();
  return c.json({ id, homeId, name: body.name.trim() }, 201);
});

app.post("/homes/:homeId/bills", async (c) => {
  const homeId = c.req.param("homeId");
  const body = await bodyRecord(c.req.raw);
  if (
    !body ||
    !validText(body.title) ||
    typeof body.totalCents !== "number" ||
    !Number.isSafeInteger(body.totalCents) ||
    body.totalCents <= 0
  ) {
    return jsonError("Title and a positive whole totalCents are required", 422);
  }
  const home = await c.env.DB.prepare("SELECT id FROM homes WHERE id = ?")
    .bind(homeId)
    .first<{ id: string }>();
  if (!home) return jsonError("Home not found", 404);
  const members = await c.env.DB.prepare(
    "SELECT id FROM members WHERE home_id = ? ORDER BY created_at, rowid",
  )
    .bind(homeId)
    .all<{ id: string }>();
  if (members.results.length === 0)
    return jsonError("Home has no members", 422);
  const billId = crypto.randomUUID();
  const base = Math.floor(body.totalCents / members.results.length);
  const extra = body.totalCents % members.results.length;
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      "INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)",
    ).bind(billId, homeId, body.title.trim(), body.totalCents),
    ...members.results.map((member, index) =>
      c.env.DB.prepare(
        "INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)",
      ).bind(
        crypto.randomUUID(),
        billId,
        member.id,
        base + (index < extra ? 1 : 0),
      ),
    ),
  ];
  await c.env.DB.batch(statements);
  const shares = await c.env.DB.prepare(
    "SELECT id, member_id AS memberId, amount_cents AS amountCents, paid_at AS paidAt FROM shares WHERE bill_id = ? ORDER BY rowid",
  )
    .bind(billId)
    .all();
  return c.json(
    {
      id: billId,
      homeId,
      title: body.title.trim(),
      totalCents: body.totalCents,
      shares: shares.results,
    },
    201,
  );
});

app.get("/homes/:homeId/bills", async (c) => {
  const homeId = c.req.param("homeId");
  const home = await c.env.DB.prepare("SELECT id FROM homes WHERE id = ?")
    .bind(homeId)
    .first<{ id: string }>();
  if (!home) return jsonError("Home not found", 404);
  const bills = await c.env.DB.prepare(
    "SELECT id, home_id AS homeId, title, total_cents AS totalCents FROM bills WHERE home_id = ? ORDER BY rowid DESC",
  )
    .bind(homeId)
    .all<{ id: string; homeId: string; title: string; totalCents: number }>();
  const result = await Promise.all(
    bills.results.map(async (bill) => {
      const shares = await c.env.DB.prepare(
        "SELECT s.id, s.member_id AS memberId, m.name AS memberName, s.amount_cents AS amountCents, s.paid_at AS paidAt FROM shares s JOIN members m ON m.id = s.member_id WHERE s.bill_id = ? ORDER BY m.created_at, m.rowid",
      )
        .bind(bill.id)
        .all();
      return { ...bill, shares: shares.results };
    }),
  );
  return c.json({ bills: result });
});

app.post("/bills/:billId/shares/:shareId/pay", async (c) => {
  const key = c.req.header("Idempotency-Key")?.trim();
  if (!key) return jsonError("Idempotency-Key header is required", 400);
  if (key.length > 200) return jsonError("Idempotency-Key is too long", 400);
  const { billId, shareId } = c.req.param();
  const share = await c.env.DB.prepare(
    "SELECT s.id, s.bill_id AS billId, s.member_id AS memberId, s.amount_cents AS amountCents, s.paid_at AS paidAt, s.idempotency_key AS idempotencyKey FROM shares s JOIN bills b ON b.id = s.bill_id WHERE s.id = ? AND b.id = ?",
  )
    .bind(shareId, billId)
    .first<{
      id: string;
      billId: string;
      memberId: string;
      amountCents: number;
      paidAt: string | null;
      idempotencyKey: string | null;
    }>();
  if (!share) return jsonError("Bill or share not found", 404);
  if (share.paidAt) {
    if (share.idempotencyKey === key)
      return c.json({
        id: share.id,
        memberId: share.memberId,
        amountCents: share.amountCents,
        paidAt: share.paidAt,
      });
    return jsonError("Share already paid with a different key", 409);
  }
  const paidAt = new Date().toISOString();
  const update = await c.env.DB.prepare(
    "UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND bill_id = ? AND paid_at IS NULL",
  )
    .bind(paidAt, key, shareId, billId)
    .run();
  if (update.meta.changes === 0) {
    const current = await c.env.DB.prepare(
      "SELECT paid_at AS paidAt, idempotency_key AS idempotencyKey FROM shares WHERE id = ?",
    )
      .bind(shareId)
      .first<{ paidAt: string | null; idempotencyKey: string | null }>();
    if (current?.idempotencyKey === key && current.paidAt)
      return c.json({
        id: share.id,
        memberId: share.memberId,
        amountCents: share.amountCents,
        paidAt: current.paidAt,
      });
    return jsonError("Share already paid with a different key", 409);
  }
  return c.json({
    id: share.id,
    memberId: share.memberId,
    amountCents: share.amountCents,
    paidAt,
  });
});

app.get("/homes/:homeId/balances", async (c) => {
  const homeId = c.req.param("homeId");
  const home = await c.env.DB.prepare("SELECT id FROM homes WHERE id = ?")
    .bind(homeId)
    .first<{ id: string }>();
  if (!home) return jsonError("Home not found", 404);
  const rows = await c.env.DB.prepare(
    "SELECT m.id AS memberId, m.name, COALESCE(SUM(CASE WHEN s.paid_at IS NULL AND b.id IS NOT NULL THEN s.amount_cents ELSE 0 END), 0) AS outstandingCents FROM members m LEFT JOIN shares s ON s.member_id = m.id LEFT JOIN bills b ON b.id = s.bill_id AND b.home_id = m.home_id WHERE m.home_id = ? GROUP BY m.id ORDER BY m.created_at, m.rowid",
  )
    .bind(homeId)
    .all();
  return c.json({ balances: rows.results });
});

export default app;
