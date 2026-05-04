import { computed, DestroyRef, effect, inject, Injectable, signal } from '@angular/core'
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop'
import { NavigationEnd, Router } from '@angular/router'
import { injectWorkspace } from '@xpert-ai/cloud/state'
import {
  AiThreadService,
  appendMessagePlainText,
  AssistantCode,
  CHAT_EVENT_TYPE_THREAD_CONTEXT_USAGE,
  ChatMessageEventTypeEnum,
  ChatMessageTypeEnum,
  ChatConversationService,
  ChatMessageService,
  createMessageAppendContextTracker,
  filterMessageText,
  type IChatConversation,
  type IChatMessage,
  OrderTypeEnum,
  type TChatConversationStatus,
  XpertAPIService
} from '../../../@core'
import { AppService } from '../../../app.service'
import { distinctUntilChanged, EMPTY, filter, firstValueFrom, map, startWith, switchMap } from 'rxjs'
import { injectAssistantChatkitRuntime } from '../../assistant/assistant-chatkit.runtime'
import {
  type ChatKitEffectEvent,
  type ChatKitPromptWorkflowEffect,
  type ChatKitWorkspaceSkillEffect,
  getChatKitEffectXpertId,
  getChatKitPromptWorkflowEffect,
  getChatKitWorkspaceSkillEffect
} from '../utils'

type AssistantRouteState = {
  workspaceRouteId: string | null
  xpertRouteId: string | null
}

export type AssistantContext = {
  workspaceId: string | null
  xpertId: string | null
}

export type AssistantStudioRuntimeContext = {
  targetXpertId: string
  baseDraftHash: string | null
  unsaved: boolean
}

type StudioRefreshEvent = {
  xpertId: string | null
  nonce: number
}

export type AssistantConversationPreviewStatus = TChatConversationStatus | 'loading'

export type AssistantConversationPreviewUsage = {
  threadId: string
  agentKey: string
  runId: string | null
  updatedAt: string | null
  contextTokens: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  embedTokens: number
  totalPrice: number
  currency: string | null
}

export type AssistantConversationPreview = {
  threadId: string
  conversationId: string | null
  title: string | null
  latestAiMessageText: string | null
  status: AssistantConversationPreviewStatus
  usage: AssistantConversationPreviewUsage | null
}

export type PromptWorkflowRefreshEvent = ChatKitPromptWorkflowEffect & {
  nonce: number
}

export type WorkspaceSkillRefreshEvent = ChatKitWorkspaceSkillEffect & {
  nonce: number
}

const CONVERSATION_PREVIEW_REFRESH_DEBOUNCE_MS = 250
const ASSISTANT_MESSAGE_STREAM_NESTED_KEYS = [
  'data',
  'item',
  'payload',
  'content',
  'detail',
  'message',
  'delta',
  'chunk'
] as const
const ASSISTANT_MESSAGE_ID_KEYS = ['id', 'messageId', 'message_id'] as const

type ConversationPreviewHydrateOptions = {
  showLoading: boolean
}

type AssistantLogEvent = {
  name: string
  data?: unknown
}

type AssistantMessageTextChunk = {
  messageId: string | null
  text: string
}

type AssistantConversationPreviewStream = {
  threadId: string
  messageId: string | null
  text: string
}

@Injectable()
export class XpertAssistantFacade {
  readonly #router = inject(Router)
  readonly #appService = inject(AppService)
  readonly #xpertService = inject(XpertAPIService)
  readonly #threadService = inject(AiThreadService)
  readonly #conversationService = inject(ChatConversationService)
  readonly #messageService = inject(ChatMessageService)
  readonly #selectedWorkspace = injectWorkspace()
  readonly #destroyRef = inject(DestroyRef)

  readonly open = signal(false)
  readonly isMobile = this.#appService.isMobile
  readonly assistantCode = signal(AssistantCode.XPERT_SHARED)

