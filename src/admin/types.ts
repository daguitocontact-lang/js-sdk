/**
 * Public types for the admin client. JSON wire-field names mirror the
 * Python and Go SDKs exactly (`key_prefix`, `monthly_budget_micro_usd`,
 * etc). TS-side accessors stay camelCase.
 */

export interface AccountKey {
  id: string
  name: string
  keyPrefix: string
  monthlyBudgetMicroUsd: number | null
  currentMtdMicroUsd: number
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export interface AccountKeyCreated extends AccountKey {
  /** Full plaintext token. Shown ONCE on creation — persist it now. */
  plaintext: string
}

export interface PublicKey {
  id: string
  flowId: string
  name: string
  keyPrefix: string
  allowedOrigins: string[]
  monthlyBudgetMicroUsd: number | null
  currentMtdMicroUsd: number
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export interface PublicKeyCreated extends PublicKey {
  plaintext: string
}

export interface OrgBudget {
  monthlyBudgetMicroUsd: number | null
  currentMtdMicroUsd: number
  mtdResetAt: string | null
}

// ------------------------------------------------------------- wire shapes

export interface AccountKeyWire {
  id?: string
  name?: string
  key_prefix?: string
  monthly_budget_micro_usd?: number | null
  current_mtd_micro_usd?: number
  created_at?: string
  last_used_at?: string | null
  revoked_at?: string | null
}

export interface AccountKeyCreatedWire extends AccountKeyWire {
  plaintext?: string
}

export interface PublicKeyWire {
  id?: string
  flow_id?: string
  name?: string
  key_prefix?: string
  allowed_origins?: string[]
  monthly_budget_micro_usd?: number | null
  current_mtd_micro_usd?: number
  created_at?: string
  last_used_at?: string | null
  revoked_at?: string | null
}

export interface PublicKeyCreatedWire extends PublicKeyWire {
  plaintext?: string
}

export interface OrgBudgetWire {
  monthly_budget_micro_usd?: number | null
  current_mtd_micro_usd?: number
  mtd_reset_at?: string | null
}

export interface KeysListWire<T> {
  keys?: T[]
}

export function parseAccountKey(wire: AccountKeyWire): AccountKey {
  return {
    id: wire.id ?? '',
    name: wire.name ?? '',
    keyPrefix: wire.key_prefix ?? '',
    monthlyBudgetMicroUsd:
      typeof wire.monthly_budget_micro_usd === 'number'
        ? wire.monthly_budget_micro_usd
        : null,
    currentMtdMicroUsd: typeof wire.current_mtd_micro_usd === 'number' ? wire.current_mtd_micro_usd : 0,
    createdAt: wire.created_at ?? '',
    lastUsedAt: wire.last_used_at ?? null,
    revokedAt: wire.revoked_at ?? null,
  }
}

export function parseAccountKeyCreated(wire: AccountKeyCreatedWire): AccountKeyCreated {
  return { ...parseAccountKey(wire), plaintext: wire.plaintext ?? '' }
}

export function parsePublicKey(wire: PublicKeyWire): PublicKey {
  return {
    id: wire.id ?? '',
    flowId: wire.flow_id ?? '',
    name: wire.name ?? '',
    keyPrefix: wire.key_prefix ?? '',
    allowedOrigins: Array.isArray(wire.allowed_origins) ? wire.allowed_origins : [],
    monthlyBudgetMicroUsd:
      typeof wire.monthly_budget_micro_usd === 'number'
        ? wire.monthly_budget_micro_usd
        : null,
    currentMtdMicroUsd: typeof wire.current_mtd_micro_usd === 'number' ? wire.current_mtd_micro_usd : 0,
    createdAt: wire.created_at ?? '',
    lastUsedAt: wire.last_used_at ?? null,
    revokedAt: wire.revoked_at ?? null,
  }
}

export function parsePublicKeyCreated(wire: PublicKeyCreatedWire): PublicKeyCreated {
  return { ...parsePublicKey(wire), plaintext: wire.plaintext ?? '' }
}

export function parseOrgBudget(wire: OrgBudgetWire): OrgBudget {
  return {
    monthlyBudgetMicroUsd:
      typeof wire.monthly_budget_micro_usd === 'number'
        ? wire.monthly_budget_micro_usd
        : null,
    currentMtdMicroUsd: typeof wire.current_mtd_micro_usd === 'number' ? wire.current_mtd_micro_usd : 0,
    mtdResetAt: wire.mtd_reset_at ?? null,
  }
}
