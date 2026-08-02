<script module lang="ts">
  let nextDialogId = 0
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import type { Snippet } from 'svelte'

  interface Props {
    title: string
    onclose: () => void
    children: Snippet
    size?: 'compact' | 'form'
  }

  let { title, onclose, children, size = 'compact' }: Props = $props()
  let dialog = $state<HTMLDialogElement>()
  let panel = $state<HTMLElement>()
  const titleId = `dialog-${++nextDialogId}`

  function close() {
    dialog?.close()
    onclose()
  }

  onMount(() => {
    dialog?.showModal()
    if (size === 'compact') panel?.focus()
    return () => dialog?.close()
  })
</script>

<dialog
  bind:this={dialog}
  aria-labelledby={titleId}
  oncancel={(event) => {
    event.preventDefault()
    close()
  }}
  onclick={(event) => event.target === event.currentTarget && close()}
>
  <section class="panel {size}" bind:this={panel} tabindex="-1">
    <h2 id={titleId}>{title}</h2>
    {@render children()}
  </section>
</dialog>

<style>
  dialog {
    width: auto;
    max-width: none;
    max-height: none;
    margin: auto;
    padding: 0;
    overflow: visible;
    color: var(--ink);
    background: transparent;
    border: 0;
  }

  .panel {
    width: min(400px, calc(100vw - 40px));
    max-height: 90vh;
    overflow-y: auto;
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: var(--shadow-2);
    padding: 24px;
  }

  .panel.form {
    width: min(440px, calc(100vw - 40px));
  }

  .panel:focus {
    outline: none;
  }

  h2 {
    margin: 0 0 14px;
    font-family: var(--font-display);
    font-size: 21px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  @media (max-width: 480px) {
    .panel,
    .panel.form {
      width: calc(100vw - 24px);
      max-height: calc(100vh - 24px);
      padding: 20px;
    }
  }
</style>
