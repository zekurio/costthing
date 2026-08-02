<script lang="ts" generics="T extends string">
  interface Option {
    value: T
    label: string
  }

  interface Props {
    value: T
    options: Option[]
    disabled?: boolean
    title?: string
    ariaLabel?: string
    onchange?: (value: T) => void
  }

  let {
    value = $bindable(),
    options,
    disabled = false,
    title = '',
    ariaLabel,
    onchange,
  }: Props = $props()

  function change(event: Event) {
    value = (event.currentTarget as HTMLSelectElement).value as T
    onchange?.(value)
  }
</script>

<select
  class="select"
  value={value}
  {disabled}
  title={title || undefined}
  aria-label={ariaLabel}
  onchange={change}
>
  {#each options as option (option.value)}
    <option value={option.value}>{option.label}</option>
  {/each}
</select>

<style>
  .select {
    width: 100%;
    min-width: 0;
    font-size: 14px;
  }
</style>
