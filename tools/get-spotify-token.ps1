# Gets a Spotify refresh token for spot bar and saves it, with the Client ID and Secret, into the app's settings on
# BUSY Bar Emulator. Run it from the project folder:
#
#   powershell -ExecutionPolicy Bypass -File tools/get-spotify-token.ps1
#
# Your Spotify app (developer.spotify.com/dashboard) must list this exact Redirect URI: http://127.0.0.1:8888/callback

$ErrorActionPreference = 'Stop'

$redirect = 'http://127.0.0.1:8888/callback'
$scope = 'user-read-currently-playing user-read-playback-state user-library-read user-modify-playback-state user-library-modify'
$emulator = Join-Path $env:LOCALAPPDATA 'busy-emulator\bin\busy-emulator.exe'

function Send-Page($stream, [string]$status, [string]$message) {
  $html = "<html><body style='font-family:sans-serif;padding:2em'><h2>$message</h2></body></html>"
  $body = [System.Text.Encoding]::UTF8.GetBytes($html)
  $head = [System.Text.Encoding]::ASCII.GetBytes(
    "HTTP/1.1 $status`r`nContent-Type: text/html; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
  $stream.Write($head, 0, $head.Length)
  $stream.Write($body, 0, $body.Length)
}

function Read-Query([string]$target) {
  $values = @{}
  $parts = $target -split '\?', 2
  if ($parts.Length -lt 2) { return $values }
  foreach ($pair in $parts[1] -split '&') {
    $kv = $pair -split '=', 2
    if ($kv.Length -eq 2) { $values[$kv[0]] = [uri]::UnescapeDataString($kv[1].Replace('+', ' ')) }
  }
  return $values
}

$clientId = (Read-Host 'Spotify Client ID').Trim()
$clientSecret = (Read-Host 'Spotify Client Secret').Trim()
if (-not $clientId -or -not $clientSecret) { throw 'Both the Client ID and the Client Secret are needed.' }

$state = [guid]::NewGuid().ToString('N')
$authorize = 'https://accounts.spotify.com/authorize' +
  '?client_id=' + [uri]::EscapeDataString($clientId) +
  '&response_type=code' +
  '&redirect_uri=' + [uri]::EscapeDataString($redirect) +
  '&scope=' + [uri]::EscapeDataString($scope) +
  '&state=' + $state

# A plain socket on 127.0.0.1 needs no admin rights, unlike HttpListener.
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 8888)
$listener.Start()
$code = $null
try {
  Write-Host ''
  Write-Host 'Opening Spotify in your browser. Log in if asked, then click Agree.'
  Write-Host "If no browser opens, paste this address into one:`n$authorize"
  Start-Process $authorize

  while (-not $code) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = [System.IO.StreamReader]::new($stream)
      $requestLine = $reader.ReadLine()
      $target = if ($requestLine) { ($requestLine -split ' ')[1] } else { '' }

      # Browsers also ask for /favicon.ico and the like: answer and keep waiting.
      if ($target -notlike '/callback*') { Send-Page $stream '404 Not Found' 'Not found'; continue }

      $query = Read-Query $target
      if ($query['state'] -ne $state) { Send-Page $stream '400 Bad Request' 'Unexpected answer, ignored.'; continue }
      if ($query['error']) {
        Send-Page $stream '200 OK' "Spotify said: $($query['error']). You can close this tab."
        throw "Spotify refused access: $($query['error'])"
      }
      $code = $query['code']
      Send-Page $stream '200 OK' 'Done! Go back to PowerShell. You can close this tab.'
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}

Write-Host 'Got the code. Asking Spotify for the refresh token...'
try {
  $answer = Invoke-RestMethod -Method Post -Uri 'https://accounts.spotify.com/api/token' -Body @{
    grant_type    = 'authorization_code'
    code          = $code
    redirect_uri  = $redirect
    client_id     = $clientId
    client_secret = $clientSecret
  }
} catch {
  $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
  throw "Spotify did not give a token: $detail"
}

$refreshToken = $answer.refresh_token
if (-not $refreshToken) { throw 'Spotify answered without a refresh_token.' }

Write-Host ''
Write-Host 'Your refresh token (keep it private):' -ForegroundColor Green
Write-Host $refreshToken
Write-Host ''

if (Test-Path $emulator) {
  Write-Host 'Saving it into spot bar on BUSY Bar Emulator...'
  & $emulator settings set "client_id=$clientId" "client_secret=$clientSecret" "refresh_token=$refreshToken" --restart
  if ($LASTEXITCODE -ne 0) { Write-Host 'Could not save it: is the emulator running? Enter the three values in the app''s settings yourself.' -ForegroundColor Yellow }
} else {
  Write-Host 'Enter the Client ID, Client Secret and this refresh token in spot bar''s settings on your BUSY Bar.'
}
