import { CommonModule } from '@angular/common'
import {
  Component,
  computed,
  DestroyRef,
  ElementRef,
  HostListener,
  afterNextRender,
  effect,
  inject,
  signal,
  viewChild
} from '@angular/core'
import { RouterModule } from '@angular/router'
import { TranslateModule } from '@ngx-translate/core'
import { ChatKit } from '@xpert-ai/chatkit-angular'
import { type AssistantConversationPreviewStatus, XpertAssistantFacade } from './assistant.facade'

type AssistantPosition = {
  x: number
  y: number
}

type ElementSize = {
  width: number
  height: number
}

type AssistantDragDirection = 'left' | 'right'

const ASSISTANT_POSITION_STORAGE_KEY = 'xpert.sharedAssistant.position.v1'
const ASSISTANT_DOCK_MARGIN = 16
const ASSISTANT_PANEL_GAP = 12
const DRAG_THRESHOLD = 6
const ASSISTANT_DOCK_TRANSITION = 'left 180ms ease-out, top 180ms ease-out'
const ASSISTANT_PET_ICON = {
  failed: 'assets/bolt/bolt-failed.gif',
  idle: 'assets/bolt/bolt-idle.gif',
  jumping: 'assets/bolt/bolt-jumping.gif',
  review: 'assets/bolt/bolt-review.gif',
  running: 'assets/bolt/bolt-running.gif',
  runningLeft: 'assets/bolt/bolt-running-left.gif',
  runningRight: 'assets/bolt/bolt-running-right.gif',
  waiting: 'assets/bolt/bolt-waiting.gif',
  waving: 'assets/bolt/bolt-waving.gif'
} as const

