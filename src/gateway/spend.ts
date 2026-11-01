import { readdir } from "node:fs/promises";
import path from "node:path";
import { LedgerCorruptError, ledgerPath, readEvents, type LedgerEvent } from "./ledger.ts";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Total spend recorded in every run ledger under runsDir.
 *
 * Deliberately pessimistic: a call with unknown cost counts its reservation,
 * and a call_start without a matching call_end (process killed mid-request)
 * also counts its reservation, because the provider may have billed it.
 *
 * Fails closed: only a missing directory or ledger counts as nothing spent.
 * An unreadable directory, a corrupt or malformed ledger, or an end event
 * whose cost cannot be determined throws, so no new paid call is made until a
 * human has looked at it.
 */
export async function totalSpentUsd(runsDir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }

  let total = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = ledgerPath(path.join(runsDir, entry.name));
    let events: LedgerEvent[];
    try {
      events = await readEvents(file);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    const open = new Map<string, number>();
    for (const event of events) {
      if (event.type === "call_start") {
        open.set(event.attemptId, event.reservedUsd);
      } else if (event.type === "call_end") {
        const reserved = open.get(event.attemptId);
        if (event.costUsd === null && reserved === undefined) {
          // Neither a cost nor a reservation to fall back on: unknown spend.
          throw new LedgerCorruptError(file, `call_end for "${event.attemptId}" has no cost and no matching call_start`);
        }
        total += event.costUsd ?? reserved!;
        open.delete(event.attemptId);
      }
    }
    for (const reserved of open.values()) total += reserved;
  }
  return total;
}

/** Budget held for one in-flight call until it is settled or released. */
export interface Reservation {
  readonly amountUsd: number;
  closed: boolean;
}

// "run": this run's budget is used up; "total": the budget across all runs is.
export type BudgetScope = "run" | "total";
export type ReserveResult = { ok: true; reservation: Reservation } | { ok: false; reason: string; scope: BudgetScope };

function requireAmount(name: string, value: number, allowZero = true): void {
  // NaN fails every comparison, so an unchecked NaN would pass every budget check.
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new RangeError(`${name} must be a finite ${allowZero ? "non-negative" : "positive"} number, got ${value}`);
  }
}

/**
 * Tracks spend for one run against both the per-run and the cumulative budget.
 *
 * A reservation holds its amount until it is settled with the real cost (the
 * request was sent) or released (it never was), so concurrent calls cannot
 * each pass the budget check against the same remaining money. Every amount
 * is validated, so a bad number can never disable the checks.
 */
export class SpendTracker {
  private readonly runBudgetUsd: number;
  private readonly totalBudgetUsd: number;
  private readonly spentBeforeRunUsd: number;
  private runSpentUsd = 0;
  private heldUsd = 0;

  constructor(runBudgetUsd: number, totalBudgetUsd: number, spentBeforeRunUsd: number) {
    requireAmount("runBudgetUsd", runBudgetUsd, false);
    requireAmount("totalBudgetUsd", totalBudgetUsd, false);
    requireAmount("spentBeforeRunUsd", spentBeforeRunUsd);
    this.runBudgetUsd = runBudgetUsd;
    this.totalBudgetUsd = totalBudgetUsd;
    this.spentBeforeRunUsd = spentBeforeRunUsd;
  }

  /** Settled spend of this run. */
  get runSpent(): number {
    return this.runSpentUsd;
  }

  tryReserve(amountUsd: number): ReserveResult {
    requireAmount("reservation", amountUsd);
    const committed = this.runSpentUsd + this.heldUsd + amountUsd;
    if (committed > this.runBudgetUsd) {
      return { ok: false, reason: `run budget $${this.runBudgetUsd} would be exceeded`, scope: "run" };
    }
    if (this.spentBeforeRunUsd + committed > this.totalBudgetUsd) {
      return { ok: false, reason: `total budget $${this.totalBudgetUsd} across runs would be exceeded`, scope: "total" };
    }
    this.heldUsd += amountUsd;
    return { ok: true, reservation: { amountUsd, closed: false } };
  }

  /**
   * The request was sent: releases the hold and records what it cost.
   *
   * An invalid cost (NaN, infinite, negative) still settles, at the full
   * reservation, before the error is raised: the request may have been
   * billed, so its hold must neither stay open nor turn into zero spend.
   */
  settle(reservation: Reservation, actualUsd: number): void {
    const valid = Number.isFinite(actualUsd) && actualUsd >= 0;
    this.close(reservation);
    this.runSpentUsd += valid ? actualUsd : reservation.amountUsd;
    if (!valid) requireAmount("actual cost", actualUsd);
  }

  /**
   * The request was never sent: releases the hold without recording spend.
   * Only for failures before the provider could have seen the request; once
   * it may have been sent, settle with the reservation instead.
   */
  release(reservation: Reservation): void {
    this.close(reservation);
  }

  private close(reservation: Reservation): void {
    if (reservation.closed) throw new Error("Reservation already settled or released");
    reservation.closed = true;
    this.heldUsd -= reservation.amountUsd;
  }
}
