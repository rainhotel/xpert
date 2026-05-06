import { C_MEASURES, FilterOperator } from '@xpert-ai/ocap-core'
import {
	buildOcapQueryFromUose,
	normalizeUoseQueryResponse,
	UoseMdxQueryRequest
} from './uose-query.mapper'

describe('uose-query.mapper', () => {
	const baseRequest: UoseMdxQueryRequest = {
		context: {
			traceId: 'trace-1',
			taskId: 'task-1',
			principalId: 'user-1',
			tenantId: 'tenant-1',
			organizationId: 'org-1',
			requestedAt: '2026-03-22T08:00:00.000Z'
		},
		modelId: 'model-1',
		cubeName: 'Sales',
		metrics: [{ metricId: 'Revenue', level: 'raw' }],
		dimensions: [{ dimensionId: '[Time Calendar]', level: '[Time Calendar].[Month]' }],
		filters: [
			{ field: 'Region', op: 'in', value: ['East', 'West'] },
			{ field: 'Amount', op: 'between', value: [10, 20] }
		],
		timeWindow: {
			from: '2026-03-01',
			to: '2026-03-31'
		},
		limit: 50
	}

	it('maps standard UOSE DSL to OCAP QueryOptions', () => {
		const query = buildOcapQueryFromUose(baseRequest)

		expect(query).toMatchObject({
			cube: 'Sales',
			rows: [
				{
					dimension: '[Time Calendar]',
					hierarchy: '[Time Calendar]',
					level: '[Time Calendar].[Month]'
				}
			],
			columns: [
				{
					dimension: C_MEASURES,
					measure: 'Revenue'
				}
			],
			paging: {
				top: 50
			}
		})
		expect(query.filters).toEqual([
			{
				dimension: {
					dimension: 'Region',
					hierarchy: 'Region'
				},
				operator: FilterOperator.EQ,
				members: [{ key: 'East' }, { key: 'West' }]
			},
			{
				dimension: {
					dimension: 'Amount',
					hierarchy: 'Amount'
				},
				operator: FilterOperator.BT,
				members: [{ key: '10' }, { key: '20' }]
			},
			{
				dimension: {
					dimension: '[Time Calendar]',
					hierarchy: '[Time Calendar]',
					level: '[Time Calendar].[Month]'
				},
				operator: FilterOperator.BT,
				members: [{ key: '2026-03-01' }, { key: '2026-03-31' }]
			}
		])
	})

	it('passes native DSL through with a cube default', () => {
		const query = buildOcapQueryFromUose({
			...baseRequest,
			queryMode: 'native_dsl',
			nativeQuery: {
				rows: [{ dimension: 'Region' }]
			}
		})

		expect(query).toEqual({
			cube: 'Sales',
			rows: [{ dimension: 'Region' }]
		})
	})

	it('normalizes OCAP QueryReturn to UOSE response', () => {
		const response = normalizeUoseQueryResponse(
			baseRequest,
			{
				data: {
					data: [{ '[Time Calendar]': '2026-03', Revenue: 100 }],
					schema: {
						columns: [{ name: 'Revenue', dataType: 'number' }]
					},
					stats: {
						statements: ['SELECT ...']
					}
				}
			},
			12
		)

		expect(response).toMatchObject({
			columns: [
				{ name: '[Time Calendar]', type: 'string' },
				{ name: 'Revenue', type: 'number' }
			],
			rows: [{ '[Time Calendar]': '2026-03', Revenue: 100 }],
			rowCount: 1,
			mdx: 'SELECT ...',
			appliedMetricVersions: [{ metricId: 'Revenue', metricVersion: 'latest' }],
			audit: {
				traceId: 'trace-1',
				taskId: 'task-1',
				principalId: 'user-1',
				modelId: 'model-1',
				cubeName: 'Sales',
				metricRefs: ['Revenue'],
				durationMs: 12,
				rowCount: 1
			}
		})
	})
})
