import { createHash } from 'node:crypto'
import { C_MEASURES, FilterOperator } from '@xpert-ai/ocap-core'
import type { QueryOptions, QueryReturn } from '@xpert-ai/ocap-core'

export type UoseMdxQueryMode = 'semantic_dsl' | 'mdx_statement' | 'native_dsl'
export type UoseMetricLevel = 'raw' | 'business' | 'decision'
export type UosePolicyEffect = 'allow' | 'deny' | 'require_approval'

export enum UoseMdxAdapterErrorCode {
	CUBE_NOT_FOUND = 'UOSE-MDX-4041',
	METRIC_NOT_MAPPED = 'UOSE-MDX-4042',
	DIMENSION_NOT_MAPPED = 'UOSE-MDX-4043',
	METRIC_VERSION_CONFLICT = 'UOSE-MDX-4091',
	POLICY_DENIED = 'UOSE-MDX-4031',
	QUERY_TIMEOUT = 'UOSE-MDX-5041',
	PROVIDER_ERROR = 'UOSE-MDX-5001'
}

export interface UoseMdxAdapterContext {
	traceId: string
	taskId: string
	principalId: string
	tenantId?: string
	organizationId?: string
	requestedAt: string
}

export interface UoseMdxMetricRef {
	metricId: string
	metricVersion?: string
	level?: UoseMetricLevel
}

export interface UoseMdxDimensionRef {
	dimensionId: string
	hierarchy?: string[]
	level?: string
}

export interface UoseMdxFilter {
	field: string
	op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'between' | 'contains'
	value: unknown
}

export interface UoseMdxQueryRequest {
	context: UoseMdxAdapterContext
	queryMode?: UoseMdxQueryMode
	modelId: string
	cubeName: string
	metrics: UoseMdxMetricRef[]
	dimensions?: UoseMdxDimensionRef[]
	filters?: UoseMdxFilter[]
	statement?: string
	nativeQuery?: Record<string, unknown>
	timeWindow?: {
		from: string
		to: string
		timezone?: string
	}
	limit?: number
	includeAuditFields?: boolean
}

export interface UoseMdxAdapterError {
	code: UoseMdxAdapterErrorCode
	message: string
	details?: Record<string, unknown>
}

export interface UoseMdxQueryResponse {
	columns: Array<{ name: string; type: string }>
	rows: Array<Record<string, unknown>>
	rowCount: number
	mdx?: string
	sql?: string
	appliedMetricVersions: Array<{ metricId: string; metricVersion: string }>
	audit: {
		traceId: string
		taskId: string
		principalId: string
		modelId: string
		cubeName: string
		metricRefs: string[]
		policyDecision: UosePolicyEffect | 'allow'
		queryHash: string
		durationMs: number
		rowCount: number
		occurredAt: string
	}
}

export function buildOcapQueryFromUose(request: UoseMdxQueryRequest): QueryOptions {
	if (request.queryMode === 'native_dsl') {
		return {
			...(request.nativeQuery ?? {}),
			cube: normalizeString(request.nativeQuery?.cube) ?? request.cubeName
		} as QueryOptions
	}

	const rows = (request.dimensions ?? []).map((dimension) => ({
		dimension: dimension.dimensionId,
		hierarchy: dimension.hierarchy?.[0] ?? dimension.dimensionId,
		level: dimension.level
	}))
	const columns = request.metrics.map((metric) => ({
		dimension: C_MEASURES,
		measure: metric.metricId
	}))
	const filters = [
		...(request.filters ?? []).map(mapFilter),
		...mapTimeWindowFilters(request)
	]

	return {
		cube: request.cubeName,
		rows,
		columns,
		filters,
		paging: {
			top: normalizeLimit(request.limit)
		}
	}
}

export function normalizeUoseQueryResponse(
	request: UoseMdxQueryRequest,
	payload: unknown,
	durationMs: number
): UoseMdxQueryResponse {
	const queryReturn = unwrapQueryReturn(payload)
	const rows = extractRows(queryReturn)
	const columns = extractColumns(queryReturn, rows)
	const stats = readObject(queryReturn)?.stats as Record<string, unknown> | undefined
	const statements = Array.isArray(stats?.statements) ? stats.statements.filter((item): item is string => typeof item === 'string') : []
	const rowCount = rows.length

	return {
		columns,
		rows,
		rowCount,
		mdx: request.statement ?? statements[0],
		sql: normalizeString(stats?.sql),
		appliedMetricVersions: request.metrics.map((metric) => ({
			metricId: metric.metricId,
			metricVersion: metric.metricVersion ?? 'latest'
		})),
		audit: {
			traceId: request.context.traceId,
			taskId: request.context.taskId,
			principalId: request.context.principalId,
			modelId: request.modelId,
			cubeName: request.cubeName,
			metricRefs: request.metrics.map((metric) => metric.metricId),
			policyDecision: 'allow',
			queryHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
			durationMs,
			rowCount,
			occurredAt: new Date().toISOString()
		}
	}
}

