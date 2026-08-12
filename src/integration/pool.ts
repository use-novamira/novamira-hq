// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Bounded concurrency over a list of items, for the two places that spawn one
 * child per site-CLI profile.
 *
 * It was private to `connection.ts` until `profiles.ts` needed the same bound
 * for the same reason — an `auth status` per profile is a real authenticated
 * round trip *to the site*, made by the child under the child's credential, and
 * an operator with twenty profiles should not open twenty at once. Rather than
 * a second copy, it moved down to a leaf that imports nothing.
 */

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Deliberately hand-rolled rather than chunked: a chunked `Promise.all` runs at
 * the speed of the slowest member of each chunk, which with a ten-second
 * per-child timeout is exactly the case that matters.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: width }, lane));
}
