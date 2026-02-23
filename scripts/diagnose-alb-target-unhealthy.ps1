[CmdletBinding()]
param(
  [string]$Region = "us-west-2",
  [string]$TargetGroupName,
  [string]$TargetGroupArn
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-AwsJson {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Args
  )

  $env:AWS_RETRY_MODE = if ($env:AWS_RETRY_MODE) { $env:AWS_RETRY_MODE } else { "standard" }
  $env:AWS_MAX_ATTEMPTS = if ($env:AWS_MAX_ATTEMPTS) { $env:AWS_MAX_ATTEMPTS } else { "10" }

  $out = & aws @Args --output json
  if ($LASTEXITCODE -ne 0) {
    throw "aws command failed (exit $LASTEXITCODE): aws $($Args -join ' ')"
  }
  return ($out | ConvertFrom-Json)
}

function Get-TargetGroup {
  param(
    [string]$Region,
    [string]$Name,
    [string]$Arn
  )

  if ($Arn) {
    $resp = Invoke-AwsJson -Args @("elbv2", "describe-target-groups", "--region", $Region, "--target-group-arns", $Arn)
  } elseif ($Name) {
    $resp = Invoke-AwsJson -Args @("elbv2", "describe-target-groups", "--region", $Region, "--names", $Name)
  } else {
    throw "Provide -TargetGroupName or -TargetGroupArn."
  }

  $tg = @($resp.TargetGroups)[0]
  if (-not $tg) {
    throw "Target group not found."
  }
  return $tg
}

function Get-ListenerRulesForTargetGroup {
  param(
    [string]$Region,
    [string[]]$LoadBalancerArns,
    [string]$TargetGroupArn
  )

  $matches = @()
  foreach ($lbArn in $LoadBalancerArns) {
    $listeners = (Invoke-AwsJson -Args @("elbv2", "describe-listeners", "--region", $Region, "--load-balancer-arn", $lbArn)).Listeners
    foreach ($listener in $listeners) {
      $rules = (Invoke-AwsJson -Args @("elbv2", "describe-rules", "--region", $Region, "--listener-arn", $listener.ListenerArn)).Rules
      foreach ($rule in $rules) {
        $usesTargetGroup = $false
        foreach ($action in $rule.Actions) {
          if ($action.PSObject.Properties["TargetGroupArn"] -and $action.TargetGroupArn -eq $TargetGroupArn) { $usesTargetGroup = $true }
          if ($action.PSObject.Properties["ForwardConfig"] -and $action.ForwardConfig -and $action.ForwardConfig.TargetGroups) {
            foreach ($tg in $action.ForwardConfig.TargetGroups) {
              if ($tg.TargetGroupArn -eq $TargetGroupArn) { $usesTargetGroup = $true }
            }
          }
        }
        if ($usesTargetGroup) {
          $hosts = @()
          foreach ($cond in $rule.Conditions) {
            if ($cond.Field -eq "host-header" -and $cond.HostHeaderConfig -and $cond.HostHeaderConfig.Values) {
              $hosts += @($cond.HostHeaderConfig.Values)
            }
          }

          $matches += [pscustomobject]@{
            LoadBalancerArn = $lbArn
            ListenerArn = $listener.ListenerArn
            ListenerPort = $listener.Port
            ListenerProtocol = $listener.Protocol
            RuleArn = $rule.RuleArn
            Priority = $rule.Priority
            Hosts = @($hosts | Select-Object -Unique)
            ActionTypes = @($rule.Actions | ForEach-Object { $_.Type } | Select-Object -Unique)
          }
        }
      }
    }
  }
  return $matches
}

function Get-PortFromHealthCheck {
  param(
    [object]$TargetGroup,
    [object]$TargetHealthDescription
  )

  $hcp = $TargetHealthDescription.HealthCheckPort
  if ($hcp -and $hcp -ne "traffic-port") {
    return [int]$hcp
  }

  if ($TargetGroup.Port) {
    return [int]$TargetGroup.Port
  }

  return $null
}

