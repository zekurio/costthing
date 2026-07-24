import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { Store } from './store.ts'

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

Deno.test('links submitted donations to the submitting Jellyfin user', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const store = await Store.load(join(directory, 'costs.json'))
    const donation = await store.submitDonation(
      {
        name: 'Alex',
        amountCents: 500,
        cadence: 'one_time',
        receivedOn: '2026-07-24',
        endsOn: null,
        userId: null, // ignored — always linked to the submitter
      },
      { id: 'u1', name: 'Alex' },
    )
    assert.equal(donation.userId, 'u1')
    assert.equal(donation.status, 'pending')
    assert.equal(store.listKnownUsers().find((u) => u.id === 'u1')?.archived, false)
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
    assert.equal(store.listDonations()[0]?.name, 'Legacy donation')
    assert.equal(JSON.parse(await Deno.readTextFile(dataFile)).donations[0].name, 'Legacy donation')
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})