  readonly #routeState = toSignal(
    this.#router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      startWith(null),
      map(() => this.readRouteState())
    ),
    { initialValue: this.readRouteState() }
  )
  readonly #xpertWorkspaceCache = signal<Record<string, string | null>>({})
  readonly #studioRuntimeContext = signal<AssistantStudioRuntimeContext | null>(null)
  readonly #studioRefresh = signal<StudioRefreshEvent | null>(null)
  readonly #promptWorkflowRefresh = signal<PromptWorkflowRefreshEvent | null>(null)
  readonly #workspaceSkillRefresh = signal<WorkspaceSkillRefreshEvent | null>(null)
  readonly #activeThreadId = signal<string | null>(null)
  readonly #responseActive = signal(false)
  readonly #conversationPreview = signal<AssistantConversationPreview | null>(null)
  readonly xpertId = computed(() => this.#routeState().xpertRouteId)
  readonly workspaceId = computed(() => {
    const routeState = this.#routeState()
    const selectedWorkspaceId = this.#selectedWorkspace()?.id ?? null
    const cachedWorkspaceId = routeState.xpertRouteId
      ? (this.#xpertWorkspaceCache()[routeState.xpertRouteId] ?? null)
      : null

    return routeState.workspaceRouteId ?? cachedWorkspaceId ?? (!routeState.xpertRouteId ? selectedWorkspaceId : null)
  })

  readonly context = computed<AssistantContext>(() => {
    return {
      workspaceId: this.workspaceId(),
      xpertId: this.xpertId()
    }
  })
  readonly requestContext = computed(() => this.buildRequestContext(this.context(), this.#studioRuntimeContext()))
  readonly runtime = injectAssistantChatkitRuntime({
    assistantCode: this.assistantCode.asReadonly(),
    requestContext: this.requestContext,
    titleKey: 'PAC.Xpert.Assistant',
    titleDefault: 'Assistant',
    onEffect: (event) => {
      this.handleEffect(event as ChatKitEffectEvent)
    },
    onLog: (event) => {
      this.handleLog(event)
    },
    onResponseStart: () => {
      this.handleResponseStart()
    },
    onResponseEnd: () => {
      this.handleResponseEnd()
    },
    onThreadChange: ({ threadId }) => {
      this.handleThreadChange(threadId)
    },
    onThreadLoadStart: ({ threadId }) => {
      this.handleThreadLoadStart(threadId)
    },
    onThreadLoadEnd: ({ threadId }) => {
      this.handleThreadLoadEnd(threadId)
    }
  })
  readonly assistantId = computed(() => {
    if (!this.runtime.isConfigured()) {
      return null
    }

    return this.runtime.config()?.assistantId ?? null
  })
  readonly control = this.runtime.control
  readonly status = this.runtime.status

  readonly studioRefresh = this.#studioRefresh.asReadonly()
  readonly promptWorkflowRefresh = this.#promptWorkflowRefresh.asReadonly()
  readonly workspaceSkillRefresh = this.#workspaceSkillRefresh.asReadonly()
  readonly conversationPreview = this.#conversationPreview.asReadonly()

  #conversationPreviewHydrateTimer: ReturnType<typeof setTimeout> | null = null
  #conversationPreviewRequestVersion = 0
  #conversationPreviewStream: AssistantConversationPreviewStream | null = null
  readonly #messageAppendContextTracker = createMessageAppendContextTracker()

  constructor() {
    effect(() => {
      if (this.xpertId()) {
        return
      }

      if (this.#studioRuntimeContext()) {
        this.#studioRuntimeContext.set(null)
      }
    })

    effect(() => {
      if (this.status() === 'ready') {
        return
      }

      this.clearConversationPreview()
    })

    this.watchXpertWorkspace()
    this.#destroyRef.onDestroy(() => {
      this.clearScheduledConversationPreviewHydrate()
    })
  }

  setOpen(open: boolean) {
    this.open.set(open)
  }

  emitStudioRefresh(xpertId: string | null) {
    this.#studioRefresh.set({
      xpertId,
      nonce: Date.now()
    })
  }

  emitPromptWorkflowRefresh(effect: ChatKitPromptWorkflowEffect) {
    this.#promptWorkflowRefresh.set({
      ...effect,
      nonce: Date.now()
    })
  }

  emitWorkspaceSkillRefresh(effect: ChatKitWorkspaceSkillEffect) {
    this.#workspaceSkillRefresh.set({
      ...effect,
      nonce: Date.now()
    })
  }

  setStudioContext(context: AssistantStudioRuntimeContext | null) {
    if (!context?.targetXpertId) {
      this.clearStudioContext()
      return
    }

    const current = this.#studioRuntimeContext()
    if (
      current?.targetXpertId === context.targetXpertId &&
      current?.baseDraftHash === context.baseDraftHash &&
      current?.unsaved === context.unsaved
    ) {
      return
    }

    this.#studioRuntimeContext.set(context)
  }

  clearStudioContext() {
    if (!this.#studioRuntimeContext()) {
      return
    }

    this.#studioRuntimeContext.set(null)
  }

  handleEffect(event: ChatKitEffectEvent) {
    switch (event.name) {
      case 'navigate_to_studio': {
        const xpertId = getChatKitEffectXpertId(event)
        if (!xpertId) {
          return
        }

        this.setOpen(false)
        void this.#router.navigate(['/xpert/x', xpertId, 'agents'])
        return
      }
      case 'refresh_studio': {
        this.emitStudioRefresh(getChatKitEffectXpertId(event) ?? this.context().xpertId)
        return
      }
      case 'refresh_prompt_workflows': {
        const effect = getChatKitPromptWorkflowEffect(event)
        if (!effect) {
          return
        }

        void this.navigateToPromptWorkflows(effect)
        return
      }
      case 'refresh_workspace_skills': {
        const effect = getChatKitWorkspaceSkillEffect(event)
        if (!effect) {
          return
        }

        void this.navigateToWorkspaceSkills(effect)
        return
      }
      default: {
        return
      }
    }
  }

  handleLog(event: AssistantLogEvent) {
    const threadId = this.#activeThreadId()
    if (!threadId) {
      return
    }

    this.applyConversationPreviewTitleEvent(threadId, event)
    this.applyConversationPreviewUsageEvent(threadId, event)
    this.applyConversationPreviewStreamEvent(threadId, event)
    this.applyConversationPreviewEndEvent(threadId, event)

    if (this.#responseActive()) {
      return
    }

    if (event.name === 'event.thread.change' || event.name.startsWith('thread.item.')) {
      this.scheduleConversationPreviewHydrate(threadId)
    }
  }

  handleThreadChange(threadId: string | null) {
    if (threadId === this.#activeThreadId()) {
      return
    }

    this.#activeThreadId.set(threadId)
    this.#responseActive.set(false)
    this.resetConversationPreviewStream()
    this.clearScheduledConversationPreviewHydrate()

    if (!threadId) {
      this.#conversationPreview.set(null)
      return
    }

    this.setLoadingConversationPreview(threadId)
    void this.hydrateConversationPreview(threadId, { showLoading: true })
  }

  handleThreadLoadStart(threadId: string) {
    if (!threadId) {
      return
    }

    this.#activeThreadId.set(threadId)
    this.#responseActive.set(false)
    this.resetConversationPreviewStream()
    this.clearScheduledConversationPreviewHydrate()
    this.setLoadingConversationPreview(threadId)
  }

  handleThreadLoadEnd(threadId: string) {
    if (!threadId) {
      return
    }

    if (threadId !== this.#activeThreadId()) {
      this.#activeThreadId.set(threadId)
    }

    void this.hydrateConversationPreview(threadId, { showLoading: true })
  }

  handleResponseStart() {
    const threadId = this.#activeThreadId()
    this.#responseActive.set(true)
    this.resetConversationPreviewStream()
    this.#conversationPreview.update((preview) => (preview ? { ...preview, status: 'busy' } : preview))
    this.clearScheduledConversationPreviewHydrate()

    const preview = this.#conversationPreview()
    if (threadId && (!preview || preview.threadId !== threadId || !preview.conversationId || !preview.title)) {
      void this.hydrateConversationPreview(threadId, { showLoading: false })
    }
  }

  handleResponseEnd() {
    const threadId = this.#activeThreadId()
    this.#responseActive.set(false)

    if (!threadId) {
      this.#conversationPreview.update((preview) => (preview ? { ...preview, status: 'idle' } : preview))
      return
    }

    void this.hydrateConversationPreview(threadId, { showLoading: false })
  }

  private watchXpertWorkspace() {
    this.#router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        startWith(null),
        map(() => this.readRouteState().xpertRouteId),
        distinctUntilChanged(),
        switchMap((xpertId) => {
          if (!xpertId || this.#xpertWorkspaceCache()[xpertId] !== undefined) {
            return EMPTY
          }

          return this.#xpertService.getTeam(xpertId).pipe(
            map((team: { workspaceId?: string | null }) => ({
              xpertId,
              workspaceId: team.workspaceId ?? null
            }))
          )
        }),
        takeUntilDestroyed()
      )
      .subscribe({
        next: ({ xpertId, workspaceId }) => {
          this.#xpertWorkspaceCache.update((cache) => ({
            ...cache,
            [xpertId]: workspaceId
          }))
        }
      })
  }

  private clearConversationPreview() {
    this.#activeThreadId.set(null)
    this.#responseActive.set(false)
    this.#conversationPreview.set(null)
    this.resetConversationPreviewStream()
    this.clearScheduledConversationPreviewHydrate()
  }

  private setLoadingConversationPreview(threadId: string) {
    this.#conversationPreview.update((preview) => {
      if (preview?.threadId === threadId) {
        return {
          ...preview,
          status: 'loading'
        }
      }

      return {
        threadId,
        conversationId: null,
        title: null,
        latestAiMessageText: null,
        status: 'loading',
        usage: null
      }
    })
  }

  private scheduleConversationPreviewHydrate(threadId: string) {
    this.clearScheduledConversationPreviewHydrate()
    this.#conversationPreviewHydrateTimer = setTimeout(() => {
      this.#conversationPreviewHydrateTimer = null
      void this.hydrateConversationPreview(threadId, { showLoading: false })
    }, CONVERSATION_PREVIEW_REFRESH_DEBOUNCE_MS)
  }

  private clearScheduledConversationPreviewHydrate() {
    if (!this.#conversationPreviewHydrateTimer) {
      return
    }

    clearTimeout(this.#conversationPreviewHydrateTimer)
    this.#conversationPreviewHydrateTimer = null
  }

  private async hydrateConversationPreview(threadId: string, options: ConversationPreviewHydrateOptions) {
    const requestVersion = ++this.#conversationPreviewRequestVersion

    if (options.showLoading) {
      this.setLoadingConversationPreview(threadId)
    }

    try {
      const conversation = await this.resolveConversationPreviewConversation(threadId)
      if (!this.isCurrentConversationPreviewRequest(requestVersion, threadId)) {
        return
      }

      this.#conversationPreview.set(
        buildConversationPreview(threadId, conversation, this.#responseActive(), this.#conversationPreview())
      )
    } catch {
      if (!this.isCurrentConversationPreviewRequest(requestVersion, threadId)) {
        return
      }

      this.#conversationPreview.update((preview) => ({
        threadId,
        conversationId: preview?.threadId === threadId ? preview.conversationId : null,
        title: preview?.threadId === threadId ? preview.title : null,
        latestAiMessageText: preview?.threadId === threadId ? preview.latestAiMessageText : null,
        status: 'error',
        usage: preview?.threadId === threadId ? preview.usage : null
      }))
    }
  }

  private applyConversationPreviewUsageEvent(threadId: string, event: AssistantLogEvent) {
    const usage = extractAssistantConversationUsageEvent(event)
    if (!usage || usage.threadId !== threadId) {
      return
    }

    this.#conversationPreview.update((preview) => ({
      threadId,
      conversationId: preview?.threadId === threadId ? preview.conversationId : null,
      title: preview?.threadId === threadId ? preview.title : null,
      latestAiMessageText: preview?.threadId === threadId ? preview.latestAiMessageText : null,
      status: this.#responseActive() ? 'busy' : preview?.threadId === threadId ? preview.status : 'idle',
      usage
    }))
  }

  private applyConversationPreviewTitleEvent(threadId: string, event: AssistantLogEvent) {
    const title = extractAssistantConversationStartTitleEvent(event)
    if (!title || title.threadId !== threadId) {
      return
    }

    this.#conversationPreview.update((preview) => {
      if (preview?.threadId === threadId && preview.title) {
        return preview
      }

      return {
        threadId,
        conversationId: preview?.threadId === threadId ? preview.conversationId : null,
        title: title.text,
        latestAiMessageText: preview?.threadId === threadId ? preview.latestAiMessageText : null,
        status: this.#responseActive() ? 'busy' : preview?.threadId === threadId ? preview.status : 'idle',
        usage: preview?.threadId === threadId ? preview.usage : null
      }
    })
  }

  private applyConversationPreviewStreamEvent(threadId: string, event: AssistantLogEvent) {
    const messageStartId = extractAssistantMessageStartIdFromLogEvent(event)
    if (messageStartId) {
      this.rememberConversationPreviewStreamMessage(threadId, messageStartId)
    }

    const chunk = extractAssistantMessageTextChunkFromLogEvent(event)
    if (!chunk) {
      return
    }

    this.appendConversationPreviewStreamText(threadId, chunk)
  }

  private applyConversationPreviewEndEvent(threadId: string, event: AssistantLogEvent) {
    const endedThreadId = extractAssistantConversationEndThreadId(event)
    if (endedThreadId !== threadId) {
      return
    }

    void this.fetchConversationPreviewLatestAiMessage(threadId)
  }

  private rememberConversationPreviewStreamMessage(threadId: string, messageId: string) {
    const currentStream = this.#conversationPreviewStream
    if (currentStream?.threadId === threadId && currentStream.messageId === messageId) {
      return
    }

    this.#messageAppendContextTracker.reset()
    this.#conversationPreviewStream = {
      threadId,
      messageId,
      text: ''
    }
  }

  private appendConversationPreviewStreamText(threadId: string, chunk: AssistantMessageTextChunk) {
    const currentStream = this.#conversationPreviewStream
    const fallbackMessageId = chunk.messageId ?? (currentStream?.threadId === threadId ? currentStream.messageId : null)
    const messageIdChanged =
      !currentStream ||
      currentStream.threadId !== threadId ||
      (!!chunk.messageId && currentStream.messageId !== chunk.messageId)

    if (messageIdChanged) {
      this.#messageAppendContextTracker.reset()
    }

    const streamId = fallbackMessageId ?? threadId
    const { messageContext } = this.#messageAppendContextTracker.resolve({
      incoming: chunk.text,
      fallbackSource: 'chat_stream',
      fallbackStreamId: streamId
    })
    const previousText = messageIdChanged ? '' : currentStream.text
    const nextText = appendMessagePlainText(previousText, chunk.text, messageContext)
    const previewText = normalizeConversationPreviewMessageText(nextText)

    this.#conversationPreviewStream = {
      threadId,
      messageId: fallbackMessageId,
      text: nextText
    }
    this.#conversationPreview.update((preview) => ({
      threadId,
      conversationId: preview?.threadId === threadId ? preview.conversationId : null,
      title: preview?.threadId === threadId ? preview.title : null,
      latestAiMessageText: previewText,
      status: this.#responseActive() ? 'busy' : preview?.threadId === threadId ? preview.status : 'idle',
      usage: preview?.threadId === threadId ? preview.usage : null
    }))
  }

  private resetConversationPreviewStream() {
    this.#conversationPreviewStream = null
    this.#messageAppendContextTracker.reset()
  }

  private async resolveConversationPreviewConversation(threadId: string) {
    let conversationId: string | null = null
    let baseConversation: IChatConversation | null = null

    try {
      const thread = await firstValueFrom(this.#threadService.getThread(threadId))
      conversationId = resolveConversationId(thread?.metadata)
    } catch {
      conversationId = null
    }

    if (!conversationId) {
      baseConversation = await firstValueFrom(this.#conversationService.getByThreadId(threadId))
      conversationId = baseConversation?.id ?? null
    }

    if (!conversationId) {
      return baseConversation
    }

    return (await firstValueFrom(this.#conversationService.getById(conversationId))) ?? baseConversation
  }

  private async fetchConversationPreviewLatestAiMessage(threadId: string) {
    try {
      const conversationId = await this.resolveConversationPreviewConversationId(threadId)
      if (!conversationId || threadId !== this.#activeThreadId()) {
        return
      }

      const { items } = await firstValueFrom(
        this.#messageService.getAllInOrg({
          where: {
            conversationId,
            role: 'ai'
          },
          order: {
            createdAt: OrderTypeEnum.DESC
          },
          take: 1
        })
      )
      const latestAiMessageText = resolveLatestAiMessagePreviewText(items[0])
      if (!latestAiMessageText || threadId !== this.#activeThreadId()) {
        return
      }

      this.#conversationPreview.update((preview) => ({
        threadId,
        conversationId,
        title: preview?.threadId === threadId ? preview.title : null,
        latestAiMessageText,
        status: this.#responseActive() ? 'busy' : preview?.threadId === threadId ? preview.status : 'idle',
        usage: preview?.threadId === threadId ? preview.usage : null
      }))
    } catch {
      return
    }
  }

  private async resolveConversationPreviewConversationId(threadId: string) {
    const preview = this.#conversationPreview()
    if (preview?.threadId === threadId && preview.conversationId) {
      return preview.conversationId
    }

    const conversation = await this.resolveConversationPreviewConversation(threadId)
    return conversation?.id ?? null
  }

  private isCurrentConversationPreviewRequest(requestVersion: number, threadId: string) {
    return requestVersion === this.#conversationPreviewRequestVersion && threadId === this.#activeThreadId()
  }

  private async navigateToPromptWorkflows(effect: ChatKitPromptWorkflowEffect) {
    this.setOpen(false)

    try {
      await this.#router.navigate(['/xpert/w', effect.workspaceId, 'prompt-workflows'])
    } finally {
      this.emitPromptWorkflowRefresh(effect)
    }
  }

  private async navigateToWorkspaceSkills(effect: ChatKitWorkspaceSkillEffect) {
    try {
      await this.#router.navigate(['/xpert/w', effect.workspaceId, 'skills'])
    } finally {
      this.emitWorkspaceSkillRefresh(effect)
    }
  }

  private readRouteState(): AssistantRouteState {
    const url = this.#router.url.split('?')[0]
    const workspaceMatch = url.match(/^\/xpert\/w\/([^/]+)/)
    const xpertMatch = url.match(/^\/xpert\/x\/([^/]+)\/agents(?:\/|$)/)

    return {
      workspaceRouteId: workspaceMatch?.[1] ?? null,
      xpertRouteId: xpertMatch?.[1] ?? null
    }
  }

  private buildRequestContext(
    context: AssistantContext,
    studioRuntimeContext?: AssistantStudioRuntimeContext | null
  ): Record<string, unknown> {
    const requestContext: Record<string, unknown> = {}
    const env: Record<string, string> = {}

    if (context.workspaceId) {
      env['workspaceId'] = context.workspaceId
    }
    if (context.xpertId) {
      env['xpertId'] = context.xpertId
    }

    if (Object.keys(env).length) {
      requestContext['env'] = env
    }

    if (context.xpertId && studioRuntimeContext?.targetXpertId) {
      requestContext['targetXpertId'] = studioRuntimeContext.targetXpertId
      requestContext['unsaved'] = studioRuntimeContext.unsaved

      if (studioRuntimeContext.baseDraftHash) {
        requestContext['baseDraftHash'] = studioRuntimeContext.baseDraftHash
      }
    }

    return requestContext
  }
}