function Test-IpPermissionAllows {
  param(
    [object]$IpPermission,
    [string]$ExpectedProtocol,
    [int]$ExpectedPort,
    [string[]]$SourceSecurityGroupIds
  )

  $proto = "$($IpPermission.IpProtocol)".ToLowerInvariant()
  $protocolAllowed = ($proto -eq "-1" -or $proto -eq $ExpectedProtocol)
  if (-not $protocolAllowed) { return $false }

  $portAllowed = $true
  if ($proto -ne "-1" -and $ExpectedPort) {
    if ($null -eq $IpPermission.FromPort -or $null -eq $IpPermission.ToPort) {
      $portAllowed = $false
    } else {
      $portAllowed = ($IpPermission.FromPort -le $ExpectedPort -and $IpPermission.ToPort -ge $ExpectedPort)
    }
  }
  if (-not $portAllowed) { return $false }

  $sourceAllowed = $false
  if ($IpPermission.UserIdGroupPairs) {
    $ruleSgIds = @($IpPermission.UserIdGroupPairs | ForEach-Object { $_.GroupId })
    foreach ($sg in $SourceSecurityGroupIds) {
      if ($ruleSgIds -contains $sg) {
        $sourceAllowed = $true
        break
      }
    }
  }
  if (-not $sourceAllowed -and $IpPermission.IpRanges) {
    $cidrs = @($IpPermission.IpRanges | ForEach-Object { $_.CidrIp })
    if ($cidrs -contains "0.0.0.0/0") { $sourceAllowed = $true }
  }
  if (-not $sourceAllowed -and $IpPermission.Ipv6Ranges) {
    $cidrs6 = @($IpPermission.Ipv6Ranges | ForEach-Object { $_.CidrIpv6 })
    if ($cidrs6 -contains "::/0") { $sourceAllowed = $true }
  }

  return $sourceAllowed
}

function Analyze-InstanceIngressForHealthCheck {
  param(
    [string]$Region,
    [object]$TargetGroup,
    [object]$TargetHealthDescription,
    [string[]]$AlbSecurityGroupIds
  )

  $instanceId = $TargetHealthDescription.Target.Id
  $instanceResp = Invoke-AwsJson -Args @("ec2", "describe-instances", "--region", $Region, "--instance-ids", $instanceId)
  $reservation = @($instanceResp.Reservations)[0]
  $instance = if ($reservation) { @($reservation.Instances)[0] } else { $null }
  if (-not $instance) {
    return [pscustomobject]@{
      InstanceId = $instanceId
      InstanceState = "not-found"
      SecurityGroupIds = @()
      HealthCheckPort = $null
      AllowsAlbToHealthCheckPort = $false
      Reason = "Instance not found."
    }
  }

  $instanceSgIds = @($instance.SecurityGroups | ForEach-Object { $_.GroupId } | Select-Object -Unique)
  $port = Get-PortFromHealthCheck -TargetGroup $TargetGroup -TargetHealthDescription $TargetHealthDescription

  $allows = $false
  if ($instanceSgIds.Count -gt 0) {
    $sgArgs = @("ec2", "describe-security-groups", "--region", $Region, "--group-ids") + $instanceSgIds
    $sgResp = Invoke-AwsJson -Args $sgArgs
    $securityGroups = @($sgResp.SecurityGroups)

    $protocol = "tcp"
    foreach ($sg in $securityGroups) {
      foreach ($perm in $sg.IpPermissions) {
        if (Test-IpPermissionAllows -IpPermission $perm -ExpectedProtocol $protocol -ExpectedPort $port -SourceSecurityGroupIds $AlbSecurityGroupIds) {
          $allows = $true
          break
        }
      }
      if ($allows) { break }
    }
  }

  return [pscustomobject]@{
    InstanceId = $instanceId
    InstanceState = $instance.State.Name
    PrivateIpAddress = $instance.PrivateIpAddress
    SecurityGroupIds = $instanceSgIds
    HealthCheckPort = $port
    AllowsAlbToHealthCheckPort = $allows
    Reason = if ($allows) { "At least one instance SG ingress rule appears to allow ALB SG to health check port." } else { "No instance SG ingress rule found that clearly allows ALB SG to health check port." }
  }
}

$aws = Get-Command aws -ErrorAction SilentlyContinue
if (-not $aws) {
  throw "aws CLI not found on PATH."
}

$tg = Get-TargetGroup -Region $Region -Name $TargetGroupName -Arn $TargetGroupArn
$tgArn = $tg.TargetGroupArn

$tgHealth = (Invoke-AwsJson -Args @("elbv2", "describe-target-health", "--region", $Region, "--target-group-arn", $tgArn)).TargetHealthDescriptions
$tgAttributes = (Invoke-AwsJson -Args @("elbv2", "describe-target-group-attributes", "--region", $Region, "--target-group-arn", $tgArn)).Attributes

