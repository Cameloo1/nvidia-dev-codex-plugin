. "$PSScriptRoot\common.ps1"

$skillRoot = Join-Path $Script:PluginRoot 'skills\nvidia-rtx-dlss'
$skillPath = Join-Path $skillRoot 'SKILL.md'
$agentPath = Join-Path $skillRoot 'agents\openai.yaml'

Assert-Truthy (Test-Path -LiteralPath $skillPath) 'NVIDIA skill SKILL.md is missing.'
Assert-Truthy (Test-Path -LiteralPath $agentPath) 'NVIDIA skill agents/openai.yaml is missing.'

$skillText = Get-Content -LiteralPath $skillPath -Raw
$skillLines = Get-Content -LiteralPath $skillPath

Assert-Truthy ($skillLines.Count -lt 500) "Skill body is too large for skill-creator guidance: $($skillLines.Count) lines."
Assert-Truthy ($skillText -match '(?s)^---\s*\r?\nname:\s*nvidia-rtx-dlss\r?\ndescription:\s+.+?\r?\n---') 'Skill frontmatter must contain name and description.'

$frontmatter = ($skillText -split '---', 3)[1]
foreach ($key in @('metadata:', 'short-description:', 'display_name:', 'default_prompt:')) {
  Assert-Truthy (!($frontmatter -match [regex]::Escape($key))) "Skill frontmatter contains unsupported key for SKILL.md: $key"
}

foreach ($required in @(
  'implementation-readiness reports',
  'SDK/header grounding',
  'D3D12 Streamline DLSS SR/DLAA',
  'RTX Video SDK',
  'Video Codec SDK/NVENC/NVDEC',
  'NVIDIA SDK/licensing boundaries'
)) {
  Assert-Truthy ($frontmatter -match [regex]::Escape($required)) "Skill trigger description missing: $required"
}

foreach ($section in @(
  '## Operating Flow',
  '## Implementation Levels',
  '## Tool Selection',
  '## Supported Base Cases',
  '## Required Gates',
  '## Routing Rules',
  '## Output Contract',
  '## Do Not Overclaim'
)) {
  Assert-Truthy ($skillText -match [regex]::Escape($section)) "Skill body missing required section: $section"
}

foreach ($toolName in @(
  'nvidia_implementation_readiness_report',
  'nvidia_implementation_contracts',
  'nvidia_sdk_header_grounding',
  'nvidia_assisted_implementation',
  'nvidia_validation_harness',
  'nvidia_license_guard'
)) {
  Assert-Truthy ($skillText -match [regex]::Escape($toolName)) "Skill body does not teach use of tool: $toolName"
}

foreach ($boundary in @(
  'Do not provide guessed SDK function calls',
  'Do not claim DLSS',
  'Do not download SDKs',
  'Do not recommend modding'
)) {
  Assert-Truthy ($skillText -match [regex]::Escape($boundary)) "Skill body missing overclaim boundary: $boundary"
}

$agentText = Get-Content -LiteralPath $agentPath -Raw
foreach ($requiredAgentText in @(
  'display_name: "NVIDIA RTX/DLSS"',
  'short_description: "Gate and scaffold NVIDIA integrations"',
  'default_prompt: "Use $nvidia-rtx-dlss',
  'allow_implicit_invocation: true'
)) {
  Assert-Truthy ($agentText -match [regex]::Escape($requiredAgentText)) "agents/openai.yaml missing: $requiredAgentText"
}

$extraDocs = Get-ChildItem -LiteralPath $skillRoot -File | Where-Object {
  $_.Name -match '^(README|INSTALLATION|QUICK_REFERENCE|CHANGELOG|GUIDE)\.md$'
}
Assert-Truthy ($extraDocs.Count -eq 0) "Skill folder contains auxiliary docs discouraged by skill-creator: $($extraDocs.Name -join ', ')"

$systemSkillValidator = 'C:\Users\wamin\.codex\skills\.system\skill-creator\scripts\quick_validate.py'
if ((Test-Path -LiteralPath $systemSkillValidator) -and (Get-Command python -ErrorAction SilentlyContinue)) {
  $result = python $systemSkillValidator $skillRoot
  Assert-Truthy (($result -join "`n") -match 'Skill is valid') "skill-creator quick_validate.py did not pass: $($result -join ' ')"
}

Write-Host 'NVIDIA skill usability and skill-creator compliance OK' -ForegroundColor Green
