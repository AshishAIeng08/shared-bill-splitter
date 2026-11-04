import { type FormEvent, useCallback, useEffect, useState } from "react";

type User = {
  id: string;
  fullName: string;
  email: string;
  emailVerified: boolean;
};
type Group = { id: string; name: string; role?: string; memberCount?: number };
type Member = { id: string; fullName: string; email: string; role: string };
type Participant = {
  userId: string;
  fullName: string;
  email: string;
  shareCents: number;
  paidAt: string | null;
};
type Expense = {
  id: string;
  title: string;
  totalCents: number;
  paidBy: string;
  paidByName: string;
  expenseDate: string;
  category: string;
  description?: string;
  splitType: string;
  createdByName: string;
  participants: Participant[];
};
type Notification = {
  id: string;
  subject: string;
  body: string;
  createdAt: string;
  readAt: string | null;
};
type Settlement = {
  id: string;
  amountCents: number;
  note: string | null;
  createdAt: string;
  fromUser: string;
  fromName: string;
  toUser: string;
  toName: string;
};
const currency = (cents: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
    cents / 100,
  );
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new Error("Can’t reach the server. Check your connection and retry.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
        ? body.error
        : "Something went wrong. Try again.",
    );
  return body as T;
}
function inputString(form: FormData, key: string) {
  return String(form.get(key) ?? "");
}

