import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const licenses = await Promise.all(
	['LICENSE', 'THIRD_PARTY_NOTICES'].map((file) =>
		readFile(new URL('../' + file, import.meta.url), 'utf8'),
	),
);

await build({
	entryPoints: ['src/main.ts'],
	bundle: true,
	platform: 'browser',
	format: 'cjs',
	target: 'es2020',
	external: ['obsidian', 'electron'],
	banner: { js: '/*\n' + licenses.map((text) => text.trimEnd()).join('\n\n') + '\n*/' },
	outfile: 'main.js',
	logLevel: 'info',
});
