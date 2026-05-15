/**
 * Org-level budget admin service — `client.budgets.{getOrg,setOrg}`.
 *
 * Per-key budgets live on `accountKeys.setBudget` / `publicKeys.setBudget`.
 */

import { AdminTransport, DaguitoError } from './http'
import { OrgBudget, OrgBudgetWire, parseOrgBudget } from './types'

export class BudgetsService {
  constructor(private readonly transport: AdminTransport) {}

  async getOrg(): Promise<OrgBudget> {
    const data = await this.transport.request<OrgBudgetWire>('GET', '/v1/account/budget')
    if (!data) throw new DaguitoError('expected JSON object from GET /v1/account/budget')
    return parseOrgBudget(data)
  }

  async setOrg(monthlyBudgetMicroUsd: number | null): Promise<OrgBudget> {
    const data = await this.transport.request<OrgBudgetWire>('PATCH', '/v1/account/budget', {
      monthly_budget_micro_usd: monthlyBudgetMicroUsd,
    })
    if (!data) throw new DaguitoError('expected JSON object from PATCH /v1/account/budget')
    return parseOrgBudget(data)
  }
}