function buildConversationPreview(
  threadId: string,
  conversation: IChatConversation | null,
  responseActive: boolean,
  previousPreview: AssistantConversationPreview | null
): AssistantConversationPreview {
  const previousLatestAiMessageText =
    previousPreview?.threadId === threadId ? previousPreview.latestAiMessageText : null
  const previousUsage = previousPreview?.threadId === threadId ? previousPreview.usage : null
  const resolvedTitle =
    resolveConversationPreviewTitle(conversation) ??
    (previousPreview?.threadId === threadId ? previousPreview.title : null)

  return {
    threadId,
    conversationId: conversation?.id ?? null,
    title: resolvedTitle,
    latestAiMessageText: previousLatestAiMessageText,
    status: responseActive ? 'busy' : (conversation?.status ?? 'idle'),
    usage: previousUsage
  }
}

function resolveConversationPreviewTitle(conversation?: IChatConversation | null) {
  const title = conversation?.title?.trim()
  if (title) {
    return title
  }

  const input = conversation?.options?.parameters?.input
  if (typeof input === 'string' && input.trim()) {
    return resolveConversationHumanInputTitle(input)
  }

  return null
}

function resolveConversationId(metadata?: { id?: string }) {
  const conversationId = metadata?.id
  return typeof conversationId === 'string' && conversationId.trim() ? conversationId : null
}

