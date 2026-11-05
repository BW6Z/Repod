import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * One paid run at a time per runs folder.
 *
 * Each SpendTracker checks the cumulative budget against a snapshot of past
 * spend taken when it starts. Two processes starting together (two `run`s,
 * or a `run` and a `probe`) would both see the same snapshot and could
 * together overspend. Every paid command therefore takes this lock before it
 * reads the ledgers, and holds it until its last call is recorded. A second
 * command is refused, not queued, so it can never act on an old snapshot.
 *
 * A lock left behind by a process that died (or was stopped with Ctrl+C) is
 * never removed automatically: its run may have unfinished ledger entries,
 * and a reused process id cannot be told apart from a live owner. The error
 * says how to check and remove it by hand.
 */
export const PAID_RUN_LOCK = "paid-run.lock";

interface LockOwner {
  token: string;
  pid: number;
  command: string;
  startedAt: string;
}

export class PaidRunLockedError extends Error {
  constructor(file: string, owner: LockOwner | null) {
    const who = owner ? `"${owner.command}" (process ${owner.pid}, started ${owner.startedAt})` : "an unknown owner (the lock file is unreadable)";
    const alive = owner ? isProcessAlive(owner.pid) : null;
    const hint = alive === false
      ? `Process ${owner!.pid} is no longer running, so the lock is probably stale.`
      : "If that process is no longer running, the lock is stale.";
    super(
      `Another paid command holds ${file}: ${who}. ${hint} ` +
      `To recover, make sure no Repod command is running, check its spend with "npm run repod -- spend", then delete the lock file.`,
    );
    this.name = "PaidRunLockedError";
  }
}

/** A hint only: process ids are reused, so "alive" may be a different process. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock's owner, or null if the file is unreadable or not in the expected shape. */
async function readOwner(file: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<LockOwner> | null;
    const valid =
      typeof value?.token === "string" && Number.isSafeInteger(value.pid) &&
      typeof value.command === "string" && typeof value.startedAt === "string";
    return valid ? (value as LockOwner) : null;
  } catch {
    return null;
  }
}

/**
 * Takes the paid-run lock in runsDir, or throws PaidRunLockedError if any
 * other command holds it. Returns the function that releases it.
 */
export async function acquirePaidRunLock(runsDir: string, command: string): Promise<() => Promise<void>> {
  await mkdir(runsDir, { recursive: true });
  const file = path.join(runsDir, PAID_RUN_LOCK);
  const owner: LockOwner = { token: randomUUID(), pid: process.pid, command, startedAt: new Date().toISOString() };
  try {
    // "wx" creates the file only if it does not exist, atomically: of two
    // processes racing here, exactly one succeeds.
    await writeFile(file, JSON.stringify(owner), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PaidRunLockedError(file, await readOwner(file));
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    // Only remove our own lock: if someone deleted it by hand and another
    // command took it since, that command's lock must stay.
    if ((await readOwner(file))?.token === owner.token) await rm(file, { force: true });
  };
}
