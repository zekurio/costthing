export interface ConfirmAction {
  label: string
  kind: 'primary' | 'danger' | 'ghost'
  run: () => void
}

export interface ConfirmDialogState {
  title: string
  body: string
  actions: ConfirmAction[]
}
