export type CashBudgetUpdate =
  | { ok: true; cashBudget: number | null }
  | { ok: false };

export function resolveCashBudgetUpdate(
  totalBudget: number,
  currentCashBudget: number | null,
  requestedCashBudget: number | null | undefined,
): CashBudgetUpdate {
  if (!Number.isSafeInteger(totalBudget) || totalBudget < 1) return { ok: false };
  const cashBudget = requestedCashBudget === undefined
    ? currentCashBudget === null ? null : Math.min(currentCashBudget, totalBudget)
    : requestedCashBudget;

  if (
    cashBudget !== null &&
    (!Number.isSafeInteger(cashBudget) || cashBudget < 0 || cashBudget > totalBudget)
  ) {
    return { ok: false };
  }
  return { ok: true, cashBudget };
}
