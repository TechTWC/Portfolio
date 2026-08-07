export type TransactionBinding = {
  transactionDatasetId: string
  transactionRevision: number
}

export type CurrentTransactionState = {
  activeDatasetId: string | null
  cloudRevision: number
}

export type ValuationFreshness = 'CURRENT' | 'STALE' | 'NO_SNAPSHOT'

export function transactionBindingMatches(
  binding: TransactionBinding,
  current: CurrentTransactionState,
): boolean {
  return binding.transactionDatasetId === current.activeDatasetId
    && binding.transactionRevision === current.cloudRevision
}

export function determineValuationFreshness(
  binding: TransactionBinding | null,
  current: CurrentTransactionState,
): ValuationFreshness {
  if (!binding) return 'NO_SNAPSHOT'
  return transactionBindingMatches(binding, current) ? 'CURRENT' : 'STALE'
}
