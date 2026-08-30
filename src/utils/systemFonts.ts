export function normalizeFontFamilies(families: string[], currentFonts: string[] = []): string[] {
  const unique = new Map<string, string>();
  for (const value of [...currentFonts, ...families]) {
    const family = String(value || '').trim();
    if (!family) continue;
    const key = family.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, family);
  }
  return Array.from(unique.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
}
