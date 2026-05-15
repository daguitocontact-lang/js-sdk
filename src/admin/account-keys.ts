/**
 * Account-key admin service — `client.accountKeys.{list,create,revoke,setBudget}`.
 *
 * Mirrors `daguito.account_keys` in Python and `Client.AccountKeys` in Go.
 */

import { AdminTransport, DaguitoError } from './http'
import {
  AccountKey,
  AccountKeyCreated,
  AccountKeyCreatedWire,
  AccountKeyWire,
  KeysListWire,
  parseAccountKey,
  parseAccountKeyCreated,
} from './types'

export interface CreateAccountKeyInput {
  name: string
  monthlyBudgetMicroUsd?: number | null
}

export class AccountKeysService {
  constructor(private readonly transport: AdminTransport) {}

  async list(): Promise<AccountKey[]> {
    const data = await this.transport.request<KeysListWire<AccountKeyWire>>(
      'GET',
      '/v1/account/api-keys',
    )
    return (data?.keys ?? []).map(parseAccountKey)
  }

  async create(input: CreateAccountKeyInput): Promise<AccountKeyCreated> {
    const body: Record<string, unknown> = { name: input.name }
    if (input.monthlyBudgetMicroUsd !== undefined) {
      body.monthly_budget_micro_usd = input.monthlyBudgetMicroUsd
    }
    const data = await this.transport.request<AccountKeyCreatedWire>(
      'POST',
      '/v1/account/api-keys',
      body,
    )
    if (!data) throw new DaguitoError('expected JSON object from POST /v1/account/api-keys')
    return parseAccountKeyCreated(data)
  }

  async revoke(keyId: string): Promise<void> {
    await this.transport.request('DELETE', `/v1/account/api-keys/${encodeURIComponent(keyId)}`)
  }

  async setBudget(keyId: string, monthlyBudgetMicroUsd: number | null): Promise<AccountKey> {
    await this.transport.request(
      'PATCH',
      `/v1/account/api-keys/${encodeURIComponent(keyId)}/budget`,
      { monthly_budget_micro_usd: monthlyBudgetMicroUsd },
    )
    // The PATCH /budget endpoint returns {id, monthly_budget_micro_usd}; we
    // re-list to surface the full shape consumers expect.
    const keys = await this.list()
    const match = keys.find((k) => k.id === keyId)
    if (!match) throw new DaguitoError('key not found after budget update')
    return match
  }
}
