/**
 * Template preview service — `client.templates.preview({ templateBody, … })`.
 *
 * Wraps `POST /v1/templates/preview`. Given a markdown/text body with
 * `[[descripción natural]]` placeholders, returns the inferred JSON
 * schema, the typed field list, optional warnings, and (when the server
 * decides to run the extractor) a model-extracted example payload. The
 * placeholder body is plain natural-language description — there is no
 * `| type` syntax, the model infers the field type downstream.
 *
 * Auth = the same Bearer account key as `client.flows.upsertAgent(...)`.
 */

import { AdminTransport, DaguitoError } from './http'

export type TemplateFieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'array'
  | 'enum'

export interface TemplateFieldDetail {
  name: string
  description: string
  type: TemplateFieldType
  enumValues?: string[]
}

export interface TemplateSchema {
  name: string
  schema: Record<string, unknown>
}

export interface TemplatePreviewExample {
  transcript: string
  transcriptOrigin: 'caller' | 'default'
  extracted: Record<string, unknown> | null
  model: string
}

export interface TemplatePreviewWarning {
  code: string
  field?: string
  message: string
  hint?: string
}

export interface TemplatePreviewInput {
  templateBody: string
  vertical?: string
  model?: string
  forceRegenerate?: boolean
}

export interface TemplatePreviewResult {
  templateSchema: TemplateSchema
  fieldNames: string[]
  fieldCount: number
  fieldsDetail: TemplateFieldDetail[]
  example: TemplatePreviewExample | null
  warnings: TemplatePreviewWarning[]
  bodyHash: string
}

interface TemplateFieldDetailWire {
  name?: string
  description?: string
  type?: TemplateFieldType
  enum_values?: string[]
}

interface TemplatePreviewExampleWire {
  transcript?: string
  transcript_origin?: 'caller' | 'default'
  extracted?: Record<string, unknown> | null
  model?: string
}

interface TemplatePreviewWarningWire {
  code?: string
  field?: string
  message?: string
  hint?: string
}

interface TemplatePreviewResultWire {
  template_schema?: { name?: string; schema?: Record<string, unknown> }
  field_names?: string[]
  field_count?: number
  fields_detail?: TemplateFieldDetailWire[]
  example?: TemplatePreviewExampleWire | null
  warnings?: TemplatePreviewWarningWire[]
  body_hash?: string
}

export class TemplatesService {
  constructor(private readonly transport: AdminTransport) {}

  async preview(input: TemplatePreviewInput): Promise<TemplatePreviewResult> {
    if (!input.templateBody) {
      throw new DaguitoError('preview: templateBody is required')
    }
    const body: Record<string, unknown> = { template_body: input.templateBody }
    if (input.vertical !== undefined) body.vertical = input.vertical
    if (input.model !== undefined) body.model = input.model
    if (input.forceRegenerate !== undefined) body.force_regenerate = input.forceRegenerate
    const data = await this.transport.request<TemplatePreviewResultWire>(
      'POST',
      '/v1/templates/preview',
      body,
    )
    if (!data) throw new DaguitoError('expected JSON object from POST /v1/templates/preview')
    return parsePreviewResult(data)
  }
}

function parsePreviewResult(wire: TemplatePreviewResultWire): TemplatePreviewResult {
  const schema = wire.template_schema ?? {}
  return {
    templateSchema: {
      name: schema.name ?? '',
      schema: schema.schema ?? {},
    },
    fieldNames: Array.isArray(wire.field_names)
      ? wire.field_names.filter((n): n is string => typeof n === 'string')
      : [],
    fieldCount: typeof wire.field_count === 'number' ? wire.field_count : 0,
    fieldsDetail: Array.isArray(wire.fields_detail)
      ? wire.fields_detail.map(parseFieldDetail)
      : [],
    example: wire.example ? parseExample(wire.example) : null,
    warnings: Array.isArray(wire.warnings) ? wire.warnings.map(parseWarning) : [],
    bodyHash: typeof wire.body_hash === 'string' ? wire.body_hash : '',
  }
}

function parseFieldDetail(wire: TemplateFieldDetailWire): TemplateFieldDetail {
  const result: TemplateFieldDetail = {
    name: wire.name ?? '',
    description: wire.description ?? '',
    type: wire.type ?? 'string',
  }
  if (Array.isArray(wire.enum_values)) {
    result.enumValues = wire.enum_values.filter((v): v is string => typeof v === 'string')
  }
  return result
}

function parseExample(wire: TemplatePreviewExampleWire): TemplatePreviewExample {
  return {
    transcript: wire.transcript ?? '',
    transcriptOrigin: wire.transcript_origin === 'caller' ? 'caller' : 'default',
    extracted: wire.extracted ?? null,
    model: wire.model ?? '',
  }
}

function parseWarning(wire: TemplatePreviewWarningWire): TemplatePreviewWarning {
  const result: TemplatePreviewWarning = {
    code: wire.code ?? '',
    message: wire.message ?? '',
  }
  if (wire.field !== undefined) result.field = wire.field
  if (wire.hint !== undefined) result.hint = wire.hint
  return result
}
