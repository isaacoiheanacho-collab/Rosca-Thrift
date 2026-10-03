# Simple .env.example secret scanner.
#
# Fails if .env.example contains a value that looks like a real credential.
# Placeholders (user:password@, your-xxx, host.region, etc.) are allowed.

$ErrorActionPreference = "Stop"
$file = "backend\.env.example"

if (-not (Test-Path $file)) {
    Write-Host "OK: $file not found - nothing to check"
    exit 0
}

$bad = @()
$lineNo = 0

Get-Content $file | ForEach-Object {
    $lineNo++
    $line = $_.Trim()

    # Skip comments and empty lines
    if ($line -eq "" -or $line.StartsWith("#")) { return }

    # Must be KEY=VALUE
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }

    $key = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim()

    # Empty values are fine
    if ($value -eq "") { return }

    # A value is OK if it matches any of these placeholder patterns
    $isPlaceholder = $false

    # Explicit placeholders
    if ($value -match "your-") { $isPlaceholder = $true }
    if ($value -match "replace-") { $isPlaceholder = $true }
    if ($value -match "password") { $isPlaceholder = $true }
    if ($value -match "^user:") { $isPlaceholder = $true }
    if ($value -match "^default:password") { $isPlaceholder = $true }

    # Placeholder hostnames
    if ($value -match "host\.region") { $isPlaceholder = $true }
    if ($value -match "host-pooler\.region") { $isPlaceholder = $true }
    if ($value -match "host\.upstash\.io") { $isPlaceholder = $true }

    # Known public URLs (not secrets)
    if ($value -match "^https://api\.textbee\.dev") { $isPlaceholder = $true }
    if ($value -match "^https://s3\.") { $isPlaceholder = $true }
    if ($value -match "^http://localhost") { $isPlaceholder = $true }

    # Obvious placeholder identifiers
    if ($value -match "rosca-receipts-example") { $isPlaceholder = $true }
    if ($value -match "447912345678") { $isPlaceholder = $true }
    if ($value -match "example\.com") { $isPlaceholder = $true }
    if ($value -match "noreply@rosca\.local") { $isPlaceholder = $true }

    # Numeric / simple values (ports, TTLs, rates, IDs)
    if ($value -match "^\d+$") { $isPlaceholder = $true }
    if ($value -match "^\d+\.\d+$") { $isPlaceholder = $true }
    if ($value -match "^04-00-04$") { $isPlaceholder = $true }
    if ($value -match "^12345678$") { $isPlaceholder = $true }

    # Business values
    if ($value -match "^ROSCA Pool$") { $isPlaceholder = $true }
    if ($value -match "^development$") { $isPlaceholder = $true }
    if ($value -match "^info$") { $isPlaceholder = $true }
    if ($value -match "^auto$") { $isPlaceholder = $true }
    if ($value -match "^us-east-005$") { $isPlaceholder = $true }

    if (-not $isPlaceholder) {
        $bad += "  Line ${lineNo}: $key=$value"
    }
}

if ($bad.Count -gt 0) {
    Write-Host "FAIL: .env.example contains values that don't look like placeholders:" -ForegroundColor Red
    $bad | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    Write-Host ""
    Write-Host "Fix: replace them with obvious placeholders (user:password@, your-xxx, etc.)" -ForegroundColor Yellow
    exit 1
}

Write-Host "OK: .env.example looks clean" -ForegroundColor Green
exit 0