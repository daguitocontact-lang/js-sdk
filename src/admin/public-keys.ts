/**
 * Public flow-key admin service — `client.publicKeys.{list,create,revoke,setBudget}`.
 */

import { AdminTransport, DaguitoError } from './http'
import {
  KeysListWire,
  PublicKey,
  PublicKeyCreated,
  PublicKeyCreatedWire,
  PublicKeyWire,
  parsePublicKey,
  parsePublicKeyCreated,
} from './types'

export interface CreatePublicKeyInput {
  name: string
  allowedOrigins: string[]
  monthlyBudgetMicroUsd?: number | null
}

export class PublicKeysService {
  constructor(private readonly transport: AdminTransport) {}

  async list(flowId: string): Promise<PublicKey[]> {
    const data = await this.transport.request<KeysListWire<PublicKeyWire>>(
      'GET',
      `/v1/flows/${encodeURIComponent(flowId)}/public-keys`,
    )
    return (data?.keys ?? []).map(parsePublicKey)
  }

  async create(flowId: string, input: CreatePublicKeyInput): Promise<PublicKeyCreated> {
    const body: Record<string, unknown> = {
      name: input.name,
      allowed_origins: input.allowedOrigins,
    }
    if (input.monthlyBudgetMicroUsd !== undefined) {
      body.monthly_budget_micro_usd = input.monthlyBudgetMicroUsd
    }
    const data = await this.transport.request<PublicKeyCreatedWire>(
      'POST',
      `/v1/flows/${encodeURIComponent(flowId)}/public-keys`,
      body,
    )
    if (!data) throw new DaguitoError('expected JSON object from POST public-keys')
    return parsePublicKeyCreated(data)
  }

  async revoke(flowId: string, keyId: string): Promise<void> {
    await this.transport.request(
      'DELETE',
      `/v1/flows/${encodeURIComponent(flowId)}/public-keys/${encodeURIComponent(keyId)}`,
    )
  }

  async setBudget(
    flowId: string,
    keyId: string,
    monthlyBudgetMicroUsd: number | null,
  ): Promise<PublicKey> {
    await this.transport.request(
      'PATCH',
      `/v1/flows/${encodeURIComponent(flowId)}/public-keys/${encodeURIComponent(keyId)}/budget`,
      { monthly_budget_micro_usd: monthlyBudgetMicroUsd },
    )
    const keys = await this.list(flowId)
    const match = keys.find((k) => k.id === keyId)
    if (!match) throw new DaguitoError('key not found after budget update')
    return match
  }
}
