import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import type { CostInput, IncomeInput } from '../shared/types.ts'
import { Store } from './store.ts'

function costInput(overrides: Partial<CostInput> = {}): CostInput {
  return {
    name: 'Server',
    category: 'Hardware',
    costCents: 1200,
    priceChanges: [],
    cadence: 'monthly',
    startsOn: '2026-07-24',
    endsOn: null,
    amortizationMonths: null,
    intervalCount: null,
    intervalUnit: null,
    ...overrides,
  }
}

function incomeInput(overrides: Partial<IncomeInput> = {}): IncomeInput {
  return {
    month: '2026-07',
    amountCents: 500,
    note: null,
    ...overrides,
  }
}

function exportData() {
  return {
    schemaVersion: 2,
    currency: 'EUR',
    exportedAt: '2026-07-24T00:00:00.000Z',
    costPoints: [],
    income: [
      {
        id: 1,
        month: '2026-07',
        amountCents: 500,
        note: 'Kasse',
      },
    ],
  }
}

/** schema v1 file with donations, as written by the previous release */
function legacyData() {
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
        receivedOn: '2020-07-01',
      },
    ],
    knownUsers: [],
  }
}

Deno.test('price changes are normalized, validated, and persist', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    // legacy records predate the field and default to a never-changing price
    const legacyPoint: Record<string, unknown> = { ...costInput({ name: 'Legacy' }), id: 1 }
    delete legacyPoint.priceChanges
    await Deno.writeTextFile(
      dataFile,
      JSON.stringify({ ...exportData(), costPoints: [legacyPoint] }),
    )

    const store = await Store.load(dataFile)
    assert.deepEqual(store.list()[0]?.priceChanges, [])

    // input order is normalized to chronological order
    const added = await store.add(
      costInput({
        priceChanges: [
          { startsOn: '2027-01-01', costCents: 1500 },
          { startsOn: '2026-10-01', costCents: 900 },
        ],
      }),
    )
    assert.deepEqual(
      added.priceChanges.map((change) => change.startsOn),
      ['2026-10-01', '2027-01-01'],
    )

    await assert.rejects(
      () =>
        store.add(
          costInput({
            priceChanges: [
              { startsOn: '2026-10-01', costCents: 900 },
              { startsOn: '2026-10-15', costCents: 950 },
            ],
          }),
        ),
      /must not repeat a calendar month/,
    )
    await assert.rejects(
      () =>
        store.add(
          costInput({
            cadence: 'one_time',
            priceChanges: [{ startsOn: '2026-10-01', costCents: 900 }],
          }),
        ),
      /not valid for one_time cadence/,
    )
    await assert.rejects(
      () => store.add(costInput({ priceChanges: [{ startsOn: '2026-07-01', costCents: 900 }] })),
      /later month/,
    )

    const reloaded = await Store.load(dataFile)
    const stored = reloaded.list().find((point) => point.id === added.id)
    assert.deepEqual(stored?.priceChanges, added.priceChanges)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('imports legacy exports and migrates donations to income', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    await Deno.writeTextFile(dataFile, JSON.stringify(exportData()))
    const store = await Store.load(dataFile)

    const imported = await store.replaceFromImport(legacyData())
    assert.equal(imported.schemaVersion, 2)
    assert.deepEqual(
      imported.income.map((entry) => [entry.month, entry.amountCents, entry.note]),
      [['2020-07', 500, 'Legacy donation']],
    )
    assert.equal(JSON.parse(await Deno.readTextFile(`${dataFile}.bak`)).income.length, 1)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('legacy donations expand into one income entry per counted month', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    await Deno.writeTextFile(
      dataFile,
      JSON.stringify({
        ...legacyData(),
        donations: [
          {
            id: 2,
            name: 'Monatlich',
            amountCents: 100,
            cadence: 'monthly',
            receivedOn: '2020-05-01',
            endsOn: '2020-07-31',
          },
          {
            id: 1,
            name: 'Einmal',
            amountCents: 500,
            cadence: 'one_time',
            receivedOn: '2020-06-10',
          },
          {
            id: 3,
            name: 'Jährlich',
            amountCents: 1200,
            cadence: 'yearly',
            receivedOn: '2020-02-29',
            endsOn: '2021-03-01',
          },
          // never counted before the migration — stays uncounted
          {
            id: 4,
            name: 'Offen',
            amountCents: 700,
            cadence: 'one_time',
            receivedOn: '2020-06-01',
            status: 'pending',
            submittedBy: 'Sam',
          },
        ],
      }),
    )

    const store = await Store.load(dataFile)
    const income = store.listIncome()
    assert.deepEqual(
      income.map((entry) => `${entry.month}:${entry.amountCents}:${entry.note}`),
      [
        '2021-02:1200:Jährlich',
        '2020-07:100:Monatlich',
        '2020-06:500:Einmal',
        '2020-06:100:Monatlich',
        '2020-05:100:Monatlich',
        '2020-02:1200:Jährlich',
      ],
    )
    assert.equal(new Set(income.map((entry) => entry.id)).size, income.length)

    await store.addIncome(incomeInput({ month: '2026-07' }))
    const persisted = JSON.parse(await Deno.readTextFile(dataFile))
    assert.equal(persisted.schemaVersion, 2)
    assert.equal(persisted.income.length, 7)
    assert.equal(persisted.donations, undefined)
    assert.equal(persisted.knownUsers, undefined)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('open-ended legacy donations stop at the current month', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    await Deno.writeTextFile(
      dataFile,
      JSON.stringify({
        ...legacyData(),
        donations: [
          { id: 1, name: 'Läuft', amountCents: 100, cadence: 'monthly', receivedOn: '2020-01-01' },
        ],
      }),
    )

    const income = (await Store.load(dataFile)).listIncome()
    assert.equal(income[0]?.month, new Date().toISOString().slice(0, 7))
    assert.equal(income.at(-1)?.month, '2020-01')
    const persisted = JSON.parse(await Deno.readTextFile(dataFile))
    assert.equal(persisted.schemaVersion, 2)
    assert.equal(persisted.donations, undefined)
    assert.equal(JSON.parse(await Deno.readTextFile(`${dataFile}.bak`)).schemaVersion, 1)

    // A later restart reads the fixed entries instead of expanding the donation again.
    const reloaded = await Store.load(dataFile)
    assert.deepEqual(reloaded.listIncome(), income)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('loads and preserves schema-v1 records accepted by the previous release', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    const legacy = {
      ...legacyData(),
      exportedAt: 'legacy timestamp',
      unknownRootField: true,
      costPoints: [
        {
          ...costInput(),
          id: 1,
          startsOn: '1969-12-01',
          endsOn: '1969-11-01',
          intervalCount: 3,
          unknownPointField: true,
        },
      ],
      donations: [
        {
          ...legacyData().donations[0],
          cadence: 'one_time',
          endsOn: '2026-07-02',
        },
      ],
    }
    await Deno.writeTextFile(dataFile, JSON.stringify(legacy))

    const store = await Store.load(dataFile)
    assert.equal(store.list()[0]?.endsOn, '1969-11-01')
    // the legacy one-time donation migrates into its receipt month's entry
    assert.equal(store.listIncome()[0]?.month, '2020-07')
    assert.equal(store.listIncome()[0]?.note, 'Legacy donation')
    await store.add(costInput({ name: 'New valid cost' }))

    const reloaded = await Store.load(dataFile)
    assert.equal(reloaded.list().length, 2)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('income entries are created, updated, removed, and listed newest first', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const dataFile = join(directory, 'costs.json')
    const store = await Store.load(dataFile)

    const first = await store.addIncome(incomeInput({ note: 'Kasse' }))
    const second = await store.addIncome(incomeInput({ month: '2026-08', amountCents: 250 }))
    assert.deepEqual([first.id, second.id], [1, 2])
    assert.deepEqual(store.listIncome().map((entry) => entry.id), [2, 1])

    const updated = await store.updateIncome(
      first.id,
      incomeInput({ month: '2026-06', amountCents: 700 }),
    )
    assert.deepEqual([updated?.month, updated?.amountCents, updated?.note], ['2026-06', 700, null])
    assert.equal(await store.updateIncome(99, incomeInput()), null)

    assert.equal(await store.removeIncome(second.id), true)
    assert.equal(await store.removeIncome(second.id), false)
    assert.deepEqual((await Store.load(dataFile)).listIncome().map((entry) => entry.id), [1])
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
      () => store.replaceFromImport({ ...exportData(), income: [{ id: 1 }] }),
      /month must be a non-empty string/,
    )
    await assert.rejects(
      () => store.replaceFromImport({ ...legacyData(), donations: [{ id: 1 }] }),
      /name must be a non-empty string/,
    )
    await assert.rejects(
      () =>
        store.replaceFromImport({
          ...legacyData(),
          donations: [
            { ...legacyData().donations[0], id: 1 },
            { ...legacyData().donations[0], id: 1 },
          ],
        }),
      /donations contains duplicate id 1/,
    )
    await assert.rejects(
      () =>
        store.replaceFromImport({
          ...legacyData(),
          donations: [{ ...legacyData().donations[0], extra: true }],
        }),
      /donations\[0\]\.extra is not supported/,
    )
    await assert.rejects(
      () =>
        store.replaceFromImport({
          ...legacyData(),
          donations: [{ ...legacyData().donations[0], id: 0 }],
        }),
      /donations\[0\]\.id must be a safe integer/,
    )
    for (
      const invalid of [
        { receivedOn: '1969-12-01' },
        { cadence: 'monthly', endsOn: '2020-06-30' },
        { cadence: 'one_time', endsOn: '2020-07-31' },
        { submittedBy: 42 },
        { userId: '' },
      ]
    ) {
      await assert.rejects(() =>
        store.replaceFromImport({
          ...legacyData(),
          donations: [{ ...legacyData().donations[0], ...invalid }],
        })
      )
    }
    await assert.rejects(
      () => store.replaceFromImport({ ...exportData(), income: undefined }),
      /income is required for schemaVersion 2/,
    )
    await assert.rejects(
      () => store.replaceFromImport({ ...exportData(), donations: [] }),
      /root\.donations is not supported/,
    )
    await assert.rejects(
      () => store.replaceFromImport({ ...exportData(), currency: 'EURO' }),
      /three-letter currency code/,
    )
    const { income: _income, ...withoutIncome } = exportData()
    await assert.rejects(
      () => store.replaceFromImport({ ...withoutIncome, imcome: [] }),
      /root\.imcome is not supported/,
    )
    await assert.rejects(
      () =>
        store.replaceFromImport({
          ...exportData(),
          income: [{ ...exportData().income[0], amountCents: Number.MAX_SAFE_INTEGER + 1 }],
        }),
      /safe integer/,
    )
    assert.equal(store.listIncome()[0]?.note, 'Kasse')
    assert.equal(JSON.parse(await Deno.readTextFile(dataFile)).income[0].note, 'Kasse')
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('readers only observe mutations after persistence commits', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-store-test-' })
  try {
    const store = await Store.load(join(directory, 'costs.json'))
    const pending = store.add(costInput())
    await Promise.resolve()

    assert.equal(store.list().length, 0)
    await pending
    assert.equal(store.list().length, 1)
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
      () => store.addIncome(incomeInput({ month: '2026-13' })),
      /must be YYYY-MM/,
    )
    await assert.rejects(
      () => store.addIncome(incomeInput({ month: '2026-7' })),
      /must be YYYY-MM/,
    )
    await assert.rejects(
      () => store.addIncome(incomeInput({ month: '1969-12' })),
      /must not be before 1970/,
    )
    await assert.rejects(
      () => store.addIncome(incomeInput({ amountCents: 0 })),
      /safe integer/,
    )
    await assert.rejects(
      () => store.addIncome(incomeInput({ note: '' })),
      /non-empty string/,
    )

    await store.add(costInput({ cadence: 'one_time', amortizationMonths: 60 }))
    await store.add(
      costInput({ cadence: 'custom', intervalCount: 3, intervalUnit: 'months' }),
    )
    await store.addIncome(incomeInput({ note: 'Kasse' }))

    const reloaded = await Store.load(dataFile)
    assert.equal(reloaded.list().length, 2)
    assert.equal(reloaded.listIncome().length, 1)
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

    const entry = await store.addIncome(incomeInput({ note: 'Kasse' }))
    entry.note = 'Changed result'
    const income = store.listIncome()
    income[0]!.note = 'Changed list'

    assert.equal(store.list()[0]?.name, 'Original')
    assert.equal(store.categoryIcons.Hardware, 'server')
    assert.equal(store.listIncome()[0]?.note, 'Kasse')
    assert.equal((await Store.load(dataFile)).list()[0]?.name, 'Original')
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})
