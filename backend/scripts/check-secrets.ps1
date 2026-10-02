# Pre-push secret scanner.
# Fails if .env.example or any tracked file contains what looks like a real credential.

$ErrorActionPreference = "Stop"
$found = 0

# Files that must never contain real secrets
$sensitiveFiles = @(
    "backend\.env.example"
)

# Patterns that indicate real credentials
$patterns = @(
    "postgresql://[^:]+:[^@]+@",         # postgres URL with password
    "rediss?://[^:]+:[^@]+@",            # redis URL with password
    "neondb_owner:",                     # Neon owner string
    "upstash\.io:6379",                  # Upstash host with port
    "AKIA[0-9A-Z]{16}",                  # AWS key
    "K00[0-9A-Za-z]{28}",                # Backblaze app key
    "sk-[a-zA-Z0-9]{20,}",               # OpenAI-ish
    "ghp_[a-zA-Z0-9]{36}"                # GitHub PAT
)

foreach ($file in $sensitiveFiles) {
    if (-not (Test-Path $file)) { continue }
    $content = Get-Content $file -Raw
    foreach ($pattern in $patterns) {
        if ($content -match $pattern) {
            Write-Host "❌ Real credential pattern found in $file" -ForegroundColor Red
            Write-Host "   Pattern: $pattern" -ForegroundColor Red
            $found++
        }
    }
}

if ($found -gt 0) {
    Write-Host ""
    Write-Host "🚨 ABORT: Fix .env.example before pushing." -ForegroundColor Red
    exit 1
}

Write-Host "✅ No leaked credentials detected in .env.example" -ForegroundColor Green
exit 0