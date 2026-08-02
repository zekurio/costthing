<script lang="ts">
  import Dialog from './Dialog.svelte'
  import type { ConfirmAction } from '../lib/dialog.ts'

  let {
    title,
    body,
    actions,
    onclose,
  }: {
    title: string
    body: string
    actions: ConfirmAction[]
    onclose: () => void
  } = $props()

  function choose(action: ConfirmAction) {
    onclose()
    action.run()
  }
</script>

<Dialog {title} {onclose}>
  <p>{body}</p>
  <div class="actions">
    {#each actions as action, index (`${action.label}-${index}`)}
      <button
        class="btn {action.kind === 'danger' ? 'danger' : action.kind}"
        onclick={() => choose(action)}
      >
        {action.label}
      </button>
    {/each}
  </div>
</Dialog>

<style>
  p {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 14px;
    flex-wrap: wrap;
  }
</style>
