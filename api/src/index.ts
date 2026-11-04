import { type Context, Hono, type MiddlewareHandler } from "hono";

type Bindings = {
  DB: D1Database;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  APP_URL?: string;
};
type Variables = { user: User };
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;
type User = {
  id: string;
  full_name: string;
  email: string;
  email_verified_at: string | null;
};
// Cloudflare Workers WebCrypto currently caps PBKDF2 at 100,000 iterations.
const PASSWORD_ITERATIONS = 100_000;
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>().basePath(
  "/api",
);
const jsonError = (
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 503,
) => Response.json({ error: message }, { status });
const nowPlus = (hours: number) =>
  new Date(Date.now() + hours * 3600_000).toISOString();
const token = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};
async function digest(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
async function passwordHash(password: string, salt = token()) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations: PASSWORD_ITERATIONS,
    },
    key,
    256,
  );
  return `pbkdf2$${PASSWORD_ITERATIONS}$${salt}$${Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
async function passwordMatches(password: string, encoded: string) {
  const [, rounds, salt, expected] = encoded.split("$");
  if (!salt || !expected || Number(rounds) !== PASSWORD_ITERATIONS)
    return false;
  return (await passwordHash(password, salt)).split("$")[3] === expected;
}
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
const text = (value: unknown, max = 200): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= max;
const email = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const userView = ({ id, full_name, email, email_verified_at }: User) => ({
  id,
  fullName: full_name,
  email,
  emailVerified: Boolean(email_verified_at),
});
function setSession(c: AppContext, value: string) {
  c.header(
    "Set-Cookie",
    `session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`,
  );
}
async function sendEmail(
  c: { env: Bindings },
  to: string,
  subject: string,
  html: string,
  template: string,
  resourceId: string | null,
) {
  if (!c.env.RESEND_API_KEY || !c.env.EMAIL_FROM) return false;
  const existing = await c.env.DB.prepare(
    "SELECT id, status FROM email_logs WHERE recipient = ? COLLATE NOCASE AND template = ? AND resource_id IS ?",
  )
    .bind(to, template, resourceId)
    .first<{ id: string; status: string }>();
  if (existing?.status === "sent") return true;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: c.env.EMAIL_FROM, to: [to], subject, html }),
  });
  const result = (await response.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
  };
  if (existing)
    await c.env.DB.prepare(
      "UPDATE email_logs SET provider_id = ?, status = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    )
      .bind(result.id ?? null, response.ok ? "sent" : "failed", existing.id)
      .run();
  else
    await c.env.DB.prepare(
      "INSERT INTO email_logs (id, recipient, template, resource_id, provider_id, status) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        crypto.randomUUID(),
        to,
        template,
        resourceId,
        result.id ?? null,
        response.ok ? "sent" : "failed",
      )
      .run();
  return response.ok;
}
function appUrl(c: AppContext) {
  return (
    c.env.APP_URL ||
    "https://shared-bill-splitter-api.ashish1053singh.workers.dev"
  ).replace(/\/$/, "");
}
async function currentUser(c: AppContext) {
  const value = c.req
    .header("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("session="))
    ?.slice(8);
  if (!value) return null;
  const row = await c.env.DB.prepare(
    "SELECT u.id, u.full_name, u.email, u.email_verified_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
  )
    .bind(await digest(value), new Date().toISOString())
    .first<User>();
  return row ?? null;
}
const auth: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "Sign in to continue" }, 401);
  if (!user.email_verified_at)
    return c.json({ error: "Verify your email before continuing" }, 403);
  c.set("user", user);
  await next();
};
async function isMember(db: D1Database, groupId: string, userId: string) {
  return Boolean(
    await db
      .prepare("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?")
      .bind(groupId, userId)
      .first(),
  );
}
async function logActivity(
  db: D1Database,
  groupId: string,
  actor: string,
  action: string,
  type: string,
  id: string,
  details: unknown = {},
) {
  await db
    .prepare(
      "INSERT INTO activity_logs (id, group_id, actor_id, action, resource_type, resource_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      groupId,
      actor,
      action,
      type,
      id,
      JSON.stringify(details),
    )
    .run();
}
async function notification(
  c: { env: Bindings },
  recipient: User,
  kind: string,
  subject: string,
  body: string,
  resourceId: string,
  emailHtml: string,
) {
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO notifications (id, user_id, kind, subject, body, resource_id) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, recipient.id, kind, subject, body, resourceId)
    .run();
  await sendEmail(c, recipient.email, subject, emailHtml, kind, resourceId);
}
app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "Internal server error" }, 500);
});
app.notFound((c) => c.json({ error: "Not found" }, 404));
app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/auth/register", async (c) => {
  const b = await bodyRecord(c.req.raw);
  if (
    !b ||
    !text(b.fullName, 120) ||
    !email(b.email) ||
    typeof b.password !== "string" ||
    b.password.length < 12 ||
    b.password.length > 128
  )
    return jsonError(
      "Enter your name, a valid email, and a password between 12 and 128 characters",
      422,
    );
  const address = b.email.trim().toLowerCase();
  if (
    await c.env.DB.prepare(
      "SELECT id FROM users WHERE email = ? COLLATE NOCASE",
    )
      .bind(address)
      .first()
  )
    return jsonError("An account already uses this email", 409);
  const id = crypto.randomUUID();
  const secret = token();
  const hashedPassword = await passwordHash(b.password);
  await c.env.DB.prepare(
    "INSERT INTO users (id, full_name, email, password_hash) VALUES (?, ?, ?, ?)",
  )
    .bind(id, b.fullName.trim(), address, hashedPassword)
    .run();
  await c.env.DB.prepare(
    "INSERT INTO verification_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
  )
    .bind(await digest(secret), id, nowPlus(24))
    .run();
  const sent = await sendEmail(
    c,
    address,
    "Verify your Common account",
    `<p>Hi ${escapeHtml(b.fullName.trim())},</p><p>Verify your email to finish creating your account.</p><p><a href="${appUrl(c)}/?verify=${secret}">Verify email</a></p>`,
    "verify-email",
    await digest(secret),
  );
  if (!sent)
    return jsonError(
      "Account created, but email delivery is not configured. Add RESEND_API_KEY and EMAIL_FROM, then request a fresh verification email.",
      503,
    );
  return c.json({ message: "Check your email for a verification link" }, 201);
});
app.post("/auth/resend-verification", async (c) => {
  const b = await bodyRecord(c.req.raw);
  if (!b || !email(b.email))
    return jsonError("Enter a valid email address", 422);
  const user = await c.env.DB.prepare(
    "SELECT id, email, full_name, email_verified_at FROM users WHERE email = ? COLLATE NOCASE",
  )
    .bind(b.email.trim())
    .first<{
      id: string;
      email: string;
      full_name: string;
      email_verified_at: string | null;
    }>();
  if (!user || user.email_verified_at)
    return c.json({
      message: "If verification is needed, a link has been sent",
    });
  const secret = token();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM verification_tokens WHERE user_id = ?").bind(
      user.id,
    ),
    c.env.DB.prepare(
      "INSERT INTO verification_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    ).bind(await digest(secret), user.id, nowPlus(24)),
  ]);
  const sent = await sendEmail(
    c,
    user.email,
    "Verify your Common account",
    `<p>Hi ${escapeHtml(user.full_name)},</p><p><a href="${appUrl(c)}/?verify=${secret}">Verify your email</a></p>`,
    "verify-email",
    await digest(secret),
  );
  return sent
    ? c.json({ message: "Check your email for a verification link" })
    : jsonError(
        "Email delivery is not configured. Add RESEND_API_KEY and EMAIL_FROM.",
        503,
      );
});
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );
}
app.get("/auth/verify", async (c) => {
  const raw = c.req.query("token");
  if (!raw) return jsonError("Verification token is required", 400);
  const hash = await digest(raw);
  const record = await c.env.DB.prepare(
    "SELECT user_id AS userId FROM verification_tokens WHERE token_hash = ? AND expires_at > ?",
  )
    .bind(hash, new Date().toISOString())
    .first<{ userId: string }>();
  if (!record) return jsonError("Verification link is invalid or expired", 422);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET email_verified_at = ? WHERE id = ?",
    ).bind(new Date().toISOString(), record.userId),
    c.env.DB.prepare("DELETE FROM verification_tokens WHERE user_id = ?").bind(
      record.userId,
    ),
  ]);
  return c.json({ message: "Email verified. You can sign in." });
});
app.post("/auth/login", async (c) => {
  const b = await bodyRecord(c.req.raw);
  if (!b || !email(b.email) || typeof b.password !== "string")
    return jsonError("Email and password are required", 422);
  const record = await c.env.DB.prepare(
    "SELECT id, full_name, email, email_verified_at, password_hash FROM users WHERE email = ? COLLATE NOCASE",
  )
    .bind(b.email.trim())
    .first<User & { password_hash: string }>();
  if (!record || !(await passwordMatches(b.password, record.password_hash)))
    return jsonError("Email or password is incorrect", 401);
  if (!record.email_verified_at)
    return jsonError("Verify your email before signing in", 403);
  const secret = token();
  await c.env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
  )
    .bind(await digest(secret), record.id, nowPlus(168))
    .run();
  setSession(c, secret);
  return c.json({ user: userView(record) });
});
app.post("/auth/logout", async (c) => {
  const raw = c.req
    .header("Cookie")
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("session="))
    ?.slice(8);
  if (raw)
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await digest(raw))
      .run();
  c.header(
    "Set-Cookie",
    "session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
  );
  return c.json({ ok: true });
});
app.get("/auth/me", auth, (c) => c.json({ user: userView(c.get("user")) }));
app.post("/auth/forgot-password", async (c) => {
  const b = await bodyRecord(c.req.raw);
  if (!b || !email(b.email))
    return jsonError("Enter a valid email address", 422);
  const user = await c.env.DB.prepare(
    "SELECT id, email, full_name FROM users WHERE email = ? COLLATE NOCASE",
  )
    .bind(b.email.trim())
    .first<{ id: string; email: string; full_name: string }>();
  if (user) {
    const secret = token();
    await c.env.DB.prepare(
      "INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    )
      .bind(await digest(secret), user.id, nowPlus(1))
      .run();
    await sendEmail(
      c,
      user.email,
      "Reset your Common password",
      `<p>Hi ${escapeHtml(user.full_name)},</p><p><a href="${appUrl(c)}/?reset=${secret}">Reset password</a></p><p>This link expires in one hour.</p>`,
      "password-reset",
      user.id,
    );
  }
  return c.json({
    message:
      "If that account exists, password reset instructions have been sent",
  });
});
app.post("/auth/reset-password", async (c) => {
  const b = await bodyRecord(c.req.raw);
  if (
    !b ||
    !text(b.token, 200) ||
    typeof b.password !== "string" ||
    b.password.length < 12 ||
    b.password.length > 128
  )
    return jsonError(
      "A valid reset token and a 12–128 character password are required",
      422,
    );
  const hash = await digest(b.token);
  const record = await c.env.DB.prepare(
    "SELECT user_id AS userId FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?",
  )
    .bind(hash, new Date().toISOString())
    .first<{ userId: string }>();
  if (!record) return jsonError("Reset link is invalid or expired", 422);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(
      await passwordHash(b.password),
      record.userId,
    ),
    c.env.DB.prepare(
      "DELETE FROM password_reset_tokens WHERE user_id = ?",
    ).bind(record.userId),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(
      record.userId,
    ),
  ]);
  return c.json({
    message: "Password updated. Sign in with your new password.",
  });
});

app.get("/users/search", auth, async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q || q.length > 100) return c.json({ users: [] });
  const rows = await c.env.DB.prepare(
    "SELECT id, full_name AS fullName, email FROM users WHERE email_verified_at IS NOT NULL AND (full_name LIKE ? OR email LIKE ?) AND id <> ? ORDER BY full_name LIMIT 20",
  )
    .bind(`%${q}%`, `%${q}%`, c.get("user").id)
    .all();
  return c.json({ users: rows.results });
});
app.get("/groups", auth, async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT g.id, g.name, g.created_at AS createdAt, gm.role, (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS memberCount FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = ? ORDER BY g.created_at DESC",
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ groups: rows.results });
});
app.post("/groups", auth, async (c) => {
  const b = await bodyRecord(c.req.raw);
  if (!b || !text(b.name, 120)) return jsonError("Group name is required", 422);
  const id = crypto.randomUUID();
  const user = c.get("user");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO groups (id, name, created_by) VALUES (?, ?, ?)",
    ).bind(id, b.name.trim(), user.id),
    c.env.DB.prepare(
      "INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')",
    ).bind(id, user.id),
  ]);
  return c.json({ id, name: b.name.trim(), role: "admin" }, 201);
});
app.get("/groups/:groupId", auth, async (c) => {
  const id = c.req.param("groupId");
  if (!(await isMember(c.env.DB, id, c.get("user").id)))
    return jsonError("Group not found", 404);
  const [group, members] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, name, created_at AS createdAt FROM groups WHERE id = ?",
    )
      .bind(id)
      .first(),
    c.env.DB.prepare(
      "SELECT u.id, u.full_name AS fullName, u.email, gm.role, gm.joined_at AS joinedAt FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY gm.joined_at",
    )
      .bind(id)
      .all(),
  ]);
  return c.json({ group, members: members.results });
});
app.post("/groups/:groupId/invitations", auth, async (c) => {
  const groupId = c.req.param("groupId"),
    user = c.get("user"),
    b = await bodyRecord(c.req.raw);
  if (!(await isMember(c.env.DB, groupId, user.id)))
    return jsonError("Group not found", 404);
  if (!b || !email(b.email)) return jsonError("A valid email is required", 422);
  const address = b.email.trim().toLowerCase();
  if (await isMemberByEmail(c.env.DB, groupId, address))
    return jsonError("This person is already in the group", 409);
  const existing = await c.env.DB.prepare(
    "SELECT id FROM invitations WHERE group_id = ? AND email = ? COLLATE NOCASE AND status = 'pending'",
  )
    .bind(groupId, address)
    .first();
  if (existing) return jsonError("An invitation is already pending", 409);
  const group = await c.env.DB.prepare("SELECT name FROM groups WHERE id = ?")
    .bind(groupId)
    .first<{ name: string }>();
  const inviteId = crypto.randomUUID(),
    secret = token();
  await c.env.DB.prepare(
    "INSERT INTO invitations (id, group_id, email, invited_by, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      inviteId,
      groupId,
      address,
      user.id,
      await digest(secret),
      nowPlus(168),
    )
    .run();
  const sent = await sendEmail(
    c,
    address,
    `Invitation to join ${group?.name ?? "a group"}`,
    `<p>${escapeHtml(user.full_name)} invited you to ${escapeHtml(group?.name ?? "a group")}.</p><p><a href="${appUrl(c)}/?invite=${secret}">Accept or reject invitation</a></p>`,
    "group-invitation",
    inviteId,
  );
  return c.json(
    { id: inviteId, email: address, status: "pending", emailSent: sent },
    201,
  );
});
async function isMemberByEmail(db: D1Database, group: string, address: string) {
  return Boolean(
    await db
      .prepare(
        "SELECT 1 FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? AND u.email = ? COLLATE NOCASE",
      )
      .bind(group, address)
      .first(),
  );
}
app.post("/invitations/respond", auth, async (c) => {
  const b = await bodyRecord(c.req.raw),
    user = c.get("user");
  if (
    !b ||
    !text(b.token, 200) ||
    !["accept", "reject"].includes(String(b.action))
  )
    return jsonError(
      "Invitation token and accept/reject action are required",
      422,
    );
  const hash = await digest(b.token),
    invitation = await c.env.DB.prepare(
      "SELECT i.id, i.group_id AS groupId, i.email, i.status FROM invitations i WHERE i.token_hash = ? AND i.expires_at > ?",
    )
      .bind(hash, new Date().toISOString())
      .first<{ id: string; groupId: string; email: string; status: string }>();
  if (
    !invitation ||
    invitation.email.toLowerCase() !== user.email.toLowerCase() ||
    invitation.status !== "pending"
  )
    return jsonError(
      "Invitation is invalid, expired, or belongs to another email",
      404,
    );
  if (b.action === "reject") {
    await c.env.DB.prepare(
      "UPDATE invitations SET status = 'rejected' WHERE id = ?",
    )
      .bind(invitation.id)
      .run();
    return c.json({ status: "rejected" });
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member') ON CONFLICT DO NOTHING",
    ).bind(invitation.groupId, user.id),
    c.env.DB.prepare(
      "UPDATE invitations SET status = 'accepted' WHERE id = ?",
    ).bind(invitation.id),
  ]);
  return c.json({ status: "accepted", groupId: invitation.groupId });
});
app.delete("/groups/:groupId/members/:userId", auth, async (c) => {
  const groupId = c.req.param("groupId"),
    target = c.req.param("userId"),
    actor = c.get("user");
  const role = await c.env.DB.prepare(
    "SELECT role FROM group_members WHERE group_id = ? AND user_id = ?",
  )
    .bind(groupId, actor.id)
    .first<{ role: string }>();
  if (role?.role !== "admin")
    return jsonError("Only group administrators can remove members", 403);
  if (target === actor.id)
    return jsonError(
      "An administrator cannot remove their own membership",
      422,
    );
  await c.env.DB.prepare(
    "DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
  )
    .bind(groupId, target)
    .run();
  return c.json({ ok: true });
});

app.get("/groups/:groupId/expenses", auth, async (c) => {
  const groupId = c.req.param("groupId");
  if (!(await isMember(c.env.DB, groupId, c.get("user").id)))
    return jsonError("Group not found", 404);
  const rows = await c.env.DB.prepare(
    "SELECT e.id, e.title, e.total_cents AS totalCents, e.paid_by AS paidBy, p.full_name AS paidByName, e.expense_date AS expenseDate, e.category, e.description, e.split_type AS splitType, e.created_by AS createdBy, maker.full_name AS createdByName, e.created_at AS createdAt FROM expenses e JOIN users p ON p.id = e.paid_by JOIN users maker ON maker.id = e.created_by WHERE e.group_id = ? AND e.deleted_at IS NULL ORDER BY e.expense_date DESC, e.created_at DESC",
  )
    .bind(groupId)
    .all<Record<string, unknown>>();
  const expenses = await Promise.all(
    rows.results.map(async (expense) => {
      const participants = await c.env.DB.prepare(
        "SELECT ep.user_id AS userId, u.full_name AS fullName, u.email, ep.share_cents AS shareCents, ep.paid_at AS paidAt FROM expense_participants ep JOIN users u ON u.id = ep.user_id WHERE ep.expense_id = ? ORDER BY u.full_name",
      )
        .bind(expense.id)
        .all();
      return { ...expense, participants: participants.results };
    }),
  );
  return c.json({ expenses });
});
app.post("/groups/:groupId/expenses", auth, async (c) => {
  const groupId = c.req.param("groupId"),
    actor = c.get("user"),
    b = await bodyRecord(c.req.raw);
  if (!(await isMember(c.env.DB, groupId, actor.id)))
    return jsonError("Group not found", 404);
  if (
    !b ||
    !text(b.title) ||
    !Number.isSafeInteger(b.totalCents) ||
    Number(b.totalCents) < 1 ||
    !text(b.paidBy, 100) ||
    !Array.isArray(b.participants) ||
    !b.participants.length ||
    b.participants.length > 100
  )
    return jsonError(
      "Title, positive totalCents, payer, and participants are required",
      422,
    );
  const splitType = b.splitType ?? "equal";
  if (
    !["equal", "exact", "percentage", "shares", "unequal"].includes(
      String(splitType),
    )
  )
    return jsonError("Unsupported split type", 422);
  const memberIds = [
    ...new Set(
      [b.paidBy, ...b.participants].filter(
        (v): v is string => typeof v === "string",
      ),
    ),
  ];
  const placeholders = memberIds.map(() => "?").join(",");
  const records = await c.env.DB.prepare(
    `SELECT u.id, u.full_name, u.email FROM users u JOIN group_members gm ON gm.user_id = u.id WHERE gm.group_id = ? AND u.id IN (${placeholders})`,
  )
    .bind(groupId, ...memberIds)
    .all<{ id: string; full_name: string; email: string }>();
  if (
    records.results.length !== memberIds.length ||
    !memberIds.includes(String(b.paidBy))
  )
    return jsonError("Payer and every participant must be a group member", 422);
  const participants = (b.participants as unknown[]).map((value) =>
    typeof value === "string"
      ? { userId: value, value: 1 }
      : typeof value === "object" && value !== null && "userId" in value
        ? {
            userId: String(value.userId),
            value: Number("value" in value ? value.value : 1),
          }
        : null,
  );
  if (
    participants.some((p) => !p || !Number.isFinite(p.value) || p.value < 0) ||
    new Set(participants.map((p) => p?.userId)).size !== participants.length
  )
    return jsonError("Participant list or split values are invalid", 422);
  const total = Number(b.totalCents);
  let shares: number[];
  if (splitType === "equal") {
    const base = Math.floor(total / participants.length),
      remainder = total % participants.length;
    shares = participants.map((_, i) => base + (i < remainder ? 1 : 0));
  } else if (splitType === "exact") {
    shares = participants.map((p) => Math.round(p?.value ?? 0));
    if (
      shares.some((v) => v < 0) ||
      shares.reduce((a, v) => a + v, 0) !== total
    )
      return jsonError(
        "Exact shares must add up to the total amount in cents",
        422,
      );
  } else if (splitType === "percentage") {
    const values = participants.map((p) => p?.value ?? 0);
    if (Math.abs(values.reduce((a, v) => a + v, 0) - 100) > 0.001)
      return jsonError("Percentages must add up to 100", 422);
    shares = prorata(total, values);
  } else {
    const values = participants.map((p) => p?.value ?? 0);
    if (values.some((v) => v <= 0) || !values.reduce((a, v) => a + v, 0))
      return jsonError("Share weights must be positive", 422);
    shares = prorata(total, values);
  }
  const date =
    typeof b.expenseDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(b.expenseDate)
      ? b.expenseDate
      : new Date().toISOString().slice(0, 10);
  const id = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      "INSERT INTO expenses (id, group_id, created_by, title, total_cents, paid_by, expense_date, category, description, split_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      id,
      groupId,
      actor.id,
      b.title.trim(),
      total,
      b.paidBy,
      date,
      text(b.category, 80) ? b.category.trim() : "Other",
      text(b.description, 1000) ? b.description.trim() : null,
      splitType,
    ),
    ...participants.map((participant, i) =>
      c.env.DB.prepare(
        "INSERT INTO expense_participants (expense_id, user_id, share_cents) VALUES (?, ?, ?)",
      ).bind(id, participant?.userId, shares[i]),
    ),
  ];
  await c.env.DB.batch(statements);
  await logActivity(c.env.DB, groupId, actor.id, "created", "expense", id, {
    title: b.title,
    totalCents: total,
  });
  const byId = new Map(records.results.map((u) => [u.id, u]));
  for (let i = 0; i < participants.length; i++) {
    const participant = participants[i];
    const person = participant ? byId.get(participant.userId) : null;
    if (!person || person.id === actor.id) continue;
    const amount = shares[i] ?? 0;
    const paidBy = byId.get(String(b.paidBy));
    const owes =
      person.id === b.paidBy
        ? "You paid this expense."
        : `You owe ${escapeHtml(paidBy?.full_name ?? "the payer")} ${formatINR(amount)}.`;
    const subject = `New shared expense: ${b.title}`;
    const body = `${actor.full_name} added ${b.title}. Your share is ${formatINR(amount)}.`;
    await notification(
      c,
      {
        id: person.id,
        full_name: person.full_name,
        email: person.email,
        email_verified_at: "yes",
      },
      "expense-created",
      subject,
      body,
      id,
      `<p>Hi ${escapeHtml(person.full_name)},</p><p>${escapeHtml(actor.full_name)} added a shared expense.</p><p><b>${escapeHtml(b.title)}</b> · Total ${formatINR(total)}</p><p>Paid by ${escapeHtml(paidBy?.full_name ?? "member")} · Your share ${formatINR(amount)}</p><p>${owes}</p><p><a href="${appUrl(c)}/?group=${groupId}&expense=${id}">Open expense</a></p>`,
    );
  }
  return c.json(
    {
      id,
      groupId,
      totalCents: total,
      splitType,
      participants: participants.map((p, i) => ({
        userId: p?.userId,
        shareCents: shares[i],
      })),
    },
    201,
  );
});
function prorata(total: number, weights: number[]) {
  const sum = weights.reduce((a, n) => a + n, 0);
  const raw = weights.map((weight) => (total * weight) / sum);
  const floors = raw.map(Math.floor);
  const remainder = total - floors.reduce((a, n) => a + n, 0);
  const order = raw
    .map((value, i) => ({ i, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (let i = 0; i < remainder; i++)
    floors[order[i]?.i ?? 0] = (floors[order[i]?.i ?? 0] ?? 0) + 1;
  return floors;
}
function formatINR(cents: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
  }).format(cents / 100);
}
async function canManageExpense(
  db: D1Database,
  expenseId: string,
  userId: string,
) {
  return db
    .prepare(
      "SELECT e.id, e.group_id AS groupId, e.title, e.created_by AS createdBy, g.name AS groupName, gm.role FROM expenses e JOIN groups g ON g.id = e.group_id JOIN group_members gm ON gm.group_id = e.group_id AND gm.user_id = ? WHERE e.id = ? AND e.deleted_at IS NULL",
    )
    .bind(userId, expenseId)
    .first<{
      id: string;
      groupId: string;
      title: string;
      createdBy: string;
      groupName: string;
      role: string;
    }>();
}
app.put("/expenses/:expenseId", auth, async (c) => {
  const user = c.get("user"),
    id = c.req.param("expenseId"),
    b = await bodyRecord(c.req.raw),
    expense = await canManageExpense(c.env.DB, id, user.id);
  if (!expense) return jsonError("Expense not found", 404);
  if (expense.createdBy !== user.id && expense.role !== "admin")
    return jsonError(
      "Only the creator or group admin can edit this expense",
      403,
    );
  if (
    !b ||
    !text(b.title) ||
    !Number.isSafeInteger(b.totalCents) ||
    Number(b.totalCents) < 1
  )
    return jsonError("Title and positive totalCents are required", 422);
  const participants = await c.env.DB.prepare(
    "SELECT user_id AS userId, share_cents AS shareCents FROM expense_participants WHERE expense_id = ? ORDER BY rowid",
  )
    .bind(id)
    .all<{ userId: string; shareCents: number }>();
  const revisedShares = prorata(
    Number(b.totalCents),
    participants.results.map((participant) => participant.shareCents),
  );
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE expenses SET title = ?, total_cents = ?, updated_at = ? WHERE id = ?",
    ).bind(b.title.trim(), Number(b.totalCents), new Date().toISOString(), id),
    ...participants.results.map((p, i) =>
      c.env.DB.prepare(
        "UPDATE expense_participants SET share_cents = ?, paid_at = NULL WHERE expense_id = ? AND user_id = ?",
      ).bind(revisedShares[i] ?? 0, id, p.userId),
    ),
  ]);
  await logActivity(
    c.env.DB,
    expense.groupId,
    user.id,
    "updated",
    "expense",
    id,
    { title: b.title.trim() },
  );
  for (const p of participants.results) {
    if (p.userId === user.id) continue;
    const to = await c.env.DB.prepare(
      "SELECT id, full_name AS fullName, email FROM users WHERE id = ?",
    )
      .bind(p.userId)
      .first<{ id: string; fullName: string; email: string }>();
    if (to)
      await notification(
        c,
        { ...to, full_name: to.fullName, email_verified_at: "yes" },
        "expense-updated",
        `Expense updated: ${b.title}`,
        `${user.full_name} updated ${b.title}.`,
        id,
        `<p>${escapeHtml(user.full_name)} updated <b>${escapeHtml(b.title)}</b> in ${escapeHtml(expense.groupName)}.</p><p><a href="${appUrl(c)}/?group=${expense.groupId}&expense=${id}">View expense</a></p>`,
      );
  }
  return c.json({ ok: true, updatedBy: userView(user) });
});
app.delete("/expenses/:expenseId", auth, async (c) => {
  const user = c.get("user"),
    expense = await canManageExpense(
      c.env.DB,
      c.req.param("expenseId"),
      user.id,
    );
  if (!expense) return jsonError("Expense not found", 404);
  if (expense.createdBy !== user.id && expense.role !== "admin")
    return jsonError(
      "Only the creator or group admin can delete this expense",
      403,
    );
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE expenses SET deleted_at = ?, updated_at = ? WHERE id = ?",
    ).bind(new Date().toISOString(), new Date().toISOString(), expense.id),
    c.env.DB.prepare(
      "INSERT INTO activity_logs (id, group_id, actor_id, action, resource_type, resource_id) VALUES (?, ?, ?, 'deleted', 'expense', ?)",
    ).bind(crypto.randomUUID(), expense.groupId, user.id, expense.id),
  ]);
  const members = await c.env.DB.prepare(
    "SELECT u.id, u.full_name AS fullName, u.email FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? AND u.id <> ?",
  )
    .bind(expense.groupId, user.id)
    .all<{ id: string; fullName: string; email: string }>();
  for (const m of members.results)
    await notification(
      c,
      { ...m, full_name: m.fullName, email_verified_at: "yes" },
      "expense-deleted",
      `Expense deleted: ${expense.title}`,
      `${user.full_name} deleted ${expense.title}.`,
      expense.id,
      `<p>${escapeHtml(user.full_name)} deleted <b>${escapeHtml(expense.title)}</b> from ${escapeHtml(expense.groupName)}.</p>`,
    );
  return c.json({ ok: true });
});
app.get("/groups/:groupId/balances", auth, async (c) => {
  const groupId = c.req.param("groupId");
  if (!(await isMember(c.env.DB, groupId, c.get("user").id)))
    return jsonError("Group not found", 404);
  const members = await c.env.DB.prepare(
    "SELECT u.id, u.full_name AS fullName, u.email FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?",
  )
    .bind(groupId)
    .all<{ id: string; fullName: string; email: string }>();
  const expenses = await c.env.DB.prepare(
    "SELECT e.paid_by AS paidBy, ep.user_id AS userId, ep.share_cents AS shareCents FROM expenses e JOIN expense_participants ep ON ep.expense_id = e.id WHERE e.group_id = ? AND e.deleted_at IS NULL",
  )
    .bind(groupId)
    .all<{ paidBy: string; userId: string; shareCents: number }>();
  const settlements = await c.env.DB.prepare(
    "SELECT from_user AS fromUser, to_user AS toUser, amount_cents AS amountCents FROM settlements WHERE group_id = ?",
  )
    .bind(groupId)
    .all<{ fromUser: string; toUser: string; amountCents: number }>();
  const net = new Map(members.results.map((m) => [m.id, 0]));
  for (const e of expenses.results) {
    net.set(e.paidBy, (net.get(e.paidBy) ?? 0) + e.shareCents);
    net.set(e.userId, (net.get(e.userId) ?? 0) - e.shareCents);
  }
  for (const s of settlements.results) {
    net.set(s.fromUser, (net.get(s.fromUser) ?? 0) + s.amountCents);
    net.set(s.toUser, (net.get(s.toUser) ?? 0) - s.amountCents);
  }
  return c.json({
    balances: members.results.map((m) => ({
      ...m,
      netCents: net.get(m.id) ?? 0,
    })),
  });
});
app.get("/dashboard", auth, async (c) => {
  const id = c.get("user").id;
  const [groups, totals, expenses, notifications] = await Promise.all([
    c.env.DB.prepare(
      "SELECT g.id, g.name FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = ? ORDER BY g.created_at DESC",
    )
      .bind(id)
      .all(),
    c.env.DB.prepare(
      "SELECT COALESCE(SUM(CASE WHEN e.paid_by = ? THEN e.total_cents ELSE 0 END),0) AS paidCents, COALESCE(SUM(CASE WHEN ep.user_id = ? THEN ep.share_cents ELSE 0 END),0) AS shareCents, COUNT(DISTINCT e.id) AS expenseCount FROM expenses e JOIN expense_participants ep ON ep.expense_id = e.id JOIN group_members gm ON gm.group_id = e.group_id AND gm.user_id = ? WHERE e.deleted_at IS NULL",
    )
      .bind(id, id, id)
      .first(),
    c.env.DB.prepare(
      "SELECT e.id, e.title, e.total_cents AS totalCents, e.expense_date AS expenseDate, g.name AS groupName FROM expenses e JOIN group_members gm ON gm.group_id = e.group_id JOIN groups g ON g.id = e.group_id WHERE gm.user_id = ? AND e.deleted_at IS NULL ORDER BY e.created_at DESC LIMIT 8",
    )
      .bind(id)
      .all(),
    c.env.DB.prepare(
      "SELECT id, kind, subject, body, resource_id AS resourceId, read_at AS readAt, created_at AS createdAt FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 8",
    )
      .bind(id)
      .all(),
  ]);
  return c.json({
    groups: groups.results,
    totals,
    recentExpenses: expenses.results,
    notifications: notifications.results,
  });
});
app.get("/notifications", auth, async (c) => {
  const list = await c.env.DB.prepare(
    "SELECT id, kind, subject, body, resource_id AS resourceId, read_at AS readAt, created_at AS createdAt FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ notifications: list.results });
});
app.post("/notifications/:id/read", auth, async (c) => {
  await c.env.DB.prepare(
    "UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?",
  )
    .bind(new Date().toISOString(), c.req.param("id"), c.get("user").id)
    .run();
  return c.json({ ok: true });
});
app.post("/groups/:groupId/settlements", auth, async (c) => {
  const groupId = c.req.param("groupId"),
    user = c.get("user"),
    b = await bodyRecord(c.req.raw),
    key = c.req.header("Idempotency-Key");
  if (!(await isMember(c.env.DB, groupId, user.id)))
    return jsonError("Group not found", 404);
  if (!key || key.length > 200)
    return jsonError("Idempotency-Key header is required", 400);
  if (
    !b ||
    !text(b.toUser, 100) ||
    !Number.isSafeInteger(b.amountCents) ||
    Number(b.amountCents) < 1 ||
    b.toUser === user.id ||
    !(await isMember(c.env.DB, groupId, b.toUser))
  )
    return jsonError("Valid recipient and positive amount are required", 422);
  const balanceRows = await c.env.DB.prepare(
    "SELECT e.paid_by AS paidBy, ep.user_id AS userId, ep.share_cents AS shareCents FROM expenses e JOIN expense_participants ep ON ep.expense_id = e.id WHERE e.group_id = ? AND e.deleted_at IS NULL",
  )
    .bind(groupId)
    .all<{ paidBy: string; userId: string; shareCents: number }>();
  const net = new Map<string, number>();
  for (const row of balanceRows.results) {
    net.set(row.paidBy, (net.get(row.paidBy) ?? 0) + row.shareCents);
    net.set(row.userId, (net.get(row.userId) ?? 0) - row.shareCents);
  }
  const oldSettlements = await c.env.DB.prepare(
    "SELECT from_user AS fromUser, to_user AS toUser, amount_cents AS amountCents FROM settlements WHERE group_id = ?",
  )
    .bind(groupId)
    .all<{ fromUser: string; toUser: string; amountCents: number }>();
  for (const item of oldSettlements.results) {
    net.set(item.fromUser, (net.get(item.fromUser) ?? 0) + item.amountCents);
    net.set(item.toUser, (net.get(item.toUser) ?? 0) - item.amountCents);
  }
  if (
    Number(b.amountCents) > Math.max(0, -(net.get(user.id) ?? 0)) ||
    Number(b.amountCents) > Math.max(0, net.get(String(b.toUser)) ?? 0)
  )
    return jsonError(
      "Settlement amount exceeds the outstanding balance between these members",
      422,
    );
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      "INSERT INTO settlements (id, group_id, from_user, to_user, amount_cents, note, created_by, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        id,
        groupId,
        user.id,
        b.toUser,
        Number(b.amountCents),
        text(b.note, 200) ? b.note.trim() : null,
        user.id,
        key,
      )
      .run();
  } catch {
    const previous = await c.env.DB.prepare(
      "SELECT id FROM settlements WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{ id: string }>();
    if (previous) return c.json({ id: previous.id, idempotent: true });
    return jsonError("Settlement could not be recorded", 409);
  }
  await logActivity(c.env.DB, groupId, user.id, "recorded", "settlement", id, {
    amountCents: b.amountCents,
  });
  const recipient = await c.env.DB.prepare(
    "SELECT id, full_name, email FROM users WHERE id = ?",
  )
    .bind(b.toUser)
    .first<{ id: string; full_name: string; email: string }>();
  if (recipient) {
    const group = await c.env.DB.prepare("SELECT name FROM groups WHERE id = ?")
      .bind(groupId)
      .first<{ name: string }>();
    await notification(
      c,
      { ...recipient, email_verified_at: "yes" },
      "settlement-recorded",
      "Settlement received",
      `${user.full_name} recorded a payment of ${formatINR(Number(b.amountCents))}.`,
      id,
      `<p>${escapeHtml(user.full_name)} recorded a payment of ${formatINR(Number(b.amountCents))} in ${escapeHtml(group?.name ?? "your group")}.</p>`,
    );
    await notification(
      c,
      {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        email_verified_at: "yes",
      },
      "settlement-confirmation",
      "Settlement recorded",
      `You recorded a payment of ${formatINR(Number(b.amountCents))}.`,
      id,
      `<p>Your payment of ${formatINR(Number(b.amountCents))} has been recorded.</p>`,
    );
  }
  return c.json(
    { id, amountCents: Number(b.amountCents), status: "recorded" },
    201,
  );
});
app.get("/groups/:groupId/settlements", auth, async (c) => {
  const groupId = c.req.param("groupId");
  if (!(await isMember(c.env.DB, groupId, c.get("user").id)))
    return jsonError("Group not found", 404);
  const rows = await c.env.DB.prepare(
    "SELECT s.id, s.amount_cents AS amountCents, s.note, s.created_at AS createdAt, s.from_user AS fromUser, f.full_name AS fromName, s.to_user AS toUser, t.full_name AS toName FROM settlements s JOIN users f ON f.id = s.from_user JOIN users t ON t.id = s.to_user WHERE s.group_id = ? ORDER BY s.created_at DESC",
  )
    .bind(groupId)
    .all();
  return c.json({ settlements: rows.results });
});
app.get("/groups/:groupId/activity", auth, async (c) => {
  const groupId = c.req.param("groupId");
  if (!(await isMember(c.env.DB, groupId, c.get("user").id)))
    return jsonError("Group not found", 404);
  const logs = await c.env.DB.prepare(
    "SELECT a.id, a.action, a.resource_type AS resourceType, a.resource_id AS resourceId, a.details, a.created_at AS createdAt, u.full_name AS actorName FROM activity_logs a JOIN users u ON u.id = a.actor_id WHERE a.group_id = ? ORDER BY a.created_at DESC LIMIT 100",
  )
    .bind(groupId)
    .all();
  return c.json({ activity: logs.results });
});

export default app;