export function HomePage() {
  const [user, setUser] = useState<User | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [totalNet, setTotalNet] = useState(0);
  const [inviteToken, setInviteToken] = useState("");
  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [balances, setBalances] = useState<
    Array<{ id: string; fullName: string; email: string; netCents: number }>
  >([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [authMode, setAuthMode] = useState<
    "login" | "register" | "forgot" | "reset"
  >("login");
  const [resetToken, setResetToken] = useState("");
  const [page, setPage] = useState("overview");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadGroups = useCallback(async (userId: string) => {
    const result = await api<{ groups: Group[] }>("/groups");
    setGroups(result.groups);
    const groupBalances = await Promise.all(
      result.groups.map((item) =>
        api<{
          balances: Array<{ id: string; netCents: number }>;
        }>(`/groups/${item.id}/balances`),
      ),
    );
    const currentId = userId;
    setTotalNet(
      groupBalances.reduce(
        (sum, result) =>
          sum +
          (result.balances.find((balance) => balance.id === currentId)
            ?.netCents ?? 0),
        0,
      ),
    );
  }, []);
  const openGroup = useCallback(async (item: Group) => {
    setGroup(item);
    setPage("group");
    setError("");
    try {
      const [detail, exp, bal, history] = await Promise.all([
        api<{ members: Member[] }>(`/groups/${item.id}`),
        api<{ expenses: Expense[] }>(`/groups/${item.id}/expenses`),
        api<{
          balances: Array<{
            id: string;
            fullName: string;
            email: string;
            netCents: number;
          }>;
        }>(`/groups/${item.id}/balances`),
        api<{ settlements: Settlement[] }>(`/groups/${item.id}/settlements`),
      ]);
      setMembers(detail.members);
      setExpenses(exp.expenses);
      setBalances(bal.balances);
      setSettlements(history.settlements);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load group.");
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams(location.search);
    const verify = params.get("verify"),
      reset = params.get("reset"),
      invite = params.get("invite");
    if (invite) setInviteToken(invite);
    (async () => {
      if (verify) {
        const result = await api<{ message: string }>(
          `/auth/verify?token=${encodeURIComponent(verify)}`,
        );
        if (alive) {
          setNotice(result.message);
          history.replaceState({}, "", "/");
        }
      }
      if (reset) {
        if (alive) {
          setResetToken(reset);
          setAuthMode("reset");
          setNotice("Choose a new password for your account.");
        }
      }
      try {
        const me = await api<{ user: User }>("/auth/me");
        if (!alive) return;
        setUser(me.user);
        const data = await api<{ groups: Group[] }>("/groups");
        if (!alive) return;
        setGroups(data.groups);
        const groupBalances = await Promise.all(
          data.groups.map((item) =>
            api<{ balances: Array<{ id: string; netCents: number }> }>(
              `/groups/${item.id}/balances`,
            ),
          ),
        );
        setTotalNet(
          groupBalances.reduce(
            (sum, result) =>
              sum +
              (result.balances.find((balance) => balance.id === me.user.id)
                ?.netCents ?? 0),
            0,
          ),
        );
        const ns = await api<{ notifications: Notification[] }>(
          "/notifications",
        );
        if (alive) setNotifications(ns.notifications);
      } catch (e) {
        if (alive && verify)
          setError(e instanceof Error ? e.message : "Verification failed.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function run(
    event: FormEvent,
    work: (form: FormData) => Promise<void>,
  ) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work(new FormData(event.currentTarget as HTMLFormElement));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }
  async function authSubmit(event: FormEvent) {
    await run(event, async (form) => {
      if (authMode === "forgot") {
        const res = await api<{ message: string }>("/auth/forgot-password", {
          method: "POST",
          body: JSON.stringify({ email: inputString(form, "email") }),
        });
        setNotice(res.message);
        return;
      }
      if (authMode === "reset") {
        const res = await api<{ message: string }>("/auth/reset-password", {
          method: "POST",
          body: JSON.stringify({
            token: resetToken,
            password: inputString(form, "password"),
          }),
        });
        setNotice(res.message);
        history.replaceState({}, "", "/");
        setAuthMode("login");
        return;
      }
      if (authMode === "register") {
        const res = await api<{ message: string }>("/auth/register", {
          method: "POST",
          body: JSON.stringify({
            fullName: inputString(form, "fullName"),
            email: inputString(form, "email"),
            password: inputString(form, "password"),
          }),
        });
        setNotice(res.message);
        setAuthMode("login");
        return;
      }
      const res = await api<{ user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: inputString(form, "email"),
          password: inputString(form, "password"),
        }),
      });
      setUser(res.user);
      await loadGroups(res.user.id);
    });
  }
  async function createGroup(event: FormEvent) {
    await run(event, async (form) => {
      const made = await api<Group>("/groups", {
        method: "POST",
        body: JSON.stringify({ name: inputString(form, "name") }),
      });
      await loadGroups(user?.id ?? "");
      await openGroup(made);
    });
  }
  async function invite(event: FormEvent) {
    if (!group) return;
    await run(event, async (form) => {
      const result = await api<{ emailSent: boolean }>(
        `/groups/${group.id}/invitations`,
        {
          method: "POST",
          body: JSON.stringify({ email: inputString(form, "email") }),
        },
      );
      setNotice(
        result.emailSent
          ? "Invitation sent by email."
          : "Invitation saved. Configure email delivery to send it.",
      );
      (event.currentTarget as HTMLFormElement).reset();
    });
  }
  async function recordSettlement(event: FormEvent) {
    if (!group) return;
    const formElement = event.currentTarget as HTMLFormElement;
    await run(event, async (form) => {
      await api(`/groups/${group.id}/settlements`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          toUser: inputString(form, "toUser"),
          amountCents: Math.round(Number(form.get("amount")) * 100),
          note: inputString(form, "note"),
        }),
      });
      setNotice("Payment recorded and balance updated.");
      await openGroup(group);
      formElement.reset();
    });
  }
  async function createExpense(event: FormEvent) {
    if (!group) return;
    const formElement = event.currentTarget as HTMLFormElement;
    await run(event, async (form) => {
      const selected = form.getAll("participant").map(String);
      const splitType = inputString(form, "splitType");
      const values = selected.map((id) => {
        const value =
          splitType === "equal" ? 1 : Number(form.get(`value:${id}`) || 0);
        return {
          userId: id,
          value: splitType === "exact" ? Math.round(value * 100) : value,
        };
      });
      await api(`/groups/${group.id}/expenses`, {
        method: "POST",
        body: JSON.stringify({
          title: inputString(form, "title"),
          totalCents: Math.round(Number(form.get("amount")) * 100),
          paidBy: inputString(form, "paidBy"),
          participants: values,
          splitType,
          category: inputString(form, "category"),
          expenseDate: inputString(form, "date"),
        }),
      });
      setNotice("Expense added and split.");
      await openGroup(group);
      formElement.reset();
    });
  }
  async function logout() {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
    setGroups([]);
    setGroup(null);
  }
  async function respondToInvitation(action: "accept" | "reject") {
    setBusy(true);
    setError("");
    try {
      await api<{ status: string; groupId?: string }>("/invitations/respond", {
        method: "POST",
        body: JSON.stringify({ token: inviteToken, action }),
      });
      setInviteToken("");
      history.replaceState({}, "", "/");
      setNotice(
        action === "accept"
          ? "Group invitation accepted."
          : "Invitation declined.",
      );
      if (action === "accept") await loadGroups(user?.id ?? "");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not respond to invitation.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <main className="auth-shell">
        <div className="state">
          <span className="spinner" /> Loading Common…
        </div>
      </main>
    );
  if (!user)
    return (
      <main className="auth-shell">
        <a className="brand" href="/">
          common<span>.</span>
        </a>
        <section className="auth-card panel">
          <span className="step">SHARED LIVING, MADE CLEAR</span>
          <h1>
            {authMode === "register"
              ? "Join Common."
              : authMode === "forgot" || authMode === "reset"
                ? "Reset your password."
                : "Good friends. Clear balances."}
          </h1>
          <p>
            {authMode === "register"
              ? "Create your account and start sharing fairly."
              : authMode === "reset"
                ? "Choose a new password for your account."
                : authMode === "forgot"
                  ? "We’ll send a secure password reset link if that email is registered."
                  : "Sign in to your expense groups and balances."}
          </p>
          {notice && (
            <div className="success" role="status">
              {notice}
            </div>
          )}
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          <form onSubmit={authSubmit} className="auth-form">
            {authMode === "register" && (
              <label>
                Full name
                <input
                  name="fullName"
                  autoComplete="name"
                  required
                  maxLength={120}
                />
              </label>
            )}
            {authMode !== "reset" &&
            authMode !== "register" &&
            authMode !== "login" ? (
              <label>
                Email address
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                />
              </label>
            ) : authMode === "register" || authMode === "login" ? (
              <label>
                Email address
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                />
              </label>
            ) : null}
            {authMode !== "forgot" && (
              <label>
                {authMode === "reset" ? "New password" : "Password"}
                <input
                  name="password"
                  type="password"
                  autoComplete={
                    authMode === "register" || authMode === "reset"
                      ? "new-password"
                      : "current-password"
                  }
                  minLength={12}
                  required
                />
              </label>
            )}
            {authMode === "register" && (
              <small>
                Use at least 12 characters. We’ll email you a verification link.
              </small>
            )}
            <button type="submit" disabled={busy}>
              {busy
                ? "Please wait…"
                : authMode === "forgot"
                  ? "Send reset link"
                  : authMode === "reset"
                    ? "Save new password"
                    : authMode === "register"
                      ? "Create account"
                      : "Sign in"}
            </button>
          </form>
          <div className="auth-links">
            {authMode === "login" ? (
              <>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setAuthMode("forgot")}
                >
                  Forgot password?
                </button>
                <span>
                  New to Common?{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setAuthMode("register")}
                  >
                    Create an account
                  </button>
                </span>
              </>
            ) : (
              <button
                type="button"
                className="text-button"
                onClick={() => setAuthMode("login")}
              >
                Back to sign in
              </button>
            )}
          </div>
        </section>
        <footer>
          <span>
            COMMON<span className="accent">.</span> MADE FOR SHARED LIVING.
          </span>
          <span>Clear is kind.</span>
        </footer>
      </main>
    );

  if (inviteToken)
    return (
      <main className="auth-shell">
        <a className="brand" href="/">
          common<span>.</span>
        </a>
        <section className="auth-card panel">
          <span className="step">GROUP INVITATION</span>
          <h1>Join the shared space?</h1>
          <p>
            This secure invitation was sent to {user.email}. You can accept it
            to join or decline it.
          </p>
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          <div className="invite-actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => respondToInvitation("accept")}
            >
              Accept invitation
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => respondToInvitation("reject")}
            >
              Decline
            </button>
          </div>
        </section>
      </main>
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          type="button"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            setPage("overview");
            setGroup(null);
          }}
        >
          common<span>.</span>
        </button>
        <div className="side-label">WORKSPACE</div>
        <button
          type="button"
          className={`nav-item ${page === "overview" ? "selected" : ""}`}
          onClick={() => {
            setPage("overview");
            setGroup(null);
          }}
        >
          ◫ <span>Overview</span>
        </button>
        <button
          type="button"
          className={`nav-item ${page === "group" ? "selected" : ""}`}
          onClick={() => group && openGroup(group)}
        >
          ▧ <span>Group details</span>
        </button>
        <div className="side-label side-groups">
          YOUR GROUPS{" "}
          <button type="button" onClick={() => setPage("overview")}>
            +
          </button>
        </div>
        {groups.map((item) => (
          <button
            type="button"
            className="group-link"
            key={item.id}
            onClick={() => openGroup(item)}
          >
            ◦ <span>{item.name}</span>
          </button>
        ))}
        <div className="sidebar-bottom">
          <div className="user-chip">
            <span className="avatar">
              {user.fullName.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <b>{user.fullName}</b>
              <small>{user.email}</small>
            </span>
          </div>
          <button type="button" className="text-button logout" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main-area">
        <header className="app-header">
          <div>
            <span className="step">YOUR SHARED SPACES</span>
            <h2>{group?.name ?? "Overview"}</h2>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="quiet-button"
              onClick={() => setPage("notifications")}
            >
              Notifications{" "}
              <span className="badge">
                {notifications.filter((item) => !item.readAt).length}
              </span>
            </button>
            <span className="avatar">
              {user.fullName.slice(0, 1).toUpperCase()}
            </span>
          </div>
        </header>
        {error && (
          <div className="alert app-alert" role="alert">
            {error}
            <button
              type="button"
              className="dismiss"
              onClick={() => setError("")}
            >
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="success app-alert" role="status">
            {notice}
            <button
              type="button"
              className="dismiss"
              onClick={() => setNotice("")}
            >
              ×
            </button>
          </div>
        )}
        {page === "overview" && (
          <>
            <section className="welcome">
              <div>
                <span className="step">
                  WELCOME BACK, {user.fullName.split(" ")[0].toUpperCase()}
                </span>
                <h1>
                  Good friends.
                  <br />
                  <em>Clear balances.</em>
                </h1>
                <p>
                  Keep shared spending simple. Bring your people together and
                  see where everyone stands.
                </p>
              </div>
              <button
                type="button"
                className="primary large"
                onClick={() => setPage("new-group")}
              >
                Create a group <span>↗</span>
              </button>
            </section>
            <section className="stat-grid">
              <article className="stat-card">
                <span>Total groups</span>
                <strong>{groups.length}</strong>
                <small>Spaces you share</small>
              </article>
              <article className="stat-card">
                <span>Your net balance</span>
                <strong className={totalNet >= 0 ? "positive" : "negative"}>
                  {currency(Math.abs(totalNet))}
                </strong>
                <small>{totalNet >= 0 ? "Others owe you" : "You owe"}</small>
              </article>
              <article className="stat-card">
                <span>Recent activity</span>
                <strong>{notifications.length}</strong>
                <small>Expense updates</small>
              </article>
            </section>
            <section className="content-grid">
              <div className="content-card">
                <div className="card-heading">
                  <div>
                    <span className="step">YOUR PEOPLE</span>
                    <h3>Expense groups</h3>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setPage("new-group")}
                  >
                    + New group
                  </button>
                </div>
                {groups.length ? (
                  <div className="group-cards">
                    {groups.map((item) => (
                      <button
                        type="button"
                        className="group-card"
                        key={item.id}
                        onClick={() => openGroup(item)}
                      >
                        <span className="group-emoji">⌂</span>
                        <span>
                          <b>{item.name}</b>
                          <small>
                            {item.memberCount ?? "Open"} members · shared
                            expenses
                          </small>
                        </span>
                        <span className="arrow">↗</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <div className="empty-illustration">⌂</div>
                    <b>Your first group starts here.</b>
                    <p>
                      Create a group, invite friends, then split your first
                      bill.
                    </p>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => setPage("new-group")}
                    >
                      Create your first group
                    </button>
                  </div>
                )}
              </div>
              <div className="content-card recent-card">
                <div className="card-heading">
                  <div>
                    <span className="step">STAY IN THE LOOP</span>
                    <h3>Recent notifications</h3>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setPage("notifications")}
                  >
                    See all
                  </button>
                </div>
                {notifications.slice(0, 5).map((item) => (
                  <article className="notification-row" key={item.id}>
                    <span className="notify-dot" />
                    <div>
                      <b>{item.subject}</b>
                      <small>{item.body}</small>
                    </div>
                  </article>
                ))}
                {notifications.length === 0 && (
                  <p className="muted">
                    Updates about expenses and settlements will appear here.
                  </p>
                )}
              </div>
            </section>
          </>
        )}
        {page === "new-group" && (
          <section className="content-card form-card">
            <span className="step">BRING YOUR PEOPLE TOGETHER</span>
            <h3>Create a group</h3>
            <p>
              Start a shared space for roommates, friends, trips, or family.
            </p>
            <form className="stack-form" onSubmit={createGroup}>
              <label>
                Group name
                <input
                  name="name"
                  placeholder="e.g. The Sunny Flat"
                  maxLength={120}
                  required
                />
              </label>
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "Creating…" : "Create group"}
              </button>
            </form>
          </section>
        )}
        {page === "group" && group && (
          <>
            <section className="group-summary">
              <div>
                <span className="step">GROUP · {members.length} MEMBERS</span>
                <h1>{group.name}</h1>
                <p>Shared expenses and balances for everyone in this group.</p>
              </div>
              <button
                type="button"
                className="primary"
                onClick={() =>
                  document
                    .getElementById("expense-form")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
              >
                + Add an expense
              </button>
            </section>
            <section className="stat-grid">
              <article className="stat-card">
                <span>Your balance here</span>
                <strong
                  className={
                    (balances.find((item) => item.id === user.id)?.netCents ??
                      0) >= 0
                      ? "positive"
                      : "negative"
                  }
                >
                  {currency(
                    Math.abs(
                      balances.find((item) => item.id === user.id)?.netCents ??
                        0,
                    ),
                  )}
                </strong>
                <small>
                  {(balances.find((item) => item.id === user.id)?.netCents ??
                    0) >= 0
                    ? "Others owe you"
                    : "You owe"}
                </small>
              </article>
              <article className="stat-card">
                <span>Group expenses</span>
                <strong>{expenses.length}</strong>
                <small>All shared expenses</small>
              </article>
              <article className="stat-card">
                <span>People</span>
                <strong>{members.length}</strong>
                <small>Verified group members</small>
              </article>
            </section>
            <section className="content-grid group-content">
              <div className="content-card">
                <div className="card-heading">
                  <div>
                    <span className="step">GROUP ACTIVITY</span>
                    <h3>Expenses</h3>
                  </div>
                </div>
                {expenses.map((expense) => (
                  <article className="expense-row" key={expense.id}>
                    <span className="expense-icon">↗</span>
                    <div className="expense-info">
                      <b>{expense.title}</b>
                      <small>
                        {expense.paidByName} paid · {expense.expenseDate} ·
                        added by {expense.createdByName}
                      </small>
                      <div className="expense-participants">
                        {expense.participants.map((p) => (
                          <span key={p.userId}>
                            {p.fullName}: {currency(p.shareCents)}
                          </span>
                        ))}
                      </div>
                    </div>
                    <strong>{currency(expense.totalCents)}</strong>
                  </article>
                ))}
                {expenses.length === 0 && (
                  <p className="muted">
                    No expenses yet. Add the first one below.
                  </p>
                )}
              </div>
              <aside className="content-card member-card">
                <div className="card-heading">
                  <div>
                    <span className="step">YOUR PEOPLE</span>
                    <h3>Members</h3>
                  </div>
                </div>
                {members.map((member) => (
                  <div className="member-row" key={member.id}>
                    <span className="avatar small-avatar">
                      {member.fullName.slice(0, 1).toUpperCase()}
                    </span>
                    <span>
                      <b>{member.fullName}</b>
                      <small>{member.email}</small>
                    </span>
                    {member.role === "admin" && <em>Admin</em>}
                  </div>
                ))}
                <form onSubmit={invite} className="invite-form">
                  <label>
                    Invite by email
                    <input
                      type="email"
                      name="email"
                      placeholder="friend@example.com"
                      required
                    />
                  </label>
                  <button type="submit" className="secondary" disabled={busy}>
                    Send invitation
                  </button>
                  <small>
                    Only the invited email can accept the secure group link.
                  </small>
                </form>
              </aside>
              <form
                id="expense-form"
                className="content-card expense-form"
                onSubmit={createExpense}
              >
                <span className="step">THE RUNNING TAB</span>
                <h3>Add an expense</h3>
                <div className="expense-fields">
                  <label>
                    Expense title
                    <input
                      name="title"
                      placeholder="Dinner, groceries…"
                      required
                      maxLength={200}
                    />
                  </label>
                  <label>
                    Total amount (₹)
                    <input
                      name="amount"
                      type="number"
                      min="0.01"
                      step="0.01"
                      placeholder="0.00"
                      required
                    />
                  </label>
                  <label>
                    Paid by
                    <select name="paidBy" required>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.fullName} · {m.email}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Category
                    <select name="category">
                      <option>Other</option>
                      <option>Food</option>
                      <option>Groceries</option>
                      <option>Rent</option>
                      <option>Travel</option>
                      <option>Utilities</option>
                      <option>Entertainment</option>
                    </select>
                  </label>
                  <label>
                    Date
                    <input
                      name="date"
                      type="date"
                      defaultValue={new Date().toISOString().slice(0, 10)}
                    />
                  </label>
                  <label>
                    Split type
                    <select name="splitType">
                      <option value="equal">Equally</option>
                      <option value="exact">Exact amounts (₹)</option>
                      <option value="percentage">Percentages (%)</option>
                      <option value="shares">Shares</option>
                    </select>
                  </label>
                  <fieldset>
                    <legend>Participants</legend>
                    {members.map((m) => (
                      <label className="check-row" key={m.id}>
                        <input
                          type="checkbox"
                          name="participant"
                          value={m.id}
                          defaultChecked
                        />
                        {m.fullName} <small>{m.email}</small>
                        {/* per-person custom input is used for non-equal splits */}
                        <input
                          className="split-value"
                          name={`value:${m.id}`}
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Split value"
                        />
                      </label>
                    ))}
                  </fieldset>
                </div>
                <p className="muted">
                  All amounts are INR. Enter exact shares in rupees; percentages
                  must total 100%, and share values are relative weights.
                </p>
                <button type="submit" className="primary" disabled={busy}>
                  {busy ? "Saving…" : "Save expense"}
                </button>
              </form>
            </section>
          </>
        )}
        {page === "group" && group && (
          <section className="settlement-grid">
            <form
              className="content-card stack-form settlement-form"
              onSubmit={recordSettlement}
            >
              <span className="step">CLOSE THE LOOP</span>
              <h3>Record a settlement</h3>
              <p className="muted">
                Record a payment you made to a group member. The amount cannot
                exceed the outstanding balance.
              </p>
              <label>
                Paid to
                <select name="toUser" required defaultValue="">
                  <option value="" disabled>
                    Choose a member
                  </option>
                  {members
                    .filter((m) => m.id !== user.id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.fullName} · {m.email}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Amount (₹)
                <input
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                />
              </label>
              <label>
                Note (optional)
                <input name="note" maxLength={200} placeholder="Cash, UPI…" />
              </label>
              <button type="submit" className="primary" disabled={busy}>
                Record payment
              </button>
            </form>
            <div className="content-card">
              <div className="card-heading">
                <div>
                  <span className="step">PAYMENT HISTORY</span>
                  <h3>Settlements</h3>
                </div>
              </div>
              {settlements.map((item) => (
                <article className="notification-row" key={item.id}>
                  <span className="expense-icon">✓</span>
                  <div>
                    <b>
                      {item.fromName} paid {item.toName}
                    </b>
                    <small>
                      {currency(item.amountCents)} ·{" "}
                      {new Date(item.createdAt).toLocaleDateString("en-IN")}
                      {item.note ? ` · ${item.note}` : ""}
                    </small>
                  </div>
                </article>
              ))}
              {settlements.length === 0 && (
                <p className="muted">Recorded payments will appear here.</p>
              )}
            </div>
          </section>
        )}
        {page === "notifications" && (
          <section className="content-card">
            <div className="card-heading">
              <div>
                <span className="step">YOUR UPDATES</span>
                <h3>Notifications</h3>
              </div>
            </div>
            {notifications.map((item) => (
              <article className="notification-row" key={item.id}>
                <span className={`notify-dot ${item.readAt ? "read" : ""}`} />
                <div>
                  <b>{item.subject}</b>
                  <small>
                    {item.body} ·{" "}
                    {new Date(item.createdAt).toLocaleString("en-IN")}
                  </small>
                </div>
              </article>
            ))}
            {notifications.length === 0 && (
              <p className="muted">You're all caught up.</p>
            )}
          </section>
        )}
        <footer className="app-footer">
          <span>
            COMMON<span className="accent">.</span> MADE FOR SHARED LIVING.
          </span>
          <span>INR · Clear is kind.</span>
        </footer>
      </main>
    </div>
  );
}