function extractAssistantConversationUsageEvent(event: AssistantLogEvent): AssistantConversationPreviewUsage | null {
  if (event.name !== 'lg.chat.event') {
    return null
  }

  return readAssistantConversationUsage(event.data)
}

function extractAssistantConversationEndThreadId(event: AssistantLogEvent) {
  if (event.name !== 'lg.conversation.end' || !isObjectLike(event.data)) {
    return null
  }

  return readNonEmptyStringProperty(event.data, 'threadId')
}

function extractAssistantConversationStartTitleEvent(
  event: AssistantLogEvent
): { threadId: string; text: string } | null {
  if (event.name !== 'lg.conversation.start' || !isObjectLike(event.data)) {
    return null
  }

  const threadId = readNonEmptyStringProperty(event.data, 'threadId')
  const inputSummary = readNonEmptyStringProperty(event.data, 'inputSummary')
  const text = inputSummary ? resolveConversationHumanInputTitle(inputSummary) : null
  if (!threadId || !text) {
    return null
  }

  return {
    threadId,
    text
  }
}

function resolveConversationHumanInputTitle(inputText: string) {
  const jsonInputText = readConversationStartJsonInputText(inputText)
  if (jsonInputText) {
    return normalizeConversationPreviewMessageText(jsonInputText)
  }

  if (inputText.trim().startsWith('{')) {
    return null
  }

  return normalizeConversationPreviewMessageText(inputText)
}

