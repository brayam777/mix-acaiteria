# Static file server equivalent to serve.cjs, for environments without Node
# on PATH. Mirrors the same root/port/content-type/path-traversal behavior.

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = if ($env:PORT) { $env:PORT } else { 8087 }

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.webp' = 'image/webp'
  '.ico'  = 'image/x-icon'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Mix Açaiteria rodando em http://localhost:$port"

$fullRoot = [System.IO.Path]::GetFullPath($root)

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    try {
      $urlPath = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)
      if ($urlPath.EndsWith('/')) { $urlPath += 'index.html' }
      $relative = $urlPath.TrimStart('/')
      $fullPath = [System.IO.Path]::GetFullPath((Join-Path $fullRoot $relative))

      if (-not $fullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $response.StatusCode = 403
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('Forbidden')
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
      elseif (Test-Path -LiteralPath $fullPath -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
        $response.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
        $bytes = [System.IO.File]::ReadAllBytes($fullPath)
        $response.StatusCode = 200
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
      else {
        $response.StatusCode = 404
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('Not found')
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    }
    catch {
      $response.StatusCode = 500
    }
    finally {
      $response.OutputStream.Close()
    }
  }
}
finally {
  $listener.Stop()
}
