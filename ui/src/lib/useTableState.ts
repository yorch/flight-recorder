import { useCallback, useMemo, useState } from 'react';
import { currentParams, replaceQuery, useHashParams } from './router.ts';
import { emptyState, readTableState, type TableState, writeTableState } from './table.ts';

/**
 * Table view state. With a namespace string it lives in the hash query (shareable,
 * survives reloads); with `null` it is component-local.
 */
export function useTableState(ns: string | null): [TableState, (next: TableState) => void] {
  const params = useHashParams();
  const [local, setLocal] = useState<TableState>(emptyState);
  const fromHash = useMemo(() => (ns === null ? null : readTableState(params, ns)), [params, ns]);
  const set = useCallback(
    (next: TableState) => {
      if (ns === null) setLocal(next);
      else replaceQuery(writeTableState(currentParams(), ns, next));
    },
    [ns],
  );
  return [fromHash ?? local, set];
}