function readConversationStartJsonInputText(inputSummary: string) {
  const trimmedInputSummary = inputSummary.trim()
  if (!trimmedInputSummary.startsWith('{')) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(trimmedInputSummary)
    return readConversationStartInputText(parsed) ?? readConversationStartJsonInputTextFragment(trimmedInputSummary)
  } catch {
    return readConversationStartJsonInputTextFragment(trimmedInputSummary)
  }
}

function readConversationStartInputText(value: unknown) {
  if (!isObjectLike(value)) {
    return null
  }

  const input = readObjectProperty(value, 'input')
  if (!isObjectLike(input)) {
    return null
  }

  return readNonEmptyStringProperty(input, 'input')
}

function readConversationStartJsonInputTextFragment(inputSummary: string) {
  const match = inputSummary.match(/"input"\s*:\s*\{\s*"input"\s*:\s*"((?:\\.|[^"\\])*)"?/)
  const value = match?.[1]
  if (!value) {
    return null
  }

  try {
    const decoded: unknown = JSON.parse(`"${value}"`)
    return typeof decoded === 'string' && decoded.trim() ? decoded : null
  } catch {
    return value.trim() ? value : null
  }
}

function resolveLatestAiMessagePreviewText(message: IChatMessage | null | undefined) {
  if (message?.role !== 'ai' || message.content == null) {
    return null
  }

  const text = filterMessageText(message.content)
  return text ? selectLastPreviewTextLines(text, 2) : null
}