@Component({
  standalone: true,
  selector: 'xp-shared-assistant',
  imports: [CommonModule, RouterModule, TranslateModule, ChatKit],
  template: `
    <div
      class="pointer-events-none fixed z-70"
      [style.left.px]="position().x"
      [style.top.px]="position().y"
      [style.transition]="dragging() ? 'none' : dockTransition"
    >
      <section
        #panel
        class="pointer-events-auto absolute flex h-[70vh] max-h-[calc(100vh-5.5rem)] w-[calc(100vw-1.5rem)] max-w-[420px] flex-col overflow-hidden rounded-2xl border border-divider-regular bg-components-card-bg shadow-xl sm:h-[min(720px,calc(100vh-10rem))] sm:max-h-[calc(100vh-10rem)]"
        [class.hidden]="!open()"
        [attr.aria-hidden]="!open()"
        [style.left.px]="panelOffset().left"
        [style.top.px]="panelOffset().top"
        [style.transition]="dragging() ? 'none' : dockTransition"
      >
        <header class="flex items-center justify-between border-b border-divider-regular px-4 py-3">
          <div class="min-w-0">
            <div class="truncate text-sm font-semibold text-text-primary">
              {{ 'PAC.Xpert.Assistant' | translate: { Default: 'Assistant' } }}
            </div>
            <div class="truncate text-xs text-text-secondary">
              {{ 'PAC.Assistant.FloatingHint' | translate: { Default: 'Drag the launcher to dock left or right.' } }}
            </div>
          </div>

          <button
            type="button"
            class="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-hover-bg hover:text-text-primary"
            [attr.aria-label]="'PAC.Common.Close' | translate: { Default: 'Close assistant' }"
            (click)="closeAssistant()"
          >
            <i class="ri-close-line text-base"></i>
          </button>
        </header>

        @switch (status()) {
          @case ('ready') {
            <div class="min-h-0 flex-1">
              <xpert-chatkit class="h-full" [control]="control()!" />
            </div>
          }
          @case ('loading') {
            <div class="flex h-full min-h-40 items-center justify-center px-6 text-sm text-text-secondary">
              {{ 'PAC.Xpert.AssistantLoading' | translate: { Default: 'Preparing assistant…' } }}
            </div>
          }
          @case ('disabled') {
            <div class="flex h-full min-h-40 flex-col items-center justify-center px-6 text-center">
              <i class="ri-pause-circle-line text-3xl text-text-tertiary"></i>
              <div class="mt-4 text-base font-medium text-text-primary">
                {{ 'PAC.Assistant.DisabledTitle' | translate: { Default: 'Assistant disabled' } }}
              </div>
              <div class="mt-2 text-sm text-text-secondary">
                {{
                  'PAC.Assistant.DisabledDesc'
                    | translate
                      : { Default: 'This assistant is configured but currently disabled for the active organization.' }
                }}
              </div>
            </div>
          }
          @default {
            <div class="flex h-full min-h-40 flex-col items-center justify-center px-6 text-center">
              <i class="ri-settings-3-line text-3xl text-text-tertiary"></i>
              <div class="mt-4 text-base font-medium text-text-primary">
                {{ 'PAC.Assistant.MissingTitle' | translate: { Default: 'Assistant not configured' } }}
              </div>
              <div class="mt-2 text-sm text-text-secondary">
                {{
                  'PAC.Assistant.MissingDesc'
                    | translate
                      : {
                          Default:
                            'Configure this assistant in Settings / Assistants before opening the assistant shell.'
                        }
                }}
              </div>
              <a
                class="mt-4 inline-flex items-center rounded-full border border-divider-regular px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-hover-bg"
                [routerLink]="assistantsRoute"
              >
                {{ 'PAC.Assistant.OpenSettings' | translate: { Default: 'Open Assistant Settings' } }}
              </a>
            </div>
          }
        }
      </section>

      @if (!open()) {
        @if (conversationPreview(); as preview) {
          @if (conversationPreviewCollapsed()) {
            <button
              type="button"
              [class]="conversationPreviewToggleClass()"
              [attr.aria-label]="
                'PAC.Xpert.AssistantConversationExpand' | translate: { Default: 'Expand assistant conversations' }
              "
              (click)="expandConversationPreview()"
            >
              <span class="text-sm font-semibold leading-none">{{ conversationPreviewCount() }}</span>
            </button>
          } @else {
            <button
              type="button"
              [class]="conversationPreviewCardClass()"
              [attr.aria-label]="preview.title || ('PAC.Xpert.Assistant' | translate: { Default: 'Assistant' })"
              (click)="openAssistant()"
            >
              <span class="absolute right-4 top-4 inline-flex items-center gap-2">
                <span
                  class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-divider-regular bg-background-default-subtle text-text-secondary"
                  [attr.aria-label]="previewStatusLabel(preview.status)"
                >
                  <i [class]="previewStatusIconClass(preview.status)" aria-hidden="true"></i>
                </span>
              </span>

              <span class="block min-w-0 pr-12">
                <span
                  class="block truncate text-base font-semibold leading-6 text-text-primary"
                  [title]="preview.title || ('PAC.Xpert.Assistant' | translate: { Default: 'Assistant' })"
                >
                  @if (preview.title) {
                    {{ preview.title }}
                  } @else {
                    {{ 'PAC.Xpert.Assistant' | translate: { Default: 'Assistant' } }}
                  }
                </span>
                @if (preview.latestAiMessageText) {
                  <span class="mt-1 line-clamp-2 whitespace-pre-line text-sm leading-5 text-text-secondary">
                    {{ preview.latestAiMessageText }}
                  </span>
                }
              </span>
            </button>

            <button
              type="button"
              [class]="conversationPreviewToggleClass()"
              [attr.aria-label]="
                'PAC.Xpert.AssistantConversationCollapse' | translate: { Default: 'Collapse assistant conversations' }
              "
              (click)="collapseConversationPreview()"
            >
              <i class="ri-arrow-down-s-line text-xl"></i>
            </button>
          }
        }
      }

      <button
        #trigger
        type="button"
        class="pointer-events-auto z-10 flex h-20 w-20 touch-none select-none items-center justify-center p-0 transition-transform hover:scale-105 active:cursor-grabbing active:scale-95"
        [class.cursor-grab]="true"
        [attr.aria-label]="'PAC.Xpert.Assistant' | translate: { Default: 'Assistant' }"
        (pointerdown)="startDrag($event)"
        (dragstart)="$event.preventDefault()"
        (click)="openAssistant()"
      >
        <span class="flex h-20 w-20 shrink-0 items-center justify-center">
          <img
            class="h-full w-full object-contain"
            [src]="assistantIconSrc()"
            alt=""
            aria-hidden="true"
            draggable="false"
          />
        </span>
      </button>
    </div>
  `
})
export class XpertSharedAssistantComponent {
  readonly #facade = inject(XpertAssistantFacade)
  readonly #destroyRef = inject(DestroyRef)

  readonly triggerRef = viewChild<ElementRef<HTMLElement>>('trigger')
  readonly panelRef = viewChild<ElementRef<HTMLElement>>('panel')

