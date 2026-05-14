. "$PSScriptRoot\common.ps1"

$positiveRoot = Join-Path $Script:PluginRoot 'test-fixtures\header-grounding-positive'
$negativeRoot = Join-Path $Script:PluginRoot 'test-fixtures\header-grounding-negative'
$rendererRoot = Join-Path $Script:PluginRoot 'test-fixtures\custom-d3d12'

$streamline = Invoke-NvidiaPluginTool -Name 'nvidia_sdk_header_grounding' -Arguments @{
  technology = 'dlss-streamline'
  roots = @($positiveRoot)
}
Assert-Truthy $streamline.detected_sdk_root 'Header grounding did not report a detected SDK root.'
Assert-Truthy ($streamline.confidence_level -in @('medium', 'high')) "Expected positive Streamline confidence, got $($streamline.confidence_level)."
Assert-Truthy $streamline.can_generate_real_api_guidance 'Positive Streamline fixture did not allow real API guidance.'
Assert-Truthy (@($streamline.missing_required_symbols).Count -eq 0) "Positive Streamline fixture reported missing symbols: $($streamline.missing_required_symbols -join ', ')"
Assert-Contains -Collection $streamline.relevant_symbols -Expected 'slInit' -Message 'Positive Streamline fixture did not expose slInit.'
Write-Host 'Positive Streamline header grounding OK' -ForegroundColor Green

foreach ($case in @(
  @{ Technology = 'reflex'; Symbol = 'SL_FEATURE_REFLEX' },
  @{ Technology = 'nrd'; Symbol = 'ReBLUR' },
  @{ Technology = 'rtx-video-sdk'; Symbol = 'RTXVideoCreate' },
  @{ Technology = 'video-codec-sdk'; Symbol = 'NV_ENCODE_API_FUNCTION_LIST' }
)) {
  $grounding = Invoke-NvidiaPluginTool -Name 'nvidia_sdk_header_grounding' -Arguments @{
    technology = $case.Technology
    roots = @($positiveRoot)
  }
  Assert-Truthy $grounding.can_generate_real_api_guidance "Expected $($case.Technology) to allow header-grounded guidance."
  Assert-Contains -Collection $grounding.relevant_symbols -Expected $case.Symbol -Message "Expected $($case.Technology) symbol $($case.Symbol)."
}
Write-Host 'Positive multi-technology header grounding OK' -ForegroundColor Green

$negative = Invoke-NvidiaPluginTool -Name 'nvidia_sdk_header_grounding' -Arguments @{
  technology = 'dlss-streamline'
  roots = @($negativeRoot)
}
Assert-Truthy (!$negative.can_generate_real_api_guidance) 'Negative Streamline fixture unexpectedly allowed real API guidance.'
Assert-Truthy ($negative.confidence_level -eq 'blocked_missing_symbols') "Expected blocked_missing_symbols, got $($negative.confidence_level)."
Assert-Contains -Collection $negative.missing_required_symbols -Expected 'slInit' -Message 'Negative Streamline fixture did not report missing slInit.'
Write-Host 'Negative header grounding blocker OK' -ForegroundColor Green

$guidance = Invoke-NvidiaPluginTool -Name 'nvidia_code_guidance' -Arguments @{
  goal = 'Build real Streamline DLSS guidance.'
  technology = 'dlss-streamline'
  project_path = $rendererRoot
  sdk_roots = @($negativeRoot)
}
Assert-Truthy ($guidance.api_generation_gate.status -eq 'blocked_missing_symbols') "Expected code guidance blocker, got $($guidance.api_generation_gate.status)."
Assert-Truthy ($guidance.code_output_mode -eq 'template_only_no_real_sdk_calls') "Expected template-only code guidance, got $($guidance.code_output_mode)."
Assert-Truthy (($guidance.code_guidance[0]) -match 'Template-only') 'Code guidance did not explicitly mark the output as template-only.'
Write-Host 'Code guidance missing-symbol blocker OK' -ForegroundColor Green

$implementation = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
  goal = 'Create Streamline init scaffold.'
  technology = 'dlss-streamline'
  project_path = $rendererRoot
  workflow = 'streamline-init-scaffold'
  sdk_root = $negativeRoot
}
Assert-Truthy ($implementation.api_generation_gate.status -eq 'blocked_missing_symbols') "Expected assisted implementation blocker, got $($implementation.api_generation_gate.status)."
Assert-Truthy ($implementation.code_output_mode -eq 'template_only_no_real_sdk_calls') "Expected assisted implementation to be template-only, got $($implementation.code_output_mode)."
$generatedText = (($implementation.implementation_package.files | ForEach-Object { $_.content }) -join "`n")
foreach ($forbidden in @('slInit\(', 'slShutdown\(', 'slDLSSGetOptimalSettings\(', 'slDLSSGSetOptions\(', 'RTXVideoCreate\(', 'NvEncOpenEncodeSessionEx\(')) {
  Assert-Truthy (!($generatedText -match $forbidden)) "Generated implementation output contained forbidden SDK call pattern: $forbidden"
}
Write-Host 'No hallucinated SDK calls in generated scaffold OK' -ForegroundColor Green

$groundedGuidance = Invoke-NvidiaPluginTool -Name 'nvidia_code_guidance' -Arguments @{
  goal = 'Build Streamline DLSS guidance with observed headers.'
  technology = 'dlss-streamline'
  project_path = $rendererRoot
  sdk_roots = @($positiveRoot)
}
Assert-Truthy ($groundedGuidance.api_generation_gate.status -eq 'header_grounded') "Expected header-grounded code guidance, got $($groundedGuidance.api_generation_gate.status)."
Assert-Truthy ($groundedGuidance.code_output_mode -eq 'header_grounded_observed_symbols_only') "Expected observed-symbol-only mode, got $($groundedGuidance.code_output_mode)."
Write-Host 'Header-grounded code guidance OK' -ForegroundColor Green
