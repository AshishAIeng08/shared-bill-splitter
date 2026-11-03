import { type FormEvent, useCallback, useEffect, useState } from "react";

type Share = {
  id: string;
  memberId: string;
  memberName: string;
  amountCents: number;
  paidAt: string | null;
};
type Bill = { id: string; title: string; totalCents: number; shares: Share[] };
type Home = { id: string; name: string };
const api = "/api";
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${api}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new Error(
      "Can’t reach the server. Check your connection and try again.",
    );
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof result === "object" &&
      result !== null &&
      "error" in result &&
      typeof result.error === "string"
        ? result.error
        : "Something went wrong. Try again.";
    throw new Error(message);
  }
  return result as T;
}

export function HomePage() {
  const [home, setHome] = useState<Home | null>(null);
  const [bills, setBills] = useState<Bill[]>([]);
  const [homeName, setHomeName] = useState("");
  const [memberName, setMemberName] = useState("");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyShare, setBusyShare] = useState<string | null>(null);

  const refresh = useCallback(async (homeId: string) => {
    const data = await request<{ bills: Bill[] }>(`/homes/${homeId}/bills`);
    setBills(data.bills);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("common-home");
    if (saved) {
      try {
        const parsed: unknown = JSON.parse(saved);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "id" in parsed &&
          "name" in parsed &&
          typeof parsed.id === "string" &&
          typeof parsed.name === "string"
        ) {
          const savedHome: Home = { id: parsed.id, name: parsed.name };
          setHome(savedHome);
          setLoading(true);
          request<{ bills: Bill[] }>(`/homes/${parsed.id}/bills`)
            .then((data) => setBills(data.bills))
            .catch((e) =>
              setError(
                e instanceof Error ? e.message : "Could not load bills.",
              ),
            )
            .finally(() => setLoading(false));
        }
      } catch {
        localStorage.removeItem("common-home");
      }
    }
  }, []);

  async function action(event: FormEvent, work: () => Promise<void>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }
  async function createHome(event: FormEvent) {
    await action(event, async () => {
      const made = await request<Home>("/homes", {
        method: "POST",
        body: JSON.stringify({ name: homeName }),
      });
      setHome(made);
      localStorage.setItem("common-home", JSON.stringify(made));
      setHomeName("");
    });
  }
  async function addMember(event: FormEvent) {
    if (!home) return;
    await action(event, async () => {
      await request(`/homes/${home.id}/members`, {
        method: "POST",
        body: JSON.stringify({ name: memberName }),
      });
      setMemberName("");
    });
  }
  async function addBill(event: FormEvent) {
    if (!home) return;
    await action(event, async () => {
      await request(`/homes/${home.id}/bills`, {
        method: "POST",
        body: JSON.stringify({
          title,
          totalCents: Math.round(Number(amount) * 100),
        }),
      });
      setTitle("");
      setAmount("");
      await refresh(home.id);
    });
  }
  async function pay(share: Share, billId: string) {
    if (!home) return;
    setBusyShare(share.id);
    setError("");
    try {
      await request(`/bills/${billId}/shares/${share.id}/pay`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      await refresh(home.id);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Payment failed. Your share is still unpaid.",
      );
    } finally {
      setBusyShare(null);
    }
  }

  return (
    <main className="shell">
      <section className="intro">
        <div className="eyebrow">
          <span className="dot" /> THE HOUSEHOLD TAB, WITHOUT THE TAB
        </div>
        <h1>
          Good friends.
          <br />
          <em>Clear balances.</em>
        </h1>
        <p>
          Keep the shared stuff simple. Add a home, split a bill, and let
          everyone settle their own share.
        </p>
      </section>
      {error && (
        <div className="alert" role="alert">
          <span>Something needs a look</span>
          {error}
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            ×
          </button>
        </div>
      )}
      {!home ? (
        <section className="setup panel">
          <div>
            <span className="step">01 / START HERE</span>
            <h2>Make it your home.</h2>
            <p>Give your shared space a name to get started.</p>
          </div>
          <form onSubmit={createHome} className="form-row">
            <input
              aria-label="Home name"
              value={homeName}
              onChange={(e) => setHomeName(e.target.value)}
              placeholder="e.g. The Sunny Flat"
              required
              maxLength={200}
            />
            <button type="submit" disabled={loading}>
              Create home <span>↗</span>
            </button>
          </form>
        </section>
      ) : (
        <>
          <section className="home-banner">
            <div>
              <span className="step">YOUR SPACE</span>
              <h2>{home.name}</h2>
            </div>
            <span className="home-icon">⌂</span>
          </section>
          <section className="forms-grid">
            <form className="panel mini-form" onSubmit={(e) => addMember(e)}>
              <span className="step">01 / THE HOUSEHOLD</span>
              <h3>Who lives here?</h3>
              <p>Add a housemate before splitting your first bill.</p>
              <div className="form-row">
                <input
                  aria-label="Member name"
                  placeholder="Their name"
                  value={memberName}
                  onChange={(e) => setMemberName(e.target.value)}
                  required
                  maxLength={200}
                />
                <button type="submit" disabled={loading}>
                  Add person
                </button>
              </div>
            </form>
            <form className="panel mini-form" onSubmit={(e) => addBill(e)}>
              <span className="step">02 / THE BILL</span>
              <h3>Share something.</h3>
              <p>Split evenly. Any leftover cents go in signup order.</p>
              <div className="form-row">
                <input
                  aria-label="Bill title"
                  placeholder="What was it for?"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  maxLength={200}
                />
                <input
                  aria-label="Amount in dollars"
                  className="amount-input"
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="$0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
                <button type="submit" disabled={loading}>
                  Split bill
                </button>
              </div>
            </form>
          </section>
          <section className="bills-section">
            <div className="section-heading">
              <div>
                <span className="step">THE RUNNING TAB</span>
                <h2>
                  Shared bills{" "}
                  <span className="count">
                    {bills.length.toString().padStart(2, "0")}
                  </span>
                </h2>
              </div>
              <span className="muted">Everyone pays their own part</span>
            </div>
            {loading && bills.length === 0 ? (
              <div className="state">
                <span className="spinner" /> Loading your bills…
              </div>
            ) : bills.length === 0 ? (
              <div className="empty panel">
                <span className="empty-mark">↗</span>
                <h3>Nothing on the tab yet.</h3>
                <p>
                  Add housemates and split your first bill. It’ll show up here.
                </p>
              </div>
            ) : (
              <div className="bill-list">
                {bills.map((bill, index) => (
                  <article className="bill-card" key={bill.id}>
                    <div className="bill-head">
                      <div>
                        <span className="step">
                          BILL {String(bills.length - index).padStart(2, "0")}
                        </span>
                        <h3>{bill.title}</h3>
                      </div>
                      <div className="bill-total">
                        <span>TOTAL</span>
                        <strong>{money(bill.totalCents)}</strong>
                      </div>
                    </div>
                    <div className="share-list">
                      {bill.shares.map((share) => (
                        <div className="share" key={share.id}>
                          <span className="person-dot">
                            {share.memberName.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="person-name">
                            {share.memberName}
                          </span>
                          <strong>{money(share.amountCents)}</strong>
                          {share.paidAt ? (
                            <span className="paid">
                              <i /> Settled
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="pay-button"
                              disabled={busyShare === share.id}
                              onClick={() => pay(share, bill.id)}
                            >
                              {busyShare === share.id ? "Paying…" : "Mark paid"}{" "}
                              <span>↗</span>
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      <footer>
        <span>
          COMMON<span className="accent">.</span> MADE FOR SHARED LIVING.
        </span>
        <span>Clear is kind.</span>
      </footer>
    </main>
  );
}
