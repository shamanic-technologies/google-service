// Thrown by a mirror write for an account that is no longer connected (its
// disconnect is purging the mirror, or the row is gone). Every bronze write is
// guarded in SQL by the account's state, so an ingest that started before the
// disconnect stops at its next write instead of racing the purge.
export class AccountDisconnectedError extends Error {
  constructor(public readonly accountId: string) {
    super(`Google account ${accountId} is disconnected: mirror writes refused`);
    this.name = "AccountDisconnectedError";
  }
}
