export function validateSftpEntryName(input: string): { value: string; error: string | null } {
  const value = input.trim();
  if (!value) return { value, error: '名称不能为空' };
  if (value === '.' || value === '..') return { value, error: '名称不能是 . 或 ..' };
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) {
    return { value, error: '名称不能包含 /、\\ 或空字符' };
  }
  return { value, error: null };
}
