// Search over items. "Make search better" is ambiguous: ranking or filtering.
export function search(items, query) {
  return items.filter((i) => i.name.includes(query));
}