function selectLastPreviewTextLines(text: string, maxLines: number) {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.slice(-maxLines).join('\n') || null
}

function readAssistantConversationUsage(value: unknown): AssistantConversationPreviewUsage | null {
  if (!isObjectLike(value) || readStringProperty(value, 'type') !== CHAT_EVENT_TYPE_THREAD_CONTEXT_USAGE) {
    return null
  }

  const threadId = readNonEmptyStringProperty(value, 'threadId')
  const agentKey = readNonEmptyStringProperty(value, 'agentKey')
  const usage = readObjectProperty(value, 'usage')
  if (!threadId || !agentKey || !isObjectLike(usage)) {
    return null
  }

  const totalTokens = readUsageNumberProperty(usage, 'totalTokens')
  if (totalTokens === null) {
    return null
  }

  return {
    threadId,
    agentKey,
    runId: readNullableStringProperty(value, 'runId'),
    updatedAt: readNullableStringProperty(value, 'updatedAt'),
    contextTokens: readOptionalUsageNumberProperty(usage, 'contextTokens'),
    inputTokens: readOptionalUsageNumberProperty(usage, 'inputTokens'),
    outputTokens: readOptionalUsageNumberProperty(usage, 'outputTokens'),
    totalTokens,
    embedTokens: readOptionalUsageNumberProperty(usage, 'embedTokens'),
    totalPrice: readOptionalFiniteNumberProperty(usage, 'totalPrice'),
    currency: readNullableStringProperty(usage, 'currency')
  }
}