$lbs = @()
$albSecurityGroups = @()
if ($tg.LoadBalancerArns -and $tg.LoadBalancerArns.Count -gt 0) {
  $lbArgs = @("elbv2", "describe-load-balancers", "--region", $Region, "--load-balancer-arns") + @($tg.LoadBalancerArns)
  $lbResp = Invoke-AwsJson -Args $lbArgs
  $lbs = @($lbResp.LoadBalancers)
  foreach ($lb in $lbs) {
    if ($lb.SecurityGroups) {
      $albSecurityGroups += @($lb.SecurityGroups)
    }
  }
  $albSecurityGroups = @($albSecurityGroups | Select-Object -Unique)
}

$ruleMatches = Get-ListenerRulesForTargetGroup -Region $Region -LoadBalancerArns @($tg.LoadBalancerArns) -TargetGroupArn $tgArn

$unhealthy = @($tgHealth | Where-Object { $_.TargetHealth.State -ne "healthy" })
$instanceAnalyses = @()
if ($tg.TargetType -eq "instance" -and $unhealthy.Count -gt 0) {
  foreach ($th in $unhealthy) {
    $instanceAnalyses += Analyze-InstanceIngressForHealthCheck -Region $Region -TargetGroup $tg -TargetHealthDescription $th -AlbSecurityGroupIds $albSecurityGroups
  }
}

$findings = New-Object System.Collections.Generic.List[string]
$recommendations = New-Object System.Collections.Generic.List[string]

if ($unhealthy.Count -gt 0) {
  $findings.Add("Target group has $($unhealthy.Count) unhealthy target(s).")
}

foreach ($th in $unhealthy) {
  $findings.Add("Target $($th.Target.Id):$($th.Target.Port) state=$($th.TargetHealth.State), reason=$($th.TargetHealth.Reason), description=$($th.TargetHealth.Description)")
}

if ($ruleMatches.Count -eq 0) {
  $findings.Add("No listener rules currently route traffic to this target group.")
} else {
  $findings.Add("Found $($ruleMatches.Count) listener rule(s) routing to this target group.")
}

foreach ($ia in $instanceAnalyses) {
  if (-not $ia.AllowsAlbToHealthCheckPort) {
    $findings.Add("Instance $($ia.InstanceId) SG rules may block ALB health checks to port $($ia.HealthCheckPort).")
    $recommendations.Add("Allow inbound tcp/$($ia.HealthCheckPort) from ALB security group(s): $($albSecurityGroups -join ', ') to instance SG(s): $($ia.SecurityGroupIds -join ', ').")
  }
  if ($ia.InstanceState -ne "running") {
    $findings.Add("Instance $($ia.InstanceId) is not running (state: $($ia.InstanceState)).")
    $recommendations.Add("Start or replace instance $($ia.InstanceId).")
  }
}

$healthProtocol = $tg.HealthCheckProtocol
$healthPath = $tg.HealthCheckPath
$healthPort = $tg.HealthCheckPort
$matcher = $tg.Matcher.HttpCode

$recommendations.Add("From the target instance, verify the app is listening on health check port and returns an expected status code for path '$healthPath' (matcher: $matcher).")
$recommendations.Add("Check application logs around ALB health check requests and failures.")
$recommendations.Add("Confirm instance route/NACL/firewall allow inbound from ALB subnets and SG.")

[pscustomobject]@{
  TargetGroup = [pscustomobject]@{
    Name = $tg.TargetGroupName
    Arn = $tgArn
    Protocol = $tg.Protocol
    Port = $tg.Port
    VpcId = $tg.VpcId
    TargetType = $tg.TargetType
    HealthCheckProtocol = $healthProtocol
    HealthCheckPort = $healthPort
    HealthCheckPath = $healthPath
    HealthCheckMatcher = $matcher
  }
  TargetHealth = $tgHealth
  TargetGroupAttributes = $tgAttributes
  AssociatedLoadBalancers = $lbs
  AlbSecurityGroupIds = $albSecurityGroups
  ListenerRulesUsingTargetGroup = $ruleMatches
  InstanceSecurityAnalysis = $instanceAnalyses
  Findings = $findings
  Recommendations = @($recommendations | Select-Object -Unique)
} | ConvertTo-Json -Depth 12
