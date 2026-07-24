<script lang="ts" generics="T extends string">
  import { Check, ChevronDown } from 'lucide-svelte'

  interface Option {
    value: T
    label: string
  }

  interface Props {
    value: T
    options: Option[]
    disabled?: boolean
    title?: string
  }

  let { value = $bindable(), options, disabled = false, title = '' }: Props = $props()

  let open = $state(false)
  let el = $state<HTMLElement>()

  const selected = $derived(options.find((o) => o.value === value))

  function choose(v: T) {
    value = v
    open = false
  }
</script>

<svelte:window
  onpointerdown={(e) => {
    if (open && el && !el.contains(e.target as Node)) open = false
  }}
  onkeydown={(e) => {
    if (e.key === 'Escape' && open) open = false
  }}
/>

<div class="select" bind:this={el}>
  <button
    type="button"
    class="trigger"
    {disabled}
    title={title || undefined}
    aria-haspopup="listbox"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <span class="label">{selected?.label ?? ''}</span>
    <span class="chev" class:open aria-hidden="true"><ChevronDown size={15} /></span>
  </button>

  {#if open}
    <ul class="panel" role="listbox">
      {#each options as opt (opt.value)}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={opt.value === value}
            class:selected={opt.value === value}
            onclick={() => choose(opt.value)}
          >
            <span class="check" aria-hidden="true">
              {#if opt.value === value}<Check size={14} />{/if}
            </span>
            {opt.label}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .select {
    position: relative;
    min-width: 0;
  }

  .trigger {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 99px;
    padding: 8px 12px 8px 14px;
    font-size: 14px;
    color: var(--ink);
    transition: border-color 120ms ease, opacity 120ms ease;
  }

  .trigger:hover:not(:disabled) {
    border-color: var(--muted);
  }

  .trigger:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chev {
    display: grid;
    place-items: center;
    color: var(--muted);
    transition: transform 140ms ease;
    flex-shrink: 0;
  }

  .chev.open {
    transform: rotate(180deg);
  }

  .panel {
    list-style: none;
    margin: 0;
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    min-width: 100%;
    max-height: 280px;
    overflow-y: auto;
    background: var(--surface);
    border-radius: 12px;
    box-shadow: var(--shadow-2);
    padding: 5px;
    z-index: 30;
  }

  .panel button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 14px;
    color: var(--ink);
    text-align: left;
    white-space: nowrap;
    transition: background 120ms ease;
  }

  .panel button:hover {
    background: var(--surface-2);
  }

  .panel button.selected {
    color: var(--accent-strong);
    font-weight: 600;
  }

  .check {
    width: 14px;
    display: grid;
    place-items: center;
    flex-shrink: 0;
  }
</style>
