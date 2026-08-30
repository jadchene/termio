export function resolveSftpContextTargets(contextPath: string, selectedPaths: string[]): string[] {
  const selected = Array.from(new Set(selectedPaths.filter(Boolean)));
  return selected.includes(contextPath) ? selected : [contextPath];
}
