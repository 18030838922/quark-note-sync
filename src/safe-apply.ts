/** Run a destructive or overwriting operation only if the file still matches the scanned version. */
export async function applyIfCurrentHash(
	getCurrentHash: () => Promise<string | null>,
	expectedHash: string | null,
	apply: () => Promise<void>,
): Promise<boolean> {
	if (await getCurrentHash() !== expectedHash) return false;
	await apply();
	return true;
}
