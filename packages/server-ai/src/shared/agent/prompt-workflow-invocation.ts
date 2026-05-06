const ARGS_PLACEHOLDER_PATTERN = /\{\{\s*args\s*\}\}/
const ARGS_PLACEHOLDER_GLOBAL_PATTERN = /\{\{\s*args\s*\}\}/g
const SLASH_INVOCATION_PATTERN = /^\s*\/([a-z0-9][a-z0-9_-]{0,63})(?:\s+([\s\S]*))?$/
const BUILTIN_SLASH_COMMAND_NAMES = new Set([
	'help',
	'clear',
	'plan',
	'skills',
	'plugins',
	'subagents',
	'model',
	'effort',
	'status',
	'mention'
])

export function parsePromptWorkflowInvocation(value: string): { name: string; args: string } | null {
	const match = SLASH_INVOCATION_PATTERN.exec(value)
	if (!match) {
		return null
	}

	return {
		name: match[1],
		args: match[2]?.trim() ?? ''
	}
}

export function isPromptWorkflowInvocationCandidate(value: string): boolean {
	const invocation = parsePromptWorkflowInvocation(value)
	return !!invocation && !BUILTIN_SLASH_COMMAND_NAMES.has(invocation.name)
}

export function renderPromptWorkflowTemplate(template: string, args: string): string {
	const normalizedTemplate = template.trim()
	const normalizedArgs = args.trim()
	if (ARGS_PLACEHOLDER_PATTERN.test(normalizedTemplate)) {
		return normalizedTemplate.replace(ARGS_PLACEHOLDER_GLOBAL_PATTERN, normalizedArgs).trim()
	}

	return [normalizedTemplate, normalizedArgs].filter(Boolean).join('\n\n')
}
