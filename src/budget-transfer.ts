export type Channel = "cash" | "digital";

type State = {
  budget: number;
  cashBudget: number | null;
  cashSpent: number;
  digitalSpent: number;
};

type ReallocationInput = State & { from: Channel; amount: number };
type ReallocationResult =
  | { ok: true; cashBudget: number; digitalBudget: number }
  | { ok: false; reason: "invalid-amount" | "allocation-not-configured" | "allocation-below-spend" | "insufficient-source-balance" };

const safeNonnegative = (value: number) => Number.isSafeInteger(value) && value >= 0;

export function resolveReallocation(input: ReallocationInput): ReallocationResult {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) return { ok: false, reason: "invalid-amount" };
  if (input.cashBudget === null) return { ok: false, reason: "allocation-not-configured" };
  const { budget, cashBudget, cashSpent, digitalSpent, from, amount } = input;
  if (![budget, cashBudget, cashSpent, digitalSpent].every(safeNonnegative) || cashBudget > budget) return { ok: false, reason: "allocation-below-spend" };
  const digitalBudget = budget - cashBudget;
  if (cashSpent > cashBudget || digitalSpent > digitalBudget) return { ok: false, reason: "allocation-below-spend" };
  const available = from === "cash" ? cashBudget - cashSpent : digitalBudget - digitalSpent;
  if (amount > available) return { ok: false, reason: "insufficient-source-balance" };
  const nextCashBudget = from === "cash" ? cashBudget - amount : cashBudget + amount;
  const nextDigitalBudget = budget - nextCashBudget;
  if (nextCashBudget < cashSpent || nextDigitalBudget < digitalSpent) return { ok: false, reason: "allocation-below-spend" };
  return { ok: true, cashBudget: nextCashBudget, digitalBudget: nextDigitalBudget };
}

type BudgetAdjustmentInput = State & { deltaBudget: number; deltaCashBudget: number };
type BudgetAdjustmentResult =
  | { ok: true; budget: number; cashBudget: number; digitalBudget: number }
  | { ok: false; reason: "invalid-adjustment" | "allocation-not-configured" | "allocation-below-spend" };

export function resolveBudgetAdjustment(input: BudgetAdjustmentInput): BudgetAdjustmentResult {
  const { budget, cashBudget, cashSpent, digitalSpent, deltaBudget, deltaCashBudget } = input;
  if (!Number.isSafeInteger(deltaBudget) || !Number.isSafeInteger(deltaCashBudget) || deltaBudget === 0) return { ok: false, reason: "invalid-adjustment" };
  if (cashBudget === null) return { ok: false, reason: "allocation-not-configured" };
  if (![budget, cashBudget, cashSpent, digitalSpent].every(safeNonnegative) || cashBudget > budget) return { ok: false, reason: "allocation-below-spend" };
  const nextBudget = budget + deltaBudget;
  const nextCashBudget = cashBudget + deltaCashBudget;
  if (!Number.isSafeInteger(nextBudget) || !Number.isSafeInteger(nextCashBudget) || nextBudget < 1 || nextCashBudget < 0 || nextCashBudget > nextBudget) return { ok: false, reason: "invalid-adjustment" };
  const nextDigitalBudget = nextBudget - nextCashBudget;
  if (nextCashBudget < cashSpent || nextDigitalBudget < digitalSpent) return { ok: false, reason: "allocation-below-spend" };
  return { ok: true, budget: nextBudget, cashBudget: nextCashBudget, digitalBudget: nextDigitalBudget };
}
