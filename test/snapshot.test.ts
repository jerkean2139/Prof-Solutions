import { describe, it, expect, beforeAll } from 'vitest';
import { computeSnapshotRows, rebuildSnapshots } from '../src/inventory/snapshot.js';
import { seed } from '../src/seed/seed.js';
import { pool } from '../src/db/pool.js';
import { ensureMigrated } from './helpers.js';

describe('computeSnapshotRows (pure)', () => {
  it('attributes committed demand to the SKU primary warehouse (most on-hand)', () => {
    const rows = computeSnapshotRows(
      [
        { sku_id: 'A', warehouse_id: 'w1', on_hand: 10 },
        { sku_id: 'A', warehouse_id: 'w2', on_hand: 30 },
      ],
      [{ sku_id: 'A', committed: 5 }],
    );
    const w1 = rows.find((r) => r.warehouse_id === 'w1')!;
    const w2 = rows.find((r) => r.warehouse_id === 'w2')!;
    expect(w2.quantity_committed).toBe(5); // more on-hand wins
    expect(w1.quantity_committed).toBe(0);
  });

  it('breaks ties by warehouse_id ascending', () => {
    const rows = computeSnapshotRows(
      [
        { sku_id: 'A', warehouse_id: 'b', on_hand: 10 },
        { sku_id: 'A', warehouse_id: 'a', on_hand: 10 },
      ],
      [{ sku_id: 'A', committed: 4 }],
    );
    expect(rows.find((r) => r.warehouse_id === 'a')!.quantity_committed).toBe(4);
    expect(rows.find((r) => r.warehouse_id === 'b')!.quantity_committed).toBe(0);
  });

  it('defaults committed to zero when there is no demand', () => {
    const rows = computeSnapshotRows(
      [{ sku_id: 'A', warehouse_id: 'w1', on_hand: 7 }],
      [],
    );
    expect(rows[0]!.quantity_committed).toBe(0);
    expect(rows[0]!.quantity_on_hand).toBe(7);
  });
});

describe('rebuildSnapshots (from the ledger)', () => {
  beforeAll(async () => {
    await ensureMigrated();
    await seed();
  });

  it('reproduces identical numbers on repeated rebuilds', async () => {
    const first = await rebuildSnapshots();
    const second = await rebuildSnapshots();
    expect(second).toEqual(first);
  });

  it('matches on-hand minus committed against the seeded loop', async () => {
    await rebuildSnapshots();
    const { rows } = await pool.query<{
      sku_code: string;
      quantity_on_hand: number;
      quantity_committed: number;
      quantity_available: number;
    }>(
      `SELECT s.sku_code, ss.quantity_on_hand, ss.quantity_committed, ss.quantity_available
         FROM inventory_snapshots ss JOIN skus s ON s.id = ss.sku_id
        ORDER BY s.sku_code`,
    );
    const bySku = Object.fromEntries(rows.map((r) => [r.sku_code, r]));
    // Seed: received 200/150/100; committed 2/1/3 from the finalized sale.
    expect(bySku['DET-5GAL']).toMatchObject({
      quantity_on_hand: 200,
      quantity_committed: 2,
      quantity_available: 198,
    });
    expect(bySku['CAN-3PK']).toMatchObject({
      quantity_on_hand: 150,
      quantity_committed: 1,
      quantity_available: 149,
    });
    expect(bySku['PBG-STD']).toMatchObject({
      quantity_on_hand: 100,
      quantity_committed: 3,
      quantity_available: 97,
    });
  });
});
