. "$PSScriptRoot\common.ps1"

$sdkRoot = Join-Path $Script:PluginRoot 'test-fixtures\local-sdk'

function Invoke-ImplementationContract {
  param(
    [Parameter(Mandatory=$true)][string]$Fixture,
    [Parameter(Mandatory=$true)][string]$ContractId,
    [switch]$WithoutSdk
  )

  $arguments = @{
    project_path = Join-Path $Script:PluginRoot $Fixture
    contract_ids = @($ContractId)
    include_evidence = $true
  }
  if (!$WithoutSdk) {
    $arguments.sdk_roots = @($sdkRoot)
  }

  $result = Invoke-NvidiaPluginTool -Name 'nvidia_implementation_contracts' -Arguments $arguments
  return @($result.contracts)[0]
}

function Assert-State {
  param(
    [Parameter(Mandatory=$true)]$Contract,
    [Parameter(Mandatory=$true)][string]$Expected
  )

  Assert-Truthy ($Contract.state -eq $Expected) "Expected $($Contract.contract_id) to be $Expected, got $($Contract.state). Blockers: $($Contract.blockers -join ' | ')"
}

function Assert-Gate {
  param(
    [Parameter(Mandatory=$true)]$Contract,
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][string]$ExpectedStatus
  )

  $gate = @($Contract.gates | Where-Object { $_.name -eq $Name })[0]
  Assert-Truthy $gate "Missing gate '$Name' on $($Contract.contract_id)."
  Assert-Truthy ($gate.status -eq $ExpectedStatus) "Expected gate '$Name' to be $ExpectedStatus, got $($gate.status)."
}

$validCases = @(
  @{ Fixture = 'test-fixtures\custom-d3d12'; ContractId = 'streamline-dlss-sr-dlaa' },
  @{ Fixture = 'test-fixtures\custom-d3d12-fg-ready'; ContractId = 'streamline-dlss-fg-mfg-readiness' },
  @{ Fixture = 'test-fixtures\custom-d3d12-dxr'; ContractId = 'd3d12-dxr-raytracing-base' },
  @{ Fixture = 'test-fixtures\custom-d3d12-nrd'; ContractId = 'nrd-denoiser-readiness' },
  @{ Fixture = 'test-fixtures\rtx-video-player'; ContractId = 'rtx-video-enhancement-pipeline' },
  @{ Fixture = 'test-fixtures\ffmpeg-pipeline'; ContractId = 'video-codec-nvenc-nvdec-pipeline' }
)

foreach ($case in $validCases) {
  $contract = Invoke-ImplementationContract -Fixture $case.Fixture -ContractId $case.ContractId
  Assert-State -Contract $contract -Expected 'satisfied'
  Assert-Gate -Contract $contract -Name 'local_sdk_header_detected' -ExpectedStatus 'pass'
  Assert-Gate -Contract $contract -Name 'source_backed_docs_available' -ExpectedStatus 'pass'
  Assert-Gate -Contract $contract -Name 'repo_contract_satisfied' -ExpectedStatus 'pass'
  Assert-Gate -Contract $contract -Name 'patch_plan_approved' -ExpectedStatus 'required_before_edits'
  Assert-Gate -Contract $contract -Name 'validation_artifact_produced' -ExpectedStatus 'required_before_claiming_ready'
}
Write-Host 'Valid implementation contract fixtures OK' -ForegroundColor Green

$incomplete = Invoke-ImplementationContract -Fixture 'test-fixtures\custom-d3d12-incomplete' -ContractId 'streamline-dlss-sr-dlaa'
Assert-State -Contract $incomplete -Expected 'blocked_missing_project_contract'
Assert-Gate -Contract $incomplete -Name 'local_sdk_header_detected' -ExpectedStatus 'pass'
Assert-Gate -Contract $incomplete -Name 'repo_contract_satisfied' -ExpectedStatus 'fail'
Write-Host 'Incomplete project blocked-state OK' -ForegroundColor Green

$browser = Invoke-ImplementationContract -Fixture 'test-fixtures\browser-only' -ContractId 'streamline-dlss-sr-dlaa'
Assert-State -Contract $browser -Expected 'rejected_unsupported_project'
Assert-Truthy (($browser.blockers -join ' ') -match 'browser') 'Browser-only path did not report a browser/native blocker.'
Write-Host 'Unsupported browser-only rejection OK' -ForegroundColor Green

$missingSdk = Invoke-ImplementationContract -Fixture 'test-fixtures\custom-d3d12' -ContractId 'streamline-dlss-sr-dlaa' -WithoutSdk
Assert-State -Contract $missingSdk -Expected 'blocked_missing_sdk'
Assert-Gate -Contract $missingSdk -Name 'local_sdk_header_detected' -ExpectedStatus 'fail'
Assert-Truthy (($missingSdk.blockers -join ' ') -match 'SDK|header') 'Missing SDK state did not report SDK/header blockers.'
Write-Host 'Missing SDK blocker-state OK' -ForegroundColor Green