  readonly assistantsRoute = ['/settings/assistants']
  readonly control = this.#facade.control
  readonly open = this.#facade.open
  readonly isMobile = this.#facade.isMobile
  readonly status = this.#facade.status
  readonly conversationPreview = this.#facade.conversationPreview
  readonly conversationPreviewCollapsed = signal(false)
  readonly conversationPreviewCount = computed(() => (this.conversationPreview() ? 1 : 0))
  readonly dragging = signal(false)
  readonly dragDirection = signal<AssistantDragDirection | null>(null)
  readonly position = signal<AssistantPosition>({
    x: ASSISTANT_DOCK_MARGIN,
    y: ASSISTANT_DOCK_MARGIN
  })
  readonly dockTransition = ASSISTANT_DOCK_TRANSITION
  readonly dockedLeft = computed(() => {
    const position = this.position()
    const button = this.buttonSize()
    const viewport = this.viewport()

    return position.x + button.width / 2 <= viewport.width / 2
  })
  readonly conversationPreviewCardClass = computed(() =>
    [
      'pointer-events-auto absolute bottom-[calc(100%+0.5rem)] z-20 w-[min(82vw,32rem)] rounded-[1.5rem] border border-divider-regular bg-components-card-bg px-5 py-4 text-left shadow-xl transition-colors hover:bg-hover-bg',
      this.dockedLeft() ? 'left-0' : 'right-0'
    ].join(' ')
  )
  readonly conversationPreviewToggleClass = computed(
    () =>
      'pointer-events-auto absolute -right-2 -top-2 z-30 inline-flex h-8 w-8 items-center justify-center rounded-full border border-divider-regular bg-components-card-bg text-text-primary shadow-xl transition-colors hover:bg-hover-bg'
  )
  readonly assistantIconSrc = computed(() => {
    const runtimeStatus = this.status()
    const previewStatus = this.conversationPreview()?.status ?? null

    if (this.dragging()) {
      return this.dragRunningIconSrc()
    }

    if (runtimeStatus === 'loading') {
      return ASSISTANT_PET_ICON.waiting
    }

    if (runtimeStatus === 'missing' || runtimeStatus === 'disabled' || runtimeStatus === 'error') {
      return ASSISTANT_PET_ICON.failed
    }

    switch (previewStatus) {
      case 'busy':
        return ASSISTANT_PET_ICON.running
      case 'loading':
        return ASSISTANT_PET_ICON.waiting
      case 'interrupted':
      case 'error':
        return ASSISTANT_PET_ICON.failed
      case 'idle':
        return this.conversationPreviewCollapsed() ? ASSISTANT_PET_ICON.jumping : ASSISTANT_PET_ICON.review
      default:
        return this.open() ? ASSISTANT_PET_ICON.waving : ASSISTANT_PET_ICON.idle
    }
  })
  readonly panelOffset = computed(() => {
    const position = this.position()
    const button = this.buttonSize()
    const panel = this.panelSize()
    const viewport = this.viewport()
    const maxLeft = Math.max(ASSISTANT_DOCK_MARGIN, viewport.width - panel.width - ASSISTANT_DOCK_MARGIN)
    const preferredLeft = position.x + button.width - panel.width
    const left = clamp(preferredLeft, ASSISTANT_DOCK_MARGIN, maxLeft)
    const aboveTop = position.y - ASSISTANT_PANEL_GAP - panel.height
    const belowTop = position.y + button.height + ASSISTANT_PANEL_GAP

    let top = aboveTop
    if (aboveTop < ASSISTANT_DOCK_MARGIN && belowTop + panel.height <= viewport.height - ASSISTANT_DOCK_MARGIN) {
      top = belowTop
    } else if (aboveTop < ASSISTANT_DOCK_MARGIN) {
      top = Math.max(ASSISTANT_DOCK_MARGIN, viewport.height - panel.height - ASSISTANT_DOCK_MARGIN)
    }

    if (top + panel.height > viewport.height - ASSISTANT_DOCK_MARGIN) {
      top = Math.max(ASSISTANT_DOCK_MARGIN, viewport.height - panel.height - ASSISTANT_DOCK_MARGIN)
    }

    return {
      left: left - position.x,
      top: top - position.y
    }
  })

  private readonly viewport = signal<ElementSize>({
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight
  })
  private readonly buttonSize = signal<ElementSize>({
    width: 0,
    height: 0
  })
  private readonly panelSize = signal<ElementSize>({
    width: 0,
    height: 0
  })

