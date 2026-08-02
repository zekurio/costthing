import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import type { CostInput, DonationInput } from '../shared/types.ts'
import { Store } from './store.ts'

function costInput(overrides: Partial<CostInput> = {}): CostInput {
  return {
    name: 'Server',
    category: 'Hardware',
    costCents: 1200,
    cadence: 'monthly',
    startsOn: '2026-07-24',
    endsOn: null,
    amortizationMonths: null,
    intervalCount: null,
    intervalUnit: null,
    ...overrides,
  }
}

function donationInput(overrides: Partial<DonationInput> = {}): DonationInput {
  return {
    name: 'Alex',
    amountCents: 500,
    cadence: 'one_time',
    receivedOn: '2026-07-24',
    endsOn: null,
    userId: null,
    ...overrides,
  }
}

function exportData() {
  return {
    schemaVersion: 1,
    currency: 'EUR',
    exportedAt: '2026-07-24T00:00:00.000Z',
    costPoints: [],
    donations: [
      {
        id: 1,
        name: 'Legacy donation',
        amountCents: 500,
        receivedOn: '2026-07-01',
      },
    ],
  }
}

Deno.test('imports an export and normalizes legacy donations', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    await Deno.writeTextFile(dataFile, JSON.stringify(exportData()))
    const store = await Store.load(dataFile)

    const imported = await store.replaceFromImport(exportData())
    assert.equal(imported.donations[0]?.cadence, 'one_time')
    assert.equal(imported.donations[0]?.endsOn, null)
    assert.equal(JSON.parse(await Deno.readTextFile(`${dataFile}.bak`)).donations.length, 1)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('keeps departed Jellyfin users as archived and re-links returning ones', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    const store = await Store.load(dataFile)

    await store.syncKnownUsers([
      { id: 'u1', name: 'Alex' },
      { id: 'u2', name: 'Sam' },
    ])
    // u2's account is deleted on the server — the record must survive as archived
    let users = await store.syncKnownUsers([{ id: 'u1', name: 'Alex' }])
    assert.equal(users.length, 2)
    assert.equal(users.find((u) => u.id === 'u2')?.archived, true)
    assert.equal(users.find((u) => u.id === 'u1')?.archived, false)

    // archived state survives a reload from disk
    const reloaded = await Store.load(dataFile)
    assert.equal(reloaded.listKnownUsers().find((u) => u.id === 'u2')?.archived, true)

    // the account comes back (or is recreated with the same id) → un-archived
    users = await store.syncKnownUsers([
      { id: 'u1', name: 'Alex' },
      { id: 'u2', name: 'Sam Neu' },
    ])
    const sam = users.find((u) => u.id === 'u2')
    assert.equal(sam?.archived, false)
    assert.equal(sam?.name, 'Sam Neu')
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('reconciles donor identities: name matches backfill, manual links spread', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const store = await Store.load(join(directory, 'costs.json'))
    const base = {
      amountCents: 500,
      cadence: 'one_time' as const,
      receivedOn: '2026-07-24',
      endsOn: null,
      userId: null,
    }
    await store.addDonation({ ...base, name: 'Alex' })
    await store.addDonation({ ...base, name: 'Kumpel' })
    await store.addDonation({ ...base, name: 'Kumpel' })

    // syncing the archive backfills by exact name (case-insensitive)
    await store.syncKnownUsers([{ id: 'u1', name: 'alex' }])
    const byName = (n: string) => store.listDonations().filter((d) => d.name === n)
    assert.equal(byName('Alex')[0]?.userId, 'u1')
    assert.equal(byName('Kumpel')[0]?.userId, null) // no matching account — untouched

    // manually linking one „Kumpel“ donation spreads to the donor's other donations
    const kumpel = byName('Kumpel')
    await store.updateDonation(kumpel[0]!.id, { ...base, name: 'Kumpel', userId: 'u2' })
    assert.ok(byName('Kumpel').every((d) => d.userId === 'u2'))

    // future donations under a claimed name inherit the identity on write
    await store.addDonation({ ...base, name: 'Kumpel' })
    assert.ok(byName('Kumpel').every((d) => d.userId === 'u2'))
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('never links ambiguous donor names', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const store = await Store.load(join(directory, 'costs.json'))
    const base = {
      amountCents: 500,
      cadence: 'one_time' as const,
      receivedOn: '2026-07-24',
      endsOn: null,
    }
    // two different people donated under the same label
    await store.addDonation({ ...base, name: 'Sam', userId: 'u1' })
    await store.addDonation({ ...base, name: 'Sam', userId: 'u2' })
    // a third „Sam“ donation must stay unlinked — even if an account matches
    await store.addDonation({ ...base, name: 'Sam', userId: null })
    await store.syncKnownUsers([{ id: 'u3', name: 'Sam' }])
    const unlinked = store.listDonations().filter((d) => d.userId === null)
    assert.equal(unlinked.length, 1)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('pending self-submissions do not claim other donations until confirmation', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const store = await Store.load(join(directory, 'costs.json'))
    const historic = await store.addDonation(donationInput())
    const pending = await store.submitDonation(
      donationInput(),
      { id: 'u1', name: 'Alex' },
    )

    assert.equal(pending.userId, 'u1')
    assert.equal(pending.status, 'pending')
    assert.equal(store.listKnownUsers().find((u) => u.id === 'u1')?.archived, false)
    assert.equal(store.listDonations().find((d) => d.id === historic.id)?.userId, null)

    await store.confirmDonation(pending.id)
    assert.equal(store.listDonations().find((d) => d.id === historic.id)?.userId, 'u1')
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('rejects invalid imports without replacing current data', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    await Deno.writeTextFile(dataFile, JSON.stringify(exportData()))
    const store = await Store.load(dataFile)

    await assert.rejects(
      () => store.replaceFromImport({ ...exportData(), donations: [{ id: 1 }] }),
      /name must be a non-empty string/,
    )
    await assert.rejects(
      () => store.replaceFromImport({ ...exportData(), currency: 'EURO' }),
      /three-letter currency code/,
    )
    await assert.rejects(
      () =>
        store.replaceFromImport({
          ...exportData(),
          donations: [{ ...exportData().donations[0], amountCents: Number.MAX_SAFE_INTEGER + 1 }],
        }),
      /safe integer/,
    )
    assert.equal(store.listDonations()[0]?.name, 'Legacy donation')
    assert.equal(JSON.parse(await Deno.readTextFile(dataFile)).donations[0].name, 'Legacy donation')
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('serializes concurrent writes and persists every allocated id', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    const store = await Store.load(dataFile)
    const added = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.add(costInput({ name: `Server ${index}` }))),
    )

    assert.deepEqual(added.map((point) => point.id), Array.from({ length: 20 }, (_, i) => i + 1))
    assert.equal(new Set(added.map((point) => point.id)).size, 20)
    const reloaded = await Store.load(dataFile)
    assert.deepEqual(
      reloaded.list().map((point) => point.id),
      Array.from({ length: 20 }, (_, i) => 20 - i),
    )
    const temporaryFiles = []
    for await (const entry of Deno.readDir(directory)) {
      if (entry.name.endsWith('.tmp')) temporaryFiles.push(entry.name)
    }
    assert.deepEqual(temporaryFiles, [])
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('rolls back data and id counters when persistence fails', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    const store = await Store.load(dataFile)
    const first = await store.add(costInput({ name: 'Persisted' }))
    const backupFile = `${dataFile}.bak`
    await Deno.remove(backupFile)
    await Deno.mkdir(backupFile)

    await assert.rejects(() => store.add(costInput({ name: 'Rolled back' })))
    assert.deepEqual(store.list().map((point) => point.name), ['Persisted'])

    await Deno.remove(backupFile)
    const recovered = await store.add(costInput({ name: 'Recovered' }))
    assert.equal(recovered.id, first.id + 1)
    assert.deepEqual(
      (await Store.load(dataFile)).list().map((point) => point.name),
      ['Recovered', 'Persisted'],
    )
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('normal CRUD enforces reload-safe semantic invariants', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    const store = await Store.load(dataFile)

    await assert.rejects(
      () => store.add(costInput({ startsOn: '2026-02-30' })),
      /not a valid date/,
    )
    await assert.rejects(
      () => store.add(costInput({ endsOn: '2026-07-23' })),
      /must be on or after/,
    )
    await assert.rejects(
      () => store.add(costInput({ cadence: 'custom', intervalUnit: 'months' })),
      /required for custom cadence/,
    )
    await assert.rejects(
      () => store.add(costInput({ cadence: 'monthly', intervalCount: 2 })),
      /only valid for custom cadence/,
    )
    await assert.rejects(
      () => store.add(costInput({ cadence: 'monthly', amortizationMonths: 12 })),
      /only valid for one_time cadence/,
    )
    await assert.rejects(
      () => store.add(costInput({ costCents: Number.MAX_SAFE_INTEGER + 1 })),
      /safe integer/,
    )
    await assert.rejects(
      () => store.addDonation(donationInput({ receivedOn: '2025-02-29' })),
      /not a valid date/,
    )
    await assert.rejects(
      () => store.addDonation(donationInput({ cadence: 'monthly', endsOn: '2026-07-23' })),
      /must be on or after/,
    )
    await assert.rejects(
      () => store.addDonation(donationInput({ endsOn: '2026-07-24' })),
      /must be null for one_time/,
    )

    await store.add(costInput({ cadence: 'one_time', amortizationMonths: 60 }))
    await store.add(
      costInput({ cadence: 'custom', intervalCount: 3, intervalUnit: 'months' }),
    )
    const donation = await store.addDonation(
      donationInput({ cadence: 'monthly', endsOn: '2026-08-01' }),
    )
    await assert.rejects(
      () =>
        store.updateDonation(
          donation.id,
          donationInput({ cadence: 'monthly', endsOn: '2026-07-23' }),
        ),
      /must be on or after/,
    )

    const reloaded = await Store.load(dataFile)
    assert.equal(reloaded.list().length, 2)
    assert.equal(reloaded.listDonations().length, 1)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('generated ids ignore payload fields, remain monotonic, and reject overflow', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    let store = await Store.load(dataFile)
    const first = await store.add({ ...costInput(), id: 999 } as CostInput)
    const second = await store.add(costInput({ name: 'Second' }))
    assert.equal(first.id, 1)
    assert.equal(second.id, 2)
    await store.remove(second.id)

    // The one-step backup also seeds the high-water mark after a reload.
    store = await Store.load(dataFile)
    assert.equal((await store.add(costInput({ name: 'Third' }))).id, 3)

    const imported = store.export()
    imported.costPoints = [{ ...costInput(), id: 100 }]
    await store.replaceFromImport(imported)
    assert.equal((await store.add(costInput({ name: 'After import' }))).id, 101)

    const unsafe = store.export()
    unsafe.costPoints = [{ ...costInput(), id: Number.MAX_SAFE_INTEGER + 1 }]
    await assert.rejects(() => store.replaceFromImport(unsafe), /safe integer/)

    const exhausted = store.export()
    exhausted.costPoints = [{ ...costInput(), id: Number.MAX_SAFE_INTEGER }]
    await store.replaceFromImport(exhausted)
    await assert.rejects(() => store.add(costInput()), /id space exhausted/)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('does not expose mutable aliases', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    const store = await Store.load(dataFile)
    const input = costInput({ name: 'Original' })
    const adding = store.add(input, 'server')
    input.name = 'Changed input'
    const added = await adding
    added.name = 'Changed result'

    const listed = store.list()
    listed[0]!.name = 'Changed list'
    const icons = store.categoryIcons
    icons.Hardware = 'changed-icon'
    const exported = store.export()
    exported.costPoints[0]!.name = 'Changed export'
    exported.categoryIcons.Hardware = 'changed-export-icon'

    const donation = await store.addDonation(donationInput())
    donation.name = 'Changed donation result'
    const donations = store.listDonations()
    donations[0]!.name = 'Changed donation list'
    const users = await store.syncKnownUsers([{ id: 'u1', name: 'Alex' }])
    users[0]!.name = 'Changed user list'

    assert.equal(store.list()[0]?.name, 'Original')
    assert.equal(store.categoryIcons.Hardware, 'server')
    assert.equal(store.listDonations()[0]?.name, 'Alex')
    assert.equal(store.listKnownUsers()[0]?.name, 'Alex')
    assert.equal((await Store.load(dataFile)).list()[0]?.name, 'Original')
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})
