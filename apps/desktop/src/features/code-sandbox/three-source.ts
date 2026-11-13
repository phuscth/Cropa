export async function loadThreeSource(): Promise<string> {
  return (await import('virtual:cropa-three')).default;
}
