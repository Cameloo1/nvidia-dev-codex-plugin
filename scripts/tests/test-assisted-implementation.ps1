. "$PSScriptRoot\common.ps1"

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("nvidia-rtx-dlss-assisted-" + [Guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  $workflows = @(
    @{ Workflow = 'unreal-plugin-config-validation'; Technology = 'unreal-dlss-plugin'; Goal = 'Create Unreal DLSS plugin config validation scaffold.' },
    @{ Workflow = 'cmake-sdk-wiring'; Technology = 'dlss-streamline'; Goal = 'Create CMake include and library path setup for Streamline.' },
    @{ Workflow = 'streamline-init-scaffold'; Technology = 'dlss-streamline'; Goal = 'Create Streamline initialization scaffold for a custom renderer.' },
    @{ Workflow = 'video-codec-sample-adaptation'; Technology = 'video-codec-sdk'; Goal = 'Create Video Codec SDK sample adaptation scaffold.' },
    @{ Workflow = 'rtx-video-pipeline-skeleton'; Technology = 'rtx-video-sdk'; Goal = 'Create RTX Video SDK media enhancement pipeline skeleton.' },
    @{ Workflow = 'nsight-marker-insertion'; Technology = 'nsight-aftermath'; Goal = 'Create Nsight marker insertion scaffold.' },
    @{ Workflow = 'reflex-marker-scaffold'; Technology = 'reflex'; Goal = 'Create Reflex marker scaffold for latency validation.' }
  )

  foreach ($item in $workflows) {
    $package = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
      goal = $item.Goal
      technology = $item.Technology
      workflow = $item.Workflow
    }
    Assert-Truthy ($package.workflow -eq $item.Workflow) "Unexpected workflow for $($item.Workflow)."
    Assert-Truthy ($package.implementation_package.files.Count -ge 1) "Missing scaffold files for $($item.Workflow)."
    Assert-Truthy ($package.written_files.Count -eq 0) "Preview mode wrote files for $($item.Workflow)."
    Write-Host "Assisted implementation preview OK: $($item.Workflow)" -ForegroundColor Green
  }

  $blocked = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -AllowError -Arguments @{
    goal = 'Attempt write without approval token.'
    technology = 'dlss-streamline'
    workflow = 'cmake-sdk-wiring'
    output_dir = (Join-Path $tempRoot 'blocked')
    write_files = $true
  }
  Assert-Truthy ($blocked.error.message -match 'APPROVED_PHASE_3_EDITS') 'Missing Phase 3 approval token was not rejected.'

  $written = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create approved CMake SDK wiring scaffold.'
    technology = 'dlss-streamline'
    workflow = 'cmake-sdk-wiring'
    output_dir = (Join-Path $tempRoot 'generated')
    write_files = $true
    approval_token = 'APPROVED_PHASE_3_EDITS'
  }
  Assert-Truthy ($written.written_files.Count -ge 1) 'Approved scaffold write did not create files.'
  Write-Host 'Assisted implementation write gate OK' -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
