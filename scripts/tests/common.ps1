$ErrorActionPreference = 'Stop'

$Script:PluginRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Script:Server = Join-Path $Script:PluginRoot 'scripts\nvidia-rtx-dlss-mcp.mjs'

function Invoke-NvidiaPluginTool {
  param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][hashtable]$Arguments,
    [switch]$AllowError
  )

  $request = @{
    jsonrpc = '2.0'
    id = 1
    method = 'tools/call'
    params = @{
      name = $Name
      arguments = $Arguments
    }
  } | ConvertTo-Json -Depth 32 -Compress

  $payload = 'Content-Length: ' + [Text.Encoding]::UTF8.GetByteCount($request) + "`r`n`r`n" + $request
  $raw = ($payload | node $Script:Server) -join [Environment]::NewLine
  $jsonStart = $raw.IndexOf('{')
  if ($jsonStart -lt 0) { throw "Unexpected MCP response: $raw" }
  $envelope = $raw.Substring($jsonStart) | ConvertFrom-Json
  if ($envelope.error) {
    if ($AllowError) { return $envelope }
    throw $envelope.error.message
  }
  return ($envelope.result.content[0].text | ConvertFrom-Json)
}

function Assert-Truthy {
  param(
    [Parameter(Mandatory=$true)]$Value,
    [Parameter(Mandatory=$true)][string]$Message
  )
  if (!$Value) { throw $Message }
}

function Assert-Contains {
  param(
    [Parameter(Mandatory=$true)]$Collection,
    [Parameter(Mandatory=$true)][string]$Expected,
    [Parameter(Mandatory=$true)][string]$Message
  )
  if ($Collection -notcontains $Expected) { throw $Message }
}