function extractAssistantMessageTextChunkFromLogEvent(event: AssistantLogEvent) {
  return findAssistantMessageTextChunk(event, new Set(), false, null)
}

function findAssistantMessageTextChunk(
  value: unknown,
  visited: Set<object>,
  allowPlainText: boolean,
  messageIdHint: string | null
): AssistantMessageTextChunk | null {
  if (typeof value === 'string') {
    return allowPlainText && value ? { messageId: messageIdHint, text: value } : null
  }

  if (Array.isArray(value)) {
    const tuplePayload =
      value.length >= 2 ? findAssistantMessageTextChunk(value[1], visited, allowPlainText, messageIdHint) : null
    if (tuplePayload) {
      return tuplePayload
    }

    for (const item of value) {
      const nested = findAssistantMessageTextChunk(item, visited, allowPlainText, messageIdHint)
      if (nested) {
        return nested
      }
    }

    return null
  }

  if (!isObjectLike(value)) {
    return null
  }

  if (visited.has(value)) {
    return null
  }
  visited.add(value)

  const messageId = readMessageId(value) ?? messageIdHint
  const type = readStringProperty(value, 'type')
  if (type === ChatMessageTypeEnum.MESSAGE) {
    return findAssistantMessageTextChunk(readObjectProperty(value, 'data'), visited, true, messageId)
  }

  const textContent = readTextContentPayload(value, messageId)
  if (textContent) {
    return textContent
  }

  for (const key of ASSISTANT_MESSAGE_STREAM_NESTED_KEYS) {
    const nested = findAssistantMessageTextChunk(readObjectProperty(value, key), visited, allowPlainText, messageId)
    if (nested) {
      return nested
    }
  }

  return null
}