  private pointerId: number | null = null
  private dragStartPointer: AssistantPosition = { x: 0, y: 0 }
  private dragStartPosition: AssistantPosition = { x: 0, y: 0 }
  private dragMoved = false
  private suppressToggle = false
  private pointerTarget: HTMLElement | null = null
  private positionInitialized = false

  constructor() {
    afterNextRender(() => {
      this.refreshViewport()
      this.observeElement(this.triggerRef()?.nativeElement, (size) => {
        this.buttonSize.set(size)
        this.ensureVisible()
      })
      this.observeElement(this.panelRef()?.nativeElement, (size) => {
        this.panelSize.set(size)
      })
      this.measureElements()
      this.restorePosition()
    })

    effect(() => {
      this.open()
      this.isMobile()
      this.scheduleMeasure()
    })

    effect(() => {
      if (this.conversationPreviewCount()) {
        return
      }

      this.conversationPreviewCollapsed.set(false)
    })
  }

  openAssistant() {
    if (this.suppressToggle) {
      this.suppressToggle = false
      return
    }

    this.#facade.setOpen(!this.open())
  }

  closeAssistant() {
    this.#facade.setOpen(false)
  }

  collapseConversationPreview() {
    this.conversationPreviewCollapsed.set(true)
  }

  expandConversationPreview() {
    this.conversationPreviewCollapsed.set(false)
  }

  isPreviewStatusActive(status: AssistantConversationPreviewStatus) {
    return status === 'busy' || status === 'loading'
  }

  previewStatusIconClass(status: AssistantConversationPreviewStatus) {
    switch (status) {
      case 'busy':
      case 'loading':
        return 'ri-loader-4-line animate-spin text-base'
      case 'interrupted':
        return 'ri-pause-circle-line text-base'
      case 'error':
        return 'ri-error-warning-line text-base text-text-destructive'
      case 'idle':
      default:
        return 'ri-check-line text-base text-text-success'
    }
  }

  previewStatusLabel(status: AssistantConversationPreviewStatus) {
    switch (status) {
      case 'busy':
        return 'Running'
      case 'loading':
        return 'Loading'
      case 'interrupted':
        return 'Interrupted'
      case 'error':
        return 'Error'
      case 'idle':
      default:
        return 'Done'
    }
  }

  startDrag(event: PointerEvent) {
    if (event.button !== 0) {
      return
    }

    this.pointerId = event.pointerId
    this.pointerTarget = event.currentTarget as HTMLElement | null
    this.dragStartPointer = {
      x: event.clientX,
      y: event.clientY
    }
    this.dragStartPosition = this.position()
    this.dragMoved = false
    this.pointerTarget?.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }

  @HostListener('document:pointermove', ['$event'])
  onPointerMove(event: PointerEvent) {
    if (this.pointerId !== event.pointerId) {
      return
    }

    const deltaX = event.clientX - this.dragStartPointer.x
    const deltaY = event.clientY - this.dragStartPointer.y

    if (!this.dragMoved && Math.hypot(deltaX, deltaY) >= DRAG_THRESHOLD) {
      this.dragMoved = true
      this.dragging.set(true)
    }

    if (!this.dragMoved) {
      return
    }

    if (Math.abs(deltaX) >= 2) {
      this.dragDirection.set(deltaX < 0 ? 'left' : 'right')
    }

    this.updatePosition({
      x: this.dragStartPosition.x + deltaX,
      y: this.dragStartPosition.y + deltaY
    })
    event.preventDefault()
  }

  @HostListener('document:pointerup', ['$event'])
  onPointerUp(event: PointerEvent) {
    if (this.pointerId !== event.pointerId) {
      return
    }

    this.finishDrag(event)
  }

  @HostListener('document:pointercancel', ['$event'])
  onPointerCancel(event: PointerEvent) {
    if (this.pointerId !== event.pointerId) {
      return
    }

    this.finishDrag(event)
  }

