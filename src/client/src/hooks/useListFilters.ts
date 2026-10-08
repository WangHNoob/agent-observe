import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

export type FilterValues = Record<string, string | undefined>;

/**
 * 列表页筛选 ↔ URL search params 同步：
 * - filters 从 URL 初始化，外部变化（后退/深链/mode 链接跳入）时回同步
 * - draft 为表单草稿，apply() 写回 URL 并重置页码
 */
export function useListFilters(keys: string[]) {
  const [search, setSearch] = useSearchParams();

  const fromSearch = (): FilterValues => {
    const f: FilterValues = {};
    for (const k of keys) f[k] = search.get(k) ?? undefined;
    return f;
  };

  const [filters, setFilters] = useState<FilterValues>(fromSearch);
  const [draft, setDraft] = useState<FilterValues>(fromSearch);
  const [page, setPage] = useState(0);

  useEffect(() => {
    const next = fromSearch();
    setFilters(next);
    setDraft(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const apply = () => {
    setPage(0);
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(draft)) {
      if (v) next.set(k, v);
    }
    setSearch(next);
  };

  const reset = () => {
    setDraft({});
    setPage(0);
    setSearch(new URLSearchParams());
  };

  return { filters, draft, setDraft, page, setPage, apply, reset };
}