export function buildUoseMdxError(
	code: UoseMdxAdapterErrorCode,
	message: string,
	details?: Record<string, unknown>
): UoseMdxAdapterError {
	return {
		code,
		message,
		details
	}
}

function mapFilter(filter: UoseMdxFilter) {
	const operator = mapFilterOperator(filter.op)
	const members = mapFilterMembers(filter)

	return {
		dimension: {
			dimension: filter.field,
			hierarchy: filter.field
		},
		operator,
		members
	}
}

function mapTimeWindowFilters(request: UoseMdxQueryRequest) {
	if (!request.timeWindow) {
		return []
	}

	const dimension = (request.dimensions ?? []).find((item) => item.level || /date|time|day|week|month|year/i.test(item.dimensionId))
	if (!dimension) {
		return []
	}

	return [
		{
			dimension: {
				dimension: dimension.dimensionId,
				hierarchy: dimension.hierarchy?.[0] ?? dimension.dimensionId,
				level: dimension.level
			},
			operator: FilterOperator.BT,
			members: [
				{ key: request.timeWindow.from },
				{ key: request.timeWindow.to }
			]
		}
	]
}

function mapFilterOperator(op: UoseMdxFilter['op']): FilterOperator {
	switch (op) {
		case 'eq':
		case 'in':
			return FilterOperator.EQ
		case 'ne':
			return FilterOperator.NE
		case 'gt':
			return FilterOperator.GT
		case 'gte':
			return FilterOperator.GE
		case 'lt':
			return FilterOperator.LT
		case 'lte':
			return FilterOperator.LE
		case 'between':
			return FilterOperator.BT
		case 'contains':
			return FilterOperator.Contains
	}
}

function mapFilterMembers(filter: UoseMdxFilter) {
	if (filter.op === 'between') {
		const range = Array.isArray(filter.value)
			? filter.value
			: [readObject(filter.value)?.from, readObject(filter.value)?.to]
		return range.slice(0, 2).map((value) => ({ key: String(value ?? '') }))
	}

	const values = filter.op === 'in' && Array.isArray(filter.value) ? filter.value : [filter.value]
	return values.map((value) => ({ key: String(value ?? '') }))
}

function unwrapQueryReturn(payload: unknown): unknown {
	const object = readObject(payload)
	if (object && readObject(object.data) && (Array.isArray(readObject(object.data)?.data) || readObject(object.data)?.schema)) {
		return object.data
	}
	return payload
}

function extractRows(payload: unknown): Array<Record<string, unknown>> {
	const object = readObject(payload)
	const rows = (
		(Array.isArray(payload) && payload) ||
		(Array.isArray(object?.rows) && object.rows) ||
		(Array.isArray(object?.data) && object.data) ||
		(Array.isArray(readObject(object?.data)?.rows) && readObject(object?.data)?.rows) ||
		(Array.isArray(readObject(object?.data)?.data) && readObject(object?.data)?.data) ||
		[]
	) as unknown[]

	return rows.map((row, index) => {
		if (row && typeof row === 'object' && !Array.isArray(row)) {
			return row as Record<string, unknown>
		}
		return {
			index,
			value: row
		}
	})
}

function extractColumns(payload: unknown, rows: Array<Record<string, unknown>>) {
	if (rows.length > 0) {
		const first = rows[0]
		return Object.keys(first).map((name) => ({
			name,
			type: inferColumnType(first[name])
		}))
	}

	const schema = (readObject(payload) as QueryReturn<unknown> | undefined)?.schema
	const schemaColumns = [...(schema?.rows ?? []), ...(schema?.columns ?? [])]
	return schemaColumns.map((column) => ({
		name: normalizeString(column.name) ?? normalizeString(column.caption) ?? 'value',
		type: normalizeString(column.dataType) ?? 'unknown'
	}))
}

function inferColumnType(value: unknown): string {
	if (value === null || value === undefined) {
		return 'unknown'
	}
	if (value instanceof Date) {
		return 'datetime'
	}
	return typeof value
}

function normalizeLimit(value: unknown): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isFinite(parsed)) {
		return 100
	}
	return Math.min(1000, Math.max(1, Math.trunc(parsed)))
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined
	}
	const trimmed = value.trim()
	return trimmed ? trimmed : undefined
}

function readObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined
	}
	return value as Record<string, unknown>
}
