import type { SkillPromptWorkflow, TChatRequestHuman } from '@xpert-ai/contracts'
import { compactObject, nonEmptyArray } from '@xpert-ai/server-common'
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs'
import {
	isPromptWorkflowInvocationCandidate,
	parsePromptWorkflowInvocation,
	renderPromptWorkflowTemplate
} from '../../../shared/agent/prompt-workflow-invocation'
import { ResolvePromptWorkflowInvocationQuery } from '../../../shared/agent/queries/resolve-prompt-workflow-invocation.query'
import type { PromptWorkflowInvocationResolution } from '../../../shared/agent/queries/resolve-prompt-workflow-invocation.query'
import {
	mergeRuntimeCapabilitiesSelection,
	normalizeRuntimeCapabilitiesSelection
} from '../../../shared/agent/runtime-capabilities'
import { PromptWorkflowService } from '../../prompt-workflow.service'
import type { RuntimePromptWorkflowCommandSource } from '../../prompt-workflow.service'

const SLASH_COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

type PromptWorkflowCommandSourceMetadata = {
	type: 'slash_command'
	name: string
	source: 'runtime'
	executionType: 'submit_prompt'
	kind: 'prompt_workflow'
	workflow: SkillPromptWorkflow
}

type PromptWorkflowInvocationDetails = PromptWorkflowInvocationResolution & {
	args: string
	commandSource: PromptWorkflowCommandSourceMetadata
	source: RuntimePromptWorkflowCommandSource
}

@QueryHandler(ResolvePromptWorkflowInvocationQuery)
export class ResolvePromptWorkflowInvocationHandler implements IQueryHandler<ResolvePromptWorkflowInvocationQuery> {
	constructor(private readonly promptWorkflowService: PromptWorkflowService) {}

	async execute(query: ResolvePromptWorkflowInvocationQuery) {
		if (!query.input.input || !isPromptWorkflowInvocationCandidate(query.input.input)) {
			return null
		}

		const commandProfile = await this.promptWorkflowService.resolveRuntimeCommandProfile(query.xpert)
		return applyPromptWorkflowInvocation(query.input, [
			...commandProfile.xpertCommands,
			...commandProfile.workspaceCommands
		])
	}
}

function applyPromptWorkflowInvocation(
	input: TChatRequestHuman | null | undefined,
	sources: RuntimePromptWorkflowCommandSource[] | null | undefined
): PromptWorkflowInvocationDetails | null {
	if (!input || !sources?.length || typeof input.input !== 'string') {
		return null
	}

	const invocation = parsePromptWorkflowInvocation(input.input)
	if (!invocation) {
		return null
	}

	const source = findPromptWorkflowCommandSource(sources, invocation.name)
	if (!source) {
		return null
	}

	const runtimeCapabilities = mergeRuntimeCapabilitiesSelection(
		normalizeRuntimeCapabilitiesSelection(input.runtimeCapabilities),
		normalizeRuntimeCapabilitiesSelection(source.runtimeCapabilities)
	)
	const commandSource = createPromptWorkflowCommandSource(source)
	const nextInput = compactObject<TChatRequestHuman>({
		...input,
		input: renderPromptWorkflowTemplate(source.template, invocation.args),
		commandSource,
		runtimeCapabilities
	})

	return {
		input: nextInput,
		args: invocation.args,
		commandSource,
		source
	}
}

function findPromptWorkflowCommandSource(
	sources: RuntimePromptWorkflowCommandSource[],
	name: string
): RuntimePromptWorkflowCommandSource | null {
	for (const source of sources) {
		if (matchesPromptWorkflowCommandSource(source, name)) {
			return source
		}
	}
	return null
}

function matchesPromptWorkflowCommandSource(source: RuntimePromptWorkflowCommandSource, name: string): boolean {
	return getPromptWorkflowInvocationNames(source).includes(name)
}

function getPromptWorkflowInvocationNames(source: RuntimePromptWorkflowCommandSource): string[] {
	return [source.name, ...(source.aliases ?? [])].filter(
		(value): value is string => typeof value === 'string' && SLASH_COMMAND_NAME_PATTERN.test(value)
	)
}

function createPromptWorkflowCommandSource(
	source: RuntimePromptWorkflowCommandSource
): PromptWorkflowCommandSourceMetadata {
	return {
		type: 'slash_command',
		name: source.name,
		source: 'runtime',
		executionType: 'submit_prompt',
		kind: 'prompt_workflow',
		workflow: createPromptWorkflowMetadata(source)
	}
}

function createPromptWorkflowMetadata(source: RuntimePromptWorkflowCommandSource): SkillPromptWorkflow {
	return compactObject<SkillPromptWorkflow>({
		type: 'prompt_workflow',
		name: source.name,
		label: source.label ?? source.name,
		description: source.description,
		tags: nonEmptyArray(source.tags ?? [])
	})
}