function extractAssistantMessageStartIdFromLogEvent(event: AssistantLogEvent) {
  return findAssistantMessageStartId(event, new Set())
}

function findAssistantMessageStartId(value: unknown, visited: Set<object>): string | null {
  if (Array.isArray(value)) {
    const tuplePayload = value.length >= 2 ? findAssistantMessageStartId(value[1], visited) : null
    if (tuplePayload) {
      return tuplePayload
    }

    for (const item of value) {
      const nested = findAssistantMessageStartId(item, visited)
      if (nested) {
        return nested
      }
    }

    return null
  }

  if (!isObjectLike(value)) {
    return null
  }

  if (visited.has(value)) {
    return null
  }
  visited.add(value)

  if (readStringProperty(value, 'type') === ChatMessageTypeEnum.EVENT) {
    const eventName = readStringProperty(value, 'event')
    if (eventName === ChatMessageEventTypeEnum.ON_MESSAGE_START) {
      return readMessageId(readObjectProperty(value, 'data')) ?? readMessageId(value)
    }
  }

  for (const key of ASSISTANT_MESSAGE_STREAM_NESTED_KEYS) {
    const nested = findAssistantMessageStartId(readObjectProperty(value, key), visited)
    if (nested) {
      return nested
    }
  }

  return null
}

function readTextContentPayload(value: object, messageId: string | null): AssistantMessageTextChunk | null {
  const text = readStringProperty(value, 'text')
  if (!text) {
    return null
  }

  const type = readStringProperty(value, 'type')
  if (type !== 'text') {
    return null
  }

  return {
    messageId,
    text
  }
}

function normalizeConversationPreviewMessageText(text: string) {
  const normalizedText = text.trim().replace(/\s+/g, ' ')
  return normalizedText || null
}

function readMessageId(value: unknown) {
  if (!isObjectLike(value)) {
    return null
  }

  for (const key of ASSISTANT_MESSAGE_ID_KEYS) {
    const id = readStringProperty(value, key)
    if (id?.trim()) {
      return id.trim()
    }
  }

  return null
}

function readNonEmptyStringProperty(value: object, key: string) {
  const property = readStringProperty(value, key)?.trim()
  return property || null
}

function readNullableStringProperty(value: object, key: string) {
  const property = readObjectProperty(value, key)
  if (property == null) {
    return null
  }

  return typeof property === 'string' ? property : null
}

function readUsageNumberProperty(value: object, key: string) {
  const property = readObjectProperty(value, key)
  if (property == null) {
    return null
  }

  const number = typeof property === 'string' ? Number.parseFloat(property) : Number(property)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null
}

function readOptionalUsageNumberProperty(value: object, key: string) {
  return readUsageNumberProperty(value, key) ?? 0
}

function readOptionalFiniteNumberProperty(value: object, key: string) {
  const property = readObjectProperty(value, key)
  const number = typeof property === 'string' ? Number.parseFloat(property) : Number(property)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function readStringProperty(value: object, key: string) {
  const property = readObjectProperty(value, key)
  return typeof property === 'string' ? property : null
}

function readObjectProperty(value: object, key: string): unknown {
  if (!hasObjectProperty(value, key)) {
    return undefined
  }

  return Reflect.get(value, key)
}

function hasObjectProperty(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isObjectLike(value: unknown): value is object {
  return !!value && typeof value === 'object'
}
