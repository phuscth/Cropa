/** The rail's filter: the starred models, or one provider's. */
export type ModelFilter = string;

interface Filterable {
  provider: string;
  name: string;
  favorite: boolean;
}

/** The models a rail filter and a search query leave, in their original order. */
export function filterModels<T extends Filterable>(models: readonly T[], filter: ModelFilter, query: string): T[] {
  const needle = query.trim().toLowerCase();
  return models.filter((model) => {
    if (filter === 'favorites' ? !model.favorite : model.provider !== filter) return false;
    return needle === '' || model.name.toLowerCase().includes(needle);
  });
}

/** Where the active option goes after a navigation key; wraps at both ends. -1 when there is no option. */
export function nextActive(index: number, count: number, key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): number {
  if (count <= 0) return -1;
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'ArrowDown':
      return index < 0 || index >= count - 1 ? 0 : index + 1;
    case 'ArrowUp':
      return index <= 0 || index >= count ? count - 1 : index - 1;
  }
}
