<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts" module>
  export type Placement = 'right-end' | 'left-end' | 'bottom-end' | 'top-end' | 'bottom-start';

  export interface Box {
    top: number;
    left: number;
    width: number;
    height: number;
  }

  /**
   * Where a menu of the given size goes next to its trigger. A menu that would leave the
   * viewport at the bottom or top opens to the other side; in any case it is kept inside
   * the viewport.
   */
  export function placeMenu(
    placement: Placement,
    trigger: Box,
    menu: { width: number; height: number },
    viewport: { width: number; height: number },
    gap = 8,
    margin = 8,
  ): { top: number; left: number } {
    const right = trigger.left + trigger.width;
    const bottom = trigger.top + trigger.height;
    let top: number;
    let left: number;
    switch (placement) {
      case 'right-end':
        left = right + gap;
        top = bottom - menu.height;
        break;
      case 'left-end':
        left = trigger.left - gap - menu.width;
        top = bottom - menu.height;
        break;
      case 'top-end':
        left = right - menu.width;
        top = trigger.top - gap - menu.height;
        if (top < margin && bottom + gap + menu.height <= viewport.height - margin) {
          top = bottom + gap;
        }
        break;
      case 'bottom-start':
      case 'bottom-end':
        left = placement === 'bottom-start' ? trigger.left : right - menu.width;
        top = bottom + gap;
        if (
          top + menu.height > viewport.height - margin &&
          trigger.top - gap - menu.height >= margin
        ) {
          top = trigger.top - gap - menu.height;
        }
        break;
    }
    const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, max));
    return {
      top: clamp(top, viewport.height - menu.height - margin),
      left: clamp(left, viewport.width - menu.width - margin),
    };
  }
</script>

<script lang="ts">
  import { tick, type Snippet } from 'svelte';

  interface Props {
    /** Accessible name of the trigger; leave out when its visible text says it all. */
    label?: string;
    placement?: Placement;
    testid?: string;
    /** Class for the trigger button (style it with :global from the using component). */
    triggerClass?: string;
    title?: string;
    disabled?: boolean;
    trigger: Snippet<[boolean]>;
    children: Snippet;
  }

  let {
    label,
    placement = 'bottom-end',
    testid,
    triggerClass = '',
    title,
    disabled = false,
    trigger,
    children,
  }: Props = $props();

  const uid = $props.id();
  let open = $state(false);
  let button = $state<HTMLButtonElement | undefined>();
  let menu = $state<HTMLDivElement | undefined>();
  let top = $state(0);
  let left = $state(0);
  let placed = $state(false);

  const ITEMS = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])';

  function items(): HTMLElement[] {
    return menu ? [...menu.querySelectorAll<HTMLElement>(ITEMS)] : [];
  }

  function position() {
    if (!button || !menu) return;
    const r = button.getBoundingClientRect();
    const next = placeMenu(
      placement,
      { top: r.top, left: r.left, width: r.width, height: r.height },
      { width: menu.offsetWidth, height: menu.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    top = next.top;
    left = next.left;
    placed = true;
  }

  async function show(focus: 'first' | 'last' = 'first') {
    if (disabled) return;
    open = true;
    placed = false;
    await tick();
    position();
    // The menu is invisible until it is placed, and an invisible element cannot take the
    // focus: wait for the placement to reach the DOM first.
    await tick();
    const all = items();
    (focus === 'last' ? all[all.length - 1] : all[0])?.focus();
  }

  function close(returnFocus = true) {
    if (!open) return;
    const hadFocus = !!menu && menu.contains(document.activeElement);
    open = false;
    if (returnFocus && hadFocus) button?.focus();
  }

  function onTriggerKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      void show(e.key === 'ArrowUp' ? 'last' : 'first');
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      open = false;
    }
  }

  function onMenuKeydown(e: KeyboardEvent) {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        all[(at + 1) % all.length]?.focus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        all[(at - 1 + all.length) % all.length]?.focus();
        break;
      case 'Home':
        e.preventDefault();
        all[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        all[all.length - 1]?.focus();
        break;
      case 'Escape':
        // Only the menu closes, not a dialog it may sit in.
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        close(false);
        break;
    }
  }

  // Choosing an entry closes the menu; the entry's own handler has already run.
  function onMenuClick(e: MouseEvent) {
    if (e.target instanceof Element && e.target.closest('[role="menuitem"]')) close();
  }

  $effect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (menu?.contains(target) || button?.contains(target)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      // Scrolling inside the menu keeps it open; anything else moves the trigger.
      if (e.target instanceof Node && menu?.contains(e.target)) return;
      position();
    };
    const onResize = () => close(false);
    // A click into an embedded app never reaches this document, so "pointer down
    // outside" cannot see it. What does happen is that the window loses the focus to
    // the frame: the menu closes then, as it does when the user turns to another window.
    const onBlur = () => close(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onBlur);
    };
  });
</script>

<button
  bind:this={button}
  type="button"
  class={triggerClass}
  aria-haspopup="menu"
  aria-expanded={open}
  aria-controls={open ? `${uid}-menu` : undefined}
  aria-label={label}
  {title}
  {disabled}
  data-testid={testid}
  onclick={() => (open ? close() : show())}
  onkeydown={onTriggerKeydown}
>
  {@render trigger(open)}
</button>
{#if open}
  <div
    bind:this={menu}
    id="{uid}-menu"
    class="menu"
    class:placed
    role="menu"
    aria-label={label}
    tabindex="-1"
    style:top="{top}px"
    style:left="{left}px"
    onkeydown={onMenuKeydown}
    onclick={onMenuClick}
  >
    {@render children()}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 40;
    min-width: 220px;
    max-width: min(320px, calc(100vw - 16px));
    max-height: min(480px, calc(100vh - 16px));
    overflow-y: auto;
    padding: var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface-raised);
    box-shadow: var(--shadow-pop);
    /* Invisible until measured and placed, so it never flashes at the wrong spot. */
    visibility: hidden;
  }
  .menu.placed {
    visibility: visible;
    animation: menu-in var(--dur-fast) var(--ease-out);
  }
  .menu:focus {
    outline: none;
  }
  @keyframes menu-in {
    from {
      opacity: 0;
    }
  }
</style>