  @HostListener('window:resize')
  onResize() {
    this.refreshViewport()
    this.measureElements()
    this.ensureVisible()
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.open()) {
      this.closeAssistant()
    }
  }

  private finishDrag(event: PointerEvent) {
    const moved = this.dragMoved

    this.pointerTarget?.releasePointerCapture?.(event.pointerId)
    this.pointerTarget = null
    this.pointerId = null
    this.dragMoved = false
    this.dragging.set(false)
    this.dragDirection.set(null)

    if (moved) {
      this.updatePosition(this.snapPosition(this.position()))
    }

    this.suppressToggle = moved
  }

  private scheduleMeasure() {
    if (typeof window === 'undefined') {
      return
    }

    window.requestAnimationFrame(() => {
      this.measureElements()
    })
  }

  private refreshViewport() {
    if (typeof window === 'undefined') {
      return
    }

    this.viewport.set({
      width: window.innerWidth,
      height: window.innerHeight
    })
  }

  private measureElements() {
    const trigger = this.triggerRef()?.nativeElement
    if (trigger) {
      this.buttonSize.set(readElementSize(trigger))
    }

    const panel = this.panelRef()?.nativeElement
    if (panel) {
      this.panelSize.set(readElementSize(panel))
    }
  }

  private observeElement(element: HTMLElement | undefined, next: (size: ElementSize) => void) {
    if (!element) {
      return
    }

    next(readElementSize(element))

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      next(readElementSize(element))
    })

    observer.observe(element)
    this.#destroyRef.onDestroy(() => observer.disconnect())
  }

  private restorePosition() {
    const stored = this.readStoredPosition()
    const position = stored ?? this.defaultPosition()
    this.position.set(this.clampPosition(position))
    this.positionInitialized = true
  }

  private defaultPosition(): AssistantPosition {
    const { width, height } = this.buttonSize()
    const viewport = this.viewport()

    return this.snapPosition({
      x: viewport.width - width - ASSISTANT_DOCK_MARGIN,
      y: viewport.height - height - ASSISTANT_DOCK_MARGIN
    })
  }

  private ensureVisible() {
    if (!this.positionInitialized) {
      return
    }

    const next = this.clampPosition(this.position())
    const current = this.position()

    if (next.x !== current.x || next.y !== current.y) {
      this.updatePosition(next)
    }
  }

  private updatePosition(position: AssistantPosition) {
    const next = this.clampPosition(position)
    this.position.set(next)

    if (this.positionInitialized) {
      this.persistPosition(next)
    }
  }

  private clampPosition(position: AssistantPosition): AssistantPosition {
    const viewport = this.viewport()
    const button = this.buttonSize()

    return {
      x: clamp(
        position.x,
        ASSISTANT_DOCK_MARGIN,
        Math.max(ASSISTANT_DOCK_MARGIN, viewport.width - button.width - ASSISTANT_DOCK_MARGIN)
      ),
      y: clamp(
        position.y,
        ASSISTANT_DOCK_MARGIN,
        Math.max(ASSISTANT_DOCK_MARGIN, viewport.height - button.height - ASSISTANT_DOCK_MARGIN)
      )
    }
  }

  private snapPosition(position: AssistantPosition): AssistantPosition {
    const clamped = this.clampPosition(position)
    const viewport = this.viewport()
    const button = this.buttonSize()
    const centerX = clamped.x + button.width / 2
    const x =
      centerX <= viewport.width / 2
        ? ASSISTANT_DOCK_MARGIN
        : Math.max(ASSISTANT_DOCK_MARGIN, viewport.width - button.width - ASSISTANT_DOCK_MARGIN)

    return {
      x,
      y: clamped.y
    }
  }

  private readStoredPosition(): AssistantPosition | null {
    if (typeof localStorage === 'undefined') {
      return null
    }

    try {
      const raw = localStorage.getItem(ASSISTANT_POSITION_STORAGE_KEY)
      if (!raw) {
        return null
      }

      const parsed = JSON.parse(raw)
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
        return parsed
      }
    } catch {
      return null
    }

    return null
  }

  private persistPosition(position: AssistantPosition) {
    if (typeof localStorage === 'undefined') {
      return
    }

    try {
      localStorage.setItem(ASSISTANT_POSITION_STORAGE_KEY, JSON.stringify(position))
    } catch {
      return
    }
  }

  private dragRunningIconSrc() {
    switch (this.dragDirection()) {
      case 'left':
        return ASSISTANT_PET_ICON.runningLeft
      case 'right':
        return ASSISTANT_PET_ICON.runningRight
      default:
        return ASSISTANT_PET_ICON.running
    }
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function readElementSize(element: HTMLElement): ElementSize {
  const rect = element.getBoundingClientRect()

  return {
    width: rect.width,
    height: rect.height
  }
}
