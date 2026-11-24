$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $projectRoot 'manifest.json'
$mainPath = Join-Path $projectRoot 'main.js'

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
	throw '找不到 manifest.json；请先在插件项目根目录运行打包脚本。'
}
if (-not (Test-Path -LiteralPath $mainPath -PathType Leaf)) {
	throw '找不到 main.js；请先运行 npm run build。'
}

$manifestText = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
$manifest = $manifestText | ConvertFrom-Json
$pluginId = [string]$manifest.id
$version = [string]$manifest.version
if ($pluginId -ne 'quark-note-sync' -or [string]::IsNullOrWhiteSpace($version)) {
	throw 'manifest.json 中的插件 ID 或版本无效。'
}

$distPath = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $distPath -Force | Out-Null
$zipPath = Join-Path $distPath "$pluginId-$version.zip"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipStream = [IO.File]::Open($zipPath, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$archive = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Create)
try {
	[IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
		$archive, $manifestPath, "$pluginId/manifest.json", [IO.Compression.CompressionLevel]::Optimal
	) | Out-Null
	[IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
		$archive, $mainPath, "$pluginId/main.js", [IO.Compression.CompressionLevel]::Optimal
	) | Out-Null
	$stylesPath = Join-Path $projectRoot 'styles.css'
	if (Test-Path -LiteralPath $stylesPath -PathType Leaf) {
		[IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
			$archive, $stylesPath, "$pluginId/styles.css", [IO.Compression.CompressionLevel]::Optimal
		) | Out-Null
	}
}
finally {
	$archive.Dispose()
	$zipStream.Dispose()
}

Write-Output "插件包已生成：$zipPath"
